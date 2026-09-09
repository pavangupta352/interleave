import { randomBytes } from 'node:crypto';

import { Client, escapeIdentifier } from 'pg';

import type { OwnedDatabase, WaitObservation } from './types.js';

const CONNECTION_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 30_000;
const CLIENT_CLOSE_TIMEOUT_MS = 5_000;

/** Creation succeeded, but initialization and recovery could not prove cleanup. */
export class OwnedDatabaseCreationError extends AggregateError {
  readonly cleanupComplete = false;

  constructor(readonly databaseName: string, errors: readonly unknown[]) {
    super(errors, `Owned database creation failed and cleanup was incomplete for ${databaseName}`, { cause: errors[0] });
    this.name = 'OwnedDatabaseCreationError';
  }
}


function generatedDatabaseName(): string {
  return `interleave_${randomBytes(16).toString('hex')}`;
}

function parseAdministratorUrl(databaseUrl: string): URL {
  if (databaseUrl.trim().length === 0) {
    throw new TypeError('An explicit PostgreSQL administrator URL is required');
  }

  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new TypeError('Administrator URL must use postgres:// or postgresql://');
  }
  for (const parameter of ['host', 'hostaddr', 'port']) {
    if (parsed.searchParams.has(parameter)) {
      throw new TypeError(
        `PostgreSQL ${parameter} must be specified in the URL authority, not its query string`,
      );
    }
  }
  // PostgreSQL names the database in the URL path. Remove aliases that some
  // connection-string implementations may interpret as a competing database.
  for (const parameter of ['database', 'dbname', 'db']) {
    parsed.searchParams.delete(parameter);
  }
  return parsed;
}

function ownedConnectionString(administratorUrl: URL, name: string): string {
  const ownedUrl = new URL(administratorUrl);
  ownedUrl.pathname = `/${name}`;
  return ownedUrl.toString();
}

function postgresClient(connectionString: string): Client {
  const connection = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });

  // node-postgres emits idle connection failures as EventEmitter errors. The
  // lifecycle methods and query promises still surface actionable failures.
  connection.on('error', () => undefined);
  return connection;
}

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeClient(client: Client | undefined, label: string): Promise<void> {
  if (client === undefined) return;
  await bounded(client.end(), CLIENT_CLOSE_TIMEOUT_MS, `Closing ${label}`);
}

async function cleanupGeneratedDatabase(
  administratorUrl: string,
  name: string,
  ownedClients: readonly (Client | undefined)[],
): Promise<void> {
  const errors: unknown[] = [];
  const closed = await Promise.allSettled(
    ownedClients.map((connection, index) =>
      closeClient(connection, `owned database client ${index + 1}`),
    ),
  );
  for (const result of closed) {
    if (result.status === 'rejected') errors.push(result.reason);
  }

  const administrator = postgresClient(administratorUrl);
  try {
    await administrator.connect();
    await administrator.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [name],
    );
    await administrator.query(
      `DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`,
    );
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await closeClient(administrator, 'cleanup administrator client');
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to clean up owned database ${name}`);
  }
}

/**
 * Creates a fresh database owned by this lifecycle. The supplied URL is used
 * only for administration; application setup and observation use independent
 * connections to the generated database.
 */
export async function createOwnedDatabase(databaseUrl: string): Promise<OwnedDatabase> {
  const parsedAdministratorUrl = parseAdministratorUrl(databaseUrl);
  const administratorUrl = parsedAdministratorUrl.toString();
  const name = generatedDatabaseName();
  const connectionString = ownedConnectionString(parsedAdministratorUrl, name);
  const administrator = postgresClient(administratorUrl);
  let databaseCreated = false;
  let db: Client | undefined;
  let observer: Client | undefined;

  try {
    await administrator.connect();
    await administrator.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    databaseCreated = true;
    await closeClient(administrator, 'creation administrator client');

    db = postgresClient(connectionString);
    await db.connect();
    observer = postgresClient(connectionString);
    await observer.connect();
    const connectedObserver = observer;

    const version = await db.query<{ server_version: string }>(
      "SELECT current_setting('server_version') AS server_version",
    );
    const serverVersion = version.rows[0]?.server_version;
    if (serverVersion === undefined) {
      throw new Error('PostgreSQL did not return its server version');
    }

    let closePromise: Promise<void> | undefined;
    return {
      name,
      connectionString,
      db,
      serverVersion,
      async observeWait(backendPid: number): Promise<WaitObservation | null> {
        if (!Number.isSafeInteger(backendPid) || backendPid <= 0) return null;

        const activity = await connectedObserver.query<{
          pid: number;
          blocker_pids: number[];
          wait_event: string | null;
          wait_event_type: string | null;
        }>(
          `SELECT pid,
                  pg_blocking_pids(pid) AS blocker_pids,
                  wait_event,
                  wait_event_type
             FROM pg_stat_activity
            WHERE pid = $1
              AND datname = current_database()
              AND backend_type = 'client backend'`,
          [backendPid],
        );
        const row = activity.rows[0];
        if (
          row === undefined ||
          row.wait_event_type !== 'Lock' ||
          row.wait_event === null ||
          row.blocker_pids.length === 0
        ) {
          return null;
        }

        return {
          pid: Number(row.pid),
          blockerPids: row.blocker_pids.map(Number),
          waitEvent: row.wait_event,
          waitEventType: row.wait_event_type,
        };
      },
      close(): Promise<void> {
        closePromise ??= cleanupGeneratedDatabase(administratorUrl, name, [db, observer]);
        return closePromise;
      },
    };
  } catch (error) {
    try {
      await closeClient(administrator, 'creation administrator client');
    } catch {
      // The cleanup connection below is the authoritative cleanup path.
    }

    if (databaseCreated) {
      try {
        await cleanupGeneratedDatabase(administratorUrl, name, [db, observer]);
      } catch (cleanupError) {
        throw new OwnedDatabaseCreationError(name, [error, cleanupError]);
      }
    }
    throw error;
  }
}
