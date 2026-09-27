import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ActorContext } from '@pavangupta352/interleave';
import { PrismaClient } from '../generated/prisma/client.ts';

export interface ClientOptions {
  /** Name every statement so node-postgres prepares it once per connection and reuses it. */
  preparedStatements?: boolean;
}

// node-postgres reuses a named statement only for identical SQL text, so the
// name is derived from that text.
const statementName = ({ sql }: { sql: string }) => `prisma_${createHash('sha256').update(sql).digest('hex').slice(0, 24)}`;

/**
 * Give one actor its own PrismaClient, backed by a node-postgres pool with a
 * single connection to the actor's Interleave endpoint. The client disconnects
 * when the operation settles, and as soon as Interleave interrupts the run.
 */
export async function withPrisma<T>(context: ActorContext, operation: (prisma: PrismaClient) => Promise<T>,
  options: ClientOptions = {}): Promise<T> {
  context.signal.throwIfAborted();
  const adapter = new PrismaPg(
    { connectionString: context.connectionString, max: 1, connectionTimeoutMillis: 5_000, application_name: 'interleave-prisma' },
    options.preparedStatements ? { statementNameGenerator: statementName } : undefined,
  );
  const prisma = new PrismaClient({ adapter });
  const disconnect = () => { void prisma.$disconnect().catch(() => undefined); };
  context.signal.addEventListener('abort', disconnect, { once: true });
  try {
    return await operation(prisma);
  } finally {
    context.signal.removeEventListener('abort', disconnect);
    await prisma.$disconnect();
  }
}
