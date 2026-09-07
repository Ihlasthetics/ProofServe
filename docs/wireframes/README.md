# I00 — ProofServe demo wireframes

Planning documentation only; none of the controls, screens, verification, or payment behavior below is implemented by I00. Owner: Ilham. Review: Ilham and Yhlas.

Authoritative references: [API contract](../api-contract.md), [shared contracts](../../packages/shared/src/contracts.ts), [request contracts](../../packages/shared/src/api.ts), [shared fixtures](../../packages/shared/src/fixtures.ts), and [team playbook](../ProofServe-Team-Build-Playbook.md). Based on main commit `d678fc87d8dd2a2999a8f9dac7ff4e839d63239b`. Y01 contracts are present; their existence does not mean the integrations work.

## Reading guide and shared legend

**Copy** means proposed visible text, shown in quotation marks. **Layout** describes placement for later developers. **Future** describes intended behavior, not a working control. **Contract pending** marks unresolved decisions for Yhlas; do not implement guessed fields or states from this document. Data references name existing shared fields, not new objects or API payloads.

Every screen places this notice directly below its page heading, before forms, service cards, or receipts:

> Wireframe uses fictional development/test content. It is not evidence of completed verification or payment.

| Element         | Shared layout and content convention                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page header     | ProofServe name linking to the planned landing page; a skip-to-main link appears on focus.                                                                                                                                                             |
| Navigation      | Planned destinations: Home, Register provider, Marketplace, Agent execution. Verification is reached through onboarding. These are destination labels, not implemented routes.                                                                         |
| Main content    | One page-level heading; ordered sections with descriptive subheadings. The order written in each screen is also its reading order.                                                                                                                     |
| Footer          | “ProofServe — planned Hedera testnet demo” and “Verification describes recent liveness, not a service-quality guarantee.” Include a return-to-home link. No claim that any sponsor integration is live.                                                |
| Cards           | Group one service, provider summary, task, result, or receipt. A card heading identifies its content.                                                                                                                                                  |
| Badges          | Readable text such as “Unverified”, “Liveness verified”, “Pending”, “Blocked”, or “Failed”; color may supplement text. Fixture status examples stay visibly labeled as fictional.                                                                      |
| Notices         | Planning-data notice first; eligibility explanations beside the affected control. Distinguish information from actionable errors with words.                                                                                                           |
| Form controls   | Visible labels, required markers explained in text, persistent instructions, and field errors beneath the relevant control. Never use placeholders as the only instructions.                                                                           |
| Error messages  | Page/form summary before affected content; safe explanatory text and a reachable recovery action. Field errors are linked from the summary. Never expose internal payloads.                                                                            |
| Loading/pending | Text states describe what is awaiting confirmation. Later updates must come from actual operations; no timers that manufacture progress or success.                                                                                                    |
| Desktop         | Header navigation in a row; bounded content width. Two columns only where specified; document order remains meaningful.                                                                                                                                |
| Small mobile    | Responsive web, single column at about 320 CSS pixels; visible navigation links wrap below the brand. Cards and full-width fields fit available width; long names and identifiers wrap. Use a vertical timeline and prevent horizontal page scrolling. |
| Controls        | Keyboard-operable links/buttons, visible focus, and practical minimum touch targets of 44 × 44 CSS pixels. Actions wrap on desktop and stack full-width on mobile without covering content.                                                            |

Accessibility applies to all five screens: semantic header, navigation, main, and footer landmarks; one h1 and logical h2/h3 order; sufficient text/background contrast; meaningful link text; text statuses rather than color alone; logical keyboard and mobile reading order. Associate instructions and errors with fields. Later asynchronous status updates should be announced politely, with urgent failures announced without repeated interruptions. Move focus to a submission-error summary when appropriate. Respect reduced-motion preferences if animation is introduced later; no animation is needed for these wireframes.

Product meaning: ProofServe is planned as a registry where autonomous agents discover and pay for AI services operated by recently verified, live humans. Verification is time-limited liveness/continuity information. The server decides validity; schema validation and a frontend boolean do not establish liveness. Payment signing and private keys remain server-side, and the browser never receives a wallet signing key.

Shared fixture dates are anchored to `fixtureReferenceTime`, not the viewer's current clock. A fixed fixture interval is not verification policy. Later fixture screens must use that reference explicitly and remain marked fictional. Payment amounts and budgets come from canonical atomic decimal strings; later code must format tinybars with string/BigInt-safe logic, never `Number` or `parseFloat`.

