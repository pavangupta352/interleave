import { afterAll, describe, expect, test } from 'vitest';
import { createOwnedDatabase } from '../src/database.js';
import { captureFixtureIdentity } from '../src/fixture-identity.js';
import type { OwnedDatabase } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const adminUrl = testDatabaseUrl();
const profile = 'postgresql17-pgvector0.8.6-v1' as const;
const databases: OwnedDatabase[] = [];
async function database(sql = ''): Promise<OwnedDatabase> {
  const owned = await createOwnedDatabase(adminUrl);
  databases.push(owned);
  if (sql) await owned.db.query(sql);
  return owned;
}
async function vectorFixture(): Promise<OwnedDatabase> {
  return database(`CREATE EXTENSION vector;
    CREATE TABLE documents (
      id integer PRIMARY KEY,
      embedding vector(3), reduced halfvec(3), sparse sparsevec(3)
    );
    INSERT INTO documents VALUES
      (1, '[1,0,-0.25]', '[1,0,-0.25]', '{1:1,3:-0.25}/3'),
      (2, NULL, NULL, NULL)`);
}
const captureVector = (owned: OwnedDatabase, options: Parameters<typeof captureFixtureIdentity>[1] = {}) =>
  captureFixtureIdentity(owned.connectionString, { ...options, profile });

