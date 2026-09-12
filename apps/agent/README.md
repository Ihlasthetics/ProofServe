# T04 buyer

```ts
import { createBuyerRun } from '@proofserve/agent';

const handle = createBuyerRun(task, {
  runId,
  registryBaseUrl,
  allowedServiceEndpoint,
});
const snapshot = await handle.execute();
```

Preparation performs no network or signing activity. `task` uses shared `AgentTask`;
`execute()` returns shared `AgentRun` with the validated result and available receipt.
Invalid configuration or an already claimed run ID rejects with a safe `BuyerError`.

**Trust boundaries.** Both URLs must come from trusted server configuration and use
HTTPS, except canonical loopback HTTP URLs are accepted for local development. The
endpoint must be the exact canonical team-controlled `/v1/triage` URL, without
credentials, query, or fragment. Never derive the allowlist from task or registry
input. Redirects are rejected and credentials omitted. Keep these domains and DNS
under team control; arbitrary third-party endpoints are unsupported.

Production uses the official x402/Hedera client and ECDSA signer with server
environment `HEDERA_PAYER_ACCOUNT_ID` and `HEDERA_PAYER_PRIVATE_KEY`; the Y05 API
constructs this dependency before it listens. Keys, payment headers, signing bytes,
and raw errors are never logged or returned. Optional
`fetcher`, `signerFactory`, `ownership`, and `now` are trusted server/test boundaries, not remote
configuration. Budget comparisons use bigint, with one offer and one paid retry.

The real T02/T03 exports discover/select the service. Registry revalidation occurs
after the 402, after signer initialization, and after signing immediately before
submission. Identity, creation timestamps, capability, endpoint, status, price,
payee, provider payout, and all verification fields must still match and be eligible.
Descriptions, display names and general updatedAt fields may change. A client cannot
eliminate a remote change after the final registry response; atomic reservations
would require a future owner-approved protocol change.

HTTP/body/signing operations have a 30-second bound. Streaming limits before JSON
allocation are 1 MiB for discovery, 16 KiB for the discarded unpaid body, and 64 KiB
for the paid body. Injected responses must expose a readable byte stream, even for
empty bodies; missing streams fail closed. Readers are cancelled and unlocked.
Payment headers are limited to 16 KiB. Late signatures are never
submitted; the SDK signing interface itself cannot be cancelled.

**Receipts and time.** Settlement requires successful Y03 `PAYMENT-RESPONSE` evidence
and matching transaction ID/HashScan headers, including the fee-payer account. This
trusts the allowlisted service's settlement response, without another network lookup.
`settledAt` is buyer observation time, not consensus time (Y03 supplies none). If
the clock fails or moves backward after validated settlement, observation time is
projected from the last valid UTC sample plus local monotonic elapsed time, saturated
at the shared maximum `9999-12-31T23:59:59.999Z`. Equal event times are valid. The run
then fails with its receipt preserved. PAID/EXECUTING events reflect observation of
Y03's single paid response. Missing evidence never creates a receipt; an ambiguous
paid request must not be automatically repaid.

**Ownership lifecycle.** Only an omitted/undefined `runId` generates an ID; explicit
null and invalid IDs are rejected. Same-handle calls share one attempt and return
detached snapshots. The injectable `BuyerOwnership` interface claims an
ID temporarily and releases it on any pre-signing failure. Immediately before
signing, `beginSigning()` atomically converts the claim to a permanent payment
tombstone. Concurrent and later handles sharing that owner cannot execute that ID.
The durable Y05 owner also records the SDK-derived transaction ID, exact expected
transfer fields, and transaction-valid-until time before submission. A final
atomic ownership/version/validity fence runs immediately before transport. Signing
failures, timeouts, and ambiguous submissions retain their tombstones; raw signed
material is never persisted. After ownership ends, a tombstone without a recorded
transaction ID is safely terminalized because submission was never authorized. A
recorded transaction remains nonterminal in `PAYING`; only exact-transaction
reconciliation may recover its receipt or record an authoritative post-expiry
`PAYMENT_FAILED` outcome.

The default owner is shared within this loaded module, with capacity 4096. Inject
one shared `createInMemoryBuyerOwnership(capacity)` instance for a different limit;
do not create an owner per handle. Capacity counts only payment tombstones, so
pre-signing failures do not exhaust it. Full capacity fails closed before signing.
Temporary claims are released in execution cleanup; tombstones are never deleted
or evicted. Y05 owns authoritative reconciliation, durable persistence, restart and
multi-worker safety, and safe cleanup. Restarting or replacing an owner loses this
protection and must never be used to authorize repayment.
**Temporary SDK workaround.** Exact `@x402/core`/`@x402/hedera` versions remain 2.25.0.
Agent-only `skipLibCheck` accommodates the pinned Hiero SDK's invalid NodeNext
declarations (`long`, `bignumber.js`, extensionless imports, and Error.stack).
Application strict checks remain enabled. No root setting, SDK patch or `any` shim
was added; remove the override when upstream declarations are corrected.

Tests use offline injected transport/facilitator boundaries. One test exercises
real production signer construction with an ephemeral unfunded key, blocks network
access, and inspects the signature without submitting or fabricating settlement.
