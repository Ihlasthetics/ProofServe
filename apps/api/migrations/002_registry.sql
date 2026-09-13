CREATE TABLE IF NOT EXISTS registry_providers (
  id varchar(128) PRIMARY KEY,
  snapshot jsonb NOT NULL,
  CONSTRAINT registry_providers_id_format CHECK (
    id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  ),
  CONSTRAINT registry_providers_snapshot_object CHECK (
    jsonb_typeof(snapshot) = 'object'
  ),
  CONSTRAINT registry_providers_snapshot_id CHECK (
    snapshot ? 'id'
    AND jsonb_typeof(snapshot->'id') = 'string'
    AND snapshot->>'id' = id
  )
);

CREATE TABLE IF NOT EXISTS registry_services (
  id varchar(128) PRIMARY KEY,
  provider_id varchar(128) NOT NULL,
  snapshot jsonb NOT NULL,
  CONSTRAINT registry_services_provider_fk FOREIGN KEY (provider_id)
    REFERENCES registry_providers(id) ON DELETE RESTRICT,
  CONSTRAINT registry_services_id_format CHECK (
    id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  ),
  CONSTRAINT registry_services_snapshot_object CHECK (
    jsonb_typeof(snapshot) = 'object'
  ),
  CONSTRAINT registry_services_snapshot_id CHECK (
    snapshot ? 'id'
    AND jsonb_typeof(snapshot->'id') = 'string'
    AND snapshot->>'id' = id
  ),
  CONSTRAINT registry_services_snapshot_provider CHECK (
    snapshot ? 'providerId'
    AND jsonb_typeof(snapshot->'providerId') = 'string'
    AND snapshot->>'providerId' = provider_id
  )
);

-- A stable World nullifier belongs to exactly one provider for this action.
CREATE TABLE IF NOT EXISTS registry_world_nullifiers (
  nullifier varchar(78) PRIMARY KEY,
  provider_id varchar(128) NOT NULL,
  CONSTRAINT registry_world_nullifiers_provider_fk FOREIGN KEY (provider_id)
    REFERENCES registry_providers(id) ON DELETE RESTRICT,
  CONSTRAINT registry_world_nullifiers_nullifier_format CHECK (
    nullifier ~ '^(0|[1-9][0-9]*)$'
  )
);

