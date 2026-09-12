import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  AgentRunSchema,
  IdentifierSchema,
  TimestampSchema,
  type AgentRun,
  type Identifier,
  type PaymentReceipt,
  type Timestamp,
} from '@proofserve/shared';
import {
  canonicalHederaTransactionId,
  type BuyerPaymentAttempt,
  type BuyerPaymentExpectation,
} from '@proofserve/agent';
import {
  AgentRunRepositoryError,
  createFailureSnapshot,
  createRecoveredPaymentSnapshot,
  validateInitialRun,
  validateRunExtension,
  type AgentRunExecutionClaim,
  type AgentRunRepository,
} from './agent-run-repository.js';

const CLAIM_LEASE_SQL = "interval '5 minutes'";

interface RunRow extends QueryResultRow {
  id: unknown;
  snapshot: unknown;
  version: unknown;
  execution_owner: unknown;
  claim_is_current?: unknown;
  has_payment_tombstone?: unknown;
  payment_identifier?: unknown;
}

interface TombstoneRow extends QueryResultRow {
  owner_id: unknown;
  payment_identifier: unknown;
  expected_payer: unknown;
  expected_receiver: unknown;
  expected_amount_atomic: unknown;
  expected_asset: unknown;
  expected_network: unknown;
  transaction_valid_until: unknown;
  submission_authorized_at: unknown;
}

interface ReadyRow extends QueryResultRow {
  ready: unknown;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The caller receives only the fixed repository error.
  }
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch {
    if (client) await rollback(client);
    throw new AgentRunRepositoryError();
  } finally {
    if (client)
      try {
        client.release();
      } catch {
        // Never expose pool diagnostics or connection configuration.
      }
  }
}

function parseRow(row: RunRow | undefined, expectedId: Identifier): AgentRun {
  try {
    if (!row || IdentifierSchema.parse(row.id) !== expectedId)
      throw new AgentRunRepositoryError();
    return AgentRunSchema.parse(row.snapshot);
  } catch {
    throw new AgentRunRepositoryError();
  }
}

function version(row: RunRow): string {
  if (typeof row.version !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.version))
    throw new AgentRunRepositoryError();
  return row.version;
}

function currentOwner(row: RunRow, ownerId: Identifier): boolean {
  return row.execution_owner === ownerId && row.claim_is_current === true;
}

function paymentAttempt(row: TombstoneRow): BuyerPaymentAttempt | undefined {
  if (row.payment_identifier === null || row.transaction_valid_until === null)
    return undefined;
  try {
    const transactionId = canonicalHederaTransactionId(row.payment_identifier);
    const validUntil = TimestampSchema.parse(
      row.transaction_valid_until instanceof Date
        ? row.transaction_valid_until.toISOString()
        : String(row.transaction_valid_until),
    );
    return {
      transactionId,
      transactionValidUntil: validUntil,
      payer: String(row.expected_payer),
      receiver: String(row.expected_receiver),
      amountAtomic: String(row.expected_amount_atomic),
      asset: String(row.expected_asset),
      network: String(row.expected_network),
    };
  } catch {
    throw new AgentRunRepositoryError();
  }
}

function samePaymentAttempt(
  left: BuyerPaymentAttempt,
  right: BuyerPaymentAttempt,
): boolean {
  return (
    left.transactionId === right.transactionId &&
    left.transactionValidUntil === right.transactionValidUntil &&
    left.payer === right.payer &&
    left.receiver === right.receiver &&
    left.amountAtomic === right.amountAtomic &&
    left.asset === right.asset &&
    left.network === right.network
  );
}

export function validatePostgresConnectionString(connectionString: string): {
  connectionString: string;
  ssl: false | { rejectUnauthorized: true };
} {
  try {
    const url = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length <= 1 ||
      url.hash
    )
      throw new AgentRunRepositoryError();
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const sslMode = url.searchParams.get('sslmode');
    for (const name of [
      'host',
      'port',
      'database',
      'ssl',
      'sslcert',
      'sslkey',
      'sslrootcert',
      'uselibpqcompat',
      'sslnegotiation',
    ])
      if (url.searchParams.has(name)) throw new AgentRunRepositoryError();
    if (
      (local && sslMode !== null && sslMode !== 'disable') ||
      (!local && sslMode !== null && sslMode !== 'verify-full')
    )
      throw new AgentRunRepositoryError();
    if (!local) url.searchParams.set('sslmode', 'verify-full');
    return {
      connectionString: url.toString(),
      ssl: local ? false : { rejectUnauthorized: true },
    };
  } catch {
    throw new AgentRunRepositoryError();
  }
}

