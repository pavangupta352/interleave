import { Prisma, type PrismaClient } from '../generated/prisma/client.ts';

export interface OrderLifecycleResult {
  code: string;
  afterRollback: number;
  created: number;
  updated: number;
  read: number;
  deleted: number;
}

/**
 * A transaction records an order and then a duplicate for the same buyer. The
 * unique index rejects the duplicate (SQLSTATE 23505, Prisma P2002), so the
 * whole transaction rolls back. The same client then creates, updates, reads and
 * deletes an order.
 */
export async function orderLifecycle(prisma: PrismaClient, productId: number, buyer: string): Promise<OrderLifecycleResult> {
  let code: string | undefined;
  try {
    await prisma.$transaction(async tx => {
      await tx.order.create({ data: { productId, buyer, quantity: 1 } });
      await tx.order.create({ data: { productId, buyer, quantity: 2 } });
    }, { maxWait: 10_000, timeout: 60_000 });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    code = error.code;
  }
  if (code === undefined) throw new Error('The duplicate order was accepted');
  const afterRollback = await prisma.order.count({ where: { productId, buyer } });
  const created = await prisma.order.create({ data: { productId, buyer, quantity: 1 } });
  const updated = await prisma.order.update({ where: { id: created.id }, data: { quantity: 2 } });
  const read = await prisma.order.findUniqueOrThrow({ where: { productId_buyer: { productId, buyer } } });
  const deleted = await prisma.order.delete({ where: { id: read.id } });
  return { code, afterRollback, created: created.quantity, updated: updated.quantity, read: read.quantity, deleted: deleted.quantity };
}
