import assert from 'node:assert/strict';
import net from 'node:net';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { ActorContext, Scenario } from '../../src/types.js';

/** An actor-owned pool, ended after the operation and on cancellation. */
export async function withPool<T>(context: ActorContext, work: (pool: Pool) => Promise<T>, config: PoolConfig = {}): Promise<T> {
  const pool = new Pool({ connectionString: context.connectionString, max: 2, ...config });
  pool.on('error', () => undefined);
  pool.on('connect', client => { client.on('error', () => undefined); });
  let ended: Promise<void> | undefined;
  const end = (): Promise<void> => (ended ??= pool.end().catch(() => undefined));
  context.signal.addEventListener('abort', end, { once: true });
  try { return await work(pool); } finally {
    context.signal.removeEventListener('abort', end);
    await end();
  }
}

export function backendPid(client: PoolClient): number {
  return (client as unknown as { processID: number }).processID;
}

const counterSetup: Scenario['setup'] = async ({ db }) => {
  await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1, 0), (2, 0)');
};

async function increment(pool: Pool): Promise<number> {
  const { rows } = await pool.query('SELECT value FROM counter WHERE id = 1');
  await pool.query('UPDATE counter SET value = $1 WHERE id = 1', [rows[0].value + 1]);
  return rows[0].value as number;
}

/** alice runs two read-modify-writes concurrently through one pg.Pool; bob runs one. */
export function poolLostUpdate(): Scenario {
  return {
    name: 'pool-lost-update',
    setup: counterSetup,
    actors: {
      alice: context => withPool(context, pool => Promise.all([increment(pool), increment(pool)])),
      bob: context => withPool(context, increment, { max: 1 }),
    },
    async invariant({ db }) {
      assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 3, 'Every pooled increment must be retained');
    },
  };
}

/**
 * Two explicitly checked-out pool clients do different work. When requested, the
 * first client's TCP connect is delayed, so the proxy accepts the second first.
 */
export function checkoutTasks(control: { delayFirstConnect: boolean; changed?: boolean }): Scenario {
  const task = async (pool: Pool, id: number): Promise<{ id: number; pid: number; read: number }> => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT value FROM counter WHERE id = ${id}`);
      await client.query(`UPDATE counter SET value = $1 WHERE id = ${id}`, [rows[0].value + (control.changed && id === 2 ? 5 : 1)]);
      return { id, pid: backendPid(client), read: rows[0].value };
    } finally { client.release(); }
  };
  return {
    name: 'pool-checkout-tasks',
    setup: counterSetup,
    actors: {
      alice: context => {
        let created = 0;
        return withPool(context, pool => Promise.all([task(pool, 1), task(pool, 2)]), {
          stream: () => {
            const socket = new net.Socket();
            if (control.delayFirstConnect && created++ === 0) {
              const connect = socket.connect.bind(socket) as (...parameters: unknown[]) => net.Socket;
              (socket as unknown as { connect: (...parameters: unknown[]) => net.Socket }).connect = (...parameters) => {
                setTimeout(() => { if (!socket.destroyed) connect(...parameters); }, 250);
                return socket;
              };
            }
            return socket;
          },
        });
      },
      bob: context => withPool(context, async pool => (await pool.query('SELECT sum(value)::int AS total FROM counter')).rows[0].total as number, { max: 1 }),
    },
    async invariant({ db }) {
      const { rows } = await db.query('SELECT id, value FROM counter ORDER BY id');
      assert.deepEqual(rows.map(row => row.value > 0), [true, true], 'Both checked-out tasks must write');
    },
  };
}

/** One actor's transaction connection holds a row lock that its side connection waits for. */
export function ownLaneLock(): Scenario {
  return {
    name: 'pool-own-lane-lock',
    setup: counterSetup,
    actors: {
      alice: context => withPool(context, async pool => {
        const transaction = await pool.connect();
        try {
          await transaction.query('BEGIN');
          await transaction.query('UPDATE counter SET value = value + 1 WHERE id = 1');
          const side = pool.query('UPDATE counter SET value = value + 10 WHERE id = 1');
          await transaction.query('COMMIT');
          await side;
        } finally { transaction.release(); }
      }),
      bob: context => withPool(context, async pool => (await pool.query('SELECT value FROM counter WHERE id = 2')).rows[0].value as number, { max: 1 }),
    },
    async invariant({ db }) {
      assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 11, 'Both of alice\'s updates must commit');
    },
  };
}

interface CouponDatabase {
  coupons: { id: number; remaining: number };
  redemptions: { actor: string };
}

/**
 * Kysely transaction that checks availability through the outer pool instead of
 * its transaction: the check runs on a second connection without the row lock.
 */
export function kyselySideQuery(): Scenario {
  const redeem = (context: ActorContext) => withPool(context, async pool => {
    const db = new Kysely<CouponDatabase>({ dialect: new PostgresDialect({ pool }) });
    let redeemed = false;
    await db.transaction().execute(async transaction => {
      const coupon = await db.selectFrom('coupons').select('remaining').where('id', '=', 1).executeTakeFirstOrThrow();
      if (coupon.remaining <= 0) return;
      await transaction.updateTable('coupons').set({ remaining: coupon.remaining - 1 }).where('id', '=', 1).execute();
      await transaction.insertInto('redemptions').values({ actor: context.actor }).execute();
      redeemed = true;
    });
    return { redeemed };
  });
  return {
    name: 'kysely-side-query',
    async setup({ db }) {
      await db.query('CREATE TABLE coupons (id int PRIMARY KEY, remaining int NOT NULL); INSERT INTO coupons VALUES (1, 1)');
      await db.query('CREATE TABLE redemptions (actor text NOT NULL)');
    },
    actors: { alice: redeem, bob: redeem },
    async invariant({ db }) {
      const { rows } = await db.query('SELECT count(*)::int AS count FROM redemptions');
      assert.ok(rows[0].count <= 1, `A single coupon was redeemed ${rows[0].count} times`);
    },
  };
}
