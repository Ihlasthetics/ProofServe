# Y06 public deployment handoff

Status: preparation only, on `chore/y06-public-deployment-final`. I04 is merged
and its World verification proxy requirements are incorporated below. No public
resources or URLs have been created by this pass. G4 and Y06 remain incomplete.
I05 is pending, and T05 remains outside this pass.

## Processes and commands

Run all commands from the repository root with Node 22 (at least 22.18.0,
below 23) and npm 10 or 11. Install with `npm ci --include=dev`: TypeScript and
other build tools are development dependencies. Keep the workspace tree,
node_modules and generated dist directories together at runtime.

| Process                   | Build after installation | Start                   | Health path |
| ------------------------- | ------------------------ | ----------------------- | ----------- |
| Next.js web               | `npm run build:web`      | `npm run start:web`     | `/`         |
| API including buyer agent | `npm run build:api`      | `npm run start:api`     | `/health`   |
| Protected triage service  | `npm run build:service`  | `npm run start:service` | `/health`   |

The build commands compile local dependencies before consumers. The API imports
`@proofserve/agent` directly; there is no fourth agent HTTP process. Next.js
requires a Node server for its registry proxy, so do not deploy it as a static export.
Builds require no payment or World credentials.

Builds are side-effect-free with respect to agent execution and payment. API
startup is not: `npm run start:api` starts durable reconciliation after the
listener opens. When the configured database contains an unfinished run, an
initial start, manual restart, deployment restart, Render cold start or request
that wakes a sleeping API may resume discovery, signing, Hedera testnet payment,
settlement reconciliation or protected-service execution. Treat starting the API
as a payment-capable operation, never as a health check.

## Selected hackathon hosting arrangement

Use Render Free for the hackathon demonstration: three Node Web Services (Web,
API including the buyer agent, and protected triage) plus one free Render
PostgreSQL database. No provider manifest, paid resources or automatic
deployments are introduced here, and this pass does not create those resources.

For each application, leave Root Directory unset so npm can access all workspaces.
Use `npm ci --include=dev && npm run build:web` as the web build command, substituting
`build:api` or `build:service` for the others; use the start commands above.
Select a Node version matching the root engine constraint. Use one free instance
for Web and triage, and exactly one API instance with no replicas. Keep API
autoscaling and automatic deploys disabled. Configure Web and triage health checks
as above. Configure or invoke API `/health` only after the database startup safety
gate below has passed. Do not attach a generic uptime ping or other keep-awake
monitor to the API. HTTPS URLs are assigned by the host.

Render Free Web Services sleep after 15 minutes idle and may restart. For the API,
a sleep/wake cycle is a restart: a request to `/health` can wake the process and
trigger reconciliation before the health response. Before allowing the free API
to sleep, verify that every demo run is terminal. After an unexpected restart
during a run, inspect PostgreSQL before deliberately waking the API where
operationally possible. An API restart also erases the in-memory provider, service,
World verification and replay-protection state even though persisted
agent-run/payment data remains in PostgreSQL. After any safely gated API restart,
recreate the provider and perform World verification again, then complete the
demonstration during one active session. The free PostgreSQL database expires
after 30 days. This arrangement is hackathon/demo hosting, not production
durability.

