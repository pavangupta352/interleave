import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { ActorContext } from '../../src/types.js';
import { withActorPool } from './connection.js';
import { postgresErrorCode } from './errors.js';

const counter = pgTable('counter', { id: integer('id').primaryKey(), value: integer('value').notNull() });
const entries = pgTable('entries', { id: integer('id').primaryKey(), value: integer('value').notNull() });
const attempts = pgTable('attempts', { actor: text('actor').primaryKey(), commits: integer('commits').notNull() });

export async function lostUpdate(context: ActorContext): Promise<{ read: number; written: number }> {
  return withActorPool(context, pool => {
    const db = drizzle(pool);
    return { async run() {
      const [before] = await db.select({ value: counter.value }).from(counter).where(eq(counter.id, 1));
      assert.ok(before);
      const [after] = await db.update(counter).set({ value: before.value + 1 }).where(eq(counter.id, 1)).returning({ value: counter.value });
      assert.ok(after);
      return { read: before.value, written: after.value };
    } };
  });
}

export async function atomic(context: ActorContext): Promise<{ written: number }> {
  return withActorPool(context, pool => {
    const db = drizzle(pool);
    return { async run() {
      const [after] = await db.update(counter).set({ value: sql`${counter.value} + 1` }).where(eq(counter.id, 1)).returning({ value: counter.value });
      assert.ok(after);
      return { written: after.value };
    } };
  });
}

export async function crudRollback(context: ActorContext) {
  return withActorPool(context, pool => {
    const db = drizzle(pool);
    const id = context.actor === 'alice' ? 1 : 2;
    return { async run() {
      const committed = await db.transaction(async tx => {
        const [inserted] = await tx.insert(entries).values({ id, value: 1 }).returning({ value: entries.value });
        const [updated] = await tx.update(entries).set({ value: 2 }).where(eq(entries.id, id)).returning({ value: entries.value });
        assert.ok(inserted); assert.ok(updated);
        return { inserted: inserted.value, updated: updated.value };
      });
      let code: string | undefined;
      try {
        await db.transaction(async tx => {
          await tx.insert(entries).values({ id: id + 10, value: 99 });
          await tx.insert(entries).values({ id, value: 100 });
        });
      } catch (error) {
        code = postgresErrorCode(error);
        if (code !== '23505') throw error;
      }
      assert.equal(code, '23505');
      const [after] = await db.select({ value: entries.value }).from(entries).where(eq(entries.id, id));
      assert.ok(after);
      const rolledBack = await db.select().from(entries).where(eq(entries.id, id + 10));
      const [deleted] = await db.delete(entries).where(eq(entries.id, id)).returning({ value: entries.value });
      assert.ok(deleted);
      return { ...committed, committed: after.value, code, rolledBack: rolledBack.length === 0, deleted: deleted.value };
    } };
  });
}

export async function serializable(context: ActorContext, retry: boolean) {
  return withActorPool(context, pool => {
    const db = drizzle(pool);
    return { async run() {
      const reads: number[] = [], errors: string[] = [];
      let rollbackVerified = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await db.transaction(async tx => {
            await tx.insert(attempts).values({ actor: context.actor, commits: 1 });
            const [before] = await tx.select({ value: counter.value }).from(counter).where(eq(counter.id, 1));
            assert.ok(before); reads.push(before.value);
            await tx.update(counter).set({ value: before.value + 1 }).where(eq(counter.id, 1));
          }, { isolationLevel: 'serializable' });
          return { attempts: attempt, reads, errors, rollbackVerified };
        } catch (error) {
          const code = postgresErrorCode(error);
          if (code !== '40001') throw error;
          errors.push(code);
          const pending = await db.select().from(attempts).where(eq(attempts.actor, context.actor));
          assert.deepEqual(pending, [], 'The failed transaction must roll back its earlier INSERT');
          rollbackVerified = true;
          if (!retry || attempt === 2) throw error;
        }
      }
      throw new Error('Whole-transaction retry exhausted');
    } };
  });
}
