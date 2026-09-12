import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  AgentRunSchema,
  PaymentReceiptSchema,
  agentTaskFixture,
  fixtureReferenceTime,
  type AgentRun,
} from '@proofserve/shared';
import { transitionAgentRun } from '@proofserve/agent';
import {
  PostgresAgentRunRepository,
  validatePostgresConnectionString,
} from '../src/postgres-agent-run-repository.js';

const paymentExpectation = {
  payer: '0.0.7162784',
  receiver: '0.0.123456',
  amountAtomic: '1000000',
  asset: '0.0.0',
  network: 'hedera:testnet',
};
const paymentAttempt = {
  ...paymentExpectation,
  transactionId: '0.0.7162784@1788940800.123456789',
  transactionValidUntil: '2099-09-06T10:00:00.000Z',
};

interface FakeResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

class FakePostgres {
  run: AgentRun | undefined;
  version = 0n;
  owner: string | undefined;
  claimIsCurrent = false;
  tombstoneOwner: string | undefined;
  paymentIdentifier: string | null = null;
  expectedPayer: string | null = null;
  expectedReceiver: string | null = null;
  expectedAmount: string | null = null;
  expectedAsset: string | null = null;
  expectedNetwork: string | null = null;
  transactionValidUntil: Date | null = null;
  submissionAuthorized = false;
  ready = true;
  failNextSnapshotUpdate = false;
  connects = 0;
  releases = 0;
  destroyedReleases = 0;
  readonly statements: string[] = [];

  async query(text: string, values: unknown[] = []): Promise<FakeResult> {
    return this.execute(text, values);
  }

  async connect(): Promise<FakeClient> {
    this.connects++;
    return new FakeClient(this);
  }

  async end(): Promise<void> {}