## 1. Landing page

**Purpose / primary user:** Introduce the planned product to a demo visitor and direct providers and buyers to their next screen.

**Heading copy:** “Discover AI services operated by recently verified humans.”

> Wireframe uses fictional development/test content. It is not evidence of completed verification or payment.

| Visual order             | Copy and important components                                                                                                                                                        | Layout / future behavior                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Header and navigation | “ProofServe”; shared navigation labels                                                                                                                                               | Shared header before main heading and planning notice.                                                                                               |
| 2. Introduction          | “Autonomous agents can discover eligible AI services operated by recently verified, live humans.”                                                                                    | Short introductory paragraph, followed by the action group.                                                                                          |
| 3. Actions               | Primary: “Explore marketplace”. Secondary: “Register a provider”.                                                                                                                    | Planned destinations: screen 4 and screen 2. Labels describe future navigation only.                                                                 |
| 4. Service preview       | “Support Ticket Triage API”; “Classify a support ticket and suggest a next action.”                                                                                                  | One preview card with capability, price, network, and separate service/provider status text as specified in screen 4. Mark preview values fictional. |
| 5. How it works          | “Register a draft service”; “Complete liveness verification before activation”; “An agent discovers an eligible service and pays per request”; “View the triage result and receipt.” | Ordered four-step summary. Supporting copy: “The buyer agent pays per request without a subscription or API key.” Describes intended final behavior. |
| 6. Footer                | Shared footer copy                                                                                                                                                                   | After the explanation, never overlaid on actions.                                                                                                    |

**States:** A later data-driven preview needs “Loading service preview”, “Preview unavailable” with retry, and “No eligible service available”. Missing or expired verification cannot be displayed as current liveness. The introduction and navigation remain readable if the preview fails.

**Data sources:** Editorial title and explanation are proposed copy. Later preview values use `activeServiceFixture`, `verifiedProviderFixture`, and their contract fields; registry discovery uses the paired service/provider entry. The fixture's current name is “Example support ticket triage”; “Support Ticket Triage API” is the planned product heading, not a silent fixture rename.

**Desktop:** Introduction/action group on the left, preview card on the right, then full-width how-it-works section and footer.

**Small mobile:** Shared wrapping navigation → heading → notice → introduction → stacked actions → preview → vertical how-it-works list → footer. Service names wrap and cards fit without horizontal scrolling.

**Accessibility:** Apply the shared landmarks/focus/contrast rules; use an ordered list for steps and descriptive action links. Preview badges include text, and a loading preview does not obscure the heading.

**Future scope:** I01 implements shell/navigation and fixture-driven cards after its dependency checks. Later marketplace integration belongs to I03. I00 implements neither.

**Contract pending:** Yhlas/Ilham can confirm final service display copy later; shared fixture data remains authoritative until explicitly changed by its owner. No new contract is needed for the introductory copy.

## 2. Provider registration

**Purpose / primary user:** Help a service operator understand registration and draft-service creation before verification.

**Heading copy:** “Register your provider and draft service.”

> Wireframe uses fictional development/test content. It is not evidence of completed verification or payment.

| Visual order                           | Copy and important components                                                                               | Layout / future behavior                                                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Introduction                        | “Registration creates a provider and a draft service. It does not verify liveness or activate the service.” | After shared header, heading, and notice.                                                                                                                                                                                                   |
| 2. Error summary                       | “Review the highlighted fields” or safe submission-error text                                               | Above form sections; absent in the normal state. Preserve entered values after failure.                                                                                                                                                     |
| 3. Provider information                | “Provider display name”; “Hedera testnet payout account”                                                    | Labeled required controls from `CreateProviderRequestSchema`: `displayName` and `payoutAccount`. Explain the account identifier format without asking for keys.                                                                             |
| 4. Draft Support Ticket Triage service | “Service name”; “Description”; “Capability”; “Price per request”; “Network”; “Asset”                        | Name and description controls; capability fixed to support-ticket triage, network to Hedera testnet, asset to HBAR. Price-entry units must be explicit; underlying `price.amountAtomic` is a decimal string of tinybars. No endpoint input. |
| 5. Action group                        | Primary: “Save draft and continue”. Secondary: “Back to home”.                                              | Planned continuation to screen 3 after required creation steps succeed. Show submission pending beside the action and prevent duplicate submission while pending.                                                                           |
| 6. Next step                           | “Next: complete liveness verification. The service cannot activate without valid operator verification.”    | Explanation below actions, followed by shared footer. No success badge merely for registration.                                                                                                                                             |