-- Persist signed contexts at issuance and retain their one-time consumption.
-- Store only canonical non-secret identifiers, never proofs or credentials.
CREATE TABLE IF NOT EXISTS registry_world_replays (
  request_nonce varchar(66) PRIMARY KEY,
  provider_id varchar(128) NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  verification_verified_at timestamptz,
  verification_expires_at timestamptz,
  consumed_at timestamptz,
  nullifier varchar(78),
  CONSTRAINT registry_world_replays_provider_fk FOREIGN KEY (provider_id)
    REFERENCES registry_providers(id) ON DELETE RESTRICT,
  CONSTRAINT registry_world_replays_nullifier_fk FOREIGN KEY (nullifier)
    REFERENCES registry_world_nullifiers(nullifier) ON DELETE RESTRICT,
  CONSTRAINT registry_world_replays_nonce_format CHECK (
    request_nonce ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT registry_world_replays_nullifier_format CHECK (
    nullifier ~ '^(0|[1-9][0-9]*)$'
  ),
  CONSTRAINT registry_world_replays_consumption_state CHECK (
    (consumed_at IS NULL AND nullifier IS NULL)
    OR (consumed_at IS NOT NULL AND nullifier IS NOT NULL)
  ),
  CONSTRAINT registry_world_replays_consumed_before_expiration CHECK (
    consumed_at IS NULL OR consumed_at < expires_at
  ),
  CONSTRAINT registry_world_replays_issuance_window CHECK (
    issued_at < expires_at
  ),
  CONSTRAINT registry_world_replays_epoch_pair CHECK (
    (verification_verified_at IS NULL AND verification_expires_at IS NULL)
    OR (verification_verified_at IS NOT NULL AND verification_expires_at IS NOT NULL)
  ),
  CONSTRAINT registry_world_replays_epoch_order CHECK (
    verification_verified_at IS NULL
    OR verification_verified_at < verification_expires_at
  )
);

-- IF NOT EXISTS must never bless a pre-existing table with an incompatible shape.
DO $proofserve_registry_schema$
BEGIN
  IF NOT (
    2 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_providers'
    )
    AND 3 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_services'
    )
    AND 2 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_nullifiers'
    )
    AND 8 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_providers'
        AND column_name = 'id' AND data_type = 'character varying'
        AND character_maximum_length = 128 AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_providers'
        AND column_name = 'snapshot' AND data_type = 'jsonb' AND is_nullable = 'NO'
    )
    AND 2 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_services'
        AND column_name IN ('id', 'provider_id') AND data_type = 'character varying'
        AND character_maximum_length = 128 AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_services'
        AND column_name = 'snapshot' AND data_type = 'jsonb' AND is_nullable = 'NO'
    )
    AND 2 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_nullifiers'
        AND column_name IN ('nullifier', 'provider_id')
        AND data_type = 'character varying'
        AND character_maximum_length IN (78, 128) AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_nullifiers'
        AND column_name = 'nullifier' AND character_maximum_length = 78
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_nullifiers'
        AND column_name = 'provider_id' AND character_maximum_length = 128
    )
    AND 2 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
        AND column_name IN ('request_nonce', 'provider_id')
        AND data_type = 'character varying'
        AND character_maximum_length IN (66, 128) AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
        AND column_name = 'request_nonce' AND character_maximum_length = 66
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
        AND column_name = 'provider_id' AND character_maximum_length = 128
    )
    AND 5 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
        AND column_name IN (
          'issued_at', 'expires_at', 'verification_verified_at',
          'verification_expires_at', 'consumed_at'
        )
        AND data_type = 'timestamp with time zone'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
        AND column_name IN ('issued_at', 'expires_at') AND is_nullable = 'NO'
      GROUP BY table_schema, table_name
      HAVING count(*) = 2
    )
    AND 3 = (
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
        AND column_name IN (
          'verification_verified_at', 'verification_expires_at', 'consumed_at'
        ) AND is_nullable = 'YES'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
        AND column_name = 'nullifier' AND data_type = 'character varying'
        AND character_maximum_length = 78 AND is_nullable = 'YES'
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
      JOIN pg_class r ON r.oid = c.conrelid AND r.relname = expected.table_name
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
        ('registry_services', 'registry_services_provider_fk', 'provider_id',
          'registry_providers', 'id',
          $definition$FOREIGN KEY (provider_id) REFERENCES registry_providers(id) ON DELETE RESTRICT$definition$),
        ('registry_world_nullifiers', 'registry_world_nullifiers_provider_fk', 'provider_id',
          'registry_providers', 'id',
          $definition$FOREIGN KEY (provider_id) REFERENCES registry_providers(id) ON DELETE RESTRICT$definition$),
        ('registry_world_replays', 'registry_world_replays_provider_fk', 'provider_id',
          'registry_providers', 'id',
          $definition$FOREIGN KEY (provider_id) REFERENCES registry_providers(id) ON DELETE RESTRICT$definition$),
        ('registry_world_replays', 'registry_world_replays_nullifier_fk', 'nullifier',
          'registry_world_nullifiers', 'nullifier',
          $definition$FOREIGN KEY (nullifier) REFERENCES registry_world_nullifiers(nullifier) ON DELETE RESTRICT$definition$)
      ) expected(table_name, constraint_name, source_column, referenced_table, referenced_column, definition)
      JOIN pg_constraint c ON c.contype = 'f' AND c.conname = expected.constraint_name
      JOIN pg_class r ON r.oid = c.conrelid AND r.relname = expected.table_name
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
        AND c.confupdtype = 'a' AND c.confdeltype = 'r'
        AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
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
          $definition$CHECK (((id)::text ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'::text))$definition$),
        ('registry_providers', 'registry_providers_snapshot_object',
          $definition$CHECK ((jsonb_typeof(snapshot) = 'object'::text))$definition$),
        ('registry_providers', 'registry_providers_snapshot_id',
          $definition$CHECK (((snapshot ? 'id'::text) AND (jsonb_typeof((snapshot -> 'id'::text)) = 'string'::text) AND ((snapshot ->> 'id'::text) = (id)::text)))$definition$),
        ('registry_services', 'registry_services_id_format',
          $definition$CHECK (((id)::text ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'::text))$definition$),
        ('registry_services', 'registry_services_snapshot_object',
          $definition$CHECK ((jsonb_typeof(snapshot) = 'object'::text))$definition$),
        ('registry_services', 'registry_services_snapshot_id',
          $definition$CHECK (((snapshot ? 'id'::text) AND (jsonb_typeof((snapshot -> 'id'::text)) = 'string'::text) AND ((snapshot ->> 'id'::text) = (id)::text)))$definition$),
        ('registry_services', 'registry_services_snapshot_provider',
          $definition$CHECK (((snapshot ? 'providerId'::text) AND (jsonb_typeof((snapshot -> 'providerId'::text)) = 'string'::text) AND ((snapshot ->> 'providerId'::text) = (provider_id)::text)))$definition$),
        ('registry_world_nullifiers', 'registry_world_nullifiers_nullifier_format',
          $definition$CHECK (((nullifier)::text ~ '^(0|[1-9][0-9]*)$'::text))$definition$),
        ('registry_world_replays', 'registry_world_replays_nonce_format',
          $definition$CHECK (((request_nonce)::text ~ '^0x[0-9a-f]{64}$'::text))$definition$),
        ('registry_world_replays', 'registry_world_replays_nullifier_format',
          $definition$CHECK (((nullifier)::text ~ '^(0|[1-9][0-9]*)$'::text))$definition$),
        ('registry_world_replays', 'registry_world_replays_consumption_state',
          $definition$CHECK ((((consumed_at IS NULL) AND (nullifier IS NULL)) OR ((consumed_at IS NOT NULL) AND (nullifier IS NOT NULL))))$definition$),
        ('registry_world_replays', 'registry_world_replays_consumed_before_expiration',
          $definition$CHECK (((consumed_at IS NULL) OR (consumed_at < expires_at)))$definition$),
        ('registry_world_replays', 'registry_world_replays_issuance_window',
          $definition$CHECK ((issued_at < expires_at))$definition$),
        ('registry_world_replays', 'registry_world_replays_epoch_pair',
          $definition$CHECK ((((verification_verified_at IS NULL) AND (verification_expires_at IS NULL)) OR ((verification_verified_at IS NOT NULL) AND (verification_expires_at IS NOT NULL))))$definition$),
        ('registry_world_replays', 'registry_world_replays_epoch_order',
          $definition$CHECK (((verification_verified_at IS NULL) OR (verification_verified_at < verification_expires_at)))$definition$)
      ) expected(table_name, constraint_name, definition)
      JOIN pg_constraint c ON c.conname = expected.constraint_name
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'c'
        AND r.relname = expected.table_name
        AND n.nspname = current_schema()
        AND c.convalidated
        AND NOT c.connoinherit
        AND pg_get_constraintdef(c.oid, false) = expected.definition
    )
  ) THEN
    RAISE EXCEPTION 'Incompatible ProofServe registry schema';
  END IF;
END
$proofserve_registry_schema$;

INSERT INTO proofserve_schema_migrations(version)
VALUES ('002_registry')
ON CONFLICT (version) DO NOTHING;
