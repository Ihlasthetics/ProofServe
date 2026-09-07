## Agent Selection Test Scenarios

### Scenario 1 — Valid Service Is Selected

**Given:**

* Required capability: `ticket-triage`
* Provider verification status: `VERIFIED`
* Service status: `ACTIVE`
* Service price is within the agent's maximum budget

**Expected Result:**

* The agent should consider the service eligible and select it.

---

### Scenario 2 — Unverified Provider Is Rejected

**Given:**

* Required capability: `ticket-triage`
* Provider verification status: `UNVERIFIED`
* Service status: `ACTIVE`
* Service price is within the agent's maximum budget

**Expected Result:**

* The agent should reject the service because the provider is not verified.

---

### Scenario 3 — Inactive Service Is Rejected

**Given:**

* Required capability: `ticket-triage`
* Provider verification status: `VERIFIED`
* Service status: `DRAFT` or `SUSPENDED`
* Service price is within the agent's maximum budget

**Expected Result:**

* The agent should reject the service because only `ACTIVE` services are eligible.

---

### Scenario 4 — Service Above Budget Is Rejected

**Given:**

* Required capability: `ticket-triage`
* Provider verification status: `VERIFIED`
* Service status: `ACTIVE`
* Service price is greater than the agent's `maxAmountAtomic`

**Expected Result:**

* The agent should reject the service because its price exceeds the maximum allowed budget.

---

### Scenario 5 — Multiple Valid Services Are Ranked Deterministically

**Given:**

* Multiple services match the required `ticket-triage` capability
* All providers are `VERIFIED`
* All services are `ACTIVE`
* All service prices are within the agent's maximum budget

**Expected Result:**

* The agent should rank the eligible services deterministically and always select the same service when given the same inputs.
* The exact deterministic ranking rule should follow the project contract or implementation decision defined for T02.
