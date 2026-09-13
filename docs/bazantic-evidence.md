# Bazantic T05 evidence

## Acceptance status

**Live acceptance: NOT RUN / NOT AUTHORIZED.**

**Gateway bindings, retry limits, and Bazantic schema support: NOT VERIFIED.**

This branch contains local documentation and configuration preparation only. It
does not prove that the Gateway is configured, the Recipe is saved, Mirror Node
is accepted as Bazantic's second service, a provider is currently verified, a
service is active, or a live run succeeds. No production endpoint, Bazantic
Recipe, World verification, or payment was invoked while preparing this file.

## Repository source of truth

- Recipe artifact: [`../recipes/bazantic-verified-paid-service.md`](../recipes/bazantic-verified-paid-service.md)
- Required flow: one `createAgentRun` POST, observation through `getAgentRun`,
  then independent confirmation through Hedera testnet Mirror Node
  `getTransaction`.
- Agent-code assessment: no change required. The existing buyer already performs
  service discovery, current-verification and allowlist checks, arbitrary-
  precision budget enforcement, durable payment ownership, one paid submission,
  and no automatic payment retry.

## Recipe and Gateway configuration checklist

All unchecked items require a human with Bazantic access and separate live
authorization.

- [ ] Record the Bazantic username: `<BAZANTIC_USERNAME>`.
- [ ] Confirm in Bazantic that the Hedera Mirror Node REST endpoint qualifies as
      the required second Bazantic/sponsor service and can be used by this Recipe.
- [ ] If Mirror Node is not accepted, stop and choose a confirmed ETHOnline
      sponsor service whose output can meaningfully verify the ProofServe result;
      do not simulate or weaken the second step.
- [ ] Configure the ProofServe Gateway origin:
      `<PROOFSERVE_API_ORIGIN>`.
- [ ] Bind `AGENT_RUN_API_TOKEN` as a Gateway-managed bearer secret; confirm it
      is absent from prompts, inputs, outputs, logs, screenshots, and recordings.
- [ ] Configure `createAgentRun` as `POST /api/agent/runs`, successful only on
      HTTP 202, with automatic retries disabled.
- [ ] Configure `getAgentRun` as `GET /api/agent/runs/{runId}`, successful only
      on HTTP 200, with no body or query parameters; confirm polling uses only
      the original `runId`, waits the configured interval, and stops after the
      configured maximum attempts.
- [ ] Configure `getTransaction` against the fixed
      `https://testnet.mirrornode.hedera.com` origin and
      `GET /api/v1/transactions/{transactionId}` with automatic retries disabled.
- [ ] Apply the exact input, tool, AgentRun, API error, and single discriminated
      output schema from the repository Recipe artifact; record whether Bazantic
      accepts every schema feature.
- [ ] Paste the exact Recipe prompt from the repository artifact without its
      Markdown fence.
- [ ] Verify the Recipe exposes required `ticket` and `maxAmountAtomic`, plus
      optional bounded `polling_interval_seconds` and `max_polling_attempts`;
      network, asset, and capability remain fixed.
- [ ] Verify the Recipe's final output depends on both the completed ProofServe
      result and exact Mirror Node transaction confirmation, including a strictly
      positive transfer to `paymentReceipt.paymentRequirements.payTo`.
- [ ] Save the Gateway and Recipe configuration.
- [ ] Obtain explicit authorization before any live acceptance attempt.

## Historical failed run

This is failure evidence only and must never be presented as successful T05
acceptance.

- Run ID: `e11a63c7-12b9-4aed-b58f-1152db864055`
- Accepted: HTTP 202 at `2026-09-12T23:27:11.712Z`
- Entered `DISCOVERING`: `2026-09-12T23:27:11.751Z`
- Failed: `2026-09-12T23:27:12.014Z`
- Terminal status: `FAILED`
- Error code: `NO_ELIGIBLE_SERVICE`
- Capability: `SUPPORT_TICKET_TRIAGE`
- Budget: `1` tinybar on `hedera:testnet`, asset `0.0.0`
- Selection: `null`
- Payment requirements: `null`
- Payment receipt: `null`
- Result: `null`
- Classification: discovery failure, not payment failure
- Detailed diagnosis: [`bazantic-t05-discovery-fix.md`](bazantic-t05-discovery-fix.md)

