import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Go actors run the checkout and checkout-safe programs built into bin/ next to
// this file (see README.md), or into the directory named by INTERLEAVE_GO.
const bin = process.env.INTERLEAVE_GO ?? fileURLToPath(new URL('./bin', import.meta.url));
export const program = name => join(bin, process.platform === 'win32' ? `${name}.exe` : name);

export async function setup({ db }) {
  await db.query(`CREATE TABLE product (id integer PRIMARY KEY, stock integer NOT NULL CHECK (stock >= 0));
    CREATE TABLE orders (id serial PRIMARY KEY, product_id integer NOT NULL REFERENCES product);
    INSERT INTO product VALUES (1, 1)`);
}

export async function invariant({ db }) {
  const { rows: [{ orders }] } = await db.query('SELECT count(*)::int AS orders FROM orders');
  assert.ok(orders <= 1, `one unit of stock was sold ${orders} times`);
}
