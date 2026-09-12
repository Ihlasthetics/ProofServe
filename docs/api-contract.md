# ProofServe API contract — Y01 with Y04 World verification

Y01 defined the shared contracts; Y02 implemented the registry behavior and Y04
implemented the World verification and activation gate described here. Later
agent-run and payment operations remain planned until their named tasks. Zod
schemas and inferred TypeScript types are exported from `@proofserve/shared`.
All public objects, including nested objects, reject unexpected fields. Fields
are required unless explicitly optional; nullable fields must be present as JSON
null when no value exists. JSON schema annotations below are used by the
documentation compatibility tests.

The API JSON boundary rejects duplicate decoded object-member names before
ordinary object construction, at every nesting level. This includes escaped
equivalents such as `"action"` and `"\u0061ction"`. Parsing retains Fastify's
1 MiB default body limit and adds a 64-container nesting limit.

## Common values and policy

- Identifiers are opaque, case-sensitive, 1–128 ASCII letters, digits, underscores,
  or hyphens, beginning with a letter or digit. Servers assign resource IDs.
- All timestamps use UTC ISO 8601 with exactly three fractional digits and a
  trailing Z: `2026-09-06T10:00:00.000Z`. Offsets, local times, invalid dates,
  and leap seconds are rejected. Server timestamps are authoritative.
- Atomic amounts are canonical positive base-10 integer strings matching
  `^[1-9][0-9]*$`. Numbers, leading zeros, whitespace, zero, negative signs,
  decimals, and scientific notation are rejected. No Number conversion is
  permitted. Later implementations compare strings safely or use BigInt.
- `amountAtomic` is the per-request price; `maxAmountAtomic` is the task's
  maximum payment. Compare amounts only after matching network and asset.
- MVP network: `hedera:testnet`; MVP asset: `0.0.0` (HBAR).
  HBAR amounts are tinybars: 1 HBAR = 100000000 tinybars.
  `1000000` tinybars is 0.01 HBAR. No mainnet or custom-token support in Y01.
- The reusable asset/account identifier syntax is numeric `shard.realm.num`
  with no leading zeros per segment. Syntax does not prove an account exists.
  Payment schemas restrict assets to HBAR even though the reusable identifier
  schema can describe other entity IDs. Account aliases are outside this MVP.
- A payment requirement contains network, asset, amountAtomic, and payTo (the
  payout account). A budget contains network, asset, and maxAmountAtomic.
  These are ProofServe domain objects, not x402 wire-format schemas. Y03/T04
  must map the pinned payment SDK's wire format into these contracts.
- URL fields require absolute HTTP(S) URL syntax. A syntactically valid URL is
  not trusted. Later backend work must use a team-controlled endpoint allowlist
  and prevent SSRF, including redirect and DNS/private-address bypasses.
  Service creation selects an endpoint from trusted server configuration;
  there is no client endpoint field in its request.
- Display names and service names are 1–120 characters; descriptions 1–1000;
  tickets 1–10000. Triage results contain category (1–120), urgency
  (low/medium/high), summary (1–1000), and suggestedAction (1–2000).
  These are output contracts, not an inference implementation.

## Verification privacy and eligibility

VerificationRecord contains only providerId, method (WORLD_SELFIE_CHECK), status,
verifiedAt, and expiresAt. UNVERIFIED has null timestamps; VERIFIED and EXPIRED
require both timestamps, with expiresAt after verifiedAt. No raw proof payload,
selfie image, biometric data, secret, private key, or arbitrary metadata is accepted.
The strict UnverifiedVerificationRecordSchema, VerifiedVerificationRecordSchema,
and ExpiredVerificationRecordSchema compose VerificationRecordSchema.
Provider embeds this record; its providerId must equal the provider's id.

A current verification means VERIFIED and verifiedAt <= server time < expiresAt.
ProofServe's freshness window is server-configured policy, separate from World's
credential inactivity behavior. Schemas do not consult the clock or establish
human liveness. Fixed fixture dates and the example 24-hour interval are not policy.

