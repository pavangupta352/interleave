import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { forPg } from './vendor/pghybrid/dist/index.js';
import type { Scenario } from '../../src/types.js';

export const QUERY = 'renewal notice period';
export const EMBEDDING = [1, 0, 0, 0, 0, 0, 0, 0];
export const EXPECTED_TITLES = ['Termination for convenience', 'Renewal pricing', 'Renewal terms'];
export const CONFIG = {
  table: 'adapter_fixture',
  textColumn: 'content',
  vectorColumn: 'embedding',
  tsvectorColumn: 'fts',
  extraColumns: ['title'],
} as const;

export const PGHYBRID_PLAN = ['first', 'second'] as const;

// Fixture data and unitVector are copied from pghybrid v0.1.4's
// js/test/adapters.test.ts at commit 6b12e4c0d8bb25957554c41ac12c56653efad49d.
// The original MIT license is preserved in vendor/LICENSE.
const DOCUMENTS: [number, string, string][] = [
  [0.15, 'Automatic extension', 'This agreement extends automatically for successive twelve month terms unless either party elects otherwise. Extension begins on the anniversary of the effective date.'],
  [0.28, 'Termination for convenience', 'Either party may terminate this agreement for convenience by giving sixty days written notice prior to the anniversary date. The notice period runs from the date of delivery.'],
  [0.4, 'Subscription term', 'The initial subscription term is twelve months from the effective date and continues until terminated in accordance with this section.'],
  [0.52, 'Fees and invoicing', 'Fees are invoiced annually in advance. Invoices are payable within thirty days of the invoice date.'],
  [0.64, 'Service levels', 'The supplier will use commercially reasonable efforts to maintain a monthly uptime percentage of at least 99.9 percent.'],
  [0.76, 'Notice requirements', 'Any notice given under this agreement must be in writing and delivered to the address set out in the order form.'],
  [0.88, 'Renewal pricing', 'Renewal pricing is subject to change on notice. The supplier will notify the customer before the renewal period commences, and any renewal notice must state the revised fees.'],
  [1.0, 'Renewal terms', 'Renewal terms and conditions apply to all customers on the standard plan from the start of each renewal period.'],
  [1.12, 'Governing law', 'This agreement is governed by the laws of England and Wales and the parties submit to the exclusive jurisdiction of its courts.'],
  [1.24, 'Confidentiality', 'Each party shall keep confidential all information disclosed by the other party and shall not disclose it to any third party.'],
  [1.36, 'Data protection', 'The supplier processes personal data only on documented instructions from the customer and in accordance with applicable data protection law.'],
  [1.48, 'Limitation of liability', 'Neither party is liable for indirect or consequential loss arising out of or in connection with this agreement.'],
];

function unitVector(angle: number): string {
  const vector = new Array(8).fill(0);
  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);
  return `[${vector.join(',')}]`;
}

async function search(connectionString: string, signal: AbortSignal): Promise<string[]> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  let ending: Promise<void> | undefined;
  const close = (): Promise<void> => (ending ??= pool.end());
  const abort = (): void => { void close().catch(() => undefined); };
  pool.on('error', abort);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const rows = await forPg(pool, CONFIG).search(QUERY, { embedding: EMBEDDING, limit: 3 });
    return rows.map(row => String(row.row.title));
  } finally {
    signal.removeEventListener('abort', abort);
    pool.off('error', abort);
    await close();
  }
}

export function createPghybridScenario(): Scenario {
  return {
    name: 'pghybrid-0.1.4-pg17-vector-0.8.6-for-pg',
    async setup({ db }) {
      await db.query('CREATE EXTENSION vector');
      await db.query(`CREATE TABLE adapter_fixture (
        id bigserial PRIMARY KEY,
        title text NOT NULL,
        content text NOT NULL,
        embedding vector(8),
        fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
      )`);
      for (const [angle, title, content] of DOCUMENTS) {
        await db.query('INSERT INTO adapter_fixture (title,content,embedding) VALUES ($1,$2,$3)', [title, content, unitVector(angle)]);
      }
    },
    actors: {
      first: ({ connectionString, signal }) => search(connectionString, signal),
      second: ({ connectionString, signal }) => search(connectionString, signal),
    },
    async invariant({ results }) {
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.status, 'fulfilled');
        assert.deepEqual(result.value, EXPECTED_TITLES);
      }
    },
  };
}

export default createPghybridScenario();
