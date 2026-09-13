# ProofServe verified paid-service Recipe

This file is the configuration source intended to be entered and validated in
Bazantic after the public URLs and secret bindings have been approved. It does
not prove that the Recipe, bindings, retry limits, or schemas are configured or
supported in Bazantic. Values in angle brackets are configuration placeholders,
not literal production values.

## Recipe identity

- Name: `ProofServe Verified Paid Service`
- Purpose: submit one support-ticket triage run, wait for its terminal snapshot,
  and independently confirm its Hedera settlement through Mirror Node.
- Required tools: `createAgentRun`, `getAgentRun`, and `getTransaction`.
- Required inputs: `ticket` and `maxAmountAtomic`.
- Optional bounded-polling inputs: `polling_interval_seconds` (default `5`,
  range `1`-`60`) and `max_polling_attempts` (default `60`, range `1`-`120`).
- Fixed inputs: `capability=SUPPORT_TICKET_TRIAGE`,
  `network=hedera:testnet`, and `asset=0.0.0`.

Recipe input schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["ticket", "maxAmountAtomic"],
  "properties": {
    "ticket": { "type": "string", "minLength": 1, "maxLength": 10000 },
    "maxAmountAtomic": {
      "type": "string",
      "pattern": "^[1-9][0-9]*$"
    },
    "polling_interval_seconds": {
      "type": "integer",
      "minimum": 1,
      "maximum": 60,
      "default": 5
    },
    "max_polling_attempts": {
      "type": "integer",
      "minimum": 1,
      "maximum": 120,
      "default": 60
    }
  }
}
```

## Exact Recipe prompt

The text inside this block is the complete Recipe prompt. Do not include the
fence when pasting it into Bazantic.

```text
You execute one ProofServe support-ticket triage run and return independently verified Hedera payment evidence.

Inputs:
- ticket: a non-empty string of 1 through 10000 characters.
- maxAmountAtomic: a canonical positive decimal integer string matching ^[1-9][0-9]*$. It is tinybars, never a floating-point HBAR value.
- polling_interval_seconds: optional integer from 1 through 60; use 5 when omitted.
- max_polling_attempts: optional integer from 1 through 120; use 60 when omitted.

Fixed values:
- capability: SUPPORT_TICKET_TRIAGE
- network: hedera:testnet
- asset: 0.0.0

