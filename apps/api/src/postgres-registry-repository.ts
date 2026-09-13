import { Pool } from 'pg';
import {
  ProviderSchema,
  ServiceListingSchema,
  type Provider,
  type ServiceListing,
  type VerifiedVerificationRecord,
} from '@proofserve/shared';
import type {
  RegistryRepository,
  WorldVerificationCommitResult,
} from './repository.js';
import { validatePostgresConnectionString } from './postgres-agent-run-repository.js';

interface ReadyRow {
  ready: unknown;
}

export class PostgresRegistryRepository implements RegistryRepository {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    try {
      const result = await this.pool.query<ReadyRow>(
        `SELECT (
           to_regclass('registry_providers') IS NOT NULL
           AND to_regclass('registry_services') IS NOT NULL
           AND to_regclass('registry_world_replays') IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM proofserve_schema_migrations
              WHERE version = '002_registry'
           )
           AND has_schema_privilege(current_user, current_schema(), 'USAGE')
           AND has_table_privilege(
             current_user,
             'proofserve_schema_migrations',
             'SELECT'
           )
           AND has_table_privilege(
             current_user,
             'registry_providers',
             'SELECT'
           )
           AND has_table_privilege(
             current_user,
             'registry_providers',
             'INSERT'
           )
           AND has_table_privilege(
             current_user,
             'registry_providers',
             'UPDATE'
           )
           AND has_table_privilege(
             current_user,
             'registry_services',
             'SELECT'
           )
           AND has_table_privilege(
             current_user,
             'registry_services',
             'INSERT'
           )
           AND has_table_privilege(
             current_user,
             'registry_services',
             'UPDATE'
           )
           AND has_table_privilege(
             current_user,
             'registry_world_replays',
             'SELECT'
           )
           AND has_table_privilege(
             current_user,
             'registry_world_replays',
             'INSERT'
           )
           AND 2 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_providers'
           )
           AND 3 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_services'
           )
           AND 1 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_providers'
                AND column_name = 'id'
                AND data_type = 'character varying'
                AND character_maximum_length = 128
                AND is_nullable = 'NO'
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_providers'
                AND column_name = 'snapshot'
                AND data_type = 'jsonb'
                AND is_nullable = 'NO'
           )
           AND 2 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_services'
                AND column_name IN ('id', 'provider_id')
                AND data_type = 'character varying'
                AND character_maximum_length = 128
                AND is_nullable = 'NO'
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_services'
                AND column_name = 'snapshot'
                AND data_type = 'jsonb'
                AND is_nullable = 'NO'
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
                AND column_name = 'nullifier'
                AND data_type = 'character varying'
                AND character_maximum_length = 78
                AND is_nullable = 'NO'
           )
           AND EXISTS (
             SELECT 1 FROM pg_constraint c
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = r.relnamespace
              WHERE c.contype = 'p'
                AND r.relname = 'registry_providers'
                AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
                AND n.nspname = current_schema()
           )
           AND EXISTS (
             SELECT 1 FROM pg_constraint c
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = r.relnamespace
              WHERE c.contype = 'p'
                AND r.relname = 'registry_services'
                AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
                AND n.nspname = current_schema()
           )
           AND EXISTS (
             SELECT 1 FROM pg_constraint c
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = r.relnamespace
              WHERE c.contype = 'p'
                AND r.relname = 'registry_world_replays'
                AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (nullifier)'
                AND n.nspname = current_schema()
           )
           AND EXISTS (
             SELECT 1 FROM pg_constraint c
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = r.relnamespace
             JOIN information_schema.table_constraints tc
               ON tc.constraint_schema = n.nspname
              AND tc.table_name = r.relname
              AND tc.constraint_name = c.conname
              WHERE c.contype = 'f'
                AND c.conname = 'registry_services_provider_fk'
                AND r.relname = 'registry_services'
                AND c.confrelid = to_regclass('registry_providers')
                AND c.conkey = ARRAY[(
                  SELECT attnum FROM pg_attribute
                   WHERE attrelid = c.conrelid
                     AND attname = 'provider_id'
                     AND NOT attisdropped
                )]::smallint[]
                AND c.confkey = ARRAY[(
                  SELECT attnum FROM pg_attribute
                   WHERE attrelid = c.confrelid
                     AND attname = 'id'
                     AND NOT attisdropped
                )]::smallint[]
                AND c.confmatchtype = 's'
                AND c.confupdtype = 'a'
                AND c.confdeltype = 'r'
                AND c.convalidated
                AND NOT c.condeferrable
                AND NOT c.condeferred
                AND tc.enforced = 'YES'
                AND pg_get_constraintdef(c.oid, false) =
                  'FOREIGN KEY (provider_id) REFERENCES registry_providers(id) ON DELETE RESTRICT'
                AND 4 = (
                  SELECT count(*) FROM pg_trigger t
                   WHERE t.tgconstraint = c.oid
                     AND t.tgisinternal
                     AND t.tgenabled = 'O'
                )
                AND n.nspname = current_schema()
           )
           AND 8 = (
             SELECT count(*)
             FROM (VALUES
               ('registry_providers', 'registry_providers_id_format',
                 $$CHECK (((id)::text ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'::text))$$),
               ('registry_providers', 'registry_providers_snapshot_object',
                 $$CHECK ((jsonb_typeof(snapshot) = 'object'::text))$$),
               ('registry_providers', 'registry_providers_snapshot_id',
                 $$CHECK (((snapshot ? 'id'::text) AND (jsonb_typeof((snapshot -> 'id'::text)) = 'string'::text) AND ((snapshot ->> 'id'::text) = (id)::text)))$$),
               ('registry_services', 'registry_services_id_format',
                 $$CHECK (((id)::text ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'::text))$$),
               ('registry_services', 'registry_services_snapshot_object',
                 $$CHECK ((jsonb_typeof(snapshot) = 'object'::text))$$),
               ('registry_services', 'registry_services_snapshot_id',
                 $$CHECK (((snapshot ? 'id'::text) AND (jsonb_typeof((snapshot -> 'id'::text)) = 'string'::text) AND ((snapshot ->> 'id'::text) = (id)::text)))$$),
               ('registry_services', 'registry_services_snapshot_provider',
                 $$CHECK (((snapshot ? 'providerId'::text) AND (jsonb_typeof((snapshot -> 'providerId'::text)) = 'string'::text) AND ((snapshot ->> 'providerId'::text) = (provider_id)::text)))$$),
               ('registry_world_replays', 'registry_world_replays_nullifier_format',
                 $$CHECK (((nullifier)::text ~ '^(0|[1-9][0-9]*)$'::text))$$)
             ) expected(table_name, constraint_name, definition)
             JOIN pg_constraint c
               ON c.conname = expected.constraint_name
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = r.relnamespace
             JOIN information_schema.table_constraints tc
               ON tc.constraint_schema = n.nspname
              AND tc.table_name = r.relname
              AND tc.constraint_name = c.conname
              WHERE c.contype = 'c'
                AND r.relname = expected.table_name
                AND n.nspname = current_schema()
                AND c.convalidated
                AND NOT c.connoinherit
                AND tc.enforced = 'YES'
                AND pg_get_constraintdef(c.oid, false) = expected.definition
           )
         ) AS ready`,
      );
      if (result.rows[0]?.ready !== true)
        throw new Error('Registry migration required');
    } catch {
      throw new Error('Registry migration required');
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createProvider(provider: Provider): Promise<void> {
    const parsed = ProviderSchema.parse(provider);
    await this.pool.query(
      'INSERT INTO registry_providers (id, snapshot) VALUES ($1, $2)',
      [parsed.id, parsed],
    );
  }

  async getProvider(id: string): Promise<Provider | undefined> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      'SELECT snapshot FROM registry_providers WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const provider = ProviderSchema.parse(row.snapshot);
    if (provider.id !== id) throw new Error('Registry record mismatch');
    return provider;
  }