export class PostgresAgentRunRepository implements AgentRunRepository {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    try {
      const result = await this.pool.query<ReadyRow>(
        `SELECT (
           to_regclass('agent_runs') IS NOT NULL
           AND to_regclass('agent_run_payment_tombstones') IS NOT NULL
           AND to_regclass('agent_runs_reconciliation_idx') IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM proofserve_schema_migrations
              WHERE version = '001_agent_runs'
           )
           AND 8 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'agent_runs'
                AND column_name IN (
                  'id', 'snapshot', 'version', 'execution_owner',
                  'execution_claimed_at', 'execution_claim_expires_at',
                  'created_at', 'updated_at'
                )
           )
           AND 11 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'agent_run_payment_tombstones'
                AND column_name IN (
                  'run_id', 'owner_id', 'signing_started_at',
                  'payment_identifier', 'expected_payer', 'expected_receiver',
                  'expected_amount_atomic', 'expected_asset', 'expected_network',
                  'transaction_valid_until', 'submission_authorized_at'
                )
           )
           AND 2 = (
             SELECT count(*)
               FROM pg_constraint c
               JOIN pg_class r ON r.oid = c.conrelid
               JOIN pg_namespace n ON n.oid = r.relnamespace
              WHERE c.contype = 'p'
                AND r.relname IN (
                  'agent_runs', 'agent_run_payment_tombstones'
                )
                AND n.nspname = current_schema()
           )
           AND EXISTS (
             SELECT 1
               FROM pg_constraint c
               JOIN pg_class r ON r.oid = c.conrelid
               JOIN pg_namespace n ON n.oid = r.relnamespace
              WHERE c.contype = 'f'
                AND r.relname = 'agent_run_payment_tombstones'
                AND c.confrelid = to_regclass('agent_runs')
                AND n.nspname = current_schema()
           )
         ) AS ready`,
      );
      if (result.rows[0]?.ready !== true) throw new AgentRunRepositoryError();
    } catch {
      throw new AgentRunRepositoryError();
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch {
      throw new AgentRunRepositoryError();
    }
  }

  async createRun(value: AgentRun): Promise<void> {
    const snapshot = validateInitialRun(value);
    try {
      await this.pool.query(
        `INSERT INTO agent_runs
           (id, snapshot, version, created_at, updated_at)
         VALUES ($1, $2::jsonb, 0, $3::timestamptz, $3::timestamptz)`,
        [snapshot.id, JSON.stringify(snapshot), snapshot.createdAt],
      );
    } catch {
      throw new AgentRunRepositoryError();
    }
  }

  async getRun(runId: Identifier): Promise<AgentRun | undefined> {
    try {
      const result = await this.pool.query<RunRow>(
        'SELECT id, snapshot, version, execution_owner FROM agent_runs WHERE id = $1',
        [runId],
      );
      if (result.rows.length === 0) return undefined;
      return parseRow(result.rows[0], runId);
    } catch (error) {
      if (error instanceof AgentRunRepositoryError) throw error;
      throw new AgentRunRepositoryError();
    }
  }

  async listReconciliationRunIds(): Promise<Identifier[]> {
    try {
      const result = await this.pool.query<RunRow>(
        `SELECT id, snapshot, version, execution_owner
           FROM agent_runs
          WHERE snapshot->>'status' NOT IN ('COMPLETED', 'FAILED')
          ORDER BY created_at, id`,
      );
      return result.rows.map((row) => IdentifierSchema.parse(row.id));
    } catch {
      throw new AgentRunRepositoryError();
    }
  }