**States:** Empty required field, invalid payout-account syntax, overlong name/description, invalid atomic price, submission pending, provider creation failure, draft-service creation failure, and draft saved. Put field validation messages directly below controls and safe server failures in the summary. Do not imply all data saved when only provider creation succeeded.

**Data sources:** `CreateProviderRequestSchema` defines the two provider fields. `CreateServiceRequestSchema` defines `providerId`, `name`, `description`, `capability`, and `price`; the provider ID comes from the successful provider response, not a free-entry field. The server supplies endpoint, payee, statuses, IDs, and timestamps. Names allow 1–120 characters and description 1–1000; price follows shared atomic-value constraints. These are field references, not new payload definitions.

**Desktop:** Provider and service sections stack in the main form column; a narrower side panel repeats the next-step explanation. Provider fields precede service fields in keyboard order. Actions sit under the form.

**Small mobile:** Wrapping navigation → heading/notice → introduction → error summary → provider display name → payout account → service name → description → fixed capability → price → fixed network/asset → full-width actions → next step → footer. All fields use available width; instructions wrap.

**Accessibility:** Apply shared rules; group related fields with descriptive legends, label required fields explicitly, associate help/errors with controls, and link summary errors to fields. A disabled submission control has adjacent readable pending text. No information depends on placeholder text or color.

**Future scope:** I02 demonstrates fixture onboarding states; I03 connects provider and draft creation to the registry. Real verification is I04. This document is not a working form.

**Contract pending:** Confirm partial-success recovery with Yhlas: provider creation and service creation are separate operations, and Y01 defines no atomic combined save, editable draft, or resume endpoint. “Save draft and continue” must reflect only confirmed operations. Ilham/Yhlas should also confirm whether the future price input displays tinybars directly or safely converts an HBAR decimal string; do not use floating-point conversion.

## 3. Verification and blocked activation

**Purpose / primary user:** Show the provider why activation is blocked and how current server-confirmed liveness enables it.

**Heading copy:** “Verify your operator before activating.”

> Wireframe uses fictional development/test content. It is not evidence of completed verification or payment.

| Visual order                  | Copy and important components                                                                                                         | Layout / future behavior                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Provider and draft summary | Provider display name; “Support Ticket Triage API”; service status                                                                    | Below shared header, heading, and notice. Keep provider verification and service activation as separate statuses.                                         |
| 2. Verification panel         | “Human-liveness and continuity signal”; current status and available timestamps                                                       | Explain time-limited verification. Show verification and expiry times with timezone when present; null timestamps display “Not verified”.                 |
| 3. Explanation/error area     | “The service cannot activate without valid operator verification.”                                                                    | Prominent notice next to activation controls; safe verification/activation failures appear here.                                                          |
| 4. Actions                    | Primary while unverified: “Start liveness verification”. Primary when eligible: “Activate service”. Secondary: “Back to marketplace”. | Future World Selfie Check interface and server activation request. Retry labels appear only for recoverable failures. No bypass or simulated pass action. |
| 5. Footer                     | Shared footer copy                                                                                                                    | After controls and explanations.                                                                                                                          |

| Intended visible state           | Copy and control placement                                            | Future source / guardrail                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unverified                       | “Unverified”; start-verification action in the panel                  | `UNVERIFIED`; no verified badge.                                                                                                                                   |
| Activation blocked               | “Activation blocked — current operator verification is required.”     | Disabled activation control with explanation; the server must also reject unauthorized activation. An attempted/rejected activation is shown here, not as success. |
| Verification pending             | “Verification pending — awaiting confirmation.”                       | Transient interface state, not a new `VerificationStatus` enum; activation remains blocked.                                                                        |
| Liveness verified                | “Liveness verified”; verified/expiry times                            | `VERIFIED` plus server-confirmed current eligibility; not a permanent guarantee.                                                                                   |
| Verification failed or cancelled | “Verification failed” or “Verification cancelled”; retry verification | Do not promote the record or display a verified badge for a failed/cancelled attempt. Any prior record must not be presented as success of that attempt.           |
| Verification expired             | “Verification expired — verify again.”                                | `EXPIRED`, or server-confirmed expiry of a stored `VERIFIED` record; activation blocked.                                                                           |
| Activation available             | “Verification confirmed. You can request activation.”                 | Only after valid server confirmation; DRAFT activation or SUSPENDED reactivation still requires server authorization.                                              |
| Activation pending/error/active  | “Activating service”, safe error with retry, or “Service active”      | Pending is transient; `ACTIVE` appears only after confirmed activation. Failure keeps the last confirmed service state.                                            |

