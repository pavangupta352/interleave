import type { PrismaClient } from '../generated/prisma/client.ts';
import { readThenWrite, type PurchaseResult } from './purchases.ts';

/** The checkout operation under test, as first written. See the README for its repair. */
export function checkout(prisma: PrismaClient, productId: number, buyer: string): Promise<PurchaseResult> {
  return readThenWrite(prisma, productId, buyer);
}
