# ProofServe

ProofServe is a human-gated service registry for autonomous buyers. A provider
registers a paid AI service, completes a time-limited World Selfie Check, and
explicitly activates the service. An embedded buyer agent can then discover the
eligible service, pay its HTTP 402 challenge on Hedera testnet through Blocky402,
and receive a Gemini-generated support-ticket triage result.

The project addresses a practical trust gap in agent commerce: a buyer needs a
machine-readable way to find a service, enforce a budget, make a real payment,
and retain evidence, while the registry needs a meaningful human-presence gate
before a provider can receive traffic. ProofServe combines those steps without
putting payment keys, World signing material, the Gemini key, or the API run token
in the browser.

## Live demo

| Component         | URL                                                                                   | Deployed source                                     |
| ----------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Next.js Web       | [proofserve-y06-web.onrender.com](https://proofserve-y06-web.onrender.com)             | `a6abcdd8ffea270097b2789cc4405655f67000ac`          |
| API + buyer agent | [proofserve-y06-api.onrender.com](https://proofserve-y06-api.onrender.com)             | `4580b20c67135fd857389c919972112235961f44`          |
| Protected triage  | [proofserve-y06-triage.onrender.com](https://proofserve-y06-triage.onrender.com)       | `4580b20c67135fd857389c919972112235961f44`          |

The reproducible public demo source is the
`release/hedera-world-demo` branch. That branch combines the I05 Web timeline at
the Web commit above with API, buyer-agent, shared, and triage sources unchanged
from the API/triage commit above.

These deployed versions are not the latest `main`. PR 23's PostgreSQL-backed
registry and nonce-bound World verification upgrade is merged into `main`, but it
has not been deployed; production migration `002_registry` was absent at the
latest recorded check on 2026-09-13. Do not deploy the `main` Web alone against
the older live API. The upgrade changes the World verification contract and
requires migration 002 plus a coordinated, matching Web/API rollout under
separate operational authorization.
The Bazantic T05 recipe remains incomplete and is outside this submission's scope.

## Implemented features

- Provider and service registration with explicit service activation.
- World Selfie Check eligibility gating: an unverified provider can create a
  draft service, but cannot activate it. Discovery and the buyer agent admit only
  active services whose provider verification is current, and eligibility is
  checked again before payment.
- A responsive Next.js onboarding, registry, and authorized agent-run timeline.
  The browser shows authoritative backend events, a result when one exists, and
  settlement evidence even when later execution fails.
- A server-side buyer agent embedded in the API, with capability, Hedera network,
  asset, and maximum-price selection constraints.
- A protected support-ticket triage endpoint using the x402 protocol,
  Blocky402/Hedera testnet settlement, and Gemini inference.
- PostgreSQL-backed durable agent-run snapshots and permanent payment tombstones
  for payment reconciliation and duplicate-payment protection.

World Selfie Check is used here as a low-assurance, time-limited liveness signal
for service eligibility. It does **not** guarantee a unique real-world identity,
the quality of an AI service, or production-grade authorization. Verification
does not activate a service by itself, and expiry makes a service ineligible.

## Architecture

```text
Browser
  -> Next.js Web (same-origin registry, World, and agent-run boundaries)
  -> API (registry plus embedded buyer agent)
  -> protected Triage service (x402 + Blocky402/Hedera + Gemini)

API -> PostgreSQL (durable run and payment records)
```

The deployed API keeps provider, service, World-verification, and replay state in
process memory; only runs and payment safety records are durable in PostgreSQL.
An API restart therefore loses the deployed registry state and must be treated as
a payment-capable event. PR 23 changes that model on `main`, but is not live.

## x402 payment flow

1. An authorized demo user submits a support ticket and maximum tinybar budget to
   the Web's same-origin server route. The Web attaches the API bearer token only
   on the server.
2. The API's embedded buyer agent discovers an active service with current World
   verification and rechecks its endpoint, eligibility, network, asset, and price.
3. The agent calls the protected triage endpoint without payment and receives an
   HTTP 402 payment requirement.
4. After validating the challenge and budget, the agent writes a permanent
   payment tombstone before signing, submits the Hedera testnet payment, and
   retries the request with the x402 payment payload.
5. The triage service uses Blocky402 to verify and settle payment, then asks Gemini
   for a structured triage result.
6. PostgreSQL retains the run timeline, known payment requirement, receipt, and
   terminal result or error. Settlement can precede a later service failure, so a
   failed run must not be described as unpaid, refunded, or safe to retry.

## Setup

Use Node.js 22 (at least 22.18.0 and below 23) and npm 10 or 11. To reproduce the
deployed source combination:

```sh
git switch release/hedera-world-demo
git rev-parse HEAD
nvm install
nvm use
npm ci --include=dev
npm run build:web
npm run build:api
npm run build:service
```

The expected branch HEAD is
`a6abcdd8ffea270097b2789cc4405655f67000ac`; its API, agent, shared, and service
trees match `4580b20c67135fd857389c919972112235961f44`.

Configure the three processes separately using the complete server-only variable
inventory and ordered database gates in the [deployment guide](docs/deployment.md).
Do not copy secrets into a committed file or expose them through `NEXT_PUBLIC_*`.
The Web is a Node server, not a static export. The buyer agent is embedded in the
API; there is no fourth HTTP process.

Builds do not initiate verification or payment. Starting, restarting, cold-starting,
or waking a funded API can resume a nonterminal run and cause payment or service
execution. Never start or wake it until the applicable database migration,
readiness check, and read-only zero-nonterminal-run gate have passed. Use exactly
one API instance, keep automatic API deploys and uptime pings disabled, and never
delete durable run, receipt, transaction, or payment-tombstone records to reset a
demo. The deployment guide contains the separate migration-001 gate for the live
demo and the migration-002 gate required before any `main` rollout.

For ordinary development validation after dependencies are installed, run:

```sh
npm run validate
```

## Recorded evidence

The completed backend G4 run on 2026-09-12 was
`c77644a4-7a77-421c-915d-43003624634a`. It settled exactly 1 tinybar, returned a
valid Gemini triage result, and finished `COMPLETED`. The Hedera transaction is
[visible on HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1789248503-871191363).

On 2026-09-13, an unverified activation was blocked; genuine World verification
succeeded; and provider `3153fa2c-d86b-4f33-b214-8b03f71accbe` explicitly
activated service `5e58802c-50a7-4abc-9584-2c57201c8033`, which was then
discoverable. Browser run `191bea42-eb4e-461d-b3ef-831821c533ee` settled 1
tinybar in transaction `0.0.7162784@1789312272.544961517` but ended `FAILED` with
`SERVICE_EXECUTION_FAILED`. It was not a successful AI run. A subsequent
authorized attempt is pending; no outcome or video URL is claimed.

## Documentation and attribution

- [World integration feedback](docs/world-feedback.md)
- [Deployment, configuration, and safety guide](docs/deployment.md)
- [API contract](docs/api-contract.md)
- [Attributions](ATTRIBUTIONS.md)

The repository uses npm workspaces for `apps/web`, `apps/api`, `apps/agent`,
`apps/service`, and `packages/shared`. See [AGENTS.md](AGENTS.md) and the
[team playbook](docs/ProofServe-Team-Build-Playbook.md) for ownership and review
rules.