  async execute(text: string, values: unknown[]): Promise<FakeResult> {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.statements.push(sql);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql))
      return { rows: [], rowCount: null };
    if (sql.includes("to_regclass('agent_runs')"))
      return { rows: [{ ready: this.ready }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO agent_runs')) {
      if (this.run) throw new Error('duplicate');
      this.run = AgentRunSchema.parse(JSON.parse(String(values[1])));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT r.id')) {
      if (!this.run || this.run.id !== values[0])
        return { rows: [], rowCount: 0 };
      if (sql.includes('JOIN agent_run_payment_tombstones')) {
        if (!this.tombstoneOwner) return { rows: [], rowCount: 0 };
        return { rows: [this.row()], rowCount: 1 };
      }
      return {
        rows: [
          {
            ...this.row(),
            has_payment_tombstone: this.tombstoneOwner !== undefined,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith('SELECT t.owner_id'))
      return this.tombstoneOwner && !this.claimIsCurrent
        ? { rows: [this.tombstoneRow()], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT id, snapshot') && sql.includes('ORDER BY'))
      return this.run && !['COMPLETED', 'FAILED'].includes(this.run.status)
        ? { rows: [this.row()], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT id, snapshot'))
      return this.run && this.run.id === values[0]
        ? { rows: [this.row()], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    if (
      sql.startsWith('UPDATE agent_runs') &&
      sql.includes('execution_claimed_at = clock_timestamp()')
    ) {
      if (!this.run || String(this.version) !== values[2])
        return { rows: [], rowCount: 0 };
      this.owner = String(values[1]);
      this.claimIsCurrent = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE agent_runs') && sql.includes('snapshot =')) {
      if (this.failNextSnapshotUpdate) {
        this.failNextSnapshotUpdate = false;
        throw new Error('SENSITIVE database failure');
      }
      const ownerGuarded = values.length === 5;
      if (
        !this.run ||
        String(this.version) !== values[3] ||
        (ownerGuarded && this.owner !== values[4])
      )
        return { rows: [], rowCount: 0 };
      this.run = AgentRunSchema.parse(JSON.parse(String(values[1])));
      this.version++;
      if (sql.includes('execution_owner = NULL')) {
        this.owner = undefined;
        this.claimIsCurrent = false;
      }
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.startsWith('UPDATE agent_runs') &&
      sql.includes('execution_owner = NULL')
    ) {
      if (this.owner === values[1]) {
        this.owner = undefined;
        this.claimIsCurrent = false;
      }
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.startsWith('UPDATE agent_runs') &&
      sql.includes('execution_claim_expires_at = clock_timestamp()')
    )
      return { rows: [], rowCount: this.owner === values[1] ? 1 : 0 };
    if (sql.startsWith('INSERT INTO agent_run_payment_tombstones')) {
      if (this.tombstoneOwner) return { rows: [], rowCount: 0 };
      this.tombstoneOwner = String(values[1]);
      this.paymentIdentifier = null;
      this.expectedPayer = String(values[2]);
      this.expectedReceiver = String(values[3]);
      this.expectedAmount = String(values[4]);
      this.expectedAsset = String(values[5]);
      this.expectedNetwork = String(values[6]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT owner_id, payment_identifier'))
      return this.tombstoneOwner
        ? {
            rows: [
              {
                ...this.tombstoneRow(),
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    if (sql.startsWith('UPDATE agent_run_payment_tombstones')) {
      if (sql.includes('submission_authorized_at = clock_timestamp()')) {
        this.submissionAuthorized = true;
        return { rows: [], rowCount: 1 };
      }
      if (
        !this.tombstoneOwner ||
        this.tombstoneOwner !== values[3] ||
        this.paymentIdentifier !== null
      )
        return { rows: [], rowCount: 0 };
      this.paymentIdentifier = String(values[1]);
      this.transactionValidUntil = new Date(String(values[2]));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unhandled fake SQL: ${sql}`);
  }

  private row(): Record<string, unknown> {
    if (!this.run) throw new Error('Missing fake run');
    return {
      id: this.run.id,
      snapshot: structuredClone(this.run),
      version: String(this.version),
      execution_owner: this.owner ?? null,
      claim_is_current: this.owner !== undefined && this.claimIsCurrent,
      payment_identifier: this.paymentIdentifier,
      ...this.tombstoneRow(),
    };
  }

  private tombstoneRow(): Record<string, unknown> {
    return {
      owner_id: this.tombstoneOwner ?? null,
      payment_identifier: this.paymentIdentifier,
      expected_payer: this.expectedPayer,
      expected_receiver: this.expectedReceiver,
      expected_amount_atomic: this.expectedAmount,
      expected_asset: this.expectedAsset,
      expected_network: this.expectedNetwork,
      transaction_valid_until: this.transactionValidUntil,
      submission_authorized_at: this.submissionAuthorized ? new Date() : null,
      has_payment_tombstone: this.tombstoneOwner !== undefined,
    };
  }
}

class FakeClient {
  constructor(private readonly database: FakePostgres) {}

  query(text: string, values: unknown[] = []) {
    return this.database.execute(text, values);
  }

  release(destroy?: boolean) {
    this.database.releases++;
    if (destroy) this.database.destroyedReleases++;
  }
}

function createdRun(): AgentRun {
  return AgentRunSchema.parse({
    id: 'run_postgres_test',
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

function payingRun(created: AgentRun): AgentRun {
  let snapshot = transitionAgentRun(created, {
    status: 'DISCOVERING',
    occurredAt: fixtureReferenceTime,
  });
  snapshot = transitionAgentRun(snapshot, {
    status: 'SELECTED',
    selectedServiceId: activeServiceId(),
    occurredAt: fixtureReferenceTime,
  });
  snapshot = transitionAgentRun(snapshot, {
    status: 'PAYMENT_REQUIRED',
    paymentRequirements: paymentRequirements(),
    occurredAt: fixtureReferenceTime,
  });
  return transitionAgentRun(snapshot, {
    status: 'PAYING',
    occurredAt: fixtureReferenceTime,
  });
}

function repository(database: FakePostgres) {
  return new PostgresAgentRunRepository(database as unknown as Pool);
}

describe('PostgreSQL agent run repository', () => {
  it('recovers a NULL-identifier tombstone only after its lease is released', async () => {
    const database = new FakePostgres();
    const runs = repository(database);
    const created = createdRun();
    await runs.createRun(created);
    const claim = await runs.claimExecution(created.id, 'owner_signing');
    if (!claim) throw new Error('Missing claim');
    await claim.persist(payingRun(created));
    await claim.beginSigning(paymentExpectation);
    expect(
      await runs.reconcileTombstonedRun(created.id, fixtureReferenceTime),
    ).toBe(false);
    expect((await runs.getRun(created.id))?.status).toBe('PAYING');
    await claim.release();
    expect(
      await runs.reconcileTombstonedRun(created.id, fixtureReferenceTime),
    ).toBe(true);
    expect((await runs.getRun(created.id))?.error?.code).toBe('PAYMENT_FAILED');
    expect(database.paymentIdentifier).toBeNull();
  });

  it('rejects generic failure for a tombstoned run without a receipt', async () => {
    const database = new FakePostgres();
    const runs = repository(database);
    const created = createdRun();
    await runs.createRun(created);
    const claim = await runs.claimExecution(created.id, 'owner_guard');
    if (!claim) throw new Error('Missing claim');
    const paying = payingRun(created);
    await claim.persist(paying);
    await claim.beginSigning(paymentExpectation);
    const failed = transitionAgentRun(paying, {
      status: 'FAILED',
      error: {
        code: 'PAYMENT_FAILED',
        message: 'Payment could not be confirmed. Do not automatically retry.',
      },
      occurredAt: fixtureReferenceTime,
    });
    await expect(claim.persist(failed)).rejects.toThrow(
      'Agent run persistence failed.',
    );
    expect((await runs.getRun(created.id))?.status).toBe('PAYING');
  });

  it('fences a paused owner whose lease expired immediately before submission', async () => {
    const database = new FakePostgres();
    const runs = repository(database);
    const created = createdRun();
    await runs.createRun(created);
    const claim = await runs.claimExecution(created.id, 'owner_paused');
    if (!claim) throw new Error('Missing claim');
    await claim.persist(payingRun(created));
    await claim.beginSigning(paymentExpectation);
    await claim.recordPaymentAttempt(paymentAttempt);
    database.claimIsCurrent = false;
    await expect(
      claim.authorizeSubmission(paymentAttempt.transactionId),
    ).rejects.toThrow('Agent run persistence failed.');
    expect(database.submissionAuthorized).toBe(false);
    expect(
      await runs.claimExecution(created.id, 'owner_takeover'),
    ).toBeUndefined();
  });

  it('rejects an old owner CAS after authoritative reconciliation wins', async () => {
    const database = new FakePostgres();
    const runs = repository(database);
    const created = createdRun();
    await runs.createRun(created);
    const claim = await runs.claimExecution(created.id, 'owner_old');
    if (!claim) throw new Error('Missing claim');
    const paying = payingRun(created);
    await claim.persist(paying);
    await claim.beginSigning(paymentExpectation);
    await claim.recordPaymentAttempt(paymentAttempt);
    database.claimIsCurrent = false;
    const receipt = PaymentReceiptSchema.parse({
      id: 'receipt_reconciled',
      runId: created.id,
      serviceId: activeServiceId(),
      paymentRequirements: paymentRequirements(),
      transactionId: paymentAttempt.transactionId,
      transactionUrl:
        'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
      settledAt: fixtureReferenceTime,
    });
    expect(
      await runs.recoverConfirmedPayment(
        created.id,
        paymentAttempt,
        receipt,
        fixtureReferenceTime,
      ),
    ).toBe(true);
    await expect(
      claim.persist(
        transitionAgentRun(paying, {
          status: 'FAILED',
          error: { code: 'PAYMENT_FAILED', message: 'Payment failed.' },
          occurredAt: fixtureReferenceTime,
        }),
      ),
    ).rejects.toThrow('Agent run persistence failed.');
    expect((await runs.getRun(created.id))?.paymentReceipt).toEqual(receipt);
  });

  it('uses short transactions and versioned row-locked monotonic updates', async () => {
    const database = new FakePostgres();
    const runs = repository(database);
    const created = createdRun();
    await runs.createRun(created);
    const detached = await runs.getRun(created.id);
    if (!detached) throw new Error('Missing run');
    detached.task.input.ticket = 'mutated copy';
    expect((await runs.getRun(created.id))?.task).toEqual(agentTaskFixture);

    const claim = await runs.claimExecution(created.id, 'owner_one');
    if (!claim) throw new Error('Missing claim');
    await claim.persist(
      transitionAgentRun(created, {
        status: 'DISCOVERING',
        occurredAt: fixtureReferenceTime,
      }),
    );
    expect((await runs.getRun(created.id))?.status).toBe('DISCOVERING');
    expect(database.statements.some((sql) => sql.includes('FOR UPDATE'))).toBe(
      true,
    );
    expect(
      database.statements.some(
        (sql) =>
          sql.includes('version = version + 1') && sql.includes('version = $4'),
      ),
    ).toBe(true);
    await claim.release();
    expect(database.connects).toBeGreaterThanOrEqual(3);
    expect(database.releases).toBe(database.connects);
    expect(database.destroyedReleases).toBe(0);
    expect(database.statements.some((sql) => sql.includes('advisory'))).toBe(
      false,
    );
  });

  it('atomically excludes concurrent owners and terminalizes abandoned tombstones', async () => {
    const database = new FakePostgres();
    const first = repository(database);
    const second = repository(database);
    let snapshot = createdRun();
    await first.createRun(snapshot);
    const claim = await first.claimExecution(snapshot.id, 'owner_one');
    if (!claim) throw new Error('Missing claim');
    expect(
      await second.claimExecution(snapshot.id, 'owner_two'),
    ).toBeUndefined();

    snapshot = transitionAgentRun(snapshot, {
      status: 'DISCOVERING',
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'SELECTED',
      selectedServiceId: activeServiceId(),
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'PAYMENT_REQUIRED',
      paymentRequirements: paymentRequirements(),
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'PAYING',
      occurredAt: fixtureReferenceTime,
    });
    await claim.persist(snapshot);
    await claim.beginSigning(paymentExpectation);
    await expect(
      claim.recordPaymentAttempt({
        ...paymentAttempt,
        transactionId: 'signed-payload-or-secret',
      }),
    ).rejects.toThrow('Agent run persistence failed.');
    await claim.recordPaymentAttempt(paymentAttempt);
    expect(await second.listReconciliationRunIds()).toEqual([snapshot.id]);
    expect(
      await second.claimExecution(snapshot.id, 'owner_two'),
    ).toBeUndefined();
    await claim.release();
    expect(
      await second.reconcileTombstonedRun(snapshot.id, fixtureReferenceTime),
    ).toBe(false);
    expect((await second.getRun(snapshot.id))?.status).toBe('PAYING');
    expect(database.paymentIdentifier).toBe('0.0.7162784@1788940800.123456789');
  });

  it('rolls back a failed snapshot commit without storing a partial transition', async () => {
    const database = new FakePostgres();
    const runs = repository(database);
    const created = createdRun();
    await runs.createRun(created);
    const claim = await runs.claimExecution(created.id, 'owner_one');
    if (!claim) throw new Error('Missing claim');
    database.failNextSnapshotUpdate = true;
    await expect(
      claim.persist(
        transitionAgentRun(created, {
          status: 'DISCOVERING',
          occurredAt: fixtureReferenceTime,
        }),
      ),
    ).rejects.toThrow('Agent run persistence failed.');
    expect(database.run).toEqual(created);
    expect(database.statements).toContain('ROLLBACK');
    await claim.release();
  });

  it('reclaims an expired pre-sign claim and fences its former owner', async () => {
    const database = new FakePostgres();
    const first = repository(database);
    const second = repository(database);
    const created = createdRun();
    await first.createRun(created);
    const old = await first.claimExecution(created.id, 'owner_old');
    if (!old) throw new Error('Missing claim');
    database.claimIsCurrent = false;
    const current = await second.claimExecution(created.id, 'owner_new');
    expect(current?.snapshot).toEqual(created);
    await expect(
      old.persist(
        transitionAgentRun(created, {
          status: 'DISCOVERING',
          occurredAt: fixtureReferenceTime,
        }),
      ),
    ).rejects.toThrow('Agent run persistence failed.');
    await current?.release();
  });

  it('fails readiness closed when the required schema version is absent', async () => {
    const database = new FakePostgres();
    database.ready = false;
    await expect(repository(database).assertReady()).rejects.toThrow(
      'Agent run persistence failed.',
    );
  });
});

describe('PostgreSQL connection policy', () => {
  it('disables TLS only for local PostgreSQL and verifies remote certificates', () => {
    expect(
      validatePostgresConnectionString(
        'postgresql://local:fictional@127.0.0.1:5432/proofserve',
      ).ssl,
    ).toBe(false);
    const remote = validatePostgresConnectionString(
      'postgresql://app:fictional@db.example.test:5432/proofserve',
    );
    expect(remote.ssl).toEqual({ rejectUnauthorized: true });
    expect(new URL(remote.connectionString).searchParams.get('sslmode')).toBe(
      'verify-full',
    );
  });

  it.each([
    'http://db.example.test/proofserve',
    'postgresql:///proofserve',
    'postgresql://db.example.test/proofserve#unsafe',
    'postgresql://db.example.test/proofserve?sslmode=disable',
    'postgresql://localhost/proofserve?host=db.example.test&sslmode=disable',
  ])('rejects unsafe database URL %s', (value) => {
    expect(() => validatePostgresConnectionString(value)).toThrow(
      'Agent run persistence failed.',
    );
  });
});

function activeServiceId() {
  return 'service_example_active';
}

function paymentRequirements() {
  return {
    network: 'hedera:testnet',
    asset: '0.0.0',
    amountAtomic: '1000000',
    payTo: '0.0.123456',
  } as const;
}

it('ships an idempotent versioned schema with durable recovery fields', () => {
  const sql = readFileSync(
    new URL('../migrations/001_agent_runs.sql', import.meta.url),
    'utf8',
  );
  expect(sql).toMatch(
    /CREATE TABLE IF NOT EXISTS proofserve_schema_migrations/,
  );
  expect(sql).toMatch(/VALUES \('001_agent_runs'\)/);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS agent_runs/);
  expect(sql).toMatch(
    /CREATE TABLE IF NOT EXISTS agent_run_payment_tombstones/,
  );
  expect(sql).toMatch(/run_id varchar\(128\) PRIMARY KEY/);
  expect(sql).toMatch(/version bigint NOT NULL/);
  expect(sql).toMatch(/execution_claim_expires_at/);
  expect(sql).toMatch(/payment_identifier/);
  expect(sql).toMatch(/agent_runs_reconciliation_idx/);
  expect(sql).toMatch(/ON DELETE RESTRICT/);
  expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING/);
});
