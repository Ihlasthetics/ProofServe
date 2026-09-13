# T05 discovery failure diagnosis

Run `e11a63c7-12b9-4aed-b58f-1152db864055` was accepted with HTTP 202 at
2026-09-12T23:27:11.712Z, entered DISCOVERING at 23:27:11.751Z, and failed at
23:27:12.014Z with NO_ELIGIBLE_SERVICE. Its SUPPORT_TICKET_TRIAGE budget was
1 tinybar on hedera:testnet / 0.0.0. Selection, payment requirements, receipt,
and result were null. This is discovery failure, not payment failure.

## All paths before SELECTED

The buyer maps any selection exception to NO_ELIGIBLE_SERVICE. Selection rejects
invalid task/time/candidate schemas, duplicate service IDs, or no qualifying
candidate. Qualifying candidates must be ACTIVE, match capability/network/asset,
have VERIFIED provider metadata with verifiedAt <= selection time < expiresAt,
and cost no more than the budget. The registry can already have filtered every
record: empty storage, inactive service, absent/mismatched provider, noncurrent
verification, endpoint differing from trusted configuration, or query mismatch
(including price above 1 tinybar). Malformed registry responses normally fail
earlier as discovery errors and map to PAYMENT_FAILED, not this code.

After choosing a candidate, but still before SELECTED, the buyer rejects an
endpoint differing from its configured allowlist or a provider payout differing
from the service payTo. It chooses the cheapest candidate deterministically;
these final checks do not try another candidate. No evidence establishes that
this latter behavior triggered the reported run.

“Unchanged” refers to the later security snapshot comparison: service id,
providerId, capability, endpoint, status, createdAt, all payment requirements;
provider id, payoutAccount, createdAt, and all verification fields. Names,
descriptions, and updatedAt are excluded. The comparison runs after SELECTED
and the unpaid challenge, then around signing/submission. It cannot explain
this run's pre-SELECTED timeline. The error text is shared by all these paths.

## Confirmed defect and inferred trigger

Production startup previously omitted the registry repository dependency, causing
createRegistry to instantiate empty in-memory maps. Providers, services,
verification, and process-local replay claims were lost across process restart;
PostgreSQL retained only agent runs/payment evidence. The deployment handoff
documents Render Free sleep/restart behavior and this exact limitation.

A restart losing registry state is therefore a supported explanation, not a
proven historical trigger. No discovery snapshot, restart log, verification
expiry, or contemporaneous endpoint configuration was captured. Earlier G4
evidence shows a matching 1-tinybar service; it does not prove that service was
still present and verified at 23:27. Other conditions above remain possible.

## Fix and deployment requirements

Production now injects a PostgreSQL registry using the existing pg dependency
and TLS policy. Migration 002_registry stores strict provider/service snapshots
and canonical World replay identifiers. Verification writes and unique replay
claims commit atomically; expiry and allowlist checks still run at discovery
and in the buyer. Startup requires the migration, exact validated and enforced
constraints, and the documented read/write privileges before listening or
reconciliation. Idle registry-pool errors are handled without logging raw database
diagnostics; the driver replaces the failed idle client or later work fails closed.
No automatic migration, seed, verification renewal, activation, or run retry exists.

After human diff review and separate operational authorization:

1. Follow the existing deployment database safety gate before any API wake/restart.
2. Apply `apps/api/migrations/002_registry.sql` after migration 001 using the
   approved migration operator and documented `psql --single-transaction` command.
   The migration is repeatable, but back up existing data first.
3. Grant the runtime role the documented registry table permissions and reserve
   capacity for both API connection pools, then confirm startup readiness passes.
4. Build the API with `npm run build:api` and deploy it under separate approval.
5. Old in-memory records are not imported. If lost, perform fresh onboarding,
   real World verification, and explicit service activation. Old run receipts
   cannot authorize verification or restore replay history.
6. Only then consider a separately approved new Recipe run. FAILED runs remain
   terminal and are not retried by this change.

The existing deployment notes describe the old deployment until this fix is
actually deployed. Keep API auto-deploy/uptime pings disabled and retain its
startup payment-safety gate. Database persistence does not remove verification
expiry or protect against database loss. Historical replay claims lost before
migration cannot be recovered by this patch.

## Local validation

- API focused suite: 320 tests passed; the 9 opt-in PostgreSQL tests were skipped
  in this ordinary run.
- PostgreSQL integration: all 9 tests passed against a disposable loopback-only
  PostgreSQL 17.11 cluster. The test applied migration 002 twice and covered an
  incomplete table, forged and unvalidated CHECK constraints, a mis-mapped foreign
  key, disabled enforcement triggers, restart persistence, concurrent replay,
  database-level rollback, verification expiry, snapshot constraints, and
  concurrent activation. The cluster was then stopped and deleted.
- The declared `qrcode@1.5.4` dependency was restored with `npm ci`; neither
  package manifests nor `package-lock.json` changed.
- Final lint, typecheck, build, diff, and full validation results are recorded in
  the human review report produced with this change.

No live database query/mutation, deployment, service restart, payment request,
Recipe execution, commit, push, or PR was performed. Local database mutations
were confined to the authorized disposable PostgreSQL integration cluster. An
initial GET discovery attempt was blocked by the local network sandbox; it was
not retried after the deployment wake/reconciliation hazard was identified.