1. An unverified provider may create a DRAFT service.
2. A service cannot become ACTIVE without a current VERIFIED provider record.
3. Expiration immediately makes a service ineligible for discovery and payment,
   even if its stored service status remains ACTIVE.
4. Re-verification will be required before activating a service, changing its
   endpoint, changing the Hedera payout account, or reactivating a suspended
   service. The initial activation may use the current successful verification;
   subsequent sensitive operations need renewed verification. Y04 must define
   the server-side operation binding and freshness policy; this snapshot format
   does not prove that an operation was authorized.
5. Buyer agents may use only ACTIVE services with current provider verification.
   The backend/agent must recheck eligibility at selection and before payment.
6. Refuse payment if the requested atomic amount exceeds the task's maximum
   atomic amount. Match quoted network, asset, and recipient to the selected
   service; a receipt is evidence only after real settlement verification.
7. Schema validation does not replace server-side authorization, ownership
   checks, replay protection, endpoint allowlisting, or settlement verification.

## Enums and planned transitions

| Enum               | Value                 | Meaning                                                         |
| ------------------ | --------------------- | --------------------------------------------------------------- |
| VerificationStatus | UNVERIFIED            | No successful verification recorded                             |
| VerificationStatus | VERIFIED              | Successfully verified; check expiry at use time                 |
| VerificationStatus | EXPIRED               | Previous verification is no longer current                      |
| ServiceStatus      | DRAFT                 | Registered but not discoverable or payable                      |
| ServiceStatus      | ACTIVE                | Activated; eligible only while provider verification is current |
| ServiceStatus      | SUSPENDED             | Disabled; not discoverable or payable                           |
| AgentRunStatus     | CREATED               | Task accepted                                                   |
| AgentRunStatus     | DISCOVERING           | Searching eligible services                                     |
| AgentRunStatus     | SELECTED              | Service selected                                                |
| AgentRunStatus     | PAYMENT_REQUIRED      | Payment requirements received                                   |
| AgentRunStatus     | PAYING                | Settlement being attempted                                      |
| AgentRunStatus     | PAID                  | Settlement confirmed                                            |
| AgentRunStatus     | EXECUTING             | Paid request executing                                          |
| AgentRunStatus     | COMPLETED             | Result available                                                |
| AgentRunStatus     | FAILED                | Terminal failure; payment may already have settled              |
| ServiceCapability  | SUPPORT_TICKET_TRIAGE | Text support-ticket classification                              |

Verification: UNVERIFIED -> VERIFIED on server-confirmed verification;
VERIFIED -> EXPIRED at expiry; EXPIRED -> VERIFIED on renewed verification.
VERIFIED -> VERIFIED is allowed when re-verification is required for a sensitive
operation, replacing the timestamps. Failed attempts never promote status.

Service: DRAFT -> ACTIVE after the verification gate; ACTIVE -> SUSPENDED;
SUSPENDED -> ACTIVE after re-verification. No transition back to DRAFT.
Suspension and sensitive-edit routes are future contracts, not Y01 endpoints.

Run: CREATED -> DISCOVERING -> SELECTED -> PAYMENT_REQUIRED -> PAYING -> PAID
-> EXECUTING -> COMPLETED. Any nonterminal state may transition to FAILED.
COMPLETED and FAILED are terminal; a retry creates a new run. T01 implements and
tests transitions using fixtures. No state machine implementation is supplied here.

Run snapshots include the task, selectedServiceId, paymentRequirements,
paymentReceipt, result, error, events, createdAt, and updatedAt. Selection is
required from SELECTED onward; requirements from PAYMENT_REQUIRED onward;
a receipt from PAID onward. Result is non-null only for COMPLETED; error only for
FAILED. A failed run retains known selection/payment data, including a settled
receipt when execution fails after payment. A receipt identifies its run and
selected service. When a receipt is present, the run must have paymentRequirements
and its network, asset, amountAtomic, and payTo must exactly match the receipt's
paymentRequirements. Events are chronological status entries and the final event
matches the snapshot status. Servers must enforce transition legality and timeline
ordering; schema parsing alone does not validate event history or real settlement.

