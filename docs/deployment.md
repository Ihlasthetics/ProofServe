# Y06 public deployment handoff

Status: Y06 public deployment and backend G4 completed on 2026-09-12 from
`4580b20c67135fd857389c919972112235961f44` on
`chore/y06-public-deployment-final`. I04 is merged and its World verification
proxy requirements are incorporated below. I05 is still pending, so the final
browser execution-timeline demonstration remains outstanding. T05 remains
outside this pass.

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

## Public hackathon hosting arrangement

The completed deployment uses Render Free for the hackathon demonstration:
three Node Web Services (Web, API including the buyer agent, and protected
triage) plus one free Render PostgreSQL database. All three services were
deployed from commit `4580b20c67135fd857389c919972112235961f44`.

| Service         | Public URL                                           | Recorded check                                                    |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Web             | https://proofserve-y06-web.onrender.com              | Public deployment recorded                                        |
| API             | https://proofserve-y06-api.onrender.com              | `/health` returned HTTP 200                                       |
| Triage          | https://proofserve-y06-triage.onrender.com           | `/health` returned HTTP 200                                       |
| Triage endpoint | https://proofserve-y06-triage.onrender.com/v1/triage | Unpaid request returned HTTP 402 with a `Payment-Required` header |

The PostgreSQL migration `apps/api/migrations/001_agent_runs.sql` was applied
successfully. Auto-deploy remained disabled for all three services, and the API
remained a single instance. No restart or redeployment occurred during G4.

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

Automatic uptime pings remain prohibited. Automatic API deployment also remains
prohibited: every API restart or deployment must pass the database safety gate
documented below before the process is started or woken.

Render supports [monorepos](https://render.com/docs/monorepo-support),
[Node web services](https://render.com/docs/web-services), and
[managed HTTPS](https://render.com/docs/tls). Its
[Postgres external endpoint](https://render.com/docs/postgresql-creating-connecting)
provides TLS. For this application, use a database hostname whose certificate
passes Node hostname and CA verification; verify this before accepting the setup.
Do not assume a private/internal hostname satisfies the existing TLS policy.
Restrict database network access to the API and approved migration operator.

## Public onboarding evidence

| Record   | ID                                     | Name                         |
| -------- | -------------------------------------- | ---------------------------- |
| Provider | `afdb746b-0f24-4ee5-bb78-d8e3bfd591a1` | ProofServe Y06 Live Provider |
| Service  | `c2b1fd11-ddc7-43c9-b0f2-e9e70ce73e84` | ProofServe Public Triage     |

Real World QR/selfie verification was completed using an Android phone, after
which the backend provider status became `VERIFIED`. Verification did not
automatically activate the service. Activation was a separate explicit request;
after it, the service became `ACTIVE` and appeared in the eligible registry
listing.

The active service advertised a price of exactly 1 tinybar, receiver
`0.0.10438900`, and endpoint
https://proofserve-y06-triage.onrender.com/v1/triage, matching the public triage
endpoint.

## Backend G4 evidence

### First safe failed run

Run `fbbc62ef-ad19-4c36-b798-785d5d1684e1` ended `FAILED` after `SELECTED`. It
never entered `PAYMENT_REQUIRED`, `PAYING`, or `PAID`; it produced no payment
receipt, and no automatic retry occurred. The likely cause was Render Free
triage spin-down. That cause is an inference, not a proven fact. A later manual
unpaid warm-up returned the expected HTTP 402 challenge.

### Successful run

Run `c77644a4-7a77-421c-915d-43003624634a` selected service
`c2b1fd11-ddc7-43c9-b0f2-e9e70ce73e84` and recorded this state sequence:

```text
CREATED
DISCOVERING
SELECTED
PAYMENT_REQUIRED
PAYING
PAID
EXECUTING
COMPLETED
```

Exactly 1 tinybar was settled on Hedera testnet. The transaction ID was
`0.0.7162784@1789248503.871191363`, with settlement time
`2026-09-12T21:28:37.804Z` and [HashScan transaction evidence](https://hashscan.io/testnet/transaction/0.0.7162784-1789248503-871191363).

Gemini returned:

| Field            | Value                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| Category         | Account Access                                                                 |
| Urgency          | high                                                                           |
| Summary          | User is unable to log in or access their account.                              |
| Suggested action | Verify user identity and send account recovery or password reset instructions. |

The final run status was `COMPLETED` with no error.

### Final PostgreSQL safety evidence

The final inspection transaction completed read-only and returned:

| Check                   | Result |
| ----------------------- | ------ |
| `agent_runs` count      | 2      |
| Payment tombstone count | 1      |
| Nonterminal run count   | 0      |

Durable run and payment evidence was not deleted, reset, or manually altered.

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

For any initial deployment to a newly migrated database, require
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

## Completed deployment and remaining acceptance

Y06 public deployment and the backend G4 run are complete. The public URLs,
onboarding result, payment evidence, model result, and final read-only database
inspection are recorded above. The backend G4 evidence does not complete I05:
the final browser execution-timeline demonstration remains outstanding until I05
is implemented and accepted.

For every later manual deployment, restart, cold start, or wake:

1. Stop new run submissions, allow active runs to finish, and execute the exact
   read-only database safety gate above.
2. Start or wake the API only when the nonterminal result has zero rows, or when
   a human payment owner explicitly authorizes recovery of every listed run.
3. Keep exactly one API instance, automatic API deployment disabled, and the API
   free of generic uptime pings or other automatic keep-awake traffic.
4. If the API restarts, recreate the provider and service and perform real World
   verification again because registry and World verification state are held in
   process memory. Never seed a verified status.
5. Preserve durable run records, payment tombstones, transaction IDs, and
   receipts. Never delete or reset them to repeat a demonstration, and never
   substitute fake verification or payment success.

## Validation for this documentation update

Format only `docs/deployment.md`, then run `git diff --check` and
`git diff --check origin/main HEAD`. Do not install dependencies, run builds,
restart or redeploy a service, or initiate another payment during this
documentation-only pass.