  async createService(service: ServiceListing): Promise<void> {
    const parsed = ServiceListingSchema.parse(service);
    await this.pool.query(
      'INSERT INTO registry_services (id, provider_id, snapshot) VALUES ($1, $2, $3)',
      [parsed.id, parsed.providerId, parsed],
    );
  }

  async getService(id: string): Promise<ServiceListing | undefined> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      'SELECT snapshot FROM registry_services WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const service = ServiceListingSchema.parse(row.snapshot);
    if (service.id !== id) throw new Error('Registry record mismatch');
    return service;
  }

  async updateService(service: ServiceListing): Promise<boolean> {
    const parsed = ServiceListingSchema.parse(service);
    const result = await this.pool.query(
      "UPDATE registry_services SET snapshot = $2 WHERE id = $1 AND provider_id = $3 AND snapshot->>'status' = 'DRAFT'",
      [parsed.id, parsed, parsed.providerId],
    );
    return result.rowCount === 1;
  }

  async listServices(): Promise<ServiceListing[]> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      'SELECT snapshot FROM registry_services',
    );
    return result.rows.map((row) => ServiceListingSchema.parse(row.snapshot));
  }

  async commitWorldVerification(
    providerId: string,
    nullifier: string,
    verification: VerifiedVerificationRecord,
    now: string,
  ): Promise<WorldVerificationCommitResult> {
    if (!/^(0|[1-9][0-9]*)$/.test(nullifier))
      throw new Error('Invalid canonical nullifier');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ snapshot: unknown }>(
        'SELECT snapshot FROM registry_providers WHERE id = $1 FOR UPDATE',
        [providerId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return 'PROVIDER_NOT_FOUND';
      }
      const provider = ProviderSchema.parse(row.snapshot);
      if (provider.id !== providerId)
        throw new Error('Registry record mismatch');
      const replay = await client.query(
        'SELECT nullifier FROM registry_world_replays WHERE nullifier = $1',
        [nullifier],
      );
      if (replay.rows.length) {
        await client.query('ROLLBACK');
        return 'WORLD_PROOF_REPLAYED';
      }
      if (
        provider.verification.status === 'VERIFIED' &&
        provider.verification.verifiedAt <= now &&
        now < provider.verification.expiresAt
      ) {
        await client.query('ROLLBACK');
        return 'PROVIDER_ALREADY_VERIFIED';
      }
      const updated = ProviderSchema.parse({
        ...provider,
        verification,
        updatedAt: now,
      });
      const claim = await client.query(
        'INSERT INTO registry_world_replays (nullifier) VALUES ($1) ON CONFLICT DO NOTHING RETURNING nullifier',
        [nullifier],
      );
      if (claim.rowCount !== 1) {
        await client.query('ROLLBACK');
        return 'WORLD_PROOF_REPLAYED';
      }
      const providerUpdate = await client.query(
        'UPDATE registry_providers SET snapshot = $2 WHERE id = $1',
        [providerId, updated],
      );
      if (providerUpdate.rowCount !== 1)
        throw new Error('Registry provider update failed');
      await client.query('COMMIT');
      return 'VERIFIED';
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Fail closed. */
      }
      throw new Error('Registry verification persistence failed');
    } finally {
      client.release();
    }
  }
}

export function createPostgresRegistryRepository(
  connectionString: string,
): PostgresRegistryRepository {
  const pool = new Pool({
    ...validatePostgresConnectionString(connectionString),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', () => {
    // pg removes the failed idle client. A later operation either obtains a new
    // connection or fails through the API's fixed, non-diagnostic error response.
  });
  return new PostgresRegistryRepository(pool);
}