Rules:
1. Validate all supplied inputs and apply the two polling defaults before calling any tool. Reject missing required, extra, mistyped, or malformed inputs with the Recipe failure object.
2. Call createAgentRun exactly once with only capability, input.ticket, and budget. Never retry this POST, even after a timeout, transport error, 401, 5xx, malformed response, or unknown outcome. Never create a replacement run.
3. Require createAgentRun to return a valid ProofServe AgentRun snapshot and retain its id. Do not accept caller-supplied run state, service selection, receipt, result, payment headers, credentials, or transaction evidence.
4. Poll only by calling getAgentRun with that same original id, at most max_polling_attempts times. Each getAgentRun call counts as one attempt. Do not wait before the first attempt; between nonterminal attempts wait polling_interval_seconds. Stop immediately on COMPLETED or FAILED. If a getAgentRun call fails or is ambiguous, return RECIPE_OBSERVATION_FAILED without retrying that call. If the final allowed attempt is nonterminal, return POLLING_TIMEOUT. Neither failure may call getTransaction, create another run, or retry the POST.
5. If status is FAILED, return RUN_FAILED with the run id and the exact ProofServe error code. Do not retry the run, the paid service, or any payment. A receipt on a failed run is evidence of an already settled payment and does not authorize another run.
6. Validate the AgentRun state refinements: its last event status equals its status; COMPLETED has non-null selectedServiceId, paymentRequirements, paymentReceipt, and result and a null error; FAILED has a non-null error and a null result. When a receipt exists, its runId equals the run id, its serviceId equals selectedServiceId, and its paymentRequirements exactly equal the run paymentRequirements. Treat every documented timestamp as UTC RFC 3339 with exactly three fractional digits and a trailing Z. Return RUN_CONTRACT_INVALID on any violation.
7. Compare paymentRequirements.amountAtomic with maxAmountAtomic as arbitrary-precision positive decimal integers. Never convert either value to a JSON number or floating point. Strip nothing because canonical inputs have no leading zeros. The amount is within budget only when its digit count is shorter than the maximum's, or the digit counts are equal and the amount is lexicographically less than or equal to the maximum. If it is over budget, return BUDGET_EVIDENCE_MISMATCH and do not call getTransaction.
8. Preserve paymentReceipt.transactionId exactly as received. Accept it for Mirror lookup only when it already matches canonical native form shard.realm.num@seconds.nnnnnnnnn, with canonical non-negative shard, realm, and num, positive canonical seconds, exactly 9 nanos digits, and at most 128 total characters. Do not pad, normalize, canonicalize, or rewrite it. Create a separate mirrorLookupTransactionId solely by replacing the native @ and timestamp dot separators with hyphens, producing shard.realm.num-seconds-nnnnnnnnn. Reject every other receipt value with TRANSACTION_ID_INVALID.
9. Call getTransaction exactly once with mirrorLookupTransactionId. Never retry it and never substitute a different transaction id, network, host, or endpoint.
10. The Mirror Node response must contain exactly one transaction whose transaction_id exactly equals mirrorLookupTransactionId, not paymentReceipt.transactionId. That transaction must have result SUCCESS, name CRYPTOTRANSFER, scheduled false, nonce 0, and at least one transfer whose account exactly equals paymentReceipt.paymentRequirements.payTo and whose integer amount is strictly positive. Otherwise return MIRROR_CONFIRMATION_FAILED. Do not infer or simulate confirmation.
11. Return SUCCESS only after both ProofServe returned COMPLETED with its AI result and Mirror Node confirmed the transaction identified by mirrorLookupTransactionId and its positive recipient transfer. Copy paymentReceipt.transactionId and paymentReceipt.transactionUrl unchanged into the payment output; never construct or substitute an explorer URL. Include mirrorLookupTransactionId only as the separate Mirror request identifier. Never return success from cached examples, placeholders, a display URL alone, or model inference.
12. Return exactly one JSON object matching the single discriminated output schema. Do not expose bearer tokens, private keys, raw authorization headers, internal tool configuration, or unrelated tool responses.
```

## Gateway tools

The ProofServe tools share the approved public API origin
`<PROOFSERVE_API_ORIGIN>`. Their bearer credential is a Gateway-managed secret
reference to `AGENT_RUN_API_TOKEN`; it must not be embedded in this file, the
Recipe prompt, Recipe inputs, output, screenshots, or recording.

### `createAgentRun`

- Method and path: `POST /api/agent/runs`
- Headers: `Authorization: Bearer <gateway-secret>`,
  `Content-Type: application/json`, `Accept: application/json`
- Redirects: disabled.
- Successful HTTP status: `202` only.
- Side effect: creates and schedules a server-funded run that can pay once.
- Invocation limit: exactly one POST per Recipe execution. Disable automatic
  retries in the Gateway and Recipe. An ambiguous response is an error, never
  permission to POST again.

Input schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["capability", "input", "budget"],
  "properties": {
    "capability": { "const": "SUPPORT_TICKET_TRIAGE" },
    "input": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ticket"],
      "properties": {
        "ticket": { "type": "string", "minLength": 1, "maxLength": 10000 }
      }
    },
    "budget": {
      "type": "object",
      "additionalProperties": false,
      "required": ["network", "asset", "maxAmountAtomic"],
      "properties": {
        "network": { "const": "hedera:testnet" },
        "asset": { "const": "0.0.0" },
        "maxAmountAtomic": { "type": "string", "pattern": "^[1-9][0-9]*$" }
      }
    }
  }
}
```

Output: the `AgentRun` schema below. Tool-level HTTP errors use the ProofServe
API error schema below.

### `getAgentRun`

- Method and path: `GET /api/agent/runs/{runId}`
- Headers: `Authorization: Bearer <gateway-secret>`,
  `Accept: application/json`
- Redirects: disabled.
- No request body or query string.
- Successful HTTP status: `200` only.
- Repeated observation of the same `runId` is permitted until a terminal
  `COMPLETED` or `FAILED` snapshot is seen. It must never lead to another POST.