Render supports [monorepos](https://render.com/docs/monorepo-support),
[Node web services](https://render.com/docs/web-services), and
[managed HTTPS](https://render.com/docs/tls). Its
[Postgres external endpoint](https://render.com/docs/postgresql-creating-connecting)
provides TLS. For this application, use a database hostname whose certificate
passes Node hostname and CA verification; verify this before accepting the setup.
Do not assume a private/internal hostname satisfies the existing TLS policy.
Restrict database network access to the API and approved migration operator.

## Runtime environment inventory

Enter real values only in the provider's per-service environment/secret settings.
Do not copy the entire root `.env.example` into every service. No application
loads that file automatically. The tables list names and purpose, not credentials.

| Web variable            | Requirement                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `REGISTRY_API_ORIGIN`   | Required for deployment; server-only public API HTTPS origin, with no path, query, or credentials.                                           |
| `PROOFSERVE_API_ORIGIN` | Required for deployment; the same server-only public API HTTPS origin, with no path, query, or credentials, for World verification proxying. |
| `PORT`                  | Host-supplied listening port for Next.js.                                                                                                    |
| `NODE_ENV`              | Production runtime mode.                                                                                                                     |

The browser calls same-origin `/api` routes. The registry boundary forwards its
implemented registry routes to `REGISTRY_API_ORIGIN`, and the merged I04 World
proxy forwards verification requests to `PROOFSERVE_API_ORIGIN`. Set both to
`<public API HTTPS origin>`. They are server-only: neither may use a
`NEXT_PUBLIC_*` name or reach browser bundles. No browser API-origin variable or
CORS change is required. I05 agent-run Web integration is still pending; never
expose the run token to make that flow work. The Web needs none of the API/service
secrets below.

| API variable                           | Requirement                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PORT`                                 | Host listening port; defaults to the local API port if omitted.                                    |
| `HOST`                                 | Bind all interfaces for hosting; already the source default.                                       |
| `NODE_ENV`                             | Production runtime mode.                                                                           |
| `TRIAGE_SERVICE_ENDPOINT`              | Required, exact public HTTPS triage URL including `/v1/triage`; shared with service configuration. |
| `DATABASE_URL`                         | Required secret, approved PostgreSQL database connection.                                          |
| `AGENT_REGISTRY_BASE_URL`              | Required, public API origin used by the embedded buyer for discovery.                              |
| `AGENT_RUN_API_TOKEN`                  | Required server-only run authorization secret; follow `validateAgentRunApiToken` in API source.    |
| `HEDERA_PAYER_ACCOUNT_ID`              | Required funded testnet buyer account identifier.                                                  |
| `HEDERA_PAYER_PRIVATE_KEY`             | Required server-only buyer signing secret.                                                         |
| `WORLD_APP_ID`                         | Required configured World application identifier.                                                  |
| `WORLD_RP_ID`                          | Required matching relying-party identifier.                                                        |
| `WORLD_RP_SIGNING_KEY`                 | Required server-only RP signing secret.                                                            |
| `WORLD_ACTION`                         | Required matching configured verification action.                                                  |
| `WORLD_ENVIRONMENT`                    | Required matching World environment; sandbox, staging and production are distinct.                 |
| `WORLD_VERIFICATION_FRESHNESS_SECONDS` | Required positive integer freshness policy accepted by `readWorldConfiguration`.                   |

| Triage service variable     | Requirement                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `TRIAGE_SERVICE_HOST`       | Required bind address for all interfaces.                                                    |
| `TRIAGE_SERVICE_PORT`       | Required listening port; set to the host's selected port. This service does not read `PORT`. |
| `NODE_ENV`                  | Production runtime mode.                                                                     |
| `TRIAGE_SERVICE_ENDPOINT`   | Required exact public HTTPS URL ending `/v1/triage`, with no query or fragment.              |
| `X402_RECEIVER_ACCOUNT_ID`  | Required separate Hedera testnet receiver; no receiver private key is needed.                |
| `X402_PRICE_TINYBAR`        | Required canonical decimal-string atomic amount.                                             |
| `BLOCKY402_FACILITATOR_URL` | Required approved Blocky402 testnet HTTPS facilitator URL.                                   |
| `TRIAGE_MODEL_PROVIDER`     | Required; current implementation supports Gemini.                                            |
| `TRIAGE_MODEL`              | Required model identifier available to the team's Gemini account.                            |
| `GEMINI_API_KEY`            | Required server-only Gemini credential.                                                      |

Set the triage port explicitly to match the provider port setting; on Render,
configure `PORT` and `TRIAGE_SERVICE_PORT` identically in that service's settings.
`RUN_REAL_PAYMENT_SMOKE` and `TRIAGE_SMOKE_URL` are manual smoke-test settings only;
do not enable the payment smoke test in hosting builds or CI.
Never put the run token, signing keys, or Gemini credential in `NEXT_PUBLIC_*`,
Next config, browser props or shared environment groups. Do not log proof/request
bodies, authorization headers, database connection strings or private keys.

## Database initialization and readiness

Schema creation is **not automatic**. Before starting the API, have the approved
database operator apply `apps/api/migrations/001_agent_runs.sql` once to the same
database and schema used by the runtime role. With libpq connection settings
provided securely outside shell history, use:

```sh
psql -X --set=ON_ERROR_STOP=1 --single-transaction --file=apps/api/migrations/001_agent_runs.sql
```

Supply `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSFILE`, `PGSSLMODE` and,
if required by the operator's trust setup, `PGSSLROOTCERT` securely to psql.
Use full certificate verification. Never put a password/connection URI in the
command or paste migration diagnostics containing credentials into this task.
These are operator-side psql settings, not additional API environment variables.

Use a currently supported PostgreSQL release. The schema requires JSONB,
transactions, foreign keys, partial indexes and ordinary catalog access; no
extension is required. No minimum server version is declared or integration-tested
by this repository. The migration role needs schema/table/index creation rights;
the API role needs schema usage, SELECT/INSERT/UPDATE on run/payment tables and
SELECT on the migration table. Both must resolve the same schema/search path.
Reserve capacity for the API pool's maximum ten connections plus administration.

For non-loopback hosts, source enforces verified TLS and accepts only absent
`sslmode` or `verify-full`; do not use `require`, disable verification, or add
certificate override URL parameters. Provider TLS incompatibility is a blocker
to report to Yhlas, not permission to weaken database security.

Startup awaits `repository.assertReady()` before listening. It checks the migration
marker, tables, required columns, keys and reconciliation index. Database connection
timeout is ten seconds; there is no startup retry loop or automatic migration.
Provision/migrate first, then start or retry the API after availability is restored.
The health endpoint is process liveness, not a continuous database/dependency probe
and not a side-effect-free startup probe.

### Required pre-start database safety gate

Run the following exact read-only inspection through a secured operator `psql`
session against the same database and schema as the API. The first result counts
the only run/payment tables created by the migration. The second uses the same
durable nonterminal predicate and ordering as `listReconciliationRunIds()` while
showing only safe operational metadata:

```sql
BEGIN TRANSACTION READ ONLY;

SELECT
  (SELECT count(*) FROM agent_runs) AS agent_run_count,
  (SELECT count(*) FROM agent_run_payment_tombstones) AS payment_tombstone_count;

SELECT
  r.id AS run_id,
  r.snapshot->>'status' AS status,
  (t.run_id IS NOT NULL) AS has_payment_tombstone,
  (t.payment_identifier IS NOT NULL) AS has_payment_identifier,
  (t.submission_authorized_at IS NOT NULL) AS submission_authorized
FROM agent_runs AS r
LEFT JOIN agent_run_payment_tombstones AS t ON t.run_id = r.id
WHERE r.snapshot->>'status' NOT IN ('COMPLETED', 'FAILED')
ORDER BY r.created_at, r.id;

COMMIT;
```

For the initial deployment, use the newly migrated database and require
`agent_run_count = 0`, `payment_tombstone_count = 0` and zero rows from the second
result. Perform this check before configuring the funded payer credentials and
before starting the API. A previously used or nonempty database does not satisfy
the initial-deployment gate, even if all of its runs are terminal.

For every later manual deploy or restart, stop new run submissions, allow active
runs to finish, then run the inspection before starting the replacement API. Funded
startup is permitted only when the second result has zero rows or when a human
payment owner explicitly authorizes startup recovery of the run IDs and states
listed by that result. Run the inspection directly in the secured database session;
never print task bodies, receipts, credentials, authorization tokens, proof
material, private keys or raw transaction/payment fields in this query, its
diagnostics or the deployment record.

If the second result contains any rows, do not start the API merely to perform a
health check. Do not delete or reset runs, permanent payment tombstones,
transaction IDs or receipts, and do not retry a payment manually. Startup may
resume side effects, so explicit payment-owner approval for the listed runs is
required before recovery.

## State and redeployment constraints

Providers, services and World replay protection are process-memory state; only
agent runs/payment state use PostgreSQL. Run exactly one long-lived API instance:
no serverless request processes, replicas or horizontal scaling. A restart loses
registry/verification/replay state even though run receipts survive.

Schedule API deploys during a maintenance window and follow the pre-start gate
above. Ensure the old process stops before routing traffic to the new one: even a
single-replica rolling deploy can briefly overlap processes with different
registry/replay state. Confirm the provider's stop/start procedure before
deployment. Recreate provider/service records and perform real verification after
restart; do not seed a verified status. Payment tombstones are permanent safety
records: preserve them and their associated runs, transaction IDs and receipts.
Never delete payment tables or records to reset a demo.

## Manual deployment and final acceptance

1. Human diff review first. Commit/push/PR/merge require separate authorization.
2. Approve hosting and provision database plus three applications. Reserve stable
   HTTPS origins on the selected Render Free arrangement. In this guide
   `WEB_PUBLIC_URL` and `API_PUBLIC_URL` are labels, not new application
   variables. PostgreSQL does not need a public HTTP URL.
3. Configure Web and service settings separately. Confirm World access,
   RP/action/environment and public web-origin settings with I04's owner; confirm
   the receiver, Blocky402 access, Gemini model access and outbound network
   connectivity. Keep automatic deploys disabled, and keep the API stopped without
   funded payer credentials.
4. Apply the existing database migration to the newly provisioned database. Run
   the pre-start inspection and require both counts and the nonterminal result to
   be zero. Only then fund the testnet payer, configure its credentials and start
   the API. Builds may run before this gate, but no API start, restart, cold start,
   wake or health request may bypass it. Deploy service and web independently. Set
   Web `REGISTRY_API_ORIGIN`, Web `PROOFSERVE_API_ORIGIN`, and API
   `AGENT_REGISTRY_BASE_URL` to the same API HTTPS origin. Set both backend
   `TRIAGE_SERVICE_ENDPOINT` values to the same service HTTPS URL including
   `/v1/triage`. Do not add an agent URL.
5. After the API startup gate has passed and the API is already running, check
   public web, API `/health` and service `/health` without credentials in a
   logged-out browser. Web and service health checks are non-payment operations.
   API `/health` is allowed only after the startup gate; it must never be used to
   wake an ungated API. Send a valid unpaid ticket POST to `/v1/triage` and verify
   HTTP 402 with Hedera testnet requirements; this must not sign or pay. Health
   responses do not prove World, Gemini, settlement or database recovery works.
6. Infrastructure deployment may begin with merged I04 before I05. After I05
   merges, validate/build and redeploy the latest approved `main` revision using
   the maintenance procedure. I05 is required for final browser G4 completion.
   Record the deployed revision and all three public URLs.
7. Warm Web and triage. Start or wake the API only after repeating the pre-start
   gate. If the API restarted, recreate the provider and perform World verification
   again. With separately authorized real testnet payment testing, complete public
   G4 during that active session:
   unverified activation blocked → real World verification → activation → discovery
   → 402 → actual payment → model result → persisted receipt and HashScan link.
   Check failure/cancellation states and never substitute fake successes.
8. Record actual public G4 evidence and time. Only after G4 passes is Y06 complete.
   Hand the stable URLs to T05's owner; do not start T05 in this task.

## Validation for this pass

For this small integration pass, do not run full repository validation. Run
Prettier only on `docs/deployment.md` and run
`git diff --check origin/main HEAD`. Do not run builds or a funded payment during
this pass. Record outcomes in the human handoff. Documentation checks do not
establish public hosting, database migration success, World access or a real
payment.
