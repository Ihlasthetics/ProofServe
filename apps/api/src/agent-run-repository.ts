import {
  AgentRunSchema,
  TimestampSchema,
  type AgentRun,
  type Identifier,
  type PaymentReceipt,
  type Timestamp,
} from '@proofserve/shared';
import {
  canonicalHederaTransactionId,
  transitionAgentRun,
  type AgentTransition,
  type BuyerPaymentAttempt,
  type BuyerPaymentExpectation,
} from '@proofserve/agent';

export class AgentRunRepositoryError extends Error {
  constructor() {
    super('Agent run persistence failed.');
    this.name = 'AgentRunRepositoryError';
  }
}

export interface AgentRunExecutionClaim {
  readonly snapshot: AgentRun;
  persist(snapshot: AgentRun): Promise<void>;
  beginSigning(expectation: BuyerPaymentExpectation): Promise<void>;
  recordPaymentAttempt(attempt: BuyerPaymentAttempt): Promise<void>;
  authorizeSubmission(transactionId: string): Promise<void>;
  release(): Promise<void>;
}

export interface AgentRunRepository {
  createRun(snapshot: AgentRun): Promise<void>;
  getRun(runId: Identifier): Promise<AgentRun | undefined>;
  listReconciliationRunIds(): Promise<Identifier[]>;
  claimExecution(
    runId: Identifier,
    ownerId: Identifier,
  ): Promise<AgentRunExecutionClaim | undefined>;
  reconcileTombstonedRun(
    runId: Identifier,
    occurredAt: Timestamp,
  ): Promise<boolean>;
  getPaymentReconciliation(
    runId: Identifier,
  ): Promise<BuyerPaymentAttempt | undefined>;
  recoverConfirmedPayment(
    runId: Identifier,
    attempt: BuyerPaymentAttempt,
    receipt: PaymentReceipt,
    occurredAt: Timestamp,
  ): Promise<boolean>;
  failExpiredPayment(
    runId: Identifier,
    transactionId: string,
    occurredAt: Timestamp,
  ): Promise<boolean>;
  failUnclaimedRun(runId: Identifier, occurredAt: Timestamp): Promise<boolean>;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateInitialRun(value: unknown): AgentRun {
  const run = AgentRunSchema.parse(value);
  if (
    run.status !== 'CREATED' ||
    run.selectedServiceId !== null ||
    run.paymentRequirements !== null ||
    run.paymentReceipt !== null ||
    run.result !== null ||
    run.error !== null ||
    run.events.length !== 1 ||
    run.events[0]?.status !== 'CREATED' ||
    run.events[0].occurredAt !== run.createdAt ||
    run.updatedAt !== run.createdAt
  )
    throw new AgentRunRepositoryError();
  return run;
}

function commandFor(target: AgentRun, eventIndex: number): AgentTransition {
  const event = target.events[eventIndex];
  if (!event) throw new AgentRunRepositoryError();
  const occurredAt = event.occurredAt;
  switch (event.status) {
    case 'DISCOVERING':
    case 'PAYING':
    case 'EXECUTING':
      return { status: event.status, occurredAt };
    case 'SELECTED':
      if (target.selectedServiceId === null)
        throw new AgentRunRepositoryError();
      return {
        status: event.status,
        selectedServiceId: target.selectedServiceId,
        occurredAt,
      };
    case 'PAYMENT_REQUIRED':
      if (target.paymentRequirements === null)
        throw new AgentRunRepositoryError();
      return {
        status: event.status,
        paymentRequirements: target.paymentRequirements,
        occurredAt,
      };
    case 'PAID':
      if (target.paymentReceipt === null) throw new AgentRunRepositoryError();
      return {
        status: event.status,
        paymentReceipt: target.paymentReceipt,
        occurredAt,
      };
    case 'COMPLETED':
      if (target.result === null) throw new AgentRunRepositoryError();
      return { status: event.status, result: target.result, occurredAt };
    case 'FAILED':
      if (target.error === null) throw new AgentRunRepositoryError();
      return { status: event.status, error: target.error, occurredAt };
    case 'CREATED':
      throw new AgentRunRepositoryError();
  }
}

/** Validate a complete monotonic extension, including replay after an ambiguous commit. */
export function validateRunExtension(
  storedValue: unknown,
  targetValue: unknown,
): AgentRun {
  try {
    const stored = AgentRunSchema.parse(storedValue);
    const target = AgentRunSchema.parse(targetValue);
    if (same(stored, target)) return target;
    if (
      stored.id !== target.id ||
      stored.createdAt !== target.createdAt ||
      !same(stored.task, target.task) ||
      stored.events.length >= target.events.length ||
      !same(stored.events, target.events.slice(0, stored.events.length))
    )
      throw new AgentRunRepositoryError();
    let replayed = stored;
    for (
      let index = stored.events.length;
      index < target.events.length;
      index++
    )
      replayed = transitionAgentRun(replayed, commandFor(target, index));
    if (!same(replayed, target)) throw new AgentRunRepositoryError();
    return target;
  } catch {
    throw new AgentRunRepositoryError();
  }
}

export function createFailureSnapshot(
  run: AgentRun,
  occurredAt: Timestamp,
): AgentRun {
  const safeTime = TimestampSchema.parse(
    occurredAt < run.updatedAt ? run.updatedAt : occurredAt,
  );
  const settled = run.paymentReceipt !== null;
  return transitionAgentRun(run, {
    status: 'FAILED',
    error: settled
      ? {
          code: 'SERVICE_EXECUTION_FAILED',
          message: 'Paid service execution failed.',
        }
      : {
          code: 'PAYMENT_FAILED',
          message:
            'Payment could not be confirmed. Do not automatically retry.',
        },
    occurredAt: safeTime,
  });
}

function sameAttempt(
  attempt: BuyerPaymentAttempt,
  expectation: BuyerPaymentExpectation,
): boolean {
  return (
    attempt.payer === expectation.payer &&
    attempt.receiver === expectation.receiver &&
    attempt.amountAtomic === expectation.amountAtomic &&
    attempt.asset === expectation.asset &&
    attempt.network === expectation.network
  );
}

export function createRecoveredPaymentSnapshot(
  run: AgentRun,
  receipt: PaymentReceipt,
  occurredAt: Timestamp,
): AgentRun {
  let next = transitionAgentRun(run, {
    status: 'PAID',
    paymentReceipt: receipt,
    occurredAt,
  });
  next = transitionAgentRun(next, { status: 'EXECUTING', occurredAt });
  return createFailureSnapshot(next, occurredAt);
}

/** Deterministic test repository. Production construction never selects this. */
export class InMemoryAgentRunRepository implements AgentRunRepository {
  private readonly runs = new Map<Identifier, AgentRun>();
  private readonly activeOwners = new Map<Identifier, Identifier>();
  private readonly paymentTombstones = new Map<
    Identifier,
    {
      ownerId: Identifier;
      expectation: BuyerPaymentExpectation;
      attempt?: BuyerPaymentAttempt;
      submissionAuthorized: boolean;
    }
  >();