Input schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["runId"],
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
    }
  }
}
```

Output: the `AgentRun` schema below. Tool-level HTTP errors use the ProofServe
API error schema below.

### ProofServe `AgentRun` output schema

All objects are strict: fields not shown are rejected. Every timestamp is a UTC
RFC 3339 string with exactly millisecond precision. `paymentRequirements` must
equal `paymentReceipt.paymentRequirements` when a receipt exists; receipt
`runId` and `serviceId` must match the enclosing run.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "id": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" },
    "timestamp": { "type": "string", "format": "date-time" },
    "atomic": { "type": "string", "pattern": "^[1-9][0-9]*$" },
    "requirements": {
      "type": "object",
      "additionalProperties": false,
      "required": ["network", "asset", "amountAtomic", "payTo"],
      "properties": {
        "network": { "const": "hedera:testnet" },
        "asset": { "const": "0.0.0" },
        "amountAtomic": { "$ref": "#/$defs/atomic" },
        "payTo": {
          "type": "string",
          "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
        }
      }
    },
    "apiError": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message"],
      "properties": {
        "code": {
          "enum": [
            "VALIDATION_ERROR",
            "PROVIDER_NOT_FOUND",
            "SERVICE_NOT_FOUND",
            "RUN_NOT_FOUND",
            "PROVIDER_VERIFICATION_REQUIRED",
            "SERVICE_STATE_CONFLICT",
            "ENDPOINT_NOT_ALLOWED",
            "NO_ELIGIBLE_SERVICE",
            "BUDGET_EXCEEDED",
            "PAYMENT_FAILED",
            "SERVICE_EXECUTION_FAILED",
            "WORLD_PROOF_INVALID",
            "WORLD_PROOF_REPLAYED",
            "PROVIDER_ALREADY_VERIFIED",
            "WORLD_VERIFICATION_UNAVAILABLE",
            "UNAUTHORIZED",
            "FORBIDDEN",
            "INTERNAL_ERROR"
          ]
        },
        "message": { "type": "string", "minLength": 1, "maxLength": 1000 }
      }
    }
  },
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "task",
    "status",
    "selectedServiceId",
    "paymentRequirements",
    "paymentReceipt",
    "result",
    "error",
    "events",
    "createdAt",
    "updatedAt"
  ],
  "properties": {
    "id": { "$ref": "#/$defs/id" },
    "task": {
      "type": "object",
      "additionalProperties": false,
      "required": ["capability", "input", "budget"],
      "properties": {
        "capability": { "const": "SUPPORT_TICKET_TRIAGE" },
        "input": {
          "type": "object",
          "additionalProperties": false,
          "required": ["ticket"],
          "properties": {
            "ticket": { "type": "string", "minLength": 1, "maxLength": 10000 }
          }
        },
        "budget": {
          "type": "object",
          "additionalProperties": false,
          "required": ["network", "asset", "maxAmountAtomic"],
          "properties": {
            "network": { "const": "hedera:testnet" },
            "asset": { "const": "0.0.0" },
            "maxAmountAtomic": { "$ref": "#/$defs/atomic" }
          }
        }
      }
    },
    "status": {
      "enum": [
        "CREATED",
        "DISCOVERING",
        "SELECTED",
        "PAYMENT_REQUIRED",
        "PAYING",
        "PAID",
        "EXECUTING",
        "COMPLETED",
        "FAILED"
      ]
    },
    "selectedServiceId": {
      "oneOf": [{ "$ref": "#/$defs/id" }, { "type": "null" }]
    },
    "paymentRequirements": {
      "oneOf": [{ "$ref": "#/$defs/requirements" }, { "type": "null" }]
    },
    "paymentReceipt": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "runId",
            "serviceId",
            "paymentRequirements",
            "transactionId",
            "transactionUrl",
            "settledAt"
          ],
          "properties": {
            "id": { "$ref": "#/$defs/id" },
            "runId": { "$ref": "#/$defs/id" },
            "serviceId": { "$ref": "#/$defs/id" },
            "paymentRequirements": { "$ref": "#/$defs/requirements" },
            "transactionId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "transactionUrl": {
              "type": "string",
              "format": "uri",
              "pattern": "^https?://"
            },
            "settledAt": { "$ref": "#/$defs/timestamp" }
          }
        },
        { "type": "null" }
      ]
    },
    "result": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["category", "urgency", "summary", "suggestedAction"],
          "properties": {
            "category": { "type": "string", "minLength": 1, "maxLength": 120 },
            "urgency": { "enum": ["low", "medium", "high"] },
            "summary": { "type": "string", "minLength": 1, "maxLength": 1000 },
            "suggestedAction": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2000
            }
          }
        },
        { "type": "null" }
      ]
    },
    "error": { "oneOf": [{ "$ref": "#/$defs/apiError" }, { "type": "null" }] },
    "events": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["status", "occurredAt"],
        "properties": {
          "status": {
            "enum": [
              "CREATED",
              "DISCOVERING",
              "SELECTED",
              "PAYMENT_REQUIRED",
              "PAYING",
              "PAID",
              "EXECUTING",
              "COMPLETED",
              "FAILED"
            ]
          },
          "occurredAt": { "$ref": "#/$defs/timestamp" }
        }
      }
    },
    "createdAt": { "$ref": "#/$defs/timestamp" },
    "updatedAt": { "$ref": "#/$defs/timestamp" }
  }
}
```

