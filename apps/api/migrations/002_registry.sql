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

-- Only canonical replay identifiers, never raw World proofs or credentials.
CREATE TABLE IF NOT EXISTS registry_world_replays (
  nullifier varchar(78) PRIMARY KEY,
  CONSTRAINT registry_world_replays_nullifier_format CHECK (
    nullifier ~ '^(0|[1-9][0-9]*)$'
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
    AND 1 = (
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
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'registry_world_replays'
        AND column_name = 'nullifier' AND data_type = 'character varying'
        AND character_maximum_length = 78 AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'p' AND r.relname = 'registry_providers'
        AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
        AND n.nspname = current_schema()
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'p' AND r.relname = 'registry_services'
        AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
        AND n.nspname = current_schema()
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'p' AND r.relname = 'registry_world_replays'
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
      WHERE c.contype = 'f' AND c.conname = 'registry_services_provider_fk'
        AND r.relname = 'registry_services'
        AND c.confrelid = to_regclass('registry_providers')
        AND c.conkey = ARRAY[(
          SELECT attnum FROM pg_attribute
          WHERE attrelid = c.conrelid AND attname = 'provider_id' AND NOT attisdropped
        )]::smallint[]
        AND c.confkey = ARRAY[(
          SELECT attnum FROM pg_attribute
          WHERE attrelid = c.confrelid AND attname = 'id' AND NOT attisdropped
        )]::smallint[]
        AND c.confmatchtype = 's'
        AND c.confupdtype = 'a' AND c.confdeltype = 'r'
        AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
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
        ('registry_world_replays', 'registry_world_replays_nullifier_format',
          $definition$CHECK (((nullifier)::text ~ '^(0|[1-9][0-9]*)$'::text))$definition$)
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
  ) THEN
    RAISE EXCEPTION 'Incompatible ProofServe registry schema';
  END IF;
END
$proofserve_registry_schema$;

INSERT INTO proofserve_schema_migrations(version)
VALUES ('002_registry')
ON CONFLICT (version) DO NOTHING;