  async createRun(value: AgentRun): Promise<void> {
    const snapshot = validateInitialRun(value);
    if (this.runs.has(snapshot.id)) throw new AgentRunRepositoryError();
    this.runs.set(snapshot.id, structuredClone(snapshot));
  }

  async getRun(runId: Identifier): Promise<AgentRun | undefined> {
    const snapshot = this.runs.get(runId);
    return snapshot
      ? AgentRunSchema.parse(structuredClone(snapshot))
      : undefined;
  }

  async listReconciliationRunIds(): Promise<Identifier[]> {
    return [...this.runs.values()]
      .filter((run) => run.status !== 'COMPLETED' && run.status !== 'FAILED')
      .map((run) => run.id);
  }

  async claimExecution(
    runId: Identifier,
    ownerId: Identifier,
  ): Promise<AgentRunExecutionClaim | undefined> {
    const stored = this.runs.get(runId);
    if (
      !stored ||
      stored.status === 'COMPLETED' ||
      stored.status === 'FAILED' ||
      this.paymentTombstones.has(runId) ||
      this.activeOwners.has(runId)
    )
      return undefined;
    this.activeOwners.set(runId, ownerId);
    let active = true;
    const owns = () => active && this.activeOwners.get(runId) === ownerId;
    return {
      snapshot: AgentRunSchema.parse(structuredClone(stored)),
      persist: async (value) => {
        if (!owns()) throw new AgentRunRepositoryError();
        const current = this.runs.get(runId);
        if (!current) throw new AgentRunRepositoryError();
        const target = validateRunExtension(current, value);
        if (
          target.status === 'FAILED' &&
          target.paymentReceipt === null &&
          this.paymentTombstones.has(runId)
        )
          throw new AgentRunRepositoryError();
        this.runs.set(runId, target);
      },
      beginSigning: async (expectation) => {
        if (
          !owns() ||
          this.paymentTombstones.has(runId) ||
          this.runs.get(runId)?.status !== 'PAYING'
        )
          throw new AgentRunRepositoryError();
        this.paymentTombstones.set(runId, {
          ownerId,
          expectation: structuredClone(expectation),
          submissionAuthorized: false,
        });
      },
      recordPaymentAttempt: async (attempt) => {
        const tombstone = this.paymentTombstones.get(runId);
        if (
          !owns() ||
          !tombstone ||
          tombstone.ownerId !== ownerId ||
          tombstone.attempt !== undefined ||
          !sameAttempt(attempt, tombstone.expectation) ||
          canonicalHederaTransactionId(attempt.transactionId) !==
            attempt.transactionId ||
          TimestampSchema.safeParse(attempt.transactionValidUntil).success ===
            false
        )
          throw new AgentRunRepositoryError();
        tombstone.attempt = structuredClone(attempt);
      },
      authorizeSubmission: async (transactionId) => {
        const tombstone = this.paymentTombstones.get(runId);
        if (
          !owns() ||
          !tombstone?.attempt ||
          tombstone.submissionAuthorized ||
          tombstone.attempt.transactionId !== transactionId ||
          Date.now() >= Date.parse(tombstone.attempt.transactionValidUntil)
        )
          throw new AgentRunRepositoryError();
        tombstone.submissionAuthorized = true;
      },
      release: async () => {
        if (owns()) this.activeOwners.delete(runId);
        active = false;
      },
    };
  }