ProofServe API error schema (HTTP 400, 401, 404, or 500 as applicable):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["error"],
  "properties": {
    "error": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message"],
      "properties": {
        "code": {
          "enum": [
            "VALIDATION_ERROR",
            "PROVIDER_NOT_FOUND",
            "SERVICE_NOT_FOUND",
            "RUN_NOT_FOUND",
            "PROVIDER_VERIFICATION_REQUIRED",
            "SERVICE_STATE_CONFLICT",
            "ENDPOINT_NOT_ALLOWED",
            "NO_ELIGIBLE_SERVICE",
            "BUDGET_EXCEEDED",
            "PAYMENT_FAILED",
            "SERVICE_EXECUTION_FAILED",
            "WORLD_PROOF_INVALID",
            "WORLD_PROOF_REPLAYED",
            "PROVIDER_ALREADY_VERIFIED",
            "WORLD_VERIFICATION_UNAVAILABLE",
            "UNAUTHORIZED",
            "FORBIDDEN",
            "INTERNAL_ERROR"
          ]
        },
        "message": { "type": "string", "minLength": 1, "maxLength": 1000 }
      }
    }
  }
}
```

### `getTransaction`

- Service: Hedera testnet Mirror Node REST API.
- Fixed origin: `https://testnet.mirrornode.hedera.com`.
- Method and path: `GET /api/v1/transactions/{transactionId}`.
- `transactionId` must be the normalized path form
  `shard.realm.num-seconds-nnnnnnnnn` derived from the ProofServe receipt.
- Headers: `Accept: application/json`, `Cache-Control: no-store`.
- No credentials, request body, query string, redirects, caller-controlled host,
  or caller-controlled network.
- Invocation limit: once, after a valid completed ProofServe run and budget
  check. Disable automatic retries.