**Data sources:** Provider `verification.status`, `verifiedAt`, `expiresAt`, and service `status` come from shared contracts and later server responses. Shared verified/unverified provider and draft/active service fixtures support fictional planning examples. Pending, cancelled, and blocked are interface descriptions, not invented persisted enum values. Server time determines current validity; the fixture's 24-hour interval is not policy.

**Desktop:** Provider/draft summary beside verification panel; status → explanation → actions remain in order. Errors stay beside the affected panel, not only in a toast.

**Small mobile:** Wrapping navigation → heading/notice → provider/draft summary → verification status/times → explanation/error → stacked full-width actions → footer. Long names wrap; status is understandable without a side-by-side arrangement.

**Accessibility:** Apply shared rules; announce pending and outcome changes, preserve sensible focus after the future verification dialog closes, and keep explanatory text readable even when activation is disabled. Badges have text; retry actions state what will be retried.

**Future scope and privacy:** I00 does not implement verification. I02 shows fixture-based onboarding states. I03 displays registry activation outcomes. I04 integrates the real verification interface after Y04. The server, not a frontend boolean, decides whether verification is valid. Raw proof payloads, selfies, and biometric information must not be displayed, persisted, or logged.

**Contract pending:** Y04/Yhlas must resolve the pinned World integration, operation-bound renewal and freshness policy, and recovery when the verification response is lost. Do not guess proof fields, a frontend validity window, or a success fallback.

## 4. Service marketplace

**Purpose / primary user:** Let a buyer or demo visitor inspect the single MVP service and understand its eligibility and per-request price.

**Heading copy:** “Explore the Support Ticket Triage API.”

> Wireframe uses fictional development/test content. It is not evidence of completed verification or payment.

| Visual order           | Copy and important components                                       | Layout / future behavior                                                                                          |
| ---------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1. Introduction        | “Discover active services with recently verified human operators.”  | After shared header, heading, and notice; explain that eligibility is checked again before payment.               |
| 2. Results status      | Loading, empty, or safe error message                               | Above card area. Primary recovery action for a failed load: “Retry loading services”.                             |
| 3. Single service card | Fields in the table below                                           | One MVP card, not a catalog of invented services.                                                                 |
| 4. Actions             | Primary: “Prepare a triage task”. Secondary: “Register a provider”. | Planned destinations: screen 5 task/budget section and screen 2. Ineligible cards cannot initiate paid execution. |
| 5. Footer              | Shared footer copy                                                  | Below results and actions.                                                                                        |

| Card order / visible label | Authoritative data / planning copy                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service name               | Proposed product heading “Support Ticket Triage API”; actual service name comes from `service.name`. Current fixture name is “Example support ticket triage”. |
| Description                | `service.description`; proposed explanatory copy: “Classify a support ticket and suggest a next action.” Do not mislabel editorial copy as fixture data.      |
| Capability                 | `service.capability`: `SUPPORT_TICKET_TRIAGE`, displayed as “Support ticket triage”.                                                                          |
| Price per request          | `service.paymentRequirements.amountAtomic`; fixture string `1000000` tinybars, displayed as “0.01 HBAR per request — fictional example”.                      |
| Network                    | `service.paymentRequirements.network`: “Hedera testnet”; asset is HBAR (`0.0.0`).                                                                             |
| Service status             | `service.status`: DRAFT, ACTIVE, or SUSPENDED expressed in readable text.                                                                                     |
| Provider                   | Paired `provider.displayName`; fixture “Fictional verified operator”.                                                                                         |
| Provider verification      | Paired `provider.verification` status/timestamps; “Liveness verified” only for the current fictional reference scenario or later current server confirmation. |
| Data notice                | “Fictional development/test service preview” inside the example card in addition to the page notice.                                                          |

