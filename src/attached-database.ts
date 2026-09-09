import { Client } from 'pg';
import type { OwnedDatabase, WaitObservation } from './types.js';

/** Attach inside a worker. Only the supervising parent may drop this database. */
export async function attachOwnedDatabase(connectionString: string): Promise<OwnedDatabase> {
  const clients = [0, 1].map(() => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 30_000 });
    client.on('error', () => undefined);
    return client;
  });
  const db = clients[0]!;
  const observer = clients[1]!;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    const results = await Promise.allSettled(clients.map(client => client.end()));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length > 0) throw new Error('Worker database clients could not be closed');
  })();
  try {
    await db.connect();
    await observer.connect();
    const identity = await db.query<{ name: string; version: string }>(
      "SELECT current_database() AS name, current_setting('server_version') AS version",
    );
    const row = identity.rows[0];
    if (!row) throw new Error('PostgreSQL did not return its identity');
    return {
      name: row.name, connectionString, db, serverVersion: row.version, close,
      async observeWait(backendPid: number): Promise<WaitObservation | null> {
        if (!Number.isSafeInteger(backendPid) || backendPid <= 0) return null;
        const activity = await observer.query<{
          pid: number; blocker_pids: number[]; wait_event: string | null; wait_event_type: string | null;
        }>(
          `SELECT pid, pg_blocking_pids(pid) AS blocker_pids, wait_event, wait_event_type
             FROM pg_stat_activity
            WHERE pid = $1 AND datname = current_database() AND backend_type = 'client backend'`,
          [backendPid],
        );
        const waiting = activity.rows[0];
        if (!waiting || waiting.wait_event_type !== 'Lock' || !waiting.wait_event || !waiting.blocker_pids.length) return null;
        return { pid: Number(waiting.pid), blockerPids: waiting.blocker_pids.map(Number), waitEvent: waiting.wait_event, waitEventType: waiting.wait_event_type };
      },
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
