import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  AgentRunSchema,
  agentTaskFixture,
  fixtureReferenceTime,
  type AgentRun,
} from '@proofserve/shared';
import { transitionAgentRun } from '@proofserve/agent';
import {
  PostgresAgentRunRepository,
  validatePostgresConnectionString,
} from '../src/postgres-agent-run-repository.js';

const configuredUrl = process.env.Y05_POSTGRES_TEST_URL;
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const migration = readFileSync(
  new URL('../migrations/001_agent_runs.sql', import.meta.url),
  'utf8',
);

function newRun(id: string): AgentRun {
  return AgentRunSchema.parse({
    id,
    task: agentTaskFixture,
    status: 'CREATED',
    selectedServiceId: null,
    paymentRequirements: null,
    paymentReceipt: null,
    result: null,
    error: null,
    events: [{ status: 'CREATED', occurredAt: fixtureReferenceTime }],
    createdAt: fixtureReferenceTime,
    updatedAt: fixtureReferenceTime,
  });
}

function payingRun(run: AgentRun): AgentRun {
  let snapshot = transitionAgentRun(run, {
    status: 'DISCOVERING',
    occurredAt: fixtureReferenceTime,
  });
  snapshot = transitionAgentRun(snapshot, {
    status: 'SELECTED',
    selectedServiceId: 'service_example_active',
    occurredAt: fixtureReferenceTime,
  });
  snapshot = transitionAgentRun(snapshot, {
    status: 'PAYMENT_REQUIRED',
    paymentRequirements: {
      network: 'hedera:testnet',
      asset: '0.0.0',
      amountAtomic: '1000000',
      payTo: '0.0.123456',
    },
    occurredAt: fixtureReferenceTime,
  });
  return transitionAgentRun(snapshot, {
    status: 'PAYING',
    occurredAt: fixtureReferenceTime,
  });
}

