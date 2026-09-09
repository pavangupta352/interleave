import assert from 'node:assert/strict';
import { Kysely, PostgresDialect } from 'kysely';
import type { ActorContext } from '../../src/types.js';
import { withActorPool } from './connection.js';
import { postgresErrorCode } from './errors.js';

interface Database {
  counter: { id: number; value: number };
  entries: { id: number; value: number };
  attempts: { actor: string; commits: number };
}

export async function lostUpdate(context: ActorContext): Promise<{ read: number; written: number }> {
  return withActorPool(context, pool => {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return { close: () => db.destroy(), async run() {
      const before = await db.selectFrom('counter').select('value').where('id', '=', 1).executeTakeFirstOrThrow();
      const after = await db.updateTable('counter').set({ value: before.value + 1 }).where('id', '=', 1).returning('value').executeTakeFirstOrThrow();
      return { read: before.value, written: after.value };
    } };
  });
}

export async function atomic(context: ActorContext): Promise<{ written: number }> {
  return withActorPool(context, pool => {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return { close: () => db.destroy(), async run() {
      const after = await db.updateTable('counter').set(eb => ({ value: eb('value', '+', 1) })).where('id', '=', 1).returning('value').executeTakeFirstOrThrow();
      return { written: after.value };
    } };
  });
}

export async function crudRollback(context: ActorContext) {
  return withActorPool(context, pool => {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const id = context.actor === 'alice' ? 1 : 2;
    return { close: () => db.destroy(), async run() {
      const committed = await db.transaction().execute(async tx => {
        const inserted = await tx.insertInto('entries').values({ id, value: 1 }).returning('value').executeTakeFirstOrThrow();
        const updated = await tx.updateTable('entries').set({ value: 2 }).where('id', '=', id).returning('value').executeTakeFirstOrThrow();
        return { inserted: inserted.value, updated: updated.value };
      });
      let code: string | undefined;
      try {
        await db.transaction().execute(async tx => {
          await tx.insertInto('entries').values({ id: id + 10, value: 99 }).execute();
          await tx.insertInto('entries').values({ id, value: 100 }).execute();
        });
      } catch (error) {
        code = postgresErrorCode(error);
        if (code !== '23505') throw error;
      }
      assert.equal(code, '23505');
      const after = await db.selectFrom('entries').select('value').where('id', '=', id).executeTakeFirstOrThrow();
      const rolledBack = await db.selectFrom('entries').selectAll().where('id', '=', id + 10).execute();
      const deleted = await db.deleteFrom('entries').where('id', '=', id).returning('value').executeTakeFirstOrThrow();
      return { ...committed, committed: after.value, code, rolledBack: rolledBack.length === 0, deleted: deleted.value };
    } };
  });
}

export async function serializable(context: ActorContext, retry: boolean) {
  return withActorPool(context, pool => {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return { close: () => db.destroy(), async run() {
      const reads: number[] = [], errors: string[] = [];
      let rollbackVerified = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await db.transaction().setIsolationLevel('serializable').execute(async tx => {
            await tx.insertInto('attempts').values({ actor: context.actor, commits: 1 }).execute();
            const before = await tx.selectFrom('counter').select('value').where('id', '=', 1).executeTakeFirstOrThrow();
            reads.push(before.value);
            await tx.updateTable('counter').set({ value: before.value + 1 }).where('id', '=', 1).execute();
          });
          return { attempts: attempt, reads, errors, rollbackVerified };
        } catch (error) {
          const code = postgresErrorCode(error);
          if (code !== '40001') throw error;
          errors.push(code);
          const pending = await db.selectFrom('attempts').selectAll().where('actor', '=', context.actor).execute();
          assert.deepEqual(pending, [], 'The failed transaction must roll back its earlier INSERT');
          rollbackVerified = true;
          if (!retry || attempt === 2) throw error;
        }
      }
      throw new Error('Whole-transaction retry exhausted');
    } };
  });
}