The durable-registry repair is merged in commit
`9e1403e342f17fc13d85d19544434a155965281b`, but it has not been established in
this work that the matching Web/API rollout, fresh World verification, explicit
service activation, or Bazantic reconfiguration occurred. The failed run is
terminal and must not be retried.

## Future successful-run evidence

**Status: NOT RUN / NOT AUTHORIZED.** Replace placeholders only with evidence
captured during a separately authorized acceptance run. Do not use fictional or
local fixture data.

### Input

```json
{
  "ticket": "<LIVE_ACCEPTANCE_TICKET>",
  "maxAmountAtomic": "<CANONICAL_POSITIVE_TINYBAR_BUDGET>",
  "polling_interval_seconds": 5,
  "max_polling_attempts": 60
}
```

### Successful Recipe output

```text
<PASTE_SCHEMA_VALID_RECIPE_SUCCESS_JSON>
```

### ProofServe run

- Run ID: `<RUN_ID>`
- Created at: `<TIMESTAMP>`
- Completed at: `<TIMESTAMP>`
- Selected service ID: `<SERVICE_ID>`
- Terminal status: `<COMPLETED>`
- Event timeline: `<PASTE_OR_LINK_CAPTURED_TIMELINE>`
- AI result: `<PASTE_RESULT_JSON>`

### Payment receipt

- Receipt ID: `<RECEIPT_ID>`
- Amount atomic: `<AMOUNT_ATOMIC>`
- Asset/network: `<ASSET>` / `<NETWORK>`
- Pay-to account: `<HEDERA_ACCOUNT_ID>`
- Receipt transaction ID, unchanged: `<SHARD.REALM.NUM@SECONDS.NNNNNNNNN>`
- Receipt transaction URL, unchanged: `<RECEIPT_TRANSACTION_URL>`
- Settled at: `<TIMESTAMP>`
- Receipt JSON: `<PASTE_RECEIPT_JSON>`

### Mirror Node confirmation

- Request path: `<GET /api/v1/transactions/SHARD.REALM.NUM-SECONDS-NANOS>`
- `mirrorLookupTransactionId`: `<SHARD.REALM.NUM-SECONDS-NANOS>`
- Response `transaction_id` exactly matches `mirrorLookupTransactionId`: `<YES>`
- Matching records: `<1>`
- Result/name: `<SUCCESS>` / `<CRYPTOTRANSFER>`
- Scheduled/nonce: `<false>` / `<0>`
- Positive transfer account equals receipt `payTo`: `<YES>`
- Positive transfer amount: `<POSITIVE_INTEGER_TINYBARS>`
- Response captured at: `<TIMESTAMP>`
- Redacted response: `<PASTE_OR_LINK_CAPTURED_RESPONSE>`

### Screenshots

- Gateway tools and retry settings: `<PATH_OR_URL>`
- Exact Recipe prompt and schemas: `<PATH_OR_URL>`
- Recipe input: `<PATH_OR_URL>`
- Completed ProofServe output: `<PATH_OR_URL>`
- Mirror Node confirmation: `<PATH_OR_URL>`
- Final combined Recipe result: `<PATH_OR_URL>`

### Recording

- Complete screen recording: `<PATH_OR_URL>`
- Recorded at: `<TIMESTAMP>`
- Shows username, Gateway, Recipe, single POST, bounded polling, terminal run,
  unchanged receipt values, positive-recipient-transfer Mirror confirmation,
  and combined output: `<YES/NO>`

## Human acceptance sequence

After the rollout and live actions are separately authorized:

1. Confirm the public deployment is the intended merged commit and passes its
   operational readiness gates.
2. Perform fresh World verification and explicit service activation if needed.
3. Confirm current discovery returns an active, currently verified matching
   service within the chosen budget without invoking the Recipe.
4. Confirm Bazantic accepts the configured Mirror Node tool as the required
   second service.
5. Start one recorded Recipe execution. Do not repeat its POST if the outcome is
   delayed or unknown.
6. Capture the terminal run, unchanged receipt values, exact Mirror Node response
   including the positive recipient transfer, Bazantic combined output,
   screenshots, and recording above.
7. Review all evidence for secrets before committing any future update.
