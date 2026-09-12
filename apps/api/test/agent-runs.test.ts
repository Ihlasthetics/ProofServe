import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunSchema,
  ApiErrorResponseSchema,
  PaymentReceiptSchema,
  activeServiceFixture,
  agentTaskFixture,
  fixtureReferenceTime,
  verifiedProviderFixture,
  type AgentRun,
  type ApiErrorCode,
  type DiscoveryService,
} from '@proofserve/shared';
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { transitionAgentRun } from '@proofserve/agent';
import {
  createAgentRunService,
  createApiApp,
  InMemoryAgentRunRepository,
  type AgentRunExecutionClaim,
  type AgentRunRepository,
} from '../src/index.js';
import type { SettlementReconciler } from '../src/hedera-settlement-reconciler.js';

const apps: ReturnType<typeof createApiApp>[] = [];
const apiToken = 'test-only-agent-run-token-00000000000000000000';
const authorization = { authorization: `Bearer ${apiToken}` };
const endpoint = activeServiceFixture.endpoint;
const feePayer = '0.0.7162784';
const transaction = '0.0.7162784@1788940800.123456789';
const expectation = {
  payer: '0.0.654321',
  receiver: activeServiceFixture.paymentRequirements.payTo,
  amountAtomic: activeServiceFixture.paymentRequirements.amountAtomic,
  asset: activeServiceFixture.paymentRequirements.asset,
  network: activeServiceFixture.paymentRequirements.network,
};
const paymentAttempt = {
  ...expectation,
  transactionId: transaction,
  transactionValidUntil: '2099-09-06T10:00:00.000Z',
};
const result = {
  category: 'billing',
  urgency: 'high',
  summary: 'Duplicate charge',
  suggestedAction: 'Review the account',
} as const;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectError(
  response: { statusCode: number; json(): unknown; body: string },
  status: number,
  code: ApiErrorCode,
) {
  expect(response.statusCode).toBe(status);
  expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe(code);
  expect(response.body).not.toMatch(/SENSITIVE|stack|database|credential/i);
}

function harness(
  repository: AgentRunRepository = new InMemoryAgentRunRepository(),
  settlementReconciler: SettlementReconciler = {
    reconcile: async () => ({ status: 'UNAVAILABLE' }),
  },
  schedule: (work: () => void) => void = () => undefined,
) {
  const entry: DiscoveryService = {
    service: structuredClone(activeServiceFixture),
    provider: structuredClone(verifiedProviderFixture),
  };
  const state = {
    initial: [entry],
    fresh: [entry],
    paidBody: JSON.stringify(result),
    paidStatus: 200,
    challengeAmount: entry.service.paymentRequirements.amountAtomic,
    throwBeforeSettlement: false,
    ambiguousAfterSettlement: false,
    settlements: 0,
  };
  let discoveries = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const address = new URL(String(url));
    if (address.origin === 'https://registry.example.test')
      return Response.json({
        services: ++discoveries === 1 ? state.initial : state.fresh,
      });
    if (state.throwBeforeSettlement)
      throw new Error('SENSITIVE upstream payload and credential');
    const headers = new Headers(init?.headers);
    if (!headers.has('payment-signature'))
      return new Response('', {
        status: 402,
        headers: {
          'payment-required': encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: endpoint, mimeType: 'application/json' },
            accepts: [
              {
                scheme: 'exact',
                network: 'hedera:testnet',
                asset: '0.0.0',
                amount: state.challengeAmount,
                payTo: entry.service.paymentRequirements.payTo,
                maxTimeoutSeconds: 300,
                extra: { feePayer },
              },
            ],
          }),
        },
      });
    state.settlements++;
    if (state.ambiguousAfterSettlement)
      throw new Error('SENSITIVE response connection lost after settlement');
    return new Response(state.paidBody, {
      status: state.paidStatus,
      headers: {
        'content-type': 'application/json',
        'payment-response': encodePaymentResponseHeader({
          success: true,
          network: 'hedera:testnet',
          transaction,
        }),
        'x-proofserve-hedera-transaction-id': transaction,
        'x-proofserve-hedera-transaction-url':
          'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
      },
    });
  });
  const sign = vi.fn(async () => 'dGVzdC1zaWduYXR1cmU=');
  let runSequence = 0;
  let ownerSequence = 0;
  const service = createAgentRunService({
    repository,
    buyer: {
      registryBaseUrl: 'https://registry.example.test',
      allowedServiceEndpoint: endpoint,
      fetcher,
      signerFactory: () => ({
        accountId: '0.0.654321',
        createPartiallySignedTransferTransaction: sign,
      }),
      paymentTransaction: () => paymentAttempt,
      now: () => fixtureReferenceTime,
    },
    now: () => fixtureReferenceTime,
    runId: () => `run_y05_${++runSequence}`,
    ownerId: () => `owner_y05_${++ownerSequence}`,
    schedule,
    settlementReconciler,
  });
  const app = createApiApp({ agentRuns: service, agentRunApiToken: apiToken });
  apps.push(app);
  return { app, repository, service, state, entry, fetcher, sign };
}

