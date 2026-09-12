CREATE TABLE IF NOT EXISTS proofserve_schema_migrations (
  version varchar(128) PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id varchar(128) PRIMARY KEY,
  snapshot jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  execution_owner varchar(128),
  execution_claimed_at timestamptz,
  execution_claim_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_runs_id_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT agent_runs_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT agent_runs_snapshot_id CHECK (snapshot->>'id' = id),
  CONSTRAINT agent_runs_execution_claim CHECK (
    (execution_owner IS NULL) = (execution_claimed_at IS NULL)
    AND (execution_owner IS NULL) = (execution_claim_expires_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS agent_run_payment_tombstones (
  run_id varchar(128) PRIMARY KEY REFERENCES agent_runs(id) ON DELETE RESTRICT,
  owner_id varchar(128) NOT NULL,
  signing_started_at timestamptz NOT NULL,
  payment_identifier varchar(128),
  expected_payer varchar(128) NOT NULL,
  expected_receiver varchar(128) NOT NULL,
  expected_amount_atomic varchar(128) NOT NULL,
  expected_asset varchar(128) NOT NULL,
  expected_network varchar(128) NOT NULL,
  transaction_valid_until timestamptz,
  submission_authorized_at timestamptz,
  CONSTRAINT agent_run_payment_tombstones_owner_format CHECK (
    owner_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  ),
  CONSTRAINT agent_run_payment_identifier_format CHECK (
    payment_identifier IS NULL OR payment_identifier ~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(@[1-9][0-9]*\.[0-9]{1,9}|-[1-9][0-9]*-[0-9]{1,9})$'
  ),
  CONSTRAINT agent_run_payment_attempt_complete CHECK (
    (payment_identifier IS NULL) = (transaction_valid_until IS NULL)
    AND (submission_authorized_at IS NULL OR payment_identifier IS NOT NULL)
  ),
  CONSTRAINT agent_run_payment_amount_format CHECK (
    expected_amount_atomic ~ '^(0|[1-9][0-9]*)$'
  )
);

CREATE INDEX IF NOT EXISTS agent_runs_reconciliation_idx
  ON agent_runs (created_at, id)
  WHERE snapshot->>'status' NOT IN ('COMPLETED', 'FAILED');

INSERT INTO proofserve_schema_migrations (version)
VALUES ('001_agent_runs')
ON CONFLICT (version) DO NOTHING;
