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
  WorldVerificationContextIssue,
  WorldVerificationContextIssueResult,
  WorldVerificationContextStatus,
  WorldVerificationReplayClaim,
} from './repository.js';
import { validatePostgresConnectionString } from './postgres-agent-run-repository.js';

interface ReadyRow {
  ready: unknown;
}

function verificationEpoch(provider: Provider) {
  return provider.verification.status === 'UNVERIFIED'
    ? { verifiedAt: null, expiresAt: null }
    : {
        verifiedAt: provider.verification.verifiedAt,
        expiresAt: provider.verification.expiresAt,
      };
}

function canIssueOrConsume(provider: Provider, now: string): boolean {
  return (
    provider.verification.status === 'UNVERIFIED' ||
    now >= provider.verification.expiresAt
  );
}

export class PostgresRegistryRepository implements RegistryRepository {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    try {
      const result = await this.pool.query<ReadyRow>(
        `SELECT (
           to_regclass('registry_providers') IS NOT NULL
           AND to_regclass('registry_services') IS NOT NULL
           AND to_regclass('registry_world_nullifiers') IS NOT NULL
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
             'registry_world_nullifiers',
             'SELECT'
           )
           AND has_table_privilege(
             current_user,
             'registry_world_nullifiers',
             'INSERT'
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
           AND has_table_privilege(
             current_user,
             'registry_world_replays',
             'UPDATE'
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
           AND 2 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_nullifiers'
           )
           AND 8 = (
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
           AND 2 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_nullifiers'
                AND column_name IN ('nullifier', 'provider_id')
                AND data_type = 'character varying'
                AND character_maximum_length IN (78, 128)
                AND is_nullable = 'NO'
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_nullifiers'
                AND column_name = 'nullifier'
                AND character_maximum_length = 78
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_nullifiers'
                AND column_name = 'provider_id'
                AND character_maximum_length = 128
           )
           AND 2 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
                AND column_name IN ('request_nonce', 'provider_id')
                AND data_type = 'character varying'
                AND character_maximum_length IN (66, 128)
                AND is_nullable = 'NO'
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
                AND column_name = 'request_nonce'
                AND character_maximum_length = 66
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
                AND column_name = 'provider_id'
                AND character_maximum_length = 128
           )
           AND 5 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
                AND column_name IN (
                  'issued_at', 'expires_at', 'verification_verified_at',
                  'verification_expires_at', 'consumed_at'
                )
                AND data_type = 'timestamp with time zone'
           )
           AND 2 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
                AND column_name IN ('issued_at', 'expires_at')
                AND is_nullable = 'NO'
           )
           AND 3 = (
             SELECT count(*) FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
                AND column_name IN (
                  'verification_verified_at', 'verification_expires_at',
                  'consumed_at'
                )
                AND is_nullable = 'YES'
           )
           AND EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'registry_world_replays'
                AND column_name = 'nullifier'
                AND data_type = 'character varying'
                AND character_maximum_length = 78
                AND is_nullable = 'YES'
           )
           AND 4 = (
             SELECT count(*)
             FROM (VALUES
               ('registry_providers', 'id'),
               ('registry_services', 'id'),
               ('registry_world_nullifiers', 'nullifier'),
               ('registry_world_replays', 'request_nonce')
             ) expected(table_name, column_name)
             JOIN pg_constraint c ON c.contype = 'p'
             JOIN pg_class r
               ON r.oid = c.conrelid AND r.relname = expected.table_name
             JOIN pg_namespace n ON n.oid = r.relnamespace
             WHERE n.nspname = current_schema()
               AND c.convalidated
                AND c.conkey = ARRAY[(
                  SELECT attnum FROM pg_attribute
                   WHERE attrelid = c.conrelid
                     AND attname = expected.column_name
                     AND NOT attisdropped
                )]::smallint[]
           )
           AND 4 = (
             SELECT count(*)
             FROM (VALUES
               ('registry_services', 'registry_services_provider_fk',
                 'provider_id', 'registry_providers', 'id',
                 $$FOREIGN KEY (provider_id) REFERENCES registry_providers(id) ON DELETE RESTRICT$$),
               ('registry_world_nullifiers',
                 'registry_world_nullifiers_provider_fk', 'provider_id',
                 'registry_providers', 'id',
                 $$FOREIGN KEY (provider_id) REFERENCES registry_providers(id) ON DELETE RESTRICT$$),
               ('registry_world_replays',
                 'registry_world_replays_provider_fk', 'provider_id',
                 'registry_providers', 'id',
                 $$FOREIGN KEY (provider_id) REFERENCES registry_providers(id) ON DELETE RESTRICT$$),
               ('registry_world_replays',
                 'registry_world_replays_nullifier_fk', 'nullifier',
                 'registry_world_nullifiers', 'nullifier',
                 $$FOREIGN KEY (nullifier) REFERENCES registry_world_nullifiers(nullifier) ON DELETE RESTRICT$$)
             ) expected(table_name, constraint_name, source_column,
                        referenced_table, referenced_column, definition)
             JOIN pg_constraint c
               ON c.contype = 'f' AND c.conname = expected.constraint_name
             JOIN pg_class r
               ON r.oid = c.conrelid AND r.relname = expected.table_name
             JOIN pg_namespace n ON n.oid = r.relnamespace
             WHERE n.nspname = current_schema()
               AND c.confrelid = to_regclass(expected.referenced_table)
               AND c.conkey = ARRAY[(
                 SELECT attnum FROM pg_attribute
                  WHERE attrelid = c.conrelid
                    AND attname = expected.source_column
                    AND NOT attisdropped
               )]::smallint[]
                AND c.confkey = ARRAY[(
                  SELECT attnum FROM pg_attribute
                   WHERE attrelid = c.confrelid
                     AND attname = expected.referenced_column
                     AND NOT attisdropped
                )]::smallint[]
                AND c.confmatchtype = 's'
                AND c.confupdtype = 'a'
                AND c.confdeltype = 'r'
                AND c.convalidated
                AND NOT c.condeferrable
                AND NOT c.condeferred
                AND pg_get_constraintdef(c.oid, false) = expected.definition
                AND 4 = (
                  SELECT count(*) FROM pg_trigger t
                   WHERE t.tgconstraint = c.oid
                     AND t.tgisinternal
                     AND t.tgenabled = 'O'
                )
           )
           AND 15 = (
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
               ('registry_world_nullifiers',
                 'registry_world_nullifiers_nullifier_format',
                 $$CHECK (((nullifier)::text ~ '^(0|[1-9][0-9]*)$'::text))$$),
               ('registry_world_replays', 'registry_world_replays_nonce_format',
                 $$CHECK (((request_nonce)::text ~ '^0x[0-9a-f]{64}$'::text))$$),
               ('registry_world_replays', 'registry_world_replays_nullifier_format',
                 $$CHECK (((nullifier)::text ~ '^(0|[1-9][0-9]*)$'::text))$$),
               ('registry_world_replays',
                 'registry_world_replays_consumption_state',
                 $$CHECK ((((consumed_at IS NULL) AND (nullifier IS NULL)) OR ((consumed_at IS NOT NULL) AND (nullifier IS NOT NULL))))$$),
               ('registry_world_replays',
                 'registry_world_replays_consumed_before_expiration',
                 $$CHECK (((consumed_at IS NULL) OR (consumed_at < expires_at)))$$),
               ('registry_world_replays',
                 'registry_world_replays_issuance_window',
                 $$CHECK ((issued_at < expires_at))$$),
               ('registry_world_replays', 'registry_world_replays_epoch_pair',
                 $$CHECK ((((verification_verified_at IS NULL) AND (verification_expires_at IS NULL)) OR ((verification_verified_at IS NOT NULL) AND (verification_expires_at IS NOT NULL))))$$),
               ('registry_world_replays', 'registry_world_replays_epoch_order',
                 $$CHECK (((verification_verified_at IS NULL) OR (verification_verified_at < verification_expires_at)))$$)
             ) expected(table_name, constraint_name, definition)
             JOIN pg_constraint c
               ON c.conname = expected.constraint_name
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = r.relnamespace
              WHERE c.contype = 'c'
                AND r.relname = expected.table_name
                AND n.nspname = current_schema()
                AND c.convalidated
                AND NOT c.connoinherit
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

  async createWorldVerificationContext(
    context: WorldVerificationContextIssue,
  ): Promise<WorldVerificationContextIssueResult> {
    if (!/^0x[0-9a-f]{64}$/.test(context.canonicalRequestNonce))
      throw new Error('Invalid canonical World request nonce');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ snapshot: unknown }>(
        'SELECT snapshot FROM registry_providers WHERE id = $1 FOR UPDATE',
        [context.providerId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return 'PROVIDER_NOT_FOUND';
      }
      const provider = ProviderSchema.parse(row.snapshot);
      if (provider.id !== context.providerId)
        throw new Error('Registry record mismatch');
      if (!canIssueOrConsume(provider, context.issuedAt)) {
        await client.query('ROLLBACK');
        return 'PROVIDER_ALREADY_VERIFIED';
      }
      const epoch = verificationEpoch(provider);
      await client.query(
        `INSERT INTO registry_world_replays
           (request_nonce, provider_id, issued_at, expires_at,
            verification_verified_at, verification_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          context.canonicalRequestNonce,
          context.providerId,
          context.issuedAt,
          context.expiresAt,
          epoch.verifiedAt,
          epoch.expiresAt,
        ],
      );
      await client.query('COMMIT');
      return 'ISSUED';
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Fail closed. */
      }
      throw new Error('Registry context persistence failed');
    } finally {
      client.release();
    }
  }

  async worldVerificationContextStatus(
    providerId: string,
    canonicalRequestNonce: string,
    now: string,
  ): Promise<WorldVerificationContextStatus> {
    if (!/^0x[0-9a-f]{64}$/.test(canonicalRequestNonce))
      throw new Error('Invalid canonical World request nonce');
    const result = await this.pool.query<{
      provider_id: string;
      unexpired: boolean;
      consumed: boolean;
      epoch_matches: boolean;
      provider_eligible: boolean;
    }>(
      `SELECT c.provider_id,
              c.expires_at > $3::timestamptz AS unexpired,
              c.consumed_at IS NOT NULL AS consumed,
              c.verification_verified_at IS NOT DISTINCT FROM
                (p.snapshot->'verification'->>'verifiedAt')::timestamptz
                AND c.verification_expires_at IS NOT DISTINCT FROM
                (p.snapshot->'verification'->>'expiresAt')::timestamptz
                AS epoch_matches,
              (p.snapshot->'verification'->>'status' = 'UNVERIFIED'
                OR (p.snapshot->'verification'->>'expiresAt')::timestamptz
                  <= $3::timestamptz) AS provider_eligible
         FROM registry_world_replays c
         JOIN registry_providers p ON p.id = c.provider_id
        WHERE c.request_nonce = $1 AND c.provider_id = $2`,
      [canonicalRequestNonce, providerId, now],
    );
    const context = result.rows[0];
    if (!context || context.provider_id !== providerId)
      return 'WORLD_PROOF_INVALID';
    if (context.consumed) return 'WORLD_PROOF_REPLAYED';
    return context.unexpired &&
      context.epoch_matches &&
      context.provider_eligible
      ? 'ISSUED'
      : 'WORLD_PROOF_INVALID';
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
    claim: WorldVerificationReplayClaim,
    verification: VerifiedVerificationRecord,
    now: string,
  ): Promise<WorldVerificationCommitResult> {
    if (!/^(0|[1-9][0-9]*)$/.test(claim.canonicalNullifier))
      throw new Error('Invalid canonical nullifier');
    if (!/^0x[0-9a-f]{64}$/.test(claim.canonicalRequestNonce))
      throw new Error('Invalid canonical World request nonce');
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
      const epoch = verificationEpoch(provider);
      const contextResult = await client.query<{
        provider_id: string;
        unexpired: boolean;
        consumed: boolean;
        epoch_matches: boolean;
      }>(
        `SELECT provider_id,
                expires_at > $2::timestamptz AS unexpired,
                consumed_at IS NOT NULL AS consumed,
                verification_verified_at IS NOT DISTINCT FROM $3::timestamptz
                  AND verification_expires_at IS NOT DISTINCT FROM $4::timestamptz
                  AS epoch_matches
           FROM registry_world_replays
          WHERE request_nonce = $1
          FOR UPDATE`,
        [claim.canonicalRequestNonce, now, epoch.verifiedAt, epoch.expiresAt],
      );
      const context = contextResult.rows[0];
      if (!context || context.provider_id !== providerId) {
        await client.query('ROLLBACK');
        return 'WORLD_PROOF_INVALID';
      }
      if (context.consumed) {
        await client.query('ROLLBACK');
        return 'WORLD_PROOF_REPLAYED';
      }
      if (!context.unexpired) {
        await client.query('ROLLBACK');
        return 'WORLD_PROOF_INVALID';
      }
      if (!context.epoch_matches || !canIssueOrConsume(provider, now)) {
        await client.query('ROLLBACK');
        return 'WORLD_PROOF_INVALID';
      }
      const ownerClaim = await client.query<{ provider_id: string }>(
        'INSERT INTO registry_world_nullifiers (nullifier, provider_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING provider_id',
        [claim.canonicalNullifier, providerId],
      );
      let owner = ownerClaim.rows[0]?.provider_id;
      if (owner === undefined) {
        const existingOwner = await client.query<{ provider_id: string }>(
          'SELECT provider_id FROM registry_world_nullifiers WHERE nullifier = $1',
          [claim.canonicalNullifier],
        );
        owner = existingOwner.rows[0]?.provider_id;
      }
      if (owner !== providerId) {
        await client.query('ROLLBACK');
        return 'WORLD_PROOF_REPLAYED';
      }
      const requestClaim = await client.query(
        `UPDATE registry_world_replays
            SET consumed_at = $2, nullifier = $3
          WHERE request_nonce = $1
            AND provider_id = $4
            AND consumed_at IS NULL
            AND expires_at > $2::timestamptz`,
        [
          claim.canonicalRequestNonce,
          now,
          claim.canonicalNullifier,
          providerId,
        ],
      );
      if (requestClaim.rowCount !== 1) {
        await client.query('ROLLBACK');
        return 'WORLD_PROOF_REPLAYED';
      }
      const updated = ProviderSchema.parse({
        ...provider,
        verification,
        updatedAt: now,
      });
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
