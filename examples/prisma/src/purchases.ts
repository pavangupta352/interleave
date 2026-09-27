import { Prisma, type PrismaClient } from '../generated/prisma/client.ts';

export interface PurchaseResult {
  status: 'ordered' | 'sold-out';
  attempts: number;
  /** Prisma error codes of transactions that rolled back and were retried. */
  retried: string[];
}

// Prisma's interactive-transaction defaults (2 s to start, 5 s to finish) could
// otherwise end a transaction while Interleave holds its next command.
const TRANSACTION = { maxWait: 10_000, timeout: 60_000 };
const ATTEMPTS = 3;

class StockChanged extends Error {
  constructor() { super('The stock changed after it was read'); }
}

/**
 * Unsafe. The transaction reads the stock, records the order and then writes the
 * remainder it computed. Under READ COMMITTED, two buyers can both read the last
 * unit; the second UPDATE waits for the first buyer's row lock and then
 * overwrites the stock with the same stale remainder.
 */
export async function readThenWrite(prisma: PrismaClient, productId: number, buyer: string): Promise<PurchaseResult> {
  return prisma.$transaction(async tx => {
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
    if (product.stock < 1) return { status: 'sold-out', attempts: 1, retried: [] };
    await tx.order.create({ data: { productId, buyer, quantity: 1 } });
    await tx.product.update({ where: { id: productId }, data: { stock: product.stock - 1 } });
    return { status: 'ordered', attempts: 1, retried: [] };
  }, TRANSACTION);
}

/**
 * Repair with optimistic concurrency. The stock is written only if it still has
 * the value that was read. Otherwise the transaction rolls back, including its
 * order, and the whole purchase restarts with a fresh read.
 */
export async function compareAndSet(prisma: PrismaClient, productId: number, buyer: string): Promise<PurchaseResult> {
  const retried: string[] = [];
  for (let attempts = 1; ; attempts++) {
    try {
      const status = await prisma.$transaction(async tx => {
        const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
        if (product.stock < 1) return 'sold-out' as const;
        await tx.order.create({ data: { productId, buyer, quantity: 1 } });
        const { count } = await tx.product.updateMany({
          where: { id: productId, stock: product.stock }, data: { stock: product.stock - 1 },
        });
        if (count === 0) throw new StockChanged();
        return 'ordered' as const;
      }, TRANSACTION);
      return { status, attempts, retried };
    } catch (error) {
      if (!(error instanceof StockChanged) || attempts === ATTEMPTS) throw error;
      retried.push('stock-changed');
    }
  }
}

/** Repair with one conditional UPDATE that decrements only while stock remains. */
export async function conditionalDecrement(prisma: PrismaClient, productId: number, buyer: string): Promise<PurchaseResult> {
  return prisma.$transaction(async tx => {
    const { count } = await tx.product.updateMany({
      where: { id: productId, stock: { gte: 1 } }, data: { stock: { decrement: 1 } },
    });
    if (count === 0) return { status: 'sold-out', attempts: 1, retried: [] };
    await tx.order.create({ data: { productId, buyer, quantity: 1 } });
    return { status: 'ordered', attempts: 1, retried: [] };
  }, TRANSACTION);
}

/**
 * The read-then-write transaction at SERIALIZABLE isolation. PostgreSQL rejects
 * one of two overlapping purchases (SQLSTATE 40001, Prisma P2034). With `retry`,
 * the purchase checks that the failed attempt's order rolled back and restarts
 * the whole transaction; without it, the error reaches the caller.
 */
export async function serializable(prisma: PrismaClient, productId: number, buyer: string, retry: boolean): Promise<PurchaseResult> {
  const retried: string[] = [];
  for (let attempts = 1; ; attempts++) {
    try {
      const status = await prisma.$transaction(async tx => {
        const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
        if (product.stock < 1) return 'sold-out' as const;
        await tx.order.create({ data: { productId, buyer, quantity: 1 } });
        await tx.product.update({ where: { id: productId }, data: { stock: product.stock - 1 } });
        return 'ordered' as const;
      }, { ...TRANSACTION, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return { status, attempts, retried };
    } catch (error) {
      if (!retry || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempts === ATTEMPTS) throw error;
      if (await prisma.order.count({ where: { productId, buyer } }) !== 0) throw new Error('The failed attempt left its order behind');
      retried.push(error.code);
    }
  }
}