**States:** Active and currently eligible card; “Loading services”; “No eligible service available”; “Could not load services” with retry. The discovery contract excludes ineligible services. If a previously loaded card becomes unavailable, show “Service unavailable” with an explanation and disable its execution action until eligibility is reconfirmed. Stored `ACTIVE` status alone is insufficient when verification expires. Do not invent a discovery response containing all excluded providers.

**Data sources:** `ListServicesResponseSchema` pairs service/provider data. I01 uses existing shared fixtures; I03 uses registry discovery. Prices are atomic decimal strings, not floating-point values. Later formatting must use string/BigInt-safe tinybar logic and never `Number` or `parseFloat`; compare amounts only after matching network and asset.

**Desktop:** Bounded single-card area under heading; service details above a provider/status block, with actions beneath. No unnecessary multi-service grid or unsupported filters.

**Small mobile:** Wrapping navigation → heading/notice → introduction → results status → card fields in table order → stacked full-width actions → footer. Names, descriptions, and account identifiers wrap within the card; no horizontal scrolling.

**Accessibility:** Apply shared rules; card heading names the service, price includes units, badges name both service and verification state, and result updates are announced. Unavailable-action explanations remain keyboard-readable; link text names the destination.

**Future scope:** I01 fixture-driven card and responsive shell; I03 registry listing. No ratings, reviews, subscriptions, custom tokens, third-party endpoint entry, or additional real services are planned here.

**Contract pending:** Yhlas should confirm how the UI receives refreshed eligibility when an already displayed record expires. Y01 defines snapshots, not push updates or a polling interval. Do not infer ongoing eligibility solely from the browser clock.

## 5. Agent execution and payment receipt

**Purpose / primary user:** Let the buyer/demo viewer follow an intended agent request from task and budget through result and genuine settlement evidence.

**Heading copy:** “Run a support ticket triage task.”

> Wireframe uses fictional development/test content. It is not evidence of completed verification or payment.

**Layout order:** Shared header/navigation → heading/notice → task and maximum-budget controls → action group → current run status/error → vertical timeline → triage result → receipt → shared footer. This is a future-flow wireframe, not evidence of a real transaction.

**Actions:** Primary “Run triage task” belongs below task/budget controls; secondary “Back to marketplace”. While a run is pending, show its confirmed state and prevent duplicate submission. After failure, “Review task and budget” returns focus to the inputs. A future new-run action must make any potential new charge clear; a settled failed run does not authorize an automatic second payment.

| Timeline order                                 | Visible content                                                                                | Future evidence / contract mapping                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Task and maximum budget                     | Labeled “Support ticket” and “Maximum budget”; fixed capability/network/asset                  | `task.input.ticket`, `task.capability`, and `task.budget`; shared budget example `2000000` tinybars = 0.02 HBAR, explicitly fictional.                             |
| 2. Service discovery                           | “Discovering eligible services”                                                                | `DISCOVERING` event; no progress inferred from elapsed time.                                                                                                       |
| 3. Eligible provider selection                 | Selected service and provider summary                                                          | `SELECTED` and `selectedServiceId`; backend/agent checks current verification and active service status.                                                           |
| 4. Price evaluation                            | Quoted price alongside maximum budget                                                          | Compare authoritative service quote with matching network/asset budget using atomic strings/BigInt. This is explanatory detail, not an invented run enum.          |
| 5. HTTP 402 Payment Required                   | “HTTP 402 — payment required”; actual requested amount                                         | `PAYMENT_REQUIRED` and `paymentRequirements`; agent validates the actual requirement and rechecks price, recipient, network, asset, and eligibility before paying. |
| 6. Server-side payment signing                 | “Payment in progress on the server”                                                            | `PAYING`; describe signing within this stage only when supported by backend evidence. The browser neither signs nor receives a wallet signing key.                 |
| 7. Hedera testnet settlement through Blocky402 | “Settlement confirmed” only after actual confirmation                                          | `PAID` plus genuine backend `paymentReceipt`; fixture illustration is explicitly fictional and is never proof.                                                     |
| 8. AI service execution                        | “Executing triage service”                                                                     | `EXECUTING`; no fabricated backend progress.                                                                                                                       |
| 9. Triage result                               | Category, urgency, summary, suggested action                                                   | `COMPLETED` with `result.category`, `urgency`, `summary`, `suggestedAction`; no result before it exists.                                                           |
| 10. Payment receipt and HashScan link          | Amount, network, payee, transaction identifier, settlement time; “View settlement on HashScan” | Backend receipt fields below. No working explorer link in this wireframe; a future link must come from a real backend receipt.                                     |