describe('PostgreSQL 17 pgvector 0.8.6 fixture identity', () => {
  afterAll(async () => { for (const owned of databases) await owned.close(); });

  test('keeps the native profile extension-free and selects pgvector only when explicit', async () => {
    const owned = await vectorFixture();
    await expect(captureFixtureIdentity(owned.connectionString)).rejects.toMatchObject({ code: 'unsupported' });
    const identity = await captureFixtureIdentity(owned.connectionString, { profile });
    expect(identity.profile).toBe(profile);
    expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.counts.objects).toBeGreaterThan(237);
    expect(identity.counts.rows).toBe(2);
  });

  test('is stable across fresh database names and allocation OIDs', async () => {
    const first = await vectorFixture();
    const churn = await database('CREATE TABLE oid_churn(value integer); DROP TABLE oid_churn');
    await churn.close();
    const second = await vectorFixture();
    const a = await captureVector(first); const b = await captureVector(second);
    expect(first.name).not.toBe(second.name);
    expect(a).toEqual(b);
  });

  test('captures vector values, nullness, duplicate multiplicity and dimensions', async () => {
    const owned = await vectorFixture();
    const initial = await captureVector(owned);
    await owned.db.query("UPDATE documents SET embedding='[0,1,-0.25]' WHERE id=1");
    const changed = await captureVector(owned);
    expect(changed.components.data).not.toBe(initial.components.data);
    expect(changed.components.schema).toBe(initial.components.schema);
    await owned.db.query('INSERT INTO documents SELECT 3,embedding,reduced,sparse FROM documents WHERE id=1');
    const duplicate = await captureVector(owned);
    expect(duplicate.components.data).not.toBe(changed.components.data);
    expect(duplicate.counts.rows).toBe(changed.counts.rows + 1);
    await owned.db.query('UPDATE documents SET embedding=NULL WHERE id=1');
    const nulled = await captureVector(owned);
    expect(nulled.components.data).not.toBe(duplicate.components.data);
    await owned.db.query(`ALTER TABLE documents ALTER COLUMN embedding TYPE vector(4)
      USING CASE WHEN embedding IS NULL THEN NULL ELSE (embedding::real[] || ARRAY[0::real])::vector(4) END`);
    const resized = await captureVector(owned);
    expect(resized.components.schema).not.toBe(nulled.components.schema);
  });

  test('captures effective pgvector settings and HNSW operator class and reloptions', async () => {
    const owned = await vectorFixture();
    const baseline = await captureVector(owned);
    const configured = new URL(owned.connectionString);
    configured.searchParams.set('options', '-c hnsw.ef_search=80');
    const settingChanged = await captureFixtureIdentity(configured.toString(), { profile });
    expect(settingChanged.components.settings).not.toBe(baseline.components.settings);
    expect(settingChanged.components.schema).toBe(baseline.components.schema);

    await owned.db.query('CREATE INDEX documents_embedding_hnsw ON documents USING hnsw (embedding vector_cosine_ops) WITH (m=8,ef_construction=32)');
    const indexed = await captureVector(owned);
    expect(indexed.components.schema).not.toBe(baseline.components.schema);
    await owned.db.query('ALTER INDEX documents_embedding_hnsw SET (m=12)');
    const reloptionsChanged = await captureVector(owned);
    expect(reloptionsChanged.components.schema).not.toBe(indexed.components.schema);
    await owned.db.query('DROP INDEX documents_embedding_hnsw; CREATE INDEX documents_embedding_hnsw ON documents USING hnsw (embedding vector_l2_ops) WITH (m=12,ef_construction=32)');
    const operatorClassChanged = await captureVector(owned);
    expect(operatorClassChanged.components.schema).not.toBe(reloptionsChanged.components.schema);
  });

  test('rejects a removed member, changed member ACL, extra extension and unowned custom operator', async () => {
    const removed = await vectorFixture();
    await removed.db.query('ALTER EXTENSION vector DROP FUNCTION vector_dims(vector)');
    await expect(captureVector(removed)).rejects.toMatchObject({ code: 'unsupported' });

    const acl = await vectorFixture();
    await acl.db.query('REVOKE EXECUTE ON FUNCTION vector_dims(vector) FROM PUBLIC');
    await expect(captureVector(acl)).rejects.toMatchObject({ code: 'unsupported' });

    const extra = await vectorFixture();
    await extra.db.query('CREATE EXTENSION hstore');
    await expect(captureVector(extra)).rejects.toMatchObject({ code: 'unsupported' });

    const lookalike = await vectorFixture();
    await lookalike.db.query(`CREATE FUNCTION vector_distance(integer,integer) RETURNS integer
      LANGUAGE sql IMMUTABLE AS $$ SELECT abs($1-$2) $$;
      CREATE OPERATOR <~> (LEFTARG=integer,RIGHTARG=integer,FUNCTION=vector_distance)`);
    await expect(captureVector(lookalike)).rejects.toMatchObject({ code: 'unsupported' });

    const wrongVersion = await vectorFixture();
    await wrongVersion.db.query("UPDATE pg_catalog.pg_extension SET extversion='0.8.5' WHERE extname='vector'");
    await expect(captureVector(wrongVersion)).rejects.toMatchObject({ code: 'unsupported' });
  });

  test('uses stable canonical text for vector, halfvec, sparsevec and bounded arrays', async () => {
    const owned = await vectorFixture();
    const values = await owned.db.query(`SELECT
      '[1.23456789,-0,0.00000001]'::vector::text AS vector,
      '[1.23456789,-0,0.00000001]'::halfvec::text AS halfvec,
      '{1:1.23456789,3:-0.25}/3'::sparsevec::text AS sparsevec,
      array_fill('[1,-0.25]'::vector,ARRAY[2],ARRAY[0]) AS bounded`);
    const row = values.rows[0]!;
    expect(row.vector).toContain(',-0,');
    expect(row.halfvec).toContain(',-0,');
    expect((await owned.db.query('SELECT $1::vector::text AS value',[row.vector])).rows[0]!.value).toBe(row.vector);
    expect((await owned.db.query('SELECT $1::halfvec::text AS value',[row.halfvec])).rows[0]!.value).toBe(row.halfvec);
    expect((await owned.db.query('SELECT $1::sparsevec::text AS value',[row.sparsevec])).rows[0]!.value).toBe(row.sparsevec);
    expect((await owned.db.query('SELECT array_lower($1::vector[],1) AS lower,array_upper($1::vector[],1) AS upper',[row.bounded])).rows)
      .toEqual([{ lower: 0, upper: 1 }]);
    const maximum = await owned.db.query(`SELECT
      array_fill(0::real,ARRAY[16000])::vector AS vector,
      array_fill(0::real,ARRAY[16000])::halfvec AS halfvec,
      '{1000000000:1}/1000000000'::sparsevec::text AS sparsevec`);
    expect((await owned.db.query('SELECT vector_dims($1::vector) AS dimensions',[maximum.rows[0]!.vector])).rows)
      .toEqual([{ dimensions: 16000 }]);
    expect((await owned.db.query('SELECT vector_dims($1::halfvec) AS dimensions',[maximum.rows[0]!.halfvec])).rows)
      .toEqual([{ dimensions: 16000 }]);
    expect((await owned.db.query('SELECT $1::sparsevec::text AS value',[maximum.rows[0]!.sparsevec])).rows[0]!.value)
      .toBe(maximum.rows[0]!.sparsevec);
    await owned.db.query('CREATE TABLE maximum_vector(value vector(16000))');
    await owned.db.query('INSERT INTO maximum_vector VALUES ($1)', [maximum.rows[0]!.vector]);
    expect((await captureVector(owned)).counts.rows).toBe(3);
    for (const invalid of ['NaN', 'Infinity', '-Infinity']) {
      await expect(owned.db.query('SELECT $1::vector', [`[${invalid}]`])).rejects.toMatchObject({ code: '22000' });
    }
  });

  test('retains object, row, canonical-byte, deadline, cancellation and quiescence bounds', async () => {
    const owned = await vectorFixture();
    for (const options of [{ maxObjects: 200 }, { maxRows: 1 }, { maxBytes: 16_000 }]) {
      await expect(captureVector(owned, options)).rejects.toMatchObject({ code: 'budget-exceeded' });
    }
    await expect(captureVector(owned, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'budget-exceeded' });
    const controller = new AbortController(); controller.abort();
    await expect(captureVector(owned, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    await owned.db.query('BEGIN');
    try { await expect(captureVector(owned)).rejects.toMatchObject({ code: 'not-quiescent' }); }
    finally { await owned.db.query('ROLLBACK'); }
  });
});
