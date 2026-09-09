import assert from 'node:assert/strict';
import { Client, escapeIdentifier } from 'pg';
import { expect, test, vi } from 'vitest';
import { runOnce } from '../src/runner.js';
import { minimize, MinimizationVerificationError } from '../src/minimize.js';
import { minimizationExitCode } from '../src/cli/status.js';
import type { Scenario } from '../src/types.js';
import { testDatabaseUrl } from './helpers/postgres.js';

const databaseUrl=testDatabaseUrl();
function scenario(kind: 'actor' | 'harness' | 'cleanup', onSetup?: (name: string) => void): Scenario {
  return {
    name:`minimize-${kind}-failure`,
    async setup({ db }) {
      const name=(await db.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name;
      onSetup?.(name);
      await db.query('CREATE TABLE flag(seen boolean NOT NULL); INSERT INTO flag VALUES(false)');
    },
    actors: {
      async alice({ connectionString }) {
        const client=new Client({ connectionString }); await client.connect();
        try {
          const seen=(await client.query<{ seen: boolean }>('SELECT seen FROM flag')).rows[0]!.seen;
          if (seen && kind==='actor') throw new Error('application cannot process observed flag');
          if (seen && kind==='harness') return (()=>1) as never;
        } finally { await client.end(); }
      },
      async bob({ connectionString }) {
        const client=new Client({ connectionString }); await client.connect();
        try { await client.query('UPDATE flag SET seen=true'); } finally { await client.end(); }
      },
    },
    async invariant() { assert.fail('target invariant'); },
  };
}

test.each(['actor','harness'] as const)('minimization preserves a hard %s failure separately from its last reproduced violation',async kind=>{
  const input=scenario(kind);
  const original=await runOnce(input,{databaseUrl,plan:['alice','bob']});
  expect(original.outcome).toBe('violation');
  const reduced=await minimize(input,original,{databaseUrl,maxAttempts:8});
  expect(reduced.run.outcome).toBe('violation');
  expect(reduced.run.failure?.fingerprint).toBe(original.failure?.fingerprint);
  expect(reduced.attemptFailure).toMatchObject({outcome:kind==='actor'?'actor-error':'harness-error',cleanup:{complete:true}});
  expect(reduced.attempts).toBe(2); expect(reduced.locallyMinimal).toBe(false);
  expect(minimizationExitCode(reduced)).toBe(2);
});

test.each(['verification','reduction'] as const)('minimization keeps the exact database recovery identity when %s cleanup fails',async phase=>{
  const created: string[]=[];
  let blocked: string | undefined;
  const input=scenario('cleanup',name=>{
    expect(name).toMatch(/^interleave_[a-f0-9]{32}$/); created.push(name);
    if(created.length===(phase==='verification'?2:3)) blocked=name;
  });
  const originalQuery=Client.prototype.query;
  const original=await runOnce(input,{databaseUrl,plan:['alice','bob']});
  expect(original.outcome).toBe('violation');
  const hook=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]):any {
    if(blocked && args[0]===`DROP DATABASE IF EXISTS ${escapeIdentifier(blocked)} WITH (FORCE)`) {
      return Promise.reject(new Error(`Injected failure dropping owned database ${blocked}`));
    }
    return (originalQuery as Function).apply(this,args);
  });
  try {
    if(phase==='verification') {
      let error: unknown;
      try {await minimize(input,original,{databaseUrl,maxAttempts:8});} catch(caught){error=caught;}
      expect(error).toBeInstanceOf(MinimizationVerificationError);
      expect((error as MinimizationVerificationError).attemptFailure).toMatchObject({outcome:'harness-error',cleanup:{complete:false}});
      expect((error as Error).message).toContain(blocked);
    } else {
      const reduced=await minimize(input,original,{databaseUrl,maxAttempts:8});
      expect(reduced.run.cleanup.complete).toBe(true);
      expect(reduced.attemptFailure).toMatchObject({outcome:'harness-error',cleanup:{complete:false}});
      expect(reduced.attemptFailure?.cleanup.error).toContain(blocked);
      expect(minimizationExitCode(reduced)).toBe(2);
    }
    const admin=new Client({connectionString:databaseUrl});await admin.connect();
    try {expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[blocked])).rowCount).toBe(1);}
    finally {await admin.end();}
  } finally {
    hook.mockRestore();
    const admin=new Client({connectionString:databaseUrl});await admin.connect();
    try {for(const name of created)await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);}
    finally {await admin.end();}
  }
});
