import { testDatabaseUrl } from './helpers/postgres.js';
import { randomBytes } from 'node:crypto';
import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const cryptoControl = vi.hoisted(() => ({ forcedHex: undefined as string | undefined }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: ((size: number) => {
      if (cryptoControl.forcedHex === undefined) return actual.randomBytes(size);
      const bytes = Buffer.from(cryptoControl.forcedHex, 'hex');
      if (bytes.length !== size) throw new Error('Forced random byte count does not match');
      return bytes;
    }) as typeof actual.randomBytes,
  };
});

import { createOwnedDatabase } from '../src/database.js';

const ADMIN_DATABASE_URL =
  testDatabaseUrl();

function client(connectionString = ADMIN_DATABASE_URL): Client {
  const connection = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  connection.on('error', () => undefined);
  return connection;
}

async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('PostgreSQL did not reach the expected observable state');
}

describe('createOwnedDatabase integration', () => {
  const admin = client();

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end();
  });

  test('creates an isolated generated database and preserves the administrator database', async () => {
    const sentinel = `interleave_sentinel_${randomBytes(8).toString('hex')}`;
    const sentinelIdentifier = escapeIdentifier(sentinel);
    await admin.query(`CREATE TABLE ${sentinelIdentifier} (value text NOT NULL)`);
    await admin.query(`INSERT INTO ${sentinelIdentifier} VALUES ('preserved')`);

    const owned = await createOwnedDatabase(ADMIN_DATABASE_URL);
    try {
      expect(owned.name).toMatch(/^interleave_[0-9a-f]+$/);
      const identity = await owned.db.query<{
        database: string;
        server_version: string;
      }>(
        `SELECT current_database() AS database,
                current_setting('server_version') AS server_version`,
      );
      expect(identity.rows[0]?.database).toBe(owned.name);
      expect(owned.connectionString).toContain(`/${owned.name}`);
      expect(owned.serverVersion).toBe(identity.rows[0]?.server_version);

      await owned.db.query('CREATE TABLE owned_only (value integer NOT NULL)');
      await owned.db.query('INSERT INTO owned_only VALUES (42)');
      expect((await owned.db.query('SELECT value FROM owned_only')).rows).toEqual([
        { value: 42 },
      ]);
    } finally {
      await owned.close();
    }

    try {
      expect(
        (await admin.query(`SELECT value FROM ${sentinelIdentifier}`)).rows,
      ).toEqual([{ value: 'preserved' }]);
      const dropped = await admin.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [owned.name],
      );
      expect(dropped.rows[0]?.exists).toBe(false);
    } finally {
      await admin.query(`DROP TABLE ${sentinelIdentifier}`);
    }
  });

  test('removes database-name query parameters from the owned connection URL', async () => {
    const administratorUrl = new URL(ADMIN_DATABASE_URL);
    administratorUrl.searchParams.set('database', 'postgres');
    administratorUrl.searchParams.set('dbname', 'postgres');
    administratorUrl.searchParams.set('db', 'postgres');
    const owned = await createOwnedDatabase(administratorUrl.toString());

    try {
      const ownedUrl = new URL(owned.connectionString);
      expect(ownedUrl.searchParams.has('database')).toBe(false);
      expect(ownedUrl.searchParams.has('dbname')).toBe(false);
      expect(ownedUrl.searchParams.has('db')).toBe(false);
      expect((await owned.db.query('SELECT current_database() AS database')).rows).toEqual([
        { database: owned.name },
      ]);
    } finally {
      await owned.close();
    }
  });

  test.each(['host', 'hostaddr', 'port'])(
    'rejects an ambiguous %s route override before connecting',
    async (parameter) => {
      const administratorUrl = new URL(ADMIN_DATABASE_URL);
      administratorUrl.searchParams.set(parameter, parameter === 'port' ? '65064' : '127.0.0.1');

      await expect(createOwnedDatabase(administratorUrl.toString())).rejects.toThrow(
        /must be specified in the URL authority/i,
      );
    },
  );

  test('keeps concurrent owned databases separate and drops only the one being closed', async () => {
    const [first, second] = await Promise.all([
      createOwnedDatabase(ADMIN_DATABASE_URL),
      createOwnedDatabase(ADMIN_DATABASE_URL),
    ]);

    try {
      expect(first.name).not.toBe(second.name);
      await Promise.all([
        first.db.query('CREATE TABLE same_name (value integer NOT NULL)'),
        second.db.query('CREATE TABLE same_name (value integer NOT NULL)'),
      ]);
      await Promise.all([
        first.db.query('INSERT INTO same_name VALUES (1)'),
        second.db.query('INSERT INTO same_name VALUES (2)'),
      ]);

      await first.close();
      expect((await second.db.query('SELECT value FROM same_name')).rows).toEqual([
        { value: 2 },
      ]);
      const databases = await admin.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
        [[first.name, second.name]],
      );
      expect(databases.rows.map((row) => row.datname)).toEqual([second.name]);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  });

  test('reports only a server-confirmed row-lock wait with real blocker pids', async () => {
    const owned = await createOwnedDatabase(ADMIN_DATABASE_URL);
    const unrelated = await createOwnedDatabase(ADMIN_DATABASE_URL);
    const waiter = client(owned.connectionString);
    await waiter.connect();

    try {
      await owned.db.query('CREATE TABLE account (id integer PRIMARY KEY, balance integer NOT NULL)');
      await owned.db.query('INSERT INTO account VALUES (1, 10)');
      const ownerPid = Number(
        (await owned.db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid,
      );
      const waiterPid = Number(
        (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
      );

      await owned.db.query('BEGIN');
      await owned.db.query('UPDATE account SET balance = 11 WHERE id = 1');
      const blockedUpdate = waiter.query(
        'UPDATE account SET balance = 12 WHERE id = 1',
      );

      const observation = await eventually(() => owned.observeWait(waiterPid));
      expect(await unrelated.observeWait(waiterPid)).toBeNull();
      expect(observation).toEqual({
        pid: waiterPid,
        blockerPids: [ownerPid],
        waitEvent: 'transactionid',
        waitEventType: 'Lock',
      });

      await owned.db.query('ROLLBACK');
      await blockedUpdate;
      expect((await waiter.query('SELECT balance FROM account WHERE id = 1')).rows).toEqual([
        { balance: 12 },
      ]);
    } finally {
      await owned.db.query('ROLLBACK').catch(() => undefined);
      await waiter.end().catch(() => undefined);
      await Promise.all([owned.close(), unrelated.close()]);
    }
  });

  test('does not classify an active slow query as a lock wait', async () => {
    const owned = await createOwnedDatabase(ADMIN_DATABASE_URL);
    const slowClient = client(owned.connectionString);
    await slowClient.connect();

    try {
      const slowPid = Number(
        (await slowClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid,
      );
      const slowQuery = slowClient.query('SELECT pg_sleep(0.5)');

      await eventually(async () => {
        const activity = await owned.db.query<{ wait_event: string | null }>(
          `SELECT wait_event
             FROM pg_stat_activity
            WHERE pid = $1 AND datname = current_database()`,
          [slowPid],
        );
        return activity.rows[0]?.wait_event === 'PgSleep' ? true : null;
      });

      expect(await owned.observeWait(slowPid)).toBeNull();
      await slowQuery;
    } finally {
      await slowClient.end().catch(() => undefined);
      await owned.close();
    }
  });

  test('terminates orphan connections, drops the owned database, and closes idempotently', async () => {
    const owned = await createOwnedDatabase(ADMIN_DATABASE_URL);
    const orphan = client(owned.connectionString);
    await orphan.connect();

    await owned.close();
    await owned.close();

    await expect(orphan.query('SELECT 1')).rejects.toThrow();
    await orphan.end().catch(() => undefined);
    const database = await admin.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [owned.name],
    );
    expect(database.rows[0]?.exists).toBe(false);
    expect((await admin.query('SELECT current_database() AS database')).rows).toEqual([
      { database: new URL(ADMIN_DATABASE_URL).pathname.slice(1) },
    ]);
  });

  test('closes and drops while the owned query client is waiting on a lock', async () => {
    const owned = await createOwnedDatabase(ADMIN_DATABASE_URL);
    const blocker = client(owned.connectionString);
    await blocker.connect();

    try {
      await blocker.query('CREATE TABLE locked_row (id integer PRIMARY KEY, value integer NOT NULL)');
      await blocker.query('INSERT INTO locked_row VALUES (1, 1)');
      await blocker.query('BEGIN');
      await blocker.query('UPDATE locked_row SET value = 2 WHERE id = 1');
      const ownedPid = Number(
        (await owned.db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid,
      );
      const blockedResult = owned.db
        .query('UPDATE locked_row SET value = 3 WHERE id = 1')
        .then(
          () => null,
          (error: unknown) => error,
        );
      await eventually(() => owned.observeWait(ownedPid));

      await owned.close();
      expect(await blockedResult).toBeInstanceOf(Error);
      await expect(blocker.query('SELECT 1')).rejects.toThrow();
    } finally {
      await blocker.end().catch(() => undefined);
      await owned.close().catch(() => undefined);
    }
  });

  test('rejects an unusable administrator URL without creating a database', async () => {
    const suffix = randomBytes(16).toString('hex');
    const existingName = `interleave_${suffix}`;
    await admin.query(`CREATE DATABASE ${escapeIdentifier(existingName)}`);
    cryptoControl.forcedHex = suffix;
    const unusableUrl = new URL(ADMIN_DATABASE_URL);
    unusableUrl.pathname = '/database_that_does_not_exist';

    try {
      await expect(createOwnedDatabase(unusableUrl.toString())).rejects.toThrow();
      const existing = await admin.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [existingName],
      );
      expect(existing.rows[0]?.exists).toBe(true);
    } finally {
      cryptoControl.forcedHex = undefined;
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(existingName)} WITH (FORCE)`);
    }
  });

  test('removes a database when initialization fails after creation', async () => {
    const role = `interleave_owner_${randomBytes(8).toString('hex')}`;
    const password = randomBytes(16).toString('hex');
    await admin.query(
      `CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(password)} CREATEDB CONNECTION LIMIT 1`,
    );
    const limitedUrl = new URL(ADMIN_DATABASE_URL);
    limitedUrl.username = role;
    limitedUrl.password = password;

    try {
      await expect(createOwnedDatabase(limitedUrl.toString())).rejects.toThrow(
        /connection slot reserved|too many connections/i,
      );
      const ownedByRole = await admin.query<{ datname: string }>(
        `SELECT database.datname
           FROM pg_database AS database
           JOIN pg_roles AS owner ON owner.oid = database.datdba
          WHERE owner.rolname = $1`,
        [role],
      );
      expect(ownedByRole.rows).toEqual([]);
    } finally {
      await admin.query(`DROP ROLE ${escapeIdentifier(role)}`);
    }
  });

  test('never drops a pre-existing database when generated-name creation collides', async () => {
    const suffix = randomBytes(16).toString('hex');
    const existingName = `interleave_${suffix}`;
    await admin.query(`CREATE DATABASE ${escapeIdentifier(existingName)}`);
    cryptoControl.forcedHex = suffix;

    try {
      await expect(createOwnedDatabase(ADMIN_DATABASE_URL)).rejects.toMatchObject({
        code: '42P04',
      });
      const existing = await admin.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [existingName],
      );
      expect(existing.rows[0]?.exists).toBe(true);
    } finally {
      cryptoControl.forcedHex = undefined;
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(existingName)} WITH (FORCE)`);
    }
  });
});