A PaymentReceipt includes id, runId, serviceId, paymentRequirements, transactionId,
transactionUrl, and settledAt. Transaction IDs are nonempty opaque strings;
URLs validate syntax only. Y03/Y05 must supply genuine settlement IDs and derived
HashScan links. Client-submitted receipts are not accepted by these endpoints.

## Standard errors

All failures use ApiErrorResponseSchema. Error code is machine-readable; message
is safe display text, never a stack trace, proof payload, or secret. No arbitrary
`details` object is accepted.

<!-- schema: ApiErrorResponseSchema -->

```json
{
  "error": {
    "code": "PROVIDER_VERIFICATION_REQUIRED",
    "message": "Current provider verification is required."
  }
}
```

| HTTP status | Codes                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| 400         | VALIDATION_ERROR, WORLD_PROOF_INVALID                                   |
| 401         | UNAUTHORIZED                                                            |
| 403         | FORBIDDEN, PROVIDER_VERIFICATION_REQUIRED, ENDPOINT_NOT_ALLOWED         |
| 404         | PROVIDER_NOT_FOUND, SERVICE_NOT_FOUND, RUN_NOT_FOUND                    |
| 409         | SERVICE_STATE_CONFLICT, WORLD_PROOF_REPLAYED, PROVIDER_ALREADY_VERIFIED |
| 422         | NO_ELIGIBLE_SERVICE, BUDGET_EXCEEDED                                    |
| 502         | PAYMENT_FAILED, SERVICE_EXECUTION_FAILED                                |
| 503         | WORLD_VERIFICATION_UNAVAILABLE                                          |
| 500         | INTERNAL_ERROR                                                          |

Every endpoint may return 400 for malformed boundary data and 500 for unexpected
server failures. Future protected routes also use 401/403 for identity/ownership
failures; Y01 does not select or implement authentication. Codes for asynchronous
run failures appear in a FAILED run's error, rather than changing a successful
GET response to an HTTP failure.

## POST /api/providers

Purpose: register a provider, initially UNVERIFIED. Server assigns id and
timestamps; the caller cannot supply verification or status.
Request: CreateProviderRequestSchema.

<!-- schema: CreateProviderRequestSchema -->

```json
{
  "displayName": "Fictional unverified operator",
  "payoutAccount": "0.0.123457"
}
```

Success: 201, CreateProviderResponseSchema.

<!-- schema: CreateProviderResponseSchema -->

```json
{
  "id": "provider_example_unverified",
  "displayName": "Fictional unverified operator",
  "payoutAccount": "0.0.123457",
  "verification": {
    "providerId": "provider_example_unverified",
    "method": "WORLD_SELFIE_CHECK",
    "status": "UNVERIFIED",
    "verifiedAt": null,
    "expiresAt": null
  },
  "createdAt": "2026-09-06T10:00:00.000Z",
  "updatedAt": "2026-09-06T10:00:00.000Z"
}
```

Failures: 400 VALIDATION_ERROR (invalid account, missing fields, or supplied
verification/status). Registration does not perform World verification or confer
permission to activate a service. Payout changes will require re-verification.

## POST /api/providers/:providerId/verification/world/request

Purpose: obtain the signed RP context and public, provider-bound IDKit settings
needed to launch the IDKit 4.x Selfie Check widget. Path id uses
ProviderParamsSchema. The request is exactly an empty JSON object. The server
derives `signal` from the validated provider id as
`proofserve:provider:<providerId>` and signs only the configured World action.
The client cannot choose the action, signal, app id, RP id, environment, or key.

Request: WorldVerificationContextRequestSchema.

<!-- schema: WorldVerificationContextRequestSchema -->

```json
{}
```

