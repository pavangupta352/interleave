import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Java actors run with the launcher named by INTERLEAVE_JAVA (Java 21 or later);
// otherwise java from PATH. fetch-driver.mjs downloads this exact driver jar
// from Maven Central and keeps it only when its SHA-256 matches.
export const java = process.env.INTERLEAVE_JAVA ?? 'java';
export const driver = {
  version: '42.7.13',
  sha256: '6e0e4cc2d8cae902084f8a2b18728b073a6fd9d1f87c9d8bff8f298c18185b93',
};
export const driverJar = fileURLToPath(new URL(`./lib/postgresql-${driver.version}.jar`, import.meta.url));

export async function setup({ db }) {
  await db.query(`CREATE TABLE product (id integer PRIMARY KEY, stock integer NOT NULL CHECK (stock >= 0));
    CREATE TABLE orders (id serial PRIMARY KEY, product_id integer NOT NULL REFERENCES product);
    INSERT INTO product VALUES (1, 1)`);
}

export async function invariant({ db }) {
  const { rows: [{ orders }] } = await db.query('SELECT count(*)::int AS orders FROM orders');
  assert.ok(orders <= 1, `one unit of stock was sold ${orders} times`);
}