describe.skipIf(!configuredUrl)('PostgreSQL agent run integration', () => {
  let administration: Pool;
  let pool: Pool;
  let repository: PostgresAgentRunRepository;
  let schema: string;
  let scopedConnectionString: string;

  beforeAll(async () => {
    if (!configuredUrl)
      throw new Error('Missing opt-in PostgreSQL integration configuration.');
    const parsed = new URL(configuredUrl);
    if (!localHosts.has(parsed.hostname))
      throw new Error(
        'Y05 integration tests accept only a loopback PostgreSQL URL.',
      );
    const configuration = validatePostgresConnectionString(configuredUrl);
    administration = new Pool({ ...configuration, max: 2 });
    schema = `y05_test_${randomUUID().replaceAll('-', '')}`;
    await administration.query(`CREATE SCHEMA ${schema}`);

    const scoped = new URL(configuration.connectionString);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    scoped.searchParams.set('application_name', 'proofserve-y05-integration');
    const scopedConfiguration = validatePostgresConnectionString(
      scoped.toString(),
    );
    scopedConnectionString = scopedConfiguration.connectionString;
    pool = new Pool({ ...scopedConfiguration, max: 8 });
    repository = new PostgresAgentRunRepository(pool);
    await pool.query(migration);
    await pool.query(migration);
    await repository.assertReady();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      await administration.end();
    }
  });

  it('applies the versioned migration idempotently', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM proofserve_schema_migrations
        WHERE version = '001_agent_runs'`,
    );
    expect(result.rows[0]?.count).toBe('1');
  });

  it('enforces uniqueness and rolls back invalid guarded updates', async () => {
    const run = newRun('run_integration_unique');
    await repository.createRun(run);
    await expect(repository.createRun(run)).rejects.toThrow(
      'Agent run persistence failed.',
    );
    const claim = await repository.claimExecution(run.id, 'owner_unique');
    if (!claim) throw new Error('Expected integration claim');
    const invalid = structuredClone(run);
    invalid.status = 'PAYING';
    await expect(claim.persist(invalid)).rejects.toThrow(
      'Agent run persistence failed.',
    );
    expect(await repository.getRun(run.id)).toEqual(run);
    await claim.release();
  });

  it('grants exactly one concurrent execution owner', async () => {
    const run = newRun('run_integration_concurrent');
    await repository.createRun(run);
    const claims = await Promise.all([
      repository.claimExecution(run.id, 'owner_concurrent_one'),
      repository.claimExecution(run.id, 'owner_concurrent_two'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await claims[0]?.release();
    await claims[1]?.release();
  });

  it('uses a row lock for ownership without advisory locks', async () => {
    const run = newRun('run_integration_row_lock');
    await repository.createRun(run);
    const blocker: PoolClient = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE', [
      run.id,
    ]);
    let settled = false;
    const pending = repository
      .claimExecution(run.id, 'owner_row_lock')
      .then((claim) => {
        settled = true;
        return claim;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    await blocker.query('ROLLBACK');
    blocker.release();
    const claim = await pending;
    await claim?.release();
    const locks = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.application_name = 'proofserve-y05-integration'
          AND l.locktype = 'advisory'`,
    );
    expect(locks.rows[0]?.count).toBe('0');
  });

  it('reclaims an expired durable claim after its pool is lost', async () => {
    const lostPool = new Pool({
      ...validatePostgresConnectionString(scopedConnectionString),
      max: 1,
    });
    const lostRepository = new PostgresAgentRunRepository(lostPool);
    const run = newRun('run_integration_connection_loss');
    await lostRepository.createRun(run);
    const lostClaim = await lostRepository.claimExecution(
      run.id,
      'owner_disconnected',
    );
    expect(lostClaim).toBeDefined();
    await lostRepository.close();
    await pool.query(
      `UPDATE agent_runs
          SET execution_claim_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [run.id],
    );
    const reclaimed = await repository.claimExecution(
      run.id,
      'owner_restarted',
    );
    expect(reclaimed?.snapshot).toEqual(run);
    await reclaimed?.release();
  });

  it('includes and safely terminalizes an abandoned payment tombstone', async () => {
    const run = newRun('run_integration_tombstone');
    await repository.createRun(run);
    const claim = await repository.claimExecution(run.id, 'owner_payment');
    if (!claim) throw new Error('Expected integration claim');
    await claim.persist(payingRun(run));
    await claim.beginSigning({
      payer: '0.0.7162784',
      receiver: '0.0.123456',
      amountAtomic: '1000000',
      asset: '0.0.0',
      network: 'hedera:testnet',
    });
    await claim.recordPaymentAttempt({
      payer: '0.0.7162784',
      receiver: '0.0.123456',
      amountAtomic: '1000000',
      asset: '0.0.0',
      network: 'hedera:testnet',
      transactionId: '0.0.7162784@1788940800.123456789',
      transactionValidUntil: '2099-09-06T10:00:00.000Z',
    });
    await claim.release();
    expect(await repository.listReconciliationRunIds()).toContain(run.id);
    expect(
      await repository.reconcileTombstonedRun(run.id, fixtureReferenceTime),
    ).toBe(false);
    const pending = await repository.getRun(run.id);
    expect(pending?.status).toBe('PAYING');
    const tombstone = await pool.query<{ payment_identifier: string }>(
      `SELECT payment_identifier
         FROM agent_run_payment_tombstones
        WHERE run_id = $1`,
      [run.id],
    );
    expect(tombstone.rows[0]?.payment_identifier).toBe(
      '0.0.7162784@1788940800.123456789',
    );
  });

  it('rejects generic tombstoned failure and permits only expired authoritative absence', async () => {
    const run = newRun('run_integration_failure_guard');
    await repository.createRun(run);
    const claim = await repository.claimExecution(run.id, 'owner_guard');
    if (!claim) throw new Error('Expected integration claim');
    const paying = payingRun(run);
    await claim.persist(paying);
    const expectation = {
      payer: '0.0.7162784',
      receiver: '0.0.123456',
      amountAtomic: '1000000',
      asset: '0.0.0',
      network: 'hedera:testnet',
    };
    const transactionId = '0.0.7162784@1788940800.123456789';
    await claim.beginSigning(expectation);
    await claim.recordPaymentAttempt({
      ...expectation,
      transactionId,
      transactionValidUntil: '2099-09-06T10:00:00.000Z',
    });
    await claim.authorizeSubmission(transactionId);
    const genericFailure = transitionAgentRun(paying, {
      status: 'FAILED',
      error: {
        code: 'PAYMENT_FAILED',
        message: 'Payment could not be confirmed. Do not automatically retry.',
      },
      occurredAt: fixtureReferenceTime,
    });
    await expect(claim.persist(genericFailure)).rejects.toThrow(
      'Agent run persistence failed.',
    );
    expect((await repository.getRun(run.id))?.status).toBe('PAYING');
    await claim.release();

    await pool.query(
      `UPDATE agent_run_payment_tombstones
          SET transaction_valid_until = clock_timestamp() - interval '31 seconds'
        WHERE run_id = $1`,
      [run.id],
    );
    expect(
      await repository.failExpiredPayment(
        run.id,
        transactionId,
        fixtureReferenceTime,
      ),
    ).toBe(true);
    const failed = await repository.getRun(run.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error?.code).toBe('PAYMENT_FAILED');
    expect(failed?.paymentReceipt).toBeNull();
  });
});