Success: 200, WorldVerificationContextResponseSchema. Pass `app_id`, `action`,
`environment`, `rp_context`, `allow_legacy_proofs`, and
`require_user_presence` to `IDKitRequestWidget`; pass `signal` to
`selfieCheckLegacy({ signal })`. The pinned IDKit 4.2.4 client environments are
`production`, `staging`, and `sandbox`; Sandbox configuration returns the
exact `sandbox` destination needed by the Sandbox World application. The
signing key is never public. Final I04 widget compatibility will be verified
after I04 pins its frontend IDKit dependency.

<!-- schema: WorldVerificationContextResponseSchema -->

```json
{
  "app_id": "app_sandbox_00000000000000000000000000000000",
  "action": "proofserve-provider-verification",
  "signal": "proofserve:provider:provider_example_unverified",
  "environment": "sandbox",
  "rp_context": {
    "rp_id": "rp_00000000000000000000000000000000",
    "nonce": "0x1111111111111111111111111111111111111111111111111111111111111111",
    "created_at": 1789034400,
    "expires_at": 1789034700,
    "signature": "0x2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222"
  },
  "allow_legacy_proofs": true,
  "require_user_presence": true
}
```

Failures: 400 VALIDATION_ERROR; 404 PROVIDER_NOT_FOUND;
409 PROVIDER_ALREADY_VERIFIED; 503 WORLD_VERIFICATION_UNAVAILABLE. Unknown or
malformed requests are rejected before signing.

## POST /api/providers/:providerId/verification/world

Purpose: verify or renew a provider's human-liveness metadata. Path id uses
ProviderParamsSchema. Success only follows real server-side verification.

Request: WorldVerificationRequestSchema, the strict legacy 3.0 `IDKitResult`
returned by IDKit 4.x `selfieCheckLegacy`. `action_description` and the official
`integrity_bundle` are optional; every other illustrated field is required.
The body rejects unknown fields, other credential identifiers, v4/session proof
shapes, absent signal hashes, and absent or false user presence. No legacy
`verification_level` field exists in this contract. IDKit 4.2.4 describes the
legacy proof as ABI-encoded hex but does not publish a fixed byte length in its
TypeScript type, so the runtime contract requires nonempty, even-length hex
without inventing a length restriction. The fictional example uses a realistic
256-byte legacy proof value.

