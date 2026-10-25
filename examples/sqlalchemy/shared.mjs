import assert from 'node:assert/strict';

// Python actors run with the interpreter named by INTERLEAVE_PYTHON (for example a
// virtual environment's bin/python); otherwise python3 from PATH.
export const python = process.env.INTERLEAVE_PYTHON ?? 'python3';

export async function setup({ db }) {
  await db.query(`CREATE TABLE product (id integer PRIMARY KEY, stock integer NOT NULL CHECK (stock >= 0));
    CREATE TABLE orders (id serial PRIMARY KEY, product_id integer NOT NULL REFERENCES product);
    INSERT INTO product VALUES (1, 1)`);
}

export async function invariant({ db }) {
  const { rows: [{ orders }] } = await db.query('SELECT count(*)::int AS orders FROM orders');
  assert.ok(orders <= 1, `one unit of stock was sold ${orders} times`);
}
