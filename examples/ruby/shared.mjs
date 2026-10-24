import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Ruby actors run with the interpreter named by INTERLEAVE_RUBY; otherwise ruby
// from PATH. Bundler loads the pg gem pinned by this folder's Gemfile.lock from
// the vendor/bundle path set in .bundle/config.
export const ruby = process.env.INTERLEAVE_RUBY ?? 'ruby';
export const bundler = { env: { BUNDLE_GEMFILE: fileURLToPath(new URL('./Gemfile', import.meta.url)) } };

export async function setup({ db }) {
  await db.query(`CREATE TABLE product (id integer PRIMARY KEY, stock integer NOT NULL CHECK (stock >= 0));
    CREATE TABLE orders (id serial PRIMARY KEY, product_id integer NOT NULL REFERENCES product);
    INSERT INTO product VALUES (1, 1)`);
}

export async function invariant({ db }) {
  const { rows: [{ orders }] } = await db.query('SELECT count(*)::int AS orders FROM orders');
  assert.ok(orders <= 1, `one unit of stock was sold ${orders} times`);
}