When present, `integrity_bundle` is a strict object whose five fields are all
required. `version` is numeric `1` or `2`; `signature_format` is
`apple_app_attest` or `android_keystore`; `timestamp` is a nonnegative safe
integer; `signature` is 1–8,192 characters of unprefixed ASCII hexadecimal with
an even character count; and `jwt` is a 1–8,192-character string. The serialized
bundle may not exceed 8,192 UTF-8 bytes. In particular, the integrity signature
does not use the ordinary proof field's `0x`-prefixed wire format. These bounds
come from the current Developer Portal
[`request-schema.ts`](https://github.com/worldcoin/developer-portal/blob/main/web/api/v4/verify/request-schema.ts),
while IDKit 4.2.4 supplies the same five-field result type and forwards the
bundle without normalization.

<!-- schema: WorldVerificationRequestSchema -->

```json
{
  "protocol_version": "3.0",
  "nonce": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "action": "proofserve-provider-verification",
  "responses": [
    {
      "identifier": "selfie",
      "signal_hash": "0x00ba3a74d38621e40e736b57d28b5e96c2307cba5a9a82454f0cf8653e2d0db4",
      "proof": "0x66666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666",
      "merkle_root": "0x3333333333333333333333333333333333333333333333333333333333333333",
      "nullifier": "0x4444444444444444444444444444444444444444444444444444444444444444"
    }
  ],
  "user_presence_completed": true,
  "environment": "sandbox"
}
```

The server checks the configured action and environment and compares
`signal_hash` with `hashSignal` from the pinned official SDK using the derived
provider signal. It forwards the complete validated result without field
remapping to the fixed endpoint
`POST https://developer.world.org/api/v4/verify/{configured_rp_id}`. The RP id
comes only from server configuration. A successful upstream result must confirm
the selfie response and the submitted nullifier. For this legacy Selfie Check,
the current uniqueness-handler success body must contain exactly `success:
true`, `protocol_version: "3.0"`, one successful `selfie` result with its
nullifier, the matching `action`, the matching top-level `nullifier`, an optional
valid `created_at`, the matching `environment`, and a string `message`. Missing,
duplicate, malformed, unknown, or non-`3.0` protocol versions fail closed; the
server never inserts or rewrites that field. The older published OpenAPI success
schema omits `protocol_version`, so this contract follows the current Developer
Portal uniqueness-handler response instead and records that discrepancy here.
The endpoint remains
production-hosted for Sandbox requests; the submitted `environment: "sandbox"`
is not rewritten to staging.

Success: 200, WorldVerificationResponseSchema, which uses
VerifiedVerificationRecordSchema directly and infers the literal status VERIFIED.
UNVERIFIED and EXPIRED records are not successful responses. Store the verified record on the
provider and update the provider's updatedAt.

<!-- schema: WorldVerificationResponseSchema -->

```json
{
  "providerId": "provider_example_verified",
  "method": "WORLD_SELFIE_CHECK",
  "status": "VERIFIED",
  "verifiedAt": "2026-09-06T10:00:00.000Z",
  "expiresAt": "2026-09-07T10:00:00.000Z"
}
```

Failures: 404 PROVIDER_NOT_FOUND; 400 WORLD_PROOF_INVALID;
409 WORLD_PROOF_REPLAYED; 503 WORLD_VERIFICATION_UNAVAILABLE.
409 PROVIDER_ALREADY_VERIFIED applies to redundant verification when no renewal
is required; it must not block required re-verification for sensitive operations.
A failure never fabricates a verified record or exposes submitted proof data.
Only the canonical decimal form of the verified 256-bit nullifier is retained
for process-wide replay protection. Equivalent decimal or hexadecimal forms,
hex digit/prefix casing, and leading zeros resolve to the same key. The raw
IDKit result, proof, nonce, signal, RP signature, signing key, and upstream
response are not persisted or logged.
The replay check and provider update are one synchronous repository operation,
so concurrent equivalent submissions cannot both succeed. The default replay
store is shared by every repository/application instance in the Node process
while provider and service maps remain isolated. Tests may inject an isolated
replay store. A failed provider update rolls back its replay claim and provider
state. This MVP store survives repository/application recreation within the
process and resets only when the Node process restarts.

The upstream response is accepted only as the current strict v4 uniqueness
success shape described above. A structurally valid HTTP 400 carrying an exact
`all_verifications_failed` result for `invalid_proof`,
`invalid_merkle_root`, or `root_too_old` maps to WORLD_PROOF_INVALID. The current
legacy verifier uses a result shaped as
`{"identifier":"selfie","success":false,"code":"verification_error","detail":"..."}`
when its verification call throws; that is an operational exception and maps to
WORLD_VERIFICATION_UNAVAILABLE. Direct V2-style proof-error envelopes are not a
valid V4 response and also map to unavailable. Authentication, RP/configuration,
operational `verification_error`, unknown future codes, malformed bodies,
duplicate JSON members, unexpected statuses, redirects, rate limits, timeouts,
transport errors, and HTTP 200 `success: false` responses all fail closed as
WORLD_VERIFICATION_UNAVAILABLE. Upstream response details are never returned or
logged.

<!-- schema: ApiErrorResponseSchema -->

```json
{
  "error": {
    "code": "WORLD_PROOF_INVALID",
    "message": "World verification result is invalid."
  }
}
```

<!-- schema: ApiErrorResponseSchema -->

```json
{
  "error": {
    "code": "WORLD_PROOF_REPLAYED",
    "message": "World verification result has already been used."
  }
}
```

<!-- schema: ApiErrorResponseSchema -->

```json
{
  "error": {
    "code": "PROVIDER_ALREADY_VERIFIED",
    "message": "Provider verification is current and renewal is not required."
  }
}
```

<!-- schema: ApiErrorResponseSchema -->

```json
{
  "error": {
    "code": "WORLD_VERIFICATION_UNAVAILABLE",
    "message": "World verification is temporarily unavailable."
  }
}
```

## POST /api/services

Purpose: register a DRAFT service, including for an unverified provider.
Request: CreateServiceRequestSchema. Server selects the team-controlled endpoint
by capability and derives payTo from the provider's payoutAccount. The caller
cannot set endpoint, status, payTo, id, or timestamps.

<!-- schema: CreateServiceRequestSchema -->

```json
{
  "providerId": "provider_example_unverified",
  "name": "Example support ticket triage",
  "description": "Fictional development/test service.",
  "capability": "SUPPORT_TICKET_TRIAGE",
  "price": {
    "network": "hedera:testnet",
    "asset": "0.0.0",
    "amountAtomic": "1000000"
  }
}
```

Success: 201, CreateServiceResponseSchema.

<!-- schema: CreateServiceResponseSchema -->

```json
{
  "id": "service_example_draft",
  "providerId": "provider_example_unverified",
  "name": "Example support ticket triage",
  "description": "Fictional development/test service.",
  "capability": "SUPPORT_TICKET_TRIAGE",
  "endpoint": "https://triage.example.test/v1/triage",
  "status": "DRAFT",
  "paymentRequirements": {
    "network": "hedera:testnet",
    "asset": "0.0.0",
    "amountAtomic": "1000000",
    "payTo": "0.0.123457"
  },
  "createdAt": "2026-09-06T10:00:00.000Z",
  "updatedAt": "2026-09-06T10:00:00.000Z"
}
```

Failures: 400 VALIDATION_ERROR; 404 PROVIDER_NOT_FOUND;
403 ENDPOINT_NOT_ALLOWED if the configured endpoint fails the backend allowlist.
Creating a service never activates it or implies current verification.

## POST /api/services/:id/activate

Purpose: activate a DRAFT service or reactivate a SUSPENDED service after the
verification gate. Path id uses ServiceParamsSchema.
Request: ActivateServiceRequestSchema, exactly an empty JSON object.

<!-- schema: ActivateServiceRequestSchema -->

```json
{}
```

Success: 200, ActivateServiceResponseSchema. Example path id: service_example_active.

<!-- schema: ActivateServiceResponseSchema -->

```json
{
  "id": "service_example_active",
  "providerId": "provider_example_verified",
  "name": "Example support ticket triage",
  "description": "Fictional development/test service.",
  "capability": "SUPPORT_TICKET_TRIAGE",
  "endpoint": "https://triage.example.test/v1/triage",
  "status": "ACTIVE",
  "paymentRequirements": {
    "network": "hedera:testnet",
    "asset": "0.0.0",
    "amountAtomic": "1000000",
    "payTo": "0.0.123456"
  },
  "createdAt": "2026-09-06T10:00:00.000Z",
  "updatedAt": "2026-09-06T10:00:00.000Z"
}
```

Failures: 404 SERVICE_NOT_FOUND or PROVIDER_NOT_FOUND;
403 PROVIDER_VERIFICATION_REQUIRED for absent, expired, or otherwise insufficient
verification; 403 ENDPOINT_NOT_ALLOWED; 409 SERVICE_STATE_CONFLICT if already
ACTIVE. Reactivation requires renewed verification. Server sets updatedAt;
the example assumes activation at the fixture's reference time.

## GET /api/services

Purpose: discover only ACTIVE services whose providers have current verification.
No request body. Optional query parameters: capability, network, asset,
maxAmountAtomic. Query values are strings; duplicate keys and unknown parameters
must be rejected. With no filters, return all eligible MVP services. No pagination
is planned for this in-memory MVP. An empty match returns an empty services array.

Example URL:
`/api/services?capability=SUPPORT_TICKET_TRIAGE&network=hedera:testnet&asset=0.0.0&maxAmountAtomic=2000000`.
The uppercase capability is canonical; the playbook's earlier `ticket-triage`
query spelling is superseded by this contract, not an accepted alias.
Decoded query example (ListServicesQuerySchema):

<!-- schema: ListServicesQuerySchema -->

```json
{
  "capability": "SUPPORT_TICKET_TRIAGE",
  "network": "hedera:testnet",
  "asset": "0.0.0",
  "maxAmountAtomic": "2000000"
}
```

Success: 200, ListServicesResponseSchema. Each entry pairs a service with its
provider so T01/I01 can consume verification metadata without inventing shapes.
The server must ensure the two IDs match and enforce eligibility at request time.

<!-- schema: ListServicesResponseSchema -->

```json
{
  "services": [
    {
      "service": {
        "id": "service_example_active",
        "providerId": "provider_example_verified",
        "name": "Example support ticket triage",
        "description": "Fictional development/test service.",
        "capability": "SUPPORT_TICKET_TRIAGE",
        "endpoint": "https://triage.example.test/v1/triage",
        "status": "ACTIVE",
        "paymentRequirements": {
          "network": "hedera:testnet",
          "asset": "0.0.0",
          "amountAtomic": "1000000",
          "payTo": "0.0.123456"
        },
        "createdAt": "2026-09-06T10:00:00.000Z",
        "updatedAt": "2026-09-06T10:00:00.000Z"
      },
      "provider": {
        "id": "provider_example_verified",
        "displayName": "Fictional verified operator",
        "payoutAccount": "0.0.123456",
        "verification": {
          "providerId": "provider_example_verified",
          "method": "WORLD_SELFIE_CHECK",
          "status": "VERIFIED",
          "verifiedAt": "2026-09-06T10:00:00.000Z",
          "expiresAt": "2026-09-07T10:00:00.000Z"
        },
        "createdAt": "2026-09-06T10:00:00.000Z",
        "updatedAt": "2026-09-06T10:00:00.000Z"
      }
    }
  ]
}
```

Failures: 400 VALIDATION_ERROR for invalid filters, repeated keys, unsupported
network/asset, or a malformed budget. Price must be <= the filter maximum using
integer-safe comparison. This response is a snapshot, not an authorization to pay.

## POST /api/agent/runs

Purpose: accept a task and maximum budget for later server-side execution.
Request: CreateAgentRunRequestSchema (AgentTask). No caller-supplied state,
selected service, result, receipt, or signing credentials.

<!-- schema: CreateAgentRunRequestSchema -->

```json
{
  "capability": "SUPPORT_TICKET_TRIAGE",
  "input": {
    "ticket": "My payment was taken twice and nobody answered me."
  },
  "budget": {
    "network": "hedera:testnet",
    "asset": "0.0.0",
    "maxAmountAtomic": "2000000"
  }
}
```

Success: 202, CreateAgentRunResponseSchema, initially CREATED.

<!-- schema: CreateAgentRunResponseSchema -->

```json
{
  "id": "run_example_created",
  "task": {
    "capability": "SUPPORT_TICKET_TRIAGE",
    "input": {
      "ticket": "My payment was taken twice and nobody answered me."
    },
    "budget": {
      "network": "hedera:testnet",
      "asset": "0.0.0",
      "maxAmountAtomic": "2000000"
    }
  },
  "status": "CREATED",
  "selectedServiceId": null,
  "paymentRequirements": null,
  "paymentReceipt": null,
  "result": null,
  "error": null,
  "events": [
    {
      "status": "CREATED",
      "occurredAt": "2026-09-06T10:00:00.000Z"
    }
  ],
  "createdAt": "2026-09-06T10:00:00.000Z",
  "updatedAt": "2026-09-06T10:00:00.000Z"
}
```

Failures: 400 VALIDATION_ERROR for invalid task or budget. Once accepted,
NO_ELIGIBLE_SERVICE, BUDGET_EXCEEDED, PAYMENT_FAILED, and
SERVICE_EXECUTION_FAILED are reported in a FAILED run. No payment is made by
Y01. Later execution must check current eligibility and actual requested price
before payment, and never pay above the maximum budget.

## GET /api/agent/runs/:runId

Purpose: retrieve a run snapshot, event timeline, result, and available receipt.
No query parameters or request body. Path example (AgentRunParamsSchema):

<!-- schema: AgentRunParamsSchema -->

```json
{
  "runId": "run_example_completed"
}
```

Success: 200, GetAgentRunResponseSchema (AgentRun), including when status is FAILED.
This completed example is explicitly fictional development/test data. Its payment
receipt is not a real settlement and its explorer URL is deliberately reserved.

<!-- schema: GetAgentRunResponseSchema -->

```json
{
  "id": "run_example_completed",
  "task": {
    "capability": "SUPPORT_TICKET_TRIAGE",
    "input": {
      "ticket": "My payment was taken twice and nobody answered me."
    },
    "budget": {
      "network": "hedera:testnet",
      "asset": "0.0.0",
      "maxAmountAtomic": "2000000"
    }
  },
  "status": "COMPLETED",
  "selectedServiceId": "service_example_active",
  "paymentRequirements": {
    "network": "hedera:testnet",
    "asset": "0.0.0",
    "amountAtomic": "1000000",
    "payTo": "0.0.123456"
  },
  "paymentReceipt": {
    "id": "receipt_fictional_example",
    "runId": "run_example_completed",
    "serviceId": "service_example_active",
    "paymentRequirements": {
      "network": "hedera:testnet",
      "asset": "0.0.0",
      "amountAtomic": "1000000",
      "payTo": "0.0.123456"
    },
    "transactionId": "FICTIONAL-NOT-A-HEDERA-TRANSACTION",
    "transactionUrl": "https://explorer.example.test/fictional-transaction",
    "settledAt": "2026-09-06T10:00:05.000Z"
  },
  "result": {
    "category": "billing",
    "urgency": "high",
    "summary": "Possible duplicate payment",
    "suggestedAction": "Review payment records and contact the customer"
  },
  "error": null,
  "events": [
    {
      "status": "CREATED",
      "occurredAt": "2026-09-06T10:00:00.000Z"
    },
    {
      "status": "DISCOVERING",
      "occurredAt": "2026-09-06T10:00:01.000Z"
    },
    {
      "status": "SELECTED",
      "occurredAt": "2026-09-06T10:00:02.000Z"
    },
    {
      "status": "PAYMENT_REQUIRED",
      "occurredAt": "2026-09-06T10:00:03.000Z"
    },
    {
      "status": "PAYING",
      "occurredAt": "2026-09-06T10:00:04.000Z"
    },
    {
      "status": "PAID",
      "occurredAt": "2026-09-06T10:00:05.000Z"
    },
    {
      "status": "EXECUTING",
      "occurredAt": "2026-09-06T10:00:06.000Z"
    },
    {
      "status": "COMPLETED",
      "occurredAt": "2026-09-06T10:00:07.000Z"
    }
  ],
  "createdAt": "2026-09-06T10:00:00.000Z",
  "updatedAt": "2026-09-06T10:00:07.000Z"
}
```

Failures: 400 VALIDATION_ERROR for malformed runId or unexpected query parameters;
404 RUN_NOT_FOUND for an unknown run. A FAILED run after settlement retains its
receipt and does not imply a refund or authorize a second payment.

## Fixtures and handoff

All examples are fictional development/test data, use reserved example.test URLs,
and contain no credentials or signing keys. The shared fixtures parse through
real schemas on import. The exported fixtureReferenceTime is
2026-09-06T10:00:00.000Z and anchors all fixture timestamps. T01 and other mock
consumers must inject fixtureReferenceTime when testing time-dependent eligibility;
they must not use the computer's real current time with these fixed fixtures.
For expiry scenarios, inject an explicit offset from fixtureReferenceTime.
Never install a fixture-based success fallback in production.

Y02 implements registration, configured endpoints, ownership and activation gates,
and discovery eligibility using these contracts. Y04 resolves the explicitly
deferred World request and operation/replay policy. T01 implements the documented
run transitions with shared fixtures; I01 renders the same fixtures and identifies
them as demo data. Y03/T04/Y05 provide actual SDK mapping, settlement, inference,
and run events later. Team review and Y01 merge remain prerequisites for dependent
tasks; these contracts do not claim those integration steps are complete.