**Receipt layout and data:** A labeled detail list uses `paymentReceipt.id`, `runId`, `serviceId`, `paymentRequirements` (network, asset, amountAtomic, payTo), `transactionId`, and `settledAt`; future meaningful HashScan link text uses backend `transactionUrl`. Shared receipt fixture identifiers and reserved example URLs are fictional, not real settlements, and must not be presented as explorer evidence. Format atomic values safely. If no receipt exists, show “No settlement receipt available”, not a paid badge or invented transaction.

| Failure scenario              | Visible copy / recovery                                                        | Contract boundary                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No eligible service           | “No eligible service available”; return to marketplace                         | `NO_ELIGIBLE_SERVICE`.                                                                                                                                                                                                    |
| Service above budget          | “Service price exceeds your maximum budget”; review budget                     | `BUDGET_EXCEEDED`; never increase budget automatically.                                                                                                                                                                   |
| Malformed payment requirement | “Payment requirements could not be validated”; show safe failure               | Exact subtype mapping pending; no payment based on malformed requirements.                                                                                                                                                |
| Payment rejected              | “Payment failed”; show the last confirmed run state and a safe recovery action | `PAYMENT_FAILED`; show a `PaymentReceipt` only if the backend separately confirms genuine settlement. `PaymentReceipt` has no status field. Do not invent settlement or promise that no charge occurred without evidence. |
| Paid retry failure            | “Payment settled, but the service request failed”; keep receipt visible        | Failure retains settlement data; no implied refund or automatic second payment. Detailed failure classification pending.                                                                                                  |
| Service timeout               | “Service did not respond in time”; retain confirmed payment information        | Detailed timeout mapping pending under service-execution failure handling.                                                                                                                                                |
| Agent run failure             | “Agent run failed”; safe error and last confirmed timeline                     | `FAILED` with contract `error`; unknown failures use safe server text, not fabricated diagnostic detail.                                                                                                                  |

**Other states:** Initial task entry, field-validation errors, submission pending/error, snapshot loading/error with “Retry loading run”, and empty result/receipt placeholders. Refreshing a snapshot is distinct from starting a new paid run. `FAILED` may follow settlement; render the retained receipt even when no triage result exists.

**Data sources:** `AgentTask`, `AgentRun`, `AgentRunEvent`, `PaymentReceipt`, and `TriageResult` are shared contracts. Existing task/created/completed-run fixtures provide fictional examples only. Events contain status and time, not free-form signing or price-evaluation events. Provider display details are not embedded in the run; do not invent a provider field on it.

**Desktop:** Task/budget section at the top; vertical timeline in a wider left column and result/receipt in a right column. Document order remains timeline → result → receipt. Long transaction IDs wrap, with the descriptive explorer link on its own line.

**Small mobile:** Wrapping navigation → heading/notice → full-width ticket input → budget with units and fixed network/asset → stacked actions → run status/error → vertical numbered timeline → result → receipt → footer. Each step includes its text state and available timestamp; no horizontal arrangement is needed to understand progress. Transaction identifiers and long service names wrap within cards.

**Accessibility:** Apply shared rules; label ticket/budget controls with instructions and associated errors. Use an ordered timeline with textual states, announce meaningful updates without rereading the entire history, and keep receipt links reachable. Result urgency uses text, not color. Any future motion respects reduced-motion preferences.

**Future scope:** I05 displays execution and payment after Y05/T04 dependencies merge; backend/agent owners implement real discovery, signing, Blocky402 settlement, and inference. I00 implements none of this, and I01 must not simulate successful payments.

**Contract pending:** Yhlas/Tugrahan must confirm subtype mappings for malformed requirements, rejected payments, paid retry failures, and timeouts using the existing error contract or an owner-approved update. Confirm how I05 retrieves selected provider details and quote evaluation evidence: current run events do not carry them. Y03/Y05 must supply real settlement IDs and HashScan URLs; a syntactically valid URL alone is not settlement proof.

## Review boundary

I00 changes only this Markdown document. All five screens are plans for later authorized tasks, with desktop/mobile layouts, accessibility, fictional-data notices, and contract references. No application code, shared objects, assets, dependencies, verification, payment execution, or deployment is introduced. Ilham and Yhlas review the full document and validation results before any later commit/push authorization.
