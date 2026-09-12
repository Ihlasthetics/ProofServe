# Y06 public deployment handoff

Status: preparation only, on `chore/y06-public-deployment`. Yhlas authorized
Tugrahan to prepare Y06 before G4. No public resources or URLs have been created
by this pass. G4 and Y06 remain incomplete. I04, I05 and T05 are outside this pass.

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

## Proposed hosting arrangement — decision pending

No existing provider configuration was found. The proposed minimal arrangement
is three Render Node web services and one Render Postgres database. Human owners
must approve the provider/account and plans before provisioning. No provider
manifest, paid resources or automatic deployments are introduced here.

For each application, leave Root Directory unset so npm can access all workspaces.
Use `npm ci --include=dev && npm run build:web` as the web build command, substituting
`build:api` or `build:service` for the others; use the start commands above.
Select a Node version matching the root engine constraint. Use always-running
instances, one replica each, with API autoscaling and automatic deploys disabled.
Set the health paths above. HTTPS URLs are assigned by the host.

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

| Web variable          | Requirement                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `REGISTRY_API_ORIGIN` | Required for deployment; server-only API HTTPS origin, no path/query/credentials. Otherwise code falls back to localhost. |
| `PORT`                | Host-supplied listening port for Next.js.                                                                                 |
| `NODE_ENV`            | Production runtime mode.                                                                                                  |

The browser calls same-origin `/api` routes; `src/server/registry-boundary.ts`
forwards only the implemented registry routes to `REGISTRY_API_ORIGIN` at runtime.
No browser API-origin variable or CORS change is required for that flow. The current
proxy does not implement World or agent-run forwarding. Recheck I04/I05 server
configuration after merge; do not expose the run token to make those flows work.
The current web needs none of the API/service secrets below.

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
The health endpoint is process liveness, not a continuous database/dependency probe.

## State and redeployment constraints

Providers, services and World replay protection are process-memory state; only
agent runs/payment state use PostgreSQL. Run exactly one long-lived API instance:
no serverless request processes, replicas or horizontal scaling. A restart loses
registry/verification/replay state even though run receipts survive.

Schedule API deploys during a maintenance window, stop new demo activity and let
active runs finish. Ensure the old process stops before routing traffic to the new
one: even a single-replica rolling deploy can briefly overlap processes with
different registry/replay state. Confirm the provider's stop/start procedure before
deployment. Recreate provider/service records and perform real verification after
restart; do not seed a verified status. Never delete payment tables to reset a demo.

## Manual deployment and final acceptance

1. Human diff review first. Commit/push/PR/merge require separate authorization.
2. Approve hosting and provision database plus three applications. Reserve stable
   HTTPS origins. In this guide `WEB_PUBLIC_URL` and `API_PUBLIC_URL` are labels,
   not new application variables. PostgreSQL does not need a public HTTP URL.
3. Configure secrets separately. Confirm World access, RP/action/environment and
   public web-origin settings with I04's owner; fund the testnet payer; confirm the
   receiver, Blocky402 access, Gemini model access and outbound network connectivity.
4. Apply the existing database migration. Deploy service, API, then web. Set web
   `REGISTRY_API_ORIGIN` and API `AGENT_REGISTRY_BASE_URL` to the API HTTPS origin.
   Set both backend `TRIAGE_SERVICE_ENDPOINT` values to the same service HTTPS URL
   including `/v1/triage`. Do not add an agent URL.
5. Check public web, API `/health` and service `/health` without credentials in a
   logged-out browser. Send a valid unpaid ticket POST to `/v1/triage` and verify
   HTTP 402 with Hedera testnet requirements; this must not sign or pay. Health
   responses do not prove World, Gemini, settlement or database recovery works.
6. After I04/I05 merge, validate/build and redeploy the latest approved `main`
   revision using the maintenance procedure. Recheck merged frontend server-secret
   requirements and record the deployed revision and all three public URLs.
7. With separately authorized real testnet payment testing, run public G4:
   unverified activation blocked → real World verification → activation → discovery
   → 402 → actual payment → model result → persisted receipt and HashScan link.
   Check failure/cancellation states and never substitute fake successes.
8. Record actual public G4 evidence and time. Only after G4 passes is Y06 complete.
   Hand the stable URLs to T05's owner; do not start T05 in this task.

## Validation for this pass

Run `npm run validate`, `npm run build:web`, `npm run build:api` and
`npm run build:service` from the root. Record outcomes in the human handoff.
Local builds/tests do not establish public hosting, database migration success,
World access or a real payment. Do not run a funded payment during this pass.

Initial pass results (2026-09-12; Node 22.23.2, npm 10.9.8):

- `npm ci --include=dev --no-audit --no-fund`: passed after retrying outside the
  sandbox because npm could not write its cache. No lockfile changes.
- `npm run validate`: failed at format checking, with 119 untouched files reported.
  The Windows checkout contains CRLF files while the formatter expects LF.
- `npm run lint` and `npm run typecheck`: passed after dependency installation.
- `npm test`: failed. The agent entry-point import timed out; its focused rerun
  (`npm run test --workspace=@proofserve/agent -- test/workspace.test.ts`) passed.
  The shared contract documentation test still fails because its LF-only matcher
  finds no examples in the CRLF checkout; read-only newline normalization finds
  21 examples. API, service and web tests passed; eight database integration tests
  were skipped. No database integration success is claimed.
- `npm run build:web`, `npm run build:api`, `npm run build:service`: all passed.
- Changed JSON/Markdown formatting and `git diff --check`: passed.

Resolve the checkout formatting/contract-test issue with the repository owner
before requesting review under the green-validation rule. No unrelated source
files were reformatted or tests weakened in this pass. No real payment was run.