Input schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["transactionId"],
  "properties": {
    "transactionId": {
      "type": "string",
      "maxLength": 128,
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-[1-9][0-9]*-[0-9]{9}$"
    }
  }
}
```

The Mirror Node response must be treated as untrusted JSON. The Recipe needs
`transactions[]`, with `transaction_id`, `result`, `name`, `scheduled`, `nonce`,
and `transfers[]` entries containing `account` and integer `amount`; additional
Mirror Node fields may be present. Confirmation requires exactly one exact
`transaction_id` match to `mirrorLookupTransactionId` and a positive transfer to
the receipt's `payTo` account. It does not compare the path-form Mirror response
ID directly to the unchanged native-form receipt ID.

## Recipe output schema

This is one strict output contract. The `outcome` discriminator selects exactly
one `SUCCESS` or `FAILED` object. For `RUN_FAILED`, `proofServeErrorCode` must be
the non-null code returned by the terminal ProofServe run.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
    },
    "account": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
    },
    "nativeTransactionId": {
      "type": "string",
      "maxLength": 128,
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)@[1-9][0-9]*\\.[0-9]{9}$"
    },
    "mirrorTransactionId": {
      "type": "string",
      "maxLength": 128,
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-[1-9][0-9]*-[0-9]{9}$"
    },
    "proofServeErrorCode": {
      "enum": [
        "VALIDATION_ERROR",
        "PROVIDER_NOT_FOUND",
        "SERVICE_NOT_FOUND",
        "RUN_NOT_FOUND",
        "PROVIDER_VERIFICATION_REQUIRED",
        "SERVICE_STATE_CONFLICT",
        "ENDPOINT_NOT_ALLOWED",
        "NO_ELIGIBLE_SERVICE",
        "BUDGET_EXCEEDED",
        "PAYMENT_FAILED",
        "SERVICE_EXECUTION_FAILED",
        "WORLD_PROOF_INVALID",
        "WORLD_PROOF_REPLAYED",
        "PROVIDER_ALREADY_VERIFIED",
        "WORLD_VERIFICATION_UNAVAILABLE",
        "UNAUTHORIZED",
        "FORBIDDEN",
        "INTERNAL_ERROR"
      ]
    }
  },
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "outcome",
        "runId",
        "serviceId",
        "result",
        "payment",
        "mirrorConfirmation"
      ],
      "properties": {
        "outcome": { "const": "SUCCESS" },
        "runId": { "$ref": "#/$defs/id" },
        "serviceId": { "$ref": "#/$defs/id" },
        "result": {
          "type": "object",
          "additionalProperties": false,
          "required": ["category", "urgency", "summary", "suggestedAction"],
          "properties": {
            "category": { "type": "string", "minLength": 1, "maxLength": 120 },
            "urgency": { "enum": ["low", "medium", "high"] },
            "summary": { "type": "string", "minLength": 1, "maxLength": 1000 },
            "suggestedAction": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2000
            }
          }
        },
        "payment": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "amountAtomic",
            "asset",
            "network",
            "payTo",
            "transactionId",
            "transactionUrl",
            "settledAt"
          ],
          "properties": {
            "amountAtomic": { "type": "string", "pattern": "^[1-9][0-9]*$" },
            "asset": { "const": "0.0.0" },
            "network": { "const": "hedera:testnet" },
            "payTo": { "$ref": "#/$defs/account" },
            "transactionId": { "$ref": "#/$defs/nativeTransactionId" },
            "transactionUrl": {
              "type": "string",
              "format": "uri",
              "pattern": "^https?://"
            },
            "settledAt": { "type": "string", "format": "date-time" }
          }
        },
        "mirrorConfirmation": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "confirmed",
            "transactionId",
            "mirrorLookupTransactionId",
            "result",
            "name",
            "scheduled",
            "nonce",
            "payTo",
            "positiveTransferAmount"
          ],
          "properties": {
            "confirmed": { "const": true },
            "transactionId": { "$ref": "#/$defs/mirrorTransactionId" },
            "mirrorLookupTransactionId": {
              "$ref": "#/$defs/mirrorTransactionId"
            },
            "result": { "const": "SUCCESS" },
            "name": { "const": "CRYPTOTRANSFER" },
            "scheduled": { "const": false },
            "nonce": { "const": 0 },
            "payTo": { "$ref": "#/$defs/account" },
            "positiveTransferAmount": {
              "type": "integer",
              "exclusiveMinimum": 0
            }
          }
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "outcome",
        "code",
        "message",
        "runId",
        "proofServeErrorCode"
      ],
      "properties": {
        "outcome": { "const": "FAILED" },
        "code": {
          "enum": [
            "INPUT_INVALID",
            "CREATE_AGENT_RUN_FAILED",
            "RECIPE_OBSERVATION_FAILED",
            "POLLING_TIMEOUT",
            "RUN_FAILED",
            "RUN_CONTRACT_INVALID",
            "BUDGET_EVIDENCE_MISMATCH",
            "TRANSACTION_ID_INVALID",
            "MIRROR_CONFIRMATION_FAILED"
          ]
        },
        "message": { "type": "string", "minLength": 1, "maxLength": 1000 },
        "runId": {
          "oneOf": [{ "$ref": "#/$defs/id" }, { "type": "null" }]
        },
        "proofServeErrorCode": {
          "oneOf": [
            { "$ref": "#/$defs/proofServeErrorCode" },
            { "type": "null" }
          ]
        }
      },
      "allOf": [
        {
          "if": {
            "properties": { "code": { "const": "RUN_FAILED" } },
            "required": ["code"]
          },
          "then": {
            "properties": {
              "proofServeErrorCode": {
                "$ref": "#/$defs/proofServeErrorCode"
              }
            }
          }
        }
      ]
    }
  ]
}
```