  async reconcileTombstonedRun(
    runId: Identifier,
    occurredAt: Timestamp,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (
      !run ||
      !this.paymentTombstones.has(runId) ||
      this.activeOwners.has(runId) ||
      run.status === 'COMPLETED' ||
      run.status === 'FAILED'
    )
      return false;
    if (run.paymentReceipt === null) return false;
    this.runs.set(runId, createFailureSnapshot(run, occurredAt));
    return true;
  }

  async getPaymentReconciliation(
    runId: Identifier,
  ): Promise<BuyerPaymentAttempt | undefined> {
    if (this.activeOwners.has(runId)) return undefined;
    return structuredClone(this.paymentTombstones.get(runId)?.attempt);
  }

  async recoverConfirmedPayment(
    runId: Identifier,
    attempt: BuyerPaymentAttempt,
    receipt: PaymentReceipt,
    occurredAt: Timestamp,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    const tombstone = this.paymentTombstones.get(runId);
    if (
      !run ||
      this.activeOwners.has(runId) ||
      !tombstone?.attempt ||
      !same(tombstone.attempt, attempt) ||
      receipt.transactionId !== attempt.transactionId ||
      run.status !== 'PAYING'
    )
      return false;
    this.runs.set(
      runId,
      createRecoveredPaymentSnapshot(run, receipt, occurredAt),
    );
    return true;
  }

  async failExpiredPayment(
    runId: Identifier,
    transactionId: string,
    occurredAt: Timestamp,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    const tombstone = this.paymentTombstones.get(runId);
    if (
      !run ||
      this.activeOwners.has(runId) ||
      tombstone?.attempt?.transactionId !== transactionId ||
      Date.parse(occurredAt) <
        Date.parse(tombstone.attempt.transactionValidUntil) + 30_000 ||
      run.status === 'COMPLETED' ||
      run.status === 'FAILED'
    )
      return false;
    this.runs.set(runId, createFailureSnapshot(run, occurredAt));
    return true;
  }

  async failUnclaimedRun(
    runId: Identifier,
    occurredAt: Timestamp,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (
      !run ||
      this.paymentTombstones.has(runId) ||
      this.activeOwners.has(runId) ||
      run.status === 'COMPLETED' ||
      run.status === 'FAILED'
    )
      return false;
    this.runs.set(runId, createFailureSnapshot(run, occurredAt));
    return true;
  }

  hasPaymentTombstone(runId: Identifier): boolean {
    return this.paymentTombstones.has(runId);
  }

  getPaymentIdentifier(runId: Identifier): string | undefined {
    return this.paymentTombstones.get(runId)?.attempt?.transactionId;
  }
}
