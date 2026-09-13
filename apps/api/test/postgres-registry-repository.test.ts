import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  verifiedProviderFixture,
  VerifiedVerificationRecordSchema,
  fixtureReferenceTime,
} from '@proofserve/shared';
import { PostgresRegistryRepository } from '../src/postgres-registry-repository.js';

function harness(conflict = false, failUpdate = false, updateCount: 0 | 1 = 1) {
  const provider = structuredClone(verifiedProviderFixture);
  const verification = VerifiedVerificationRecordSchema.parse(
    provider.verification,
  );
  provider.verification = {
    providerId: provider.id,
    method: 'WORLD_SELFIE_CHECK',
    status: 'UNVERIFIED',
    verifiedAt: null,
    expiresAt: null,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT snapshot'))
      return { rows: [{ snapshot: provider }], rowCount: 1 };
    if (sql.startsWith('INSERT'))
      return { rows: [], rowCount: conflict ? 0 : 1 };
    if (sql.startsWith('UPDATE') && failUpdate)
      throw new Error('test write failure');
    if (sql.startsWith('UPDATE')) return { rows: [], rowCount: updateCount };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  return {
    repository: new PostgresRegistryRepository(pool),
    query,
    release,
    provider,
    verification,
  };
}

it('commits the verification and unique replay claim in one locked transaction', async () => {
  const h = harness();
  expect(
    await h.repository.commitWorldVerification(
      h.provider.id,
      '123',
      h.verification,
      fixtureReferenceTime,
    ),
  ).toBe('VERIFIED');
  expect(h.query.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN',
    'SELECT snapshot FROM registry_providers WHERE id = $1 FOR UPDATE',
    'SELECT nullifier FROM registry_world_replays WHERE nullifier = $1',
    'INSERT INTO registry_world_replays (nullifier) VALUES ($1) ON CONFLICT DO NOTHING RETURNING nullifier',
    'UPDATE registry_providers SET snapshot = $2 WHERE id = $1',
    'COMMIT',
  ]);
  expect(h.release).toHaveBeenCalledOnce();
});

it('ships an idempotent caller-transaction migration with strict identity constraints', () => {
  const sql = readFileSync(
    new URL('../migrations/002_registry.sql', import.meta.url),
    'utf8',
  );
  expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
  expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(3);
  expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING/);
  expect(sql).toMatch(/jsonb_typeof\(snapshot\) = 'object'/);
  expect(sql).toMatch(/snapshot \? 'id'/);
  expect(sql).toMatch(/snapshot \? 'providerId'/);
  expect(sql).toMatch(/jsonb_typeof\(snapshot->'id'\) = 'string'/);
  expect(sql).toMatch(/jsonb_typeof\(snapshot->'providerId'\) = 'string'/);
  expect(sql).toContain(
    'pg_get_constraintdef(c.oid, false) = expected.definition',
  );
  expect(sql).toContain('c.convalidated');
  expect(sql).toContain("tc.enforced = 'YES'");
  expect(sql).toContain("t.tgenabled = 'O'");
  expect(sql).toContain("c.confupdtype = 'a'");
  expect(sql).toContain("c.confdeltype = 'r'");
  expect(sql).toContain('Incompatible ProofServe registry schema');
});

it.each([true, false])(
  'requires the complete compatible registry schema: %s',
  async (ready) => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ ready }], rowCount: 1 })),
    } as unknown as Pool;
    const repository = new PostgresRegistryRepository(pool);
    if (ready) await expect(repository.assertReady()).resolves.toBeUndefined();
    else
      await expect(repository.assertReady()).rejects.toThrow(
        'Registry migration required',
      );
  },
);

it('checks runtime write privileges without mutating registry data', async () => {
  let readinessSql = '';
  const query = vi.fn(async (sql: string) => {
    readinessSql = sql;
    return { rows: [{ ready: true }], rowCount: 1 };
  });
  const repository = new PostgresRegistryRepository({
    query,
  } as unknown as Pool);
  await repository.assertReady();
  expect(readinessSql).toContain('has_schema_privilege');
  expect(readinessSql).toContain('has_table_privilege');
  expect(readinessSql).not.toContain("'SELECT,INSERT");
  expect(readinessSql.match(/'SELECT'/g)).toHaveLength(4);
  expect(readinessSql.match(/'INSERT'/g)).toHaveLength(3);
  expect(readinessSql.match(/'UPDATE'/g)).toHaveLength(2);
});

it('does not update verification when another transaction wins the replay claim', async () => {
  const h = harness(true);
  expect(
    await h.repository.commitWorldVerification(
      h.provider.id,
      '123',
      h.verification,
      fixtureReferenceTime,
    ),
  ).toBe('WORLD_PROOF_REPLAYED');
  expect(h.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(
    false,
  );
  expect(h.query).toHaveBeenLastCalledWith('ROLLBACK');
});

it('rolls back the replay claim if the provider write fails', async () => {
  const h = harness(false, true);
  await expect(
    h.repository.commitWorldVerification(
      h.provider.id,
      '123',
      h.verification,
      fixtureReferenceTime,
    ),
  ).rejects.toThrow('Registry verification persistence failed');
  expect(h.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(h.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  expect(h.release).toHaveBeenCalledOnce();
});

it('rolls back the replay claim unless exactly one provider row is updated', async () => {
  const h = harness(false, false, 0);
  await expect(
    h.repository.commitWorldVerification(
      h.provider.id,
      '123',
      h.verification,
      fixtureReferenceTime,
    ),
  ).rejects.toThrow('Registry verification persistence failed');
  expect(h.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(h.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
});

it('handles idle pool errors without an unhandled throw or diagnostic output', async () => {
  vi.resetModules();
  const pools: TestPool[] = [];
  class TestPool extends EventEmitter {
    readonly end = vi.fn(async () => undefined);

    constructor() {
      super();
      pools.push(this);
    }
  }
  vi.doMock('pg', () => ({ Pool: TestPool }));
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const { createPostgresRegistryRepository } =
      await import('../src/postgres-registry-repository.js');
    const repository = createPostgresRegistryRepository(
      'postgresql://user:password@127.0.0.1:5432/test',
    );
    const pool = pools[0];
    expect(pool).toBeDefined();
    if (!pool) throw new Error('Expected registry pool');
    expect(pool.listenerCount('error')).toBe(1);
    const diagnostic =
      'postgresql://secret-user:secret-password@secret-host/private SELECT secret';
    expect(() => pool.emit('error', new Error(diagnostic))).not.toThrow();
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    await repository.close();
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
    vi.doUnmock('pg');
    vi.resetModules();
  }
});
