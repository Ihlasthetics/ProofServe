import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  AgentRunSchema,
  agentTaskFixture,
  fixtureReferenceTime,
  type AgentRun,
  activeServiceFixture,
  verifiedProviderFixture,
  VerifiedVerificationRecordSchema,
} from '@proofserve/shared';
import { transitionAgentRun } from '@proofserve/agent';
import {
  PostgresAgentRunRepository,
  validatePostgresConnectionString,
} from '../src/postgres-agent-run-repository.js';
import { PostgresRegistryRepository } from '../src/postgres-registry-repository.js';
import { createRegistry, RegistryError } from '../src/registry.js';

const configuredUrl = process.env.Y05_POSTGRES_TEST_URL;
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const migration = readFileSync(
  new URL('../migrations/001_agent_runs.sql', import.meta.url),
  'utf8',
);
const registryMigration = readFileSync(
  new URL('../migrations/002_registry.sql', import.meta.url),
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
    await pool.query(registryMigration);
    await pool.query(registryMigration);
  });

  it('retains verified discovery and replay protection across registry and connection recreation', async () => {
    const first = new PostgresRegistryRepository(pool);
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
    await first.createProvider(provider);
    expect(
      await first.commitWorldVerification(
        provider.id,
        '123',
        verification,
        fixtureReferenceTime,
      ),
    ).toBe('VERIFIED');
    const service = structuredClone(activeServiceFixture);
    service.status = 'DRAFT';
    service.paymentRequirements.amountAtomic = '1';
    await first.createService(service);
    const options = {
      now: () => fixtureReferenceTime,
      resolveEndpoint: () => service.endpoint,
    };
    await createRegistry({ ...options, repository: first }).activateService(
      service.id,
    );
    const restarted = new PostgresRegistryRepository(
      new Pool(validatePostgresConnectionString(scopedConnectionString)),
    );
    try {
      await restarted.assertReady();
      const registry = createRegistry({ ...options, repository: restarted });
      expect(
        (
          await registry.listServices({
            capability: 'SUPPORT_TICKET_TRIAGE',
            network: 'hedera:testnet',
            asset: '0.0.0',
            maxAmountAtomic: '1',
          })
        ).services.map((entry) => entry.service.id),
      ).toEqual([service.id]);
      expect(
        await restarted.commitWorldVerification(
          provider.id,
          '123',
          verification,
          fixtureReferenceTime,
        ),
      ).toBe('WORLD_PROOF_REPLAYED');

      const concurrentProviders = [
        'provider_concurrent_world_one',
        'provider_concurrent_world_two',
      ].map((id, index) => {
        const concurrentProvider = structuredClone(verifiedProviderFixture);
        concurrentProvider.id = id;
        concurrentProvider.payoutAccount = `0.0.${700001 + index}`;
        concurrentProvider.verification = {
          providerId: id,
          method: 'WORLD_SELFIE_CHECK',
          status: 'UNVERIFIED',
          verifiedAt: null,
          expiresAt: null,
        };
        return concurrentProvider;
      });
      await Promise.all(
        concurrentProviders.map((entry) => restarted.createProvider(entry)),
      );
      const concurrentVerification = concurrentProviders.map((entry) =>
        VerifiedVerificationRecordSchema.parse({
          ...verification,
          providerId: entry.id,
        }),
      );
      const verificationResults = await Promise.all([
        restarted.commitWorldVerification(
          concurrentProviders[0]!.id,
          '456',
          concurrentVerification[0]!,
          fixtureReferenceTime,
        ),
        restarted.commitWorldVerification(
          concurrentProviders[1]!.id,
          '456',
          concurrentVerification[1]!,
          fixtureReferenceTime,
        ),
      ]);
      expect(verificationResults.sort()).toEqual([
        'VERIFIED',
        'WORLD_PROOF_REPLAYED',
      ]);
      expect(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM registry_world_replays WHERE nullifier = '456'",
          )
        ).rows[0]?.count,
      ).toBe('1');
      const verifiedStatuses = await Promise.all(
        concurrentProviders.map(
          async (entry) =>
            (await restarted.getProvider(entry.id))?.verification.status,
        ),
      );
      expect(verifiedStatuses.sort()).toEqual(['UNVERIFIED', 'VERIFIED']);

      const failedProvider = structuredClone(verifiedProviderFixture);
      failedProvider.id = 'provider_database_write_failure';
      failedProvider.payoutAccount = '0.0.700003';
      failedProvider.verification = {
        providerId: failedProvider.id,
        method: 'WORLD_SELFIE_CHECK',
        status: 'UNVERIFIED',
        verifiedAt: null,
        expiresAt: null,
      };
      await restarted.createProvider(failedProvider);
      await pool.query(`CREATE FUNCTION reject_registry_provider_update()
        RETURNS trigger LANGUAGE plpgsql AS $trigger$
        BEGIN
          IF OLD.id = 'provider_database_write_failure' THEN
            RAISE EXCEPTION 'raw provider trigger diagnostic';
          END IF;
          RETURN NEW;
        END
        $trigger$`);
      await pool.query(`CREATE TRIGGER reject_registry_provider_update
        BEFORE UPDATE ON registry_providers
        FOR EACH ROW EXECUTE FUNCTION reject_registry_provider_update()`);
      try {
        const failedVerification = VerifiedVerificationRecordSchema.parse({
          ...verification,
          providerId: failedProvider.id,
        });
        let failure: unknown;
        try {
          await restarted.commitWorldVerification(
            failedProvider.id,
            '789',
            failedVerification,
            fixtureReferenceTime,
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          'Registry verification persistence failed',
        );
        expect((failure as Error).message).not.toContain(
          'raw provider trigger diagnostic',
        );
        expect(
          (
            await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM registry_world_replays WHERE nullifier = '789'",
            )
          ).rows[0]?.count,
        ).toBe('0');
        expect(
          (await restarted.getProvider(failedProvider.id))?.verification.status,
        ).toBe('UNVERIFIED');
      } finally {
        await pool.query(
          'DROP TRIGGER reject_registry_provider_update ON registry_providers',
        );
        await pool.query('DROP FUNCTION reject_registry_provider_update()');
      }
      expect(
        (
          await createRegistry({
            ...options,
            repository: restarted,
            now: () => verification.expiresAt,
          }).listServices({})
        ).services,
      ).toEqual([]);
      expect(
        (
          await createRegistry({
            ...options,
            repository: restarted,
            resolveEndpoint: () => 'https://other.example.test/v1/triage',
          }).listServices({})
        ).services,
      ).toEqual([]);
      expect(
        (await registry.listServices({ maxAmountAtomic: '1' })).services[0]
          ?.provider.verification,
      ).toEqual(verification);

      const concurrentService = structuredClone(service);
      concurrentService.id = 'service_concurrent_activation';
      concurrentService.status = 'DRAFT';
      await restarted.createService(concurrentService);
      const activations = await Promise.allSettled([
        registry.activateService(concurrentService.id),
        createRegistry({ ...options, repository: restarted }).activateService(
          concurrentService.id,
        ),
      ]);
      expect(
        activations.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = activations.find(({ status }) => status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status !== 'rejected')
        throw new Error('Expected one activation conflict');
      expect(rejected.reason).toBeInstanceOf(RegistryError);
      if (!(rejected.reason instanceof RegistryError))
        throw new Error('Expected registry error');
      expect(rejected.reason.code).toBe('SERVICE_STATE_CONFLICT');
    } finally {
      await restarted.close();
    }

    await pool.query(
      'ALTER TABLE registry_services DROP CONSTRAINT registry_services_snapshot_provider',
    );
    try {
      await expect(first.assertReady()).rejects.toThrow(
        'Registry migration required',
      );
    } finally {
      await pool.query(
        `ALTER TABLE registry_services
           ADD CONSTRAINT registry_services_snapshot_provider CHECK (
             snapshot ? 'providerId'
             AND jsonb_typeof(snapshot->'providerId') = 'string'
             AND snapshot->>'providerId' = provider_id
           )`,
      );
    }
    await expect(first.assertReady()).resolves.toBeUndefined();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (administration && schema) {
      await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      await administration.end();
    }
  });

  it('applies both versioned migrations idempotently and rejects incompatible tables', async () => {
    const result = await pool.query<{ version: string; count: string }>(
      `SELECT version, count(*)::text AS count
         FROM proofserve_schema_migrations
        WHERE version IN ('001_agent_runs', '002_registry')
        GROUP BY version
        ORDER BY version`,
    );
    expect(result.rows).toEqual([
      { version: '001_agent_runs', count: '1' },
      { version: '002_registry', count: '1' },
    ]);

    const incompatibleSchema = `t05_incompatible_${randomUUID().replaceAll('-', '')}`;
    await administration.query(`CREATE SCHEMA ${incompatibleSchema}`);
    const incompatibleUrl = new URL(scopedConnectionString);
    incompatibleUrl.searchParams.set(
      'options',
      `-c search_path=${incompatibleSchema}`,
    );
    const incompatiblePool = new Pool(
      validatePostgresConnectionString(incompatibleUrl.toString()),
    );
    try {
      await incompatiblePool.query(migration);
      await incompatiblePool.query(
        'CREATE TABLE registry_providers (id varchar(128) PRIMARY KEY)',
      );
      await expect(incompatiblePool.query(registryMigration)).rejects.toThrow();
      const marker = await incompatiblePool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM proofserve_schema_migrations
          WHERE version = '002_registry'`,
      );
      expect(marker.rows[0]?.count).toBe('0');
      expect(
        await incompatiblePool.query(
          "SELECT to_regclass('registry_services') AS service_table",
        ),
      ).toMatchObject({ rows: [{ service_table: null }] });
    } finally {
      await incompatiblePool.end();
      await administration.query(`DROP SCHEMA ${incompatibleSchema} CASCADE`);
    }

    const incompatibleDefinitions = [
      `ALTER TABLE registry_providers
         DROP CONSTRAINT registry_providers_snapshot_object,
         ADD CONSTRAINT registry_providers_snapshot_object CHECK (true)`,
      `ALTER TABLE registry_services
         DROP CONSTRAINT registry_services_snapshot_provider,
         ADD CONSTRAINT registry_services_snapshot_provider CHECK (
           snapshot ? 'providerId'
           AND jsonb_typeof(snapshot->'providerId') = 'string'
           AND snapshot->>'providerId' = provider_id
         ) NOT VALID`,
      `ALTER TABLE registry_services
         DROP CONSTRAINT registry_services_provider_fk,
         ADD CONSTRAINT registry_services_provider_fk
           FOREIGN KEY (id) REFERENCES registry_providers(id)
           ON UPDATE CASCADE ON DELETE CASCADE`,
      'ALTER TABLE registry_services DISABLE TRIGGER ALL',
    ];
    for (const [
      index,
      incompatibleDefinition,
    ] of incompatibleDefinitions.entries()) {
      const incompatibleDefinitionSchema = `t05_constraint_${index}_${randomUUID().replaceAll('-', '')}`;
      await administration.query(
        `CREATE SCHEMA ${incompatibleDefinitionSchema}`,
      );
      const definitionUrl = new URL(scopedConnectionString);
      definitionUrl.searchParams.set(
        'options',
        `-c search_path=${incompatibleDefinitionSchema}`,
      );
      const definitionPool = new Pool(
        validatePostgresConnectionString(definitionUrl.toString()),
      );
      try {
        await definitionPool.query(migration);
        await definitionPool.query(registryMigration);
        const registryRepository = new PostgresRegistryRepository(
          definitionPool,
        );
        await expect(registryRepository.assertReady()).resolves.toBeUndefined();
        await definitionPool.query(incompatibleDefinition);
        await expect(registryRepository.assertReady()).rejects.toThrow(
          'Registry migration required',
        );
        await expect(definitionPool.query(registryMigration)).rejects.toThrow(
          'Incompatible ProofServe registry schema',
        );
      } finally {
        await definitionPool.end();
        await administration.query(
          `DROP SCHEMA ${incompatibleDefinitionSchema} CASCADE`,
        );
      }
    }
  });

  it('rejects a SELECT-only registry role and accepts all required privileges', async () => {
    const role = `t05_registry_role_${randomUUID().replaceAll('-', '')}`;
    let restrictedPool: Pool | undefined;
    await administration.query(`CREATE ROLE ${role} LOGIN`);
    try {
      await administration.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await administration.query(
        `GRANT SELECT ON
           ${schema}.proofserve_schema_migrations,
           ${schema}.registry_providers,
           ${schema}.registry_services,
           ${schema}.registry_world_replays
         TO ${role}`,
      );
      const restrictedUrl = new URL(scopedConnectionString);
      restrictedUrl.username = role;
      restrictedUrl.password = '';
      restrictedPool = new Pool(
        validatePostgresConnectionString(restrictedUrl.toString()),
      );
      const restrictedRepository = new PostgresRegistryRepository(
        restrictedPool,
      );
      await expect(restrictedRepository.assertReady()).rejects.toThrow(
        'Registry migration required',
      );

      await administration.query(
        `GRANT INSERT, UPDATE ON
           ${schema}.registry_providers,
           ${schema}.registry_services
         TO ${role}`,
      );
      await administration.query(
        `GRANT INSERT ON ${schema}.registry_world_replays TO ${role}`,
      );
      await expect(restrictedRepository.assertReady()).resolves.toBeUndefined();
    } finally {
      if (restrictedPool) await restrictedPool.end();
      await administration.query(`DROP OWNED BY ${role}`);
      await administration.query(`DROP ROLE ${role}`);
    }
  });

  it('enforces uniqueness and rolls back invalid guarded updates', async () => {
    await expect(
      pool.query(
        `INSERT INTO registry_providers (id, snapshot)
         VALUES ('provider_missing_identity', '{}'::jsonb)`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO registry_providers (id, snapshot)
         VALUES ('provider_null_identity', '{"id":null}'::jsonb)`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO registry_providers (id, snapshot)
         VALUES ('provider_array_snapshot', '[]'::jsonb)`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO registry_services (id, provider_id, snapshot)
         VALUES ('service_missing_provider', $1, $2::jsonb)`,
        [
          verifiedProviderFixture.id,
          JSON.stringify({ id: 'service_missing_provider' }),
        ],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO registry_services (id, provider_id, snapshot)
         VALUES ('service_null_provider', $1, $2::jsonb)`,
        [
          verifiedProviderFixture.id,
          JSON.stringify({
            id: 'service_null_provider',
            providerId: null,
          }),
        ],
      ),
    ).rejects.toThrow();
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

  it('recovers a released NULL-identifier tombstone without signing or submission', async () => {
    const run = newRun('run_integration_null_payment_identifier');
    await repository.createRun(run);
    const claim = await repository.claimExecution(run.id, 'owner_null_attempt');
    if (!claim) throw new Error('Expected integration claim');
    await claim.persist(payingRun(run));
    await claim.beginSigning({
      payer: '0.0.7162784',
      receiver: '0.0.123456',
      amountAtomic: '1000000',
      asset: '0.0.0',
      network: 'hedera:testnet',
    });
    expect(
      await repository.reconcileTombstonedRun(run.id, fixtureReferenceTime),
    ).toBe(false);
    expect((await repository.getRun(run.id))?.status).toBe('PAYING');
    await claim.release();
    expect(
      await repository.reconcileTombstonedRun(run.id, fixtureReferenceTime),
    ).toBe(true);
    const failed = await repository.getRun(run.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error?.code).toBe('PAYMENT_FAILED');
    expect(failed?.paymentReceipt).toBeNull();
    const tombstone = await pool.query<{ payment_identifier: string | null }>(
      `SELECT payment_identifier
         FROM agent_run_payment_tombstones
        WHERE run_id = $1`,
      [run.id],
    );
    expect(tombstone.rows[0]?.payment_identifier).toBeNull();
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
