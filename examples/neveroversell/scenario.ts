import assert from 'node:assert/strict';
import { Pool } from 'pg';
import type { Scenario } from '../../src/types.js';
import { createInventory } from './vendor/src/index.js';
import {
  naiveBuy,
  naiveSetup,
  naiveStatus,
  naiveUpsertResource,
} from './vendor/src/naive.js';

const RESOURCE_ID = 'single-seat';

export const NAIVE_OVERSELL_PLAN = [
  'alice',
  'bob',
  'alice',
  'bob',
  'alice',
  'alice',
  'alice',
  'bob',
  'bob',
  'bob',
] as const;

function poolFor(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
}

async function usingPool<T>(
  connectionString: string,
  signal: AbortSignal | undefined,
  operation: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = poolFor(connectionString);
  let idleError: Error | undefined;
  let ending: Promise<void> | undefined;
  const close = (): Promise<void> => (ending ??= pool.end());
  const onIdleError = (error: Error): void => {
    idleError ??= error;
  };
  const onAbort = (): void => {
    void close().catch(() => undefined);
  };

  pool.on('error', onIdleError);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const value = await operation(pool);
    if (idleError) throw idleError;
    return value;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    pool.off('error', onIdleError);
    await close();
  }
}

function naiveBuyer(accountId: string): Scenario['actors'][string] {
  return async ({ connectionString, signal }) =>
    usingPool(connectionString, signal, (pool) =>
      naiveBuy(pool, {
        resourceId: RESOURCE_ID,
        qty: 1,
        accountId,
        gapMs: 0,
      }),
    );
}

function safeBuyer(accountId: string): Scenario['actors'][string] {
  return async ({ connectionString, signal }) =>
    usingPool(connectionString, signal, async (pool) => {
      const result = await createInventory({ pool }).hold({
        resourceId: RESOURCE_ID,
        qty: 1,
        accountId,
      });
      return result.status;
    });
}

export function createNaiveOversellScenario(): Scenario {
  return {
    name: 'neveroversell-naive-buy-gap-0',
    async setup({ connectionString }) {
      await usingPool(connectionString, undefined, async (pool) => {
        await naiveSetup(pool);
        await naiveUpsertResource(pool, RESOURCE_ID, 1);
      });
    },
    actors: {
      alice: naiveBuyer('alice'),
      bob: naiveBuyer('bob'),
    },
    async invariant({ connectionString }) {
      await usingPool(connectionString, undefined, async (pool) => {
        const status = await naiveStatus(pool, RESOURCE_ID);
        const orders = await pool.query<{ accepted_qty: string }>(
          `select coalesce(sum(qty), 0)::text as accepted_qty
             from naive_orders
            where resource_id = $1`,
          [RESOURCE_ID],
        );
        const acceptedQty = Number(orders.rows[0]?.accepted_qty ?? 0);
        assert.ok(
          status.sold <= status.total && acceptedQty <= status.total,
          `constructed naiveBuy demo oversold: sold=${status.sold}, acceptedQty=${acceptedQty}, total=${status.total}`,
        );
      });
    },
  };
}

export function createSafeReservationScenario(): Scenario {
  return {
    name: 'neveroversell-safe-reservations',
    async setup({ connectionString }) {
      await usingPool(connectionString, undefined, async (pool) => {
        const inventory = createInventory({ pool });
        await inventory.migrate();
        const resource = await inventory.upsertResource({ id: RESOURCE_ID, total: 1 });
        assert.equal(resource.status, 'created');
      });
    },
    actors: {
      alice: safeBuyer('alice'),
      bob: safeBuyer('bob'),
    },
    async invariant({ connectionString, results }) {
      await usingPool(connectionString, undefined, async (pool) => {
        const inventory = createInventory({ pool });
        const status = await inventory.status(RESOURCE_ID);
        const holds = await inventory.holds({ resourceId: RESOURCE_ID });
        assert.ok(status, 'safe resource exists');
        assert.ok(status.held + status.sold <= status.total, 'safe reservation capacity is preserved');
        assert.equal(status.held, 1, 'exactly one unit is held');
        assert.equal(holds.filter((hold) => hold.state === 'held').length, 1, 'exactly one hold is accepted');
        assert.deepEqual(
          results.map((result) => result.value).sort(),
          ['held', 'insufficient'],
          'one buyer succeeds and one buyer is rejected',
        );
      });
    },
  };
}