describe('Y05 agent run API', () => {
  it('fails closed when production run persistence was not injected', async () => {
    const app = createApiApp({ agentRunApiToken: apiToken });
    apps.push(app);
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/agent/runs',
        payload: agentTaskFixture,
        headers: authorization,
      }),
      500,
      'INTERNAL_ERROR',
    );
  });

  it('returns the strict CREATED snapshot with 202 before execution starts, then exposes successful progression', async () => {
    const h = harness();
    const createdResponse = await h.app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      payload: agentTaskFixture,
      headers: authorization,
    });
    expect(createdResponse.statusCode).toBe(202);
    const created = AgentRunSchema.parse(createdResponse.json());
    expect(created).toMatchObject({
      id: 'run_y05_1',
      task: agentTaskFixture,
      status: 'CREATED',
      selectedServiceId: null,
      paymentRequirements: null,
      paymentReceipt: null,
      result: null,
      error: null,
    });
    expect(created.events).toEqual([
      { status: 'CREATED', occurredAt: fixtureReferenceTime },
    ]);
    expect(h.fetcher).not.toHaveBeenCalled();

    await h.service.executeRun(created.id);
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/agent/runs/${created.id}`,
      headers: authorization,
    });
    expect(response.statusCode).toBe(200);
    const completed = AgentRunSchema.parse(response.json());
    expect(completed.status).toBe('COMPLETED');
    expect(completed.result).toEqual(result);
    expect(completed.events.map((event) => event.status)).toEqual([
      'CREATED',
      'DISCOVERING',
      'SELECTED',
      'PAYMENT_REQUIRED',
      'PAYING',
      'PAID',
      'EXECUTING',
      'COMPLETED',
    ]);
    expect(h.sign).toHaveBeenCalledTimes(1);
  });

  it('returns detached GET data and RUN_NOT_FOUND without accepting query parameters or bodies', async () => {
    const h = harness();
    const created = await h.service.createRun(agentTaskFixture);
    const first = await h.service.getRun(created.id);
    first.task.input.ticket = 'mutated response only';
    expect((await h.service.getRun(created.id)).task).toEqual(agentTaskFixture);
    expectError(
      await h.app.inject({
        method: 'GET',
        url: '/api/agent/runs/unknown',
        headers: authorization,
      }),
      404,
      'RUN_NOT_FOUND',
    );
    expectError(
      await h.app.inject({
        method: 'GET',
        url: `/api/agent/runs/${created.id}?unexpected=1`,
        headers: authorization,
      }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await h.app.inject({
        method: 'GET',
        url: `/api/agent/runs/${created.id}`,
        payload: '{}',
        headers: { ...authorization, 'content-type': 'application/json' },
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it.each([
    'id',
    'runId',
    'status',
    'selectedServiceId',
    'paymentRequirements',
    'paymentReceipt',
    'result',
    'error',
    'events',
    'createdAt',
    'updatedAt',
    'credentials',
    'endpoint',
    'price',
    'ownership',
    'payment',
  ])('rejects caller-controlled %s', async (field) => {
    const h = harness();
    expectError(
      await h.app.inject({
        method: 'POST',
        url: '/api/agent/runs',
        payload: { ...agentTaskFixture, [field]: 'SENSITIVE caller value' },
        headers: authorization,
      }),
      400,
      'VALIDATION_ERROR',
    );
    expect(await h.repository.getRun('run_y05_1')).toBeUndefined();
  });

  it.each([
    'cookie',
    'x-api-key',
    'payment-signature',
    'payment-required',
    'payment-response',
    'x-proofserve-hedera-transaction-id',
    'x-proofserve-hedera-transaction-url',
  ])(
    'rejects caller-controlled credential or payment header %s',
    async (name) => {
      const h = harness();
      expectError(
        await h.app.inject({
          method: 'POST',
          url: '/api/agent/runs',
          payload: agentTaskFixture,
          headers: { ...authorization, [name]: 'SENSITIVE caller value' },
        }),
        400,
        'VALIDATION_ERROR',
      );
      expect(await h.repository.getRun('run_y05_1')).toBeUndefined();
    },
  );

  it('blocks anonymous and invalid callers before creation, execution, or read', async () => {
    const h = harness();
    for (const headers of [
      undefined,
      { authorization: 'Bearer SENSITIVE-invalid-token-value' },
    ]) {
      expectError(
        await h.app.inject({
          method: 'POST',
          url: '/api/agent/runs',
          payload: agentTaskFixture,
          ...(headers ? { headers } : {}),
        }),
        401,
        'UNAUTHORIZED',
      );
    }
    expect(await h.repository.getRun('run_y05_1')).toBeUndefined();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();

    const created = await h.service.createRun(agentTaskFixture);
    for (const headers of [undefined, { authorization: 'Basic invalid' }])
      expectError(
        await h.app.inject({
          method: 'GET',
          url: `/api/agent/runs/${created.id}`,
          ...(headers ? { headers } : {}),
        }),
        401,
        'UNAUTHORIZED',
      );
  });

  it('uses shared ownership across concurrent service instances and signs only once', async () => {
    const repository = new InMemoryAgentRunRepository();
    const first = harness(repository);
    const second = harness(repository);
    const created = await first.service.createRun(agentTaskFixture);
    await Promise.all([
      first.service.executeRun(created.id),
      second.service.executeRun(created.id),
    ]);
    expect((await repository.getRun(created.id))?.status).toBe('COMPLETED');
    expect(first.sign.mock.calls.length + second.sign.mock.calls.length).toBe(
      1,
    );
    expect(repository.hasPaymentTombstone(created.id)).toBe(true);
  });

  it('rechecks current eligibility and actual price against budget before signing', async () => {
    const changed = harness();
    const changedEntry = structuredClone(changed.entry);
    changedEntry.service.paymentRequirements.amountAtomic = '999999';
    changed.state.fresh = [changedEntry];
    const first = await changed.service.createRun(agentTaskFixture);
    await changed.service.executeRun(first.id);
    expect((await changed.service.getRun(first.id)).error?.code).toBe(
      'NO_ELIGIBLE_SERVICE',
    );
    expect(changed.sign).not.toHaveBeenCalled();

    const overBudget = harness();
    overBudget.state.challengeAmount = (
      BigInt(agentTaskFixture.budget.maxAmountAtomic) + 1n
    ).toString();
    const second = await overBudget.service.createRun(agentTaskFixture);
    await overBudget.service.executeRun(second.id);
    expect((await overBudget.service.getRun(second.id)).error?.code).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(overBudget.sign).not.toHaveBeenCalled();
  });

  it('sanitizes pre-settlement failures and retains a strict receipt after settlement failure', async () => {
    const before = harness();
    before.state.throwBeforeSettlement = true;
    const beforeRun = await before.service.createRun(agentTaskFixture);
    await before.service.executeRun(beforeRun.id);
    const failedBefore = await before.service.getRun(beforeRun.id);
    expect(failedBefore.status).toBe('FAILED');
    expect(failedBefore.paymentReceipt).toBeNull();
    expect(JSON.stringify(failedBefore)).not.toContain('SENSITIVE');

    const after = harness();
    after.state.paidBody = 'SENSITIVE invalid upstream body {';
    const afterRun = await after.service.createRun(agentTaskFixture);
    await after.service.executeRun(afterRun.id);
    const failedAfter = await after.service.getRun(afterRun.id);
    expect(failedAfter.status).toBe('FAILED');
    expect(failedAfter.error?.code).toBe('SERVICE_EXECUTION_FAILED');
    expect(failedAfter.paymentReceipt?.transactionId).toBe(transaction);
    expect(JSON.stringify(failedAfter)).not.toContain('SENSITIVE');
  });
});

class FailingPersistRepository implements AgentRunRepository {
  constructor(
    private readonly delegate: InMemoryAgentRunRepository,
    private readonly failAfterCommit: boolean,
  ) {}

  createRun(snapshot: AgentRun) {
    return this.delegate.createRun(snapshot);
  }

  getRun(runId: AgentRun['id']) {
    return this.delegate.getRun(runId);
  }

  listReconciliationRunIds() {
    return this.delegate.listReconciliationRunIds();
  }

  getPaymentReconciliation(runId: AgentRun['id']) {
    return this.delegate.getPaymentReconciliation(runId);
  }

  recoverConfirmedPayment(
    ...parameters: Parameters<AgentRunRepository['recoverConfirmedPayment']>
  ) {
    return this.delegate.recoverConfirmedPayment(...parameters);
  }

  failExpiredPayment(
    ...parameters: Parameters<AgentRunRepository['failExpiredPayment']>
  ) {
    return this.delegate.failExpiredPayment(...parameters);
  }

  reconcileTombstonedRun(
    runId: AgentRun['id'],
    occurredAt: AgentRun['updatedAt'],
  ) {
    return this.delegate.reconcileTombstonedRun(runId, occurredAt);
  }

  failUnclaimedRun(runId: AgentRun['id'], occurredAt: AgentRun['updatedAt']) {
    return this.delegate.failUnclaimedRun(runId, occurredAt);
  }

  async claimExecution(
    runId: AgentRun['id'],
    ownerId: AgentRun['id'],
  ): Promise<AgentRunExecutionClaim | undefined> {
    const claim = await this.delegate.claimExecution(runId, ownerId);
    if (!claim) return undefined;
    let failed = false;
    return {
      snapshot: claim.snapshot,
      beginSigning: (value) => claim.beginSigning(value),
      recordPaymentAttempt: (value) => claim.recordPaymentAttempt(value),
      authorizeSubmission: (value) => claim.authorizeSubmission(value),
      release: () => claim.release(),
      persist: async (snapshot) => {
        if (!failed && snapshot.status === 'PAID') {
          failed = true;
          if (this.failAfterCommit) await claim.persist(snapshot);
          throw new Error('SENSITIVE database acknowledgement');
        }
        await claim.persist(snapshot);
      },
    };
  }
}

describe('Y05 reconciliation', () => {
  async function abandonPayment(
    repository: InMemoryAgentRunRepository,
    attempt = paymentAttempt,
  ) {
    const first = harness(repository);
    const created = await first.service.createRun(agentTaskFixture);
    const claim = await repository.claimExecution(created.id, 'old_owner');
    if (!claim) throw new Error('Expected claim');
    let snapshot = transitionAgentRun(created, {
      status: 'DISCOVERING',
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'SELECTED',
      selectedServiceId: activeServiceFixture.id,
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'PAYMENT_REQUIRED',
      paymentRequirements: activeServiceFixture.paymentRequirements,
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'PAYING',
      occurredAt: fixtureReferenceTime,
    });
    await claim.persist(snapshot);
    await claim.beginSigning(expectation);
    await claim.recordPaymentAttempt(attempt);
    await claim.release();
    return { created, claim, snapshot };
  }

  it('authoritatively recovers settlement after a crash before receipt persistence', async () => {
    const repository = new InMemoryAgentRunRepository();
    const { created } = await abandonPayment(repository);
    const restarted = harness(repository, {
      reconcile: async () => ({
        status: 'CONFIRMED',
        settledAt: fixtureReferenceTime,
        transactionUrl:
          'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
      }),
    });
    await restarted.service.executeRun(created.id);
    const recovered = await restarted.service.getRun(created.id);
    expect(recovered.status).toBe('FAILED');
    expect(recovered.error?.code).toBe('SERVICE_EXECUTION_FAILED');
    expect(recovered.paymentReceipt?.transactionId).toBe(transaction);
    expect(recovered.events.map((event) => event.status)).toEqual(
      expect.arrayContaining(['PAID', 'EXECUTING']),
    );
    expect(restarted.fetcher).not.toHaveBeenCalled();
    expect(restarted.sign).not.toHaveBeenCalled();
  });

  it('queues same-process reconciliation after an authorized ambiguous settlement and never repays', async () => {
    const repository = new InMemoryAgentRunRepository();
    const scheduled: Array<() => void> = [];
    const reconcile = vi.fn<SettlementReconciler['reconcile']>(async () => ({
      status: 'CONFIRMED',
      settledAt: fixtureReferenceTime,
      transactionUrl:
        'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
    }));
    const h = harness(repository, { reconcile }, (work) =>
      scheduled.push(work),
    );
    h.state.ambiguousAfterSettlement = true;
    const created = await h.service.createRun(agentTaskFixture);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await vi.waitFor(async () => {
      expect((await repository.getRun(created.id))?.status).toBe('PAYING');
      expect(scheduled).toHaveLength(1);
    });
    expect(h.sign).toHaveBeenCalledTimes(1);
    const paidRequests = () =>
      h.fetcher.mock.calls.filter(([, init]) =>
        new Headers(init?.headers).has('payment-signature'),
      );
    expect(paidRequests()).toHaveLength(1);
    expect(h.state.settlements).toBe(1);
    expect(reconcile).not.toHaveBeenCalled();

    scheduled.shift()!();
    await vi.waitFor(async () => {
      expect(
        (await repository.getRun(created.id))?.paymentReceipt?.transactionId,
      ).toBe(transaction);
    });
    const recovered = await repository.getRun(created.id);
    expect(recovered?.error?.code).toBe('SERVICE_EXECUTION_FAILED');
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(paidRequests()).toHaveLength(1);
    expect(h.state.settlements).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('rejects a generic failure snapshot for a tombstoned run without a receipt', async () => {
    const repository = new InMemoryAgentRunRepository();
    const first = harness(repository);
    const created = await first.service.createRun(agentTaskFixture);
    const claim = await repository.claimExecution(created.id, 'owner_guard');
    if (!claim) throw new Error('Expected claim');
    let paying = transitionAgentRun(created, {
      status: 'DISCOVERING',
      occurredAt: fixtureReferenceTime,
    });
    paying = transitionAgentRun(paying, {
      status: 'SELECTED',
      selectedServiceId: activeServiceFixture.id,
      occurredAt: fixtureReferenceTime,
    });
    paying = transitionAgentRun(paying, {
      status: 'PAYMENT_REQUIRED',
      paymentRequirements: activeServiceFixture.paymentRequirements,
      occurredAt: fixtureReferenceTime,
    });
    paying = transitionAgentRun(paying, {
      status: 'PAYING',
      occurredAt: fixtureReferenceTime,
    });
    await claim.persist(paying);
    await claim.beginSigning(expectation);
    const failed = transitionAgentRun(paying, {
      status: 'FAILED',
      error: {
        code: 'PAYMENT_FAILED',
        message: 'Payment could not be confirmed. Do not automatically retry.',
      },
      occurredAt: fixtureReferenceTime,
    });
    await expect(claim.persist(failed)).rejects.toThrow(
      'Agent run persistence failed.',
    );
    expect((await repository.getRun(created.id))?.status).toBe('PAYING');
    await claim.release();
  });

  it('fails generically only when authoritative absence is observed after expiry and grace', async () => {
    const repository = new InMemoryAgentRunRepository();
    const expired = {
      ...paymentAttempt,
      transactionValidUntil: '2026-09-06T09:00:00.000Z',
    };
    const { created } = await abandonPayment(repository, expired);
    const restarted = harness(repository, {
      reconcile: async () => ({ status: 'ABSENT' }),
    });
    await restarted.service.executeRun(created.id);
    const recovered = await restarted.service.getRun(created.id);
    expect(recovered.status).toBe('FAILED');
    expect(recovered.error?.code).toBe('PAYMENT_FAILED');
    expect(recovered.paymentReceipt).toBeNull();
    expect(restarted.fetcher).not.toHaveBeenCalled();
  });

  it('does not permit takeover while the persisted transaction remains valid', async () => {
    const repository = new InMemoryAgentRunRepository();
    const { created } = await abandonPayment(repository);
    expect(
      await repository.claimExecution(created.id, 'new_owner'),
    ).toBeUndefined();
    const restarted = harness(repository, {
      reconcile: async () => ({ status: 'ABSENT' }),
    });
    await restarted.service.executeRun(created.id);
    expect((await restarted.service.getRun(created.id)).status).toBe('PAYING');
  });

  it.each([false, true])(
    'atomically reconciles a receipt after persistence failure (commit applied: %s)',
    async (failAfterCommit) => {
      const durable = new InMemoryAgentRunRepository();
      const h = harness(new FailingPersistRepository(durable, failAfterCommit));
      h.state.paidBody = 'SENSITIVE invalid body {';
      const created = await h.service.createRun(agentTaskFixture);
      await h.service.executeRun(created.id);
      const stored = AgentRunSchema.parse(await durable.getRun(created.id));
      expect(stored.status).toBe('FAILED');
      expect(stored.paymentReceipt?.transactionId).toBe(transaction);
      expect(stored.events.map((event) => event.status)).toContain('PAID');
      expect(JSON.stringify(stored)).not.toContain('SENSITIVE');
    },
  );

  it('reclaims interrupted pre-signing work and resumes monotonically', async () => {
    const repository = new InMemoryAgentRunRepository();
    const first = harness(repository);
    const created = await first.service.createRun(agentTaskFixture);
    const abandoned = await repository.claimExecution(created.id, 'old_owner');
    if (!abandoned) throw new Error('Expected claim');
    await abandoned.persist(
      transitionAgentRun(created, {
        status: 'DISCOVERING',
        occurredAt: fixtureReferenceTime,
      }),
    );
    await abandoned.release();

    const restarted = harness(repository);
    await restarted.service.reconcile();
    await restarted.service.executeRun(created.id);
    const completed = AgentRunSchema.parse(await repository.getRun(created.id));
    expect(completed.status).toBe('COMPLETED');
    expect(
      completed.events.filter((event) => event.status === 'DISCOVERING'),
    ).toHaveLength(1);
    expect(restarted.sign).toHaveBeenCalledTimes(1);
  });

  it('keeps a crash after tombstone insertion pending without retrying signing', async () => {
    const repository = new InMemoryAgentRunRepository();
    const first = harness(repository);
    const created = await first.service.createRun(agentTaskFixture);
    const claim = await repository.claimExecution(created.id, 'old_owner');
    if (!claim) throw new Error('Expected claim');
    let snapshot = created;
    snapshot = transitionAgentRun(snapshot, {
      status: 'DISCOVERING',
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'SELECTED',
      selectedServiceId: activeServiceFixture.id,
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'PAYMENT_REQUIRED',
      paymentRequirements: activeServiceFixture.paymentRequirements,
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'PAYING',
      occurredAt: fixtureReferenceTime,
    });
    await claim.persist(snapshot);
    await claim.beginSigning(expectation);
    await claim.release();

    const restarted = harness(repository);
    await restarted.service.reconcile();
    await restarted.service.executeRun(created.id);
    const recovered = await repository.getRun(created.id);
    expect(recovered?.status).toBe('PAYING');
    expect(recovered?.error).toBeNull();
    expect(restarted.fetcher).not.toHaveBeenCalled();
    expect(restarted.sign).not.toHaveBeenCalled();
  });

  it('keeps ambiguous post-submit work pending during a temporary reconciliation outage', async () => {
    const repository = new InMemoryAgentRunRepository();
    const first = harness(repository);
    const created = await first.service.createRun(agentTaskFixture);
    const claim = await repository.claimExecution(created.id, 'old_owner');
    if (!claim) throw new Error('Expected claim');
    let snapshot = transitionAgentRun(created, {
      status: 'DISCOVERING',
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'SELECTED',
      selectedServiceId: activeServiceFixture.id,
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'PAYMENT_REQUIRED',
      paymentRequirements: activeServiceFixture.paymentRequirements,
      occurredAt: fixtureReferenceTime,
    });
    snapshot = transitionAgentRun(snapshot, {
      status: 'PAYING',
      occurredAt: fixtureReferenceTime,
    });
    await claim.persist(snapshot);
    await claim.beginSigning(expectation);
    await claim.recordPaymentAttempt({
      ...paymentAttempt,
      transactionValidUntil: '2026-09-06T09:00:00.000Z',
    });
    await claim.release();
    expect(repository.getPaymentIdentifier(created.id)).toBe(transaction);

    const restarted = harness(repository);
    await restarted.service.executeRun(created.id);
    const failed = await repository.getRun(created.id);
    expect(failed?.status).toBe('PAYING');
    expect(failed?.error).toBeNull();
    expect(JSON.stringify(failed)).not.toContain(transaction);
    expect(restarted.sign).not.toHaveBeenCalled();
    expect(restarted.fetcher).not.toHaveBeenCalled();
  });

  it.each(['PAID', 'EXECUTING'] as const)(
    'preserves a durable receipt when recovering abandoned %s work',
    async (status) => {
      const repository = new InMemoryAgentRunRepository();
      const first = harness(repository);
      const created = await first.service.createRun(agentTaskFixture);
      const claim = await repository.claimExecution(created.id, 'old_owner');
      if (!claim) throw new Error('Expected claim');
      let snapshot = transitionAgentRun(created, {
        status: 'DISCOVERING',
        occurredAt: fixtureReferenceTime,
      });
      snapshot = transitionAgentRun(snapshot, {
        status: 'SELECTED',
        selectedServiceId: activeServiceFixture.id,
        occurredAt: fixtureReferenceTime,
      });
      snapshot = transitionAgentRun(snapshot, {
        status: 'PAYMENT_REQUIRED',
        paymentRequirements: activeServiceFixture.paymentRequirements,
        occurredAt: fixtureReferenceTime,
      });
      snapshot = transitionAgentRun(snapshot, {
        status: 'PAYING',
        occurredAt: fixtureReferenceTime,
      });
      await claim.persist(snapshot);
      await claim.beginSigning(expectation);
      await claim.recordPaymentAttempt(paymentAttempt);
      const receipt = PaymentReceiptSchema.parse({
        id: 'receipt_recovery_test',
        runId: created.id,
        serviceId: activeServiceFixture.id,
        paymentRequirements: activeServiceFixture.paymentRequirements,
        transactionId: transaction,
        transactionUrl:
          'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
        settledAt: fixtureReferenceTime,
      });
      snapshot = transitionAgentRun(snapshot, {
        status: 'PAID',
        paymentReceipt: receipt,
        occurredAt: fixtureReferenceTime,
      });
      if (status === 'EXECUTING')
        snapshot = transitionAgentRun(snapshot, {
          status: 'EXECUTING',
          occurredAt: fixtureReferenceTime,
        });
      await claim.persist(snapshot);
      await claim.release();

      const restarted = harness(repository);
      await restarted.service.reconcile();
      await restarted.service.executeRun(created.id);
      const failed = AgentRunSchema.parse(await repository.getRun(created.id));
      expect(failed.status).toBe('FAILED');
      expect(failed.error?.code).toBe('SERVICE_EXECUTION_FAILED');
      expect(failed.paymentReceipt).toEqual(receipt);
      expect(restarted.fetcher).not.toHaveBeenCalled();
      expect(restarted.sign).not.toHaveBeenCalled();
    },
  );

  it('terminalizes an unexpected execution-construction failure after 202', async () => {
    const repository = new InMemoryAgentRunRepository();
    const service = createAgentRunService({
      repository,
      buyer: {
        registryBaseUrl: 'https://registry.example.test',
        allowedServiceEndpoint: endpoint,
      },
      now: () => fixtureReferenceTime,
      runId: () => 'run_constructor_failure',
      ownerId: () => 'owner_constructor_failure',
      schedule: () => undefined,
      createBuyer: () => {
        throw new Error('SENSITIVE constructor failure');
      },
    });
    const created = await service.createRun(agentTaskFixture);
    expect(created.status).toBe('CREATED');
    await service.executeRun(created.id);
    const failed = await service.getRun(created.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error?.code).toBe('PAYMENT_FAILED');
    expect(JSON.stringify(failed)).not.toContain('SENSITIVE');
  });
});