  async claimExecution(
    runId: Identifier,
    ownerId: Identifier,
  ): Promise<AgentRunExecutionClaim | undefined> {
    const snapshot = await transaction(this.pool, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT r.id, r.snapshot, r.version, r.execution_owner,
                r.execution_owner IS NOT NULL
                  AND r.execution_claim_expires_at > clock_timestamp()
                  AS claim_is_current,
                EXISTS (
                  SELECT 1 FROM agent_run_payment_tombstones t
                   WHERE t.run_id = r.id
                ) AS has_payment_tombstone
           FROM agent_runs r
          WHERE r.id = $1
          FOR UPDATE OF r`,
        [runId],
      );
      if (result.rows.length === 0) return undefined;
      const row = result.rows[0];
      if (!row) throw new AgentRunRepositoryError();
      const run = parseRow(row, runId);
      if (
        row.has_payment_tombstone === true ||
        row.claim_is_current === true ||
        run.status === 'COMPLETED' ||
        run.status === 'FAILED'
      )
        return undefined;
      const updated = await client.query(
        `UPDATE agent_runs
            SET execution_owner = $2,
                execution_claimed_at = clock_timestamp(),
                execution_claim_expires_at = clock_timestamp() + ${CLAIM_LEASE_SQL}
          WHERE id = $1 AND version = $3`,
        [runId, ownerId, version(row)],
      );
      if (updated.rowCount !== 1) throw new AgentRunRepositoryError();
      return run;
    });
    if (!snapshot) return undefined;
    let active = true;
    const claim: AgentRunExecutionClaim = {
      snapshot,
      persist: async (value) => {
        if (!active) throw new AgentRunRepositoryError();
        await transaction(this.pool, async (client) => {
          const result = await client.query<RunRow>(
            `SELECT id, snapshot, version, execution_owner,
                    execution_claim_expires_at > clock_timestamp()
                      AS claim_is_current,
                    EXISTS (
                      SELECT 1 FROM agent_run_payment_tombstones t
                       WHERE t.run_id = agent_runs.id
                    ) AS has_payment_tombstone
               FROM agent_runs WHERE id = $1 FOR UPDATE`,
            [runId],
          );
          const row = result.rows[0];
          if (!row || !currentOwner(row, ownerId))
            throw new AgentRunRepositoryError();
          const target = validateRunExtension(parseRow(row, runId), value);
          if (
            target.status === 'FAILED' &&
            target.paymentReceipt === null &&
            row.has_payment_tombstone === true
          )
            throw new AgentRunRepositoryError();
          const updated = await client.query(
            `UPDATE agent_runs
                SET snapshot = $2::jsonb,
                    version = version + 1,
                    updated_at = $3::timestamptz,
                    execution_claim_expires_at = clock_timestamp() + ${CLAIM_LEASE_SQL}
              WHERE id = $1 AND version = $4 AND execution_owner = $5`,
            [
              runId,
              JSON.stringify(target),
              target.updatedAt,
              version(row),
              ownerId,
            ],
          );
          if (updated.rowCount !== 1) throw new AgentRunRepositoryError();
        });
      },
      beginSigning: async (expectation: BuyerPaymentExpectation) => {
        if (!active) throw new AgentRunRepositoryError();
        await transaction(this.pool, async (client) => {
          const result = await client.query<RunRow>(
            `SELECT id, snapshot, version, execution_owner,
                    execution_claim_expires_at > clock_timestamp()
                      AS claim_is_current
               FROM agent_runs WHERE id = $1 FOR UPDATE`,
            [runId],
          );
          const row = result.rows[0];
          if (
            !row ||
            !currentOwner(row, ownerId) ||
            parseRow(row, runId).status !== 'PAYING'
          )
            throw new AgentRunRepositoryError();
          const inserted = await client.query(
            `INSERT INTO agent_run_payment_tombstones
               (run_id, owner_id, signing_started_at, payment_identifier,
                expected_payer, expected_receiver, expected_amount_atomic,
                expected_asset, expected_network, transaction_valid_until,
                submission_authorized_at)
             VALUES ($1, $2, clock_timestamp(), NULL, $3, $4, $5, $6, $7,
                     NULL, NULL)
             ON CONFLICT (run_id) DO NOTHING`,
            [
              runId,
              ownerId,
              expectation.payer,
              expectation.receiver,
              expectation.amountAtomic,
              expectation.asset,
              expectation.network,
            ],
          );
          if (inserted.rowCount !== 1) throw new AgentRunRepositoryError();
          await client.query(
            `UPDATE agent_runs
                SET execution_claim_expires_at = clock_timestamp() + ${CLAIM_LEASE_SQL}
              WHERE id = $1 AND execution_owner = $2`,
            [runId, ownerId],
          );
        });
      },
      recordPaymentAttempt: async (attempt) => {
        let canonical: string;
        try {
          canonical = canonicalHederaTransactionId(attempt.transactionId);
        } catch {
          throw new AgentRunRepositoryError();
        }
        if (!active || canonical !== attempt.transactionId)
          throw new AgentRunRepositoryError();
        await transaction(this.pool, async (client) => {
          const runResult = await client.query<RunRow>(
            `SELECT id, snapshot, version, execution_owner,
                    execution_claim_expires_at > clock_timestamp()
                      AS claim_is_current
               FROM agent_runs WHERE id = $1 FOR UPDATE`,
            [runId],
          );
          const row = runResult.rows[0];
          if (!row || !currentOwner(row, ownerId))
            throw new AgentRunRepositoryError();
          const tombstone = await client.query<TombstoneRow>(
            `SELECT owner_id, payment_identifier, expected_payer,
                    expected_receiver, expected_amount_atomic, expected_asset,
                    expected_network, transaction_valid_until,
                    submission_authorized_at
               FROM agent_run_payment_tombstones
              WHERE run_id = $1 FOR UPDATE`,
            [runId],
          );
          const payment = tombstone.rows[0];
          if (
            payment?.owner_id !== ownerId ||
            payment.payment_identifier !== null ||
            payment.expected_payer !== attempt.payer ||
            payment.expected_receiver !== attempt.receiver ||
            payment.expected_amount_atomic !== attempt.amountAtomic ||
            payment.expected_asset !== attempt.asset ||
            payment.expected_network !== attempt.network
          )
            throw new AgentRunRepositoryError();
          const updated = await client.query(
            `UPDATE agent_run_payment_tombstones
                SET payment_identifier = $2,
                    transaction_valid_until = $3::timestamptz
              WHERE run_id = $1 AND owner_id = $4
                AND payment_identifier IS NULL`,
            [
              runId,
              attempt.transactionId,
              attempt.transactionValidUntil,
              ownerId,
            ],
          );
          if (updated.rowCount !== 1) throw new AgentRunRepositoryError();
          await client.query(
            `UPDATE agent_runs
                SET execution_claim_expires_at = clock_timestamp() + ${CLAIM_LEASE_SQL}
              WHERE id = $1 AND execution_owner = $2`,
            [runId, ownerId],
          );
        });
      },
      authorizeSubmission: async (transactionId) => {
        if (!active) throw new AgentRunRepositoryError();
        await transaction(this.pool, async (client) => {
          const result = await client.query<RunRow>(
            `SELECT r.id, r.snapshot, r.version, r.execution_owner,
                    r.execution_claim_expires_at > clock_timestamp()
                      AS claim_is_current
               FROM agent_runs r
               JOIN agent_run_payment_tombstones t ON t.run_id = r.id
              WHERE r.id = $1
                AND t.owner_id = $2
                AND t.payment_identifier = $3
                AND t.transaction_valid_until > clock_timestamp()
                AND t.submission_authorized_at IS NULL
              FOR UPDATE OF r, t`,
            [runId, ownerId, transactionId],
          );
          const row = result.rows[0];
          if (!row || !currentOwner(row, ownerId))
            throw new AgentRunRepositoryError();
          const updated = await client.query(
            `UPDATE agent_run_payment_tombstones t
                SET submission_authorized_at = clock_timestamp()
               FROM agent_runs r
              WHERE t.run_id = $1 AND t.owner_id = $2
                AND t.payment_identifier = $3
                AND t.transaction_valid_until > clock_timestamp()
                AND t.submission_authorized_at IS NULL
                AND r.id = t.run_id AND r.version = $4
                AND r.execution_owner = $2
                AND r.execution_claim_expires_at > clock_timestamp()`,
            [runId, ownerId, transactionId, version(row)],
          );
          if (updated.rowCount !== 1) throw new AgentRunRepositoryError();
        });
      },
      release: async () => {
        if (!active) return;
        try {
          await transaction(this.pool, async (client) => {
            await client.query(
              `UPDATE agent_runs
                  SET execution_owner = NULL,
                      execution_claimed_at = NULL,
                      execution_claim_expires_at = NULL
                WHERE id = $1 AND execution_owner = $2`,
              [runId, ownerId],
            );
          });
        } finally {
          active = false;
        }
      },
    };
    return claim;
  }

  async reconcileTombstonedRun(
    runId: Identifier,
    occurredAt: Timestamp,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT r.id, r.snapshot, r.version, r.execution_owner,
                t.payment_identifier,
                r.execution_owner IS NOT NULL
                  AND r.execution_claim_expires_at > clock_timestamp()
                  AS claim_is_current
           FROM agent_runs r
           JOIN agent_run_payment_tombstones t ON t.run_id = r.id
          WHERE r.id = $1
          FOR UPDATE OF r, t`,
        [runId],
      );
      if (result.rows.length === 0) return false;
      const row = result.rows[0];
      if (!row) throw new AgentRunRepositoryError();
      const run = parseRow(row, runId);
      if (
        row.claim_is_current === true ||
        run.status === 'COMPLETED' ||
        run.status === 'FAILED'
      )
        return false;
      if (row.payment_identifier !== null && run.paymentReceipt === null)
        return false;
      const failed = createFailureSnapshot(run, occurredAt);
      const updated = await client.query(
        `UPDATE agent_runs
            SET snapshot = $2::jsonb,
                version = version + 1,
                updated_at = $3::timestamptz,
                execution_owner = NULL,
                execution_claimed_at = NULL,
                execution_claim_expires_at = NULL
          WHERE id = $1 AND version = $4`,
        [runId, JSON.stringify(failed), failed.updatedAt, version(row)],
      );
      if (updated.rowCount !== 1) throw new AgentRunRepositoryError();
      return true;
    });
  }

  async getPaymentReconciliation(
    runId: Identifier,
  ): Promise<BuyerPaymentAttempt | undefined> {
    try {
      const result = await this.pool.query<TombstoneRow>(
        `SELECT t.owner_id, t.payment_identifier, t.expected_payer,
                t.expected_receiver, t.expected_amount_atomic,
                t.expected_asset, t.expected_network,
                t.transaction_valid_until, t.submission_authorized_at
           FROM agent_run_payment_tombstones t
           JOIN agent_runs r ON r.id = t.run_id
          WHERE t.run_id = $1
            AND (r.execution_owner IS NULL
                 OR r.execution_claim_expires_at <= clock_timestamp())
            AND r.snapshot->>'status' NOT IN ('COMPLETED', 'FAILED')`,
        [runId],
      );
      const row = result.rows[0];
      return row ? paymentAttempt(row) : undefined;
    } catch (error) {
      if (error instanceof AgentRunRepositoryError) throw error;
      throw new AgentRunRepositoryError();
    }
  }

  async recoverConfirmedPayment(
    runId: Identifier,
    attempt: BuyerPaymentAttempt,
    receipt: PaymentReceipt,
    occurredAt: Timestamp,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<RunRow & TombstoneRow>(
        `SELECT r.id, r.snapshot, r.version, r.execution_owner,
                t.owner_id, t.payment_identifier, t.expected_payer,
                t.expected_receiver, t.expected_amount_atomic,
                t.expected_asset, t.expected_network,
                t.transaction_valid_until, t.submission_authorized_at,
                r.execution_owner IS NOT NULL
                  AND r.execution_claim_expires_at > clock_timestamp()
                  AS claim_is_current
           FROM agent_runs r
           JOIN agent_run_payment_tombstones t ON t.run_id = r.id
          WHERE r.id = $1
          FOR UPDATE OF r, t`,
        [runId],
      );
      const row = result.rows[0];
      if (!row || row.claim_is_current === true) return false;
      const persisted = paymentAttempt(row);
      const run = parseRow(row, runId);
      if (
        !persisted ||
        !samePaymentAttempt(persisted, attempt) ||
        receipt.transactionId !== attempt.transactionId ||
        run.status !== 'PAYING'
      )
        return false;
      const recovered = createRecoveredPaymentSnapshot(
        run,
        receipt,
        occurredAt,
      );
      const updated = await client.query(
        `UPDATE agent_runs
            SET snapshot = $2::jsonb, version = version + 1,
                updated_at = $3::timestamptz, execution_owner = NULL,
                execution_claimed_at = NULL, execution_claim_expires_at = NULL
          WHERE id = $1 AND version = $4`,
        [runId, JSON.stringify(recovered), recovered.updatedAt, version(row)],
      );
      if (updated.rowCount !== 1) throw new AgentRunRepositoryError();
      return true;
    });
  }

  async failExpiredPayment(
    runId: Identifier,
    transactionId: string,
    occurredAt: Timestamp,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT r.id, r.snapshot, r.version, r.execution_owner,
                r.execution_owner IS NOT NULL
                  AND r.execution_claim_expires_at > clock_timestamp()
                  AS claim_is_current
           FROM agent_runs r
           JOIN agent_run_payment_tombstones t ON t.run_id = r.id
          WHERE r.id = $1 AND t.payment_identifier = $2
            AND t.transaction_valid_until + interval '30 seconds'
                <= clock_timestamp()
          FOR UPDATE OF r, t`,
        [runId, transactionId],
      );
      const row = result.rows[0];
      if (!row || row.claim_is_current === true) return false;
      const run = parseRow(row, runId);
      if (run.status === 'COMPLETED' || run.status === 'FAILED') return false;
      const failed = createFailureSnapshot(run, occurredAt);
      const updated = await client.query(
        `UPDATE agent_runs
            SET snapshot = $2::jsonb, version = version + 1,
                updated_at = $3::timestamptz, execution_owner = NULL,
                execution_claimed_at = NULL, execution_claim_expires_at = NULL
          WHERE id = $1 AND version = $4`,
        [runId, JSON.stringify(failed), failed.updatedAt, version(row)],
      );
      if (updated.rowCount !== 1) throw new AgentRunRepositoryError();
      return true;
    });
  }

  async failUnclaimedRun(
    runId: Identifier,
    occurredAt: Timestamp,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT r.id, r.snapshot, r.version, r.execution_owner,
                r.execution_owner IS NOT NULL
                  AND r.execution_claim_expires_at > clock_timestamp()
                  AS claim_is_current,
                EXISTS (
                  SELECT 1 FROM agent_run_payment_tombstones t
                   WHERE t.run_id = r.id
                ) AS has_payment_tombstone
           FROM agent_runs r
          WHERE r.id = $1
          FOR UPDATE OF r`,
        [runId],
      );
      if (result.rows.length === 0) return false;
      const row = result.rows[0];
      if (!row) throw new AgentRunRepositoryError();
      const run = parseRow(row, runId);
      if (
        row.claim_is_current === true ||
        row.has_payment_tombstone === true ||
        run.status === 'COMPLETED' ||
        run.status === 'FAILED'
      )
        return false;
      const failed = createFailureSnapshot(run, occurredAt);
      const updated = await client.query(
        `UPDATE agent_runs
            SET snapshot = $2::jsonb,
                version = version + 1,
                updated_at = $3::timestamptz,
                execution_owner = NULL,
                execution_claimed_at = NULL,
                execution_claim_expires_at = NULL
          WHERE id = $1 AND version = $4`,
        [runId, JSON.stringify(failed), failed.updatedAt, version(row)],
      );
      if (updated.rowCount !== 1) throw new AgentRunRepositoryError();
      return true;
    });
  }
}

export function createPostgresAgentRunRepository(
  connectionString: string,
): PostgresAgentRunRepository {
  const configuration = validatePostgresConnectionString(connectionString);
  return new PostgresAgentRunRepository(
    new Pool({
      ...configuration,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    }),
  );
}
