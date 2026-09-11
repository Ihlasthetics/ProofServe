import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRunSchema,
  activeServiceFixture,
  agentTaskFixture,
  fixtureReferenceTime,
  verifiedProviderFixture,
  type DiscoveryService,
} from '@proofserve/shared';
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';
import { createServiceApp } from '../../service/src/app.js';
import {
  createBuyerRun,
  createInMemoryBuyerOwnership,
  BuyerError,
  type BuyerOptions,
} from '../src/index.js';
import * as discovery from '../src/registry-client.js';
import * as selection from '../src/service-selection.js';

const endpoint = activeServiceFixture.endpoint;
const feePayer = '0.0.7162784';
// Explicit test-only settlement, supplied only by the fake facilitator.
const transaction = '0.0.7162784@1788940800.123456789';
const transactionUrl =
  'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789';
const signingBytes = 'dGVzdC1vbmx5LXNpZ25lZC1ieXRlcw==';
const result = {
  category: 'account',
  urgency: 'high',
  summary: 'Account inaccessible',
  suggestedAction: 'Restore access',
} as const;
const apps: ReturnType<typeof createServiceApp>[] = [];
let nextRunId = 0;
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64');

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('Public internet is forbidden in tests')),
  );
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function harness(amount = '1000000') {
  const task = structuredClone(agentTaskFixture);
  task.budget.maxAmountAtomic = amount;
  const entry: DiscoveryService = {
    service: structuredClone(activeServiceFixture),
    provider: structuredClone(verifiedProviderFixture),
  };
  entry.service.paymentRequirements.amountAtomic = amount;
  const state = {
    initial: [entry],
    fresh: [entry],
    time: fixtureReferenceTime,
    unpaid: (response: Response) => response,
    paid: (response: Response) => response,
    settlement: {
      success: true,
      network: 'hedera:testnet',
      transaction,
    } as SettleResponse,
  };
  const verify = vi.fn<FacilitatorClient['verify']>(async (payload) => {
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual({
      scheme: 'exact',
      network: 'hedera:testnet',
      asset: '0.0.0',
      amount,
      payTo: entry.service.paymentRequirements.payTo,
      maxTimeoutSeconds: 300,
      extra: { feePayer },
    });
    expect(payload.payload).toEqual({ transaction: signingBytes });
    return { isValid: true };
  });
  const settle = vi.fn<FacilitatorClient['settle']>(
    async () => state.settlement,
  );
  const engine = vi.fn(async () => result);
  const app = createServiceApp({
    publicUrl: endpoint,
    receiverAccountId: entry.service.paymentRequirements.payTo,
    priceTinybar: amount,
    engine: { triage: engine },
    facilitator: {
      getSupported: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'hedera:testnet',
            extra: { feePayer },
          },
        ],
        extensions: [],
        signers: { 'hedera:*': [feePayer] },
      }),
      verify,
      settle,
    },
  });
  apps.push(app);
  let discoveries = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const address = new URL(String(url));
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (address.origin === 'https://registry.example.test') {
      expect(address.pathname).toBe('/api/services');
      expect(init?.method).toBe('GET');
      return Response.json({
        services: ++discoveries === 1 ? state.initial : state.fresh,
      });
    }
    expect(address.href).toBe(endpoint);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(task.input));
    const headers = Object.fromEntries(new Headers(init?.headers));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers,
      payload: String(init?.body),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) responseHeaders.set(name, String(value));
    }
    const output = new Response(response.body, {
      status: response.statusCode,
      headers: responseHeaders,
    });
    return headers['payment-signature']
      ? state.paid(output)
      : state.unpaid(output);
  });
  const sign = vi.fn<(requirement: PaymentRequirements) => Promise<string>>(
    async () => signingBytes,
  );
  const signerFactory = vi.fn(() => ({
    accountId: '0.0.654321',
    createPartiallySignedTransferTransaction: sign,
  }));
  const options: BuyerOptions = {
    registryBaseUrl: 'https://registry.example.test',
    allowedServiceEndpoint: endpoint,
    runId: `run_t04_${++nextRunId}`,
    fetcher,
    signerFactory,
    now: () => state.time,
  };
  const prepare = () => createBuyerRun(task, options);
  return {
    task,
    entry,
    state,
    fetcher,
    sign,
    signerFactory,
    options,
    prepare,
    verify,
    settle,
    engine,
    app,
  };
}

function changeOffer(
  h: ReturnType<typeof harness>,
  change: (value: ReturnType<typeof decodePaymentRequiredHeader>) => unknown,
) {
  h.state.unpaid = (response) => {
    const header = response.headers.get('payment-required');
    if (!header) throw new Error('Missing test challenge');
    response.headers.set(
      'payment-required',
      encode(change(decodePaymentRequiredHeader(header))),
    );
    return response;
  };
}
const failure = async (
  h: ReturnType<typeof harness>,
  code = 'PAYMENT_FAILED',
) => {
  const output = await h.prepare().execute();
  expect(output.status).toBe('FAILED');
  expect(output.error?.code).toBe(code);
  expect(output.result).toBeNull();
  expect(AgentRunSchema.safeParse(output).success).toBe(true);
  expect(JSON.stringify(output)).not.toContain('SENSITIVE');
  return output;
};

describe('T04 real buyer flow with offline Y03 service', () => {
  it.each(['initialization', 'signing'] as const)(
    'refreshes the registry after %s and blocks every security change',
    async (phase) => {
      for (const kind of [
        'inactive',
        'suspended',
        'unverified',
        'expired',
        'revoked',
        'missing',
        'duplicate',
        'endpoint',
        'receiver',
        'price',
        'payout',
        'network',
        'asset',
        'capability',
        'identity',
        'verification',
      ]) {
        const h = harness();
        const fresh = structuredClone(h.entry);
        fresh.service.name = 'Harmless simultaneous edit';
        if (kind === 'inactive') fresh.service.status = 'DRAFT';
        if (kind === 'suspended') fresh.service.status = 'SUSPENDED';
        if (kind === 'unverified')
          fresh.provider.verification = {
            ...fresh.provider.verification,
            status: 'UNVERIFIED',
            verifiedAt: null,
            expiresAt: null,
          };
        if (kind === 'expired')
          fresh.provider.verification = {
            ...fresh.provider.verification,
            status: 'EXPIRED',
            verifiedAt: '2026-09-05T00:00:00.000Z',
            expiresAt: fixtureReferenceTime,
          };
        if (kind === 'revoked')
          Reflect.set(fresh.provider.verification, 'status', 'REVOKED');
        if (kind === 'endpoint')
          fresh.service.endpoint = 'https://other.example.test/v1/triage';
        if (kind === 'receiver')
          fresh.service.paymentRequirements.payTo = '0.0.999';
        if (kind === 'price')
          fresh.service.paymentRequirements.amountAtomic = '999999';
        if (kind === 'payout') fresh.provider.payoutAccount = '0.0.999';
        if (kind === 'network')
          Reflect.set(
            fresh.service.paymentRequirements,
            'network',
            'hedera:mainnet',
          );
        if (kind === 'asset')
          Reflect.set(fresh.service.paymentRequirements, 'asset', '0.0.1');
        if (kind === 'capability')
          Reflect.set(fresh.service, 'capability', 'OTHER');
        if (kind === 'identity') fresh.service.id = 'replacement';
        if (kind === 'verification')
          fresh.provider.verification = {
            ...fresh.provider.verification,
            status: 'VERIFIED',
            verifiedAt: '2026-09-05T00:00:00.000Z',
            expiresAt: '2026-09-08T00:00:00.000Z',
          };
        const change = () => {
          h.state.fresh =
            kind === 'missing'
              ? []
              : kind === 'duplicate'
                ? [fresh, fresh]
                : [fresh];
        };
        if (phase === 'initialization')
          h.options.signerFactory = async () => {
            await Promise.resolve();
            change();
            return h.signerFactory();
          };
        else
          h.sign.mockImplementation(async () => {
            await Promise.resolve();
            change();
            return signingBytes;
          });
        expect((await h.prepare().execute()).status, kind).toBe('FAILED');
        expect(h.sign, kind).toHaveBeenCalledTimes(
          phase === 'initialization' ? 0 : 1,
        );
        expect(
          h.fetcher.mock.calls.filter(([, init]) =>
            new Headers(init?.headers).has('payment-signature'),
          ),
          kind,
        ).toHaveLength(0);
      }
    },
  );

  it('allows descriptive edits without overlooking payment fields', async () => {
    const h = harness();
    h.sign.mockImplementation(async () => {
      const fresh = structuredClone(h.entry);
      fresh.service.name = 'Renamed';
      fresh.service.description = 'New description';
      fresh.service.updatedAt = '2026-09-06T10:00:01.000Z';
      fresh.provider.displayName = 'New name';
      fresh.provider.updatedAt = fresh.service.updatedAt;
      h.state.fresh = [fresh];
      return signingBytes;
    });
    expect((await h.prepare().execute()).status).toBe('COMPLETED');
  });

  it.each(['concurrent', 'sequential'] as const)(
    'claims explicit runId across independent %s handles',
    async (mode) => {
      const h = harness();
      const first = h.prepare();
      const second = h.prepare();
      const firstResult = first.execute();
      if (mode === 'sequential') await firstResult;
      const outcomes = await Promise.allSettled([
        firstResult,
        second.execute(),
      ]);
      expect(outcomes[0]).toMatchObject({
        status: 'fulfilled',
        value: { status: 'COMPLETED' },
      });
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { code: 'VALIDATION_ERROR' },
      });
      expect((await first.execute()).status).toBe('COMPLETED');
      await expect(h.prepare().execute()).rejects.toBeInstanceOf(BuyerError);
      expect(h.sign).toHaveBeenCalledTimes(1);
      expect(h.verify).toHaveBeenCalledTimes(1);
      expect(
        h.fetcher.mock.calls.filter(([, init]) =>
          new Headers(init?.headers).has('payment-signature'),
        ),
      ).toHaveLength(1);
    },
  );

  it.each(['throwing', 'malformed', 'backward'] as const)(
    'retains validated settlement with a %s clock',
    async (kind) => {
      const h = harness();
      let received = false;
      h.state.paid = (response) => {
        received = true;
        return response;
      };
      h.options.now = () => {
        if (!received) return fixtureReferenceTime;
        if (kind === 'throwing') throw new Error('SENSITIVE clock');
        return kind === 'malformed' ? 'SENSITIVE' : '2026-09-01T00:00:00.000Z';
      };
      const output = await failure(h, 'SERVICE_EXECUTION_FAILED');
      expect(output.paymentReceipt?.transactionId).toBe(transaction);
      expect(output.paymentReceipt?.transactionUrl).toBe(transactionUrl);
      expect(output.paymentReceipt!.settledAt >= fixtureReferenceTime).toBe(
        true,
      );
      expect(output.events.map((event) => event.status)).toContain('PAID');
      expect(h.sign).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['unpaid', 'paid'] as const)(
    'bounds %s streamed bodies before JSON allocation',
    async (phase) => {
      for (const advertised of [true, false]) {
        const h = harness();
        const cancel = vi.fn();
        h.state[phase] = (response) => {
          const headers = new Headers(response.headers);
          if (advertised) headers.set('content-length', '999999999');
          else headers.delete('content-length');
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(70_000));
              },
              cancel,
            }),
            { status: response.status, headers },
          );
        };
        const output = await failure(
          h,
          phase === 'paid' ? 'SERVICE_EXECUTION_FAILED' : 'PAYMENT_FAILED',
        );
        expect(h.sign).toHaveBeenCalledTimes(phase === 'paid' ? 1 : 0);
        if (phase === 'paid')
          expect(output.paymentReceipt?.transactionId).toBe(transaction);
        if (!advertised) expect(cancel).toHaveBeenCalled();
      }
    },
  );

  it('rejects duplicate or absent selected services on revalidation', async () => {
    for (const duplicate of [false, true]) {
      const h = harness();
      h.state.fresh = duplicate ? [h.entry, structuredClone(h.entry)] : [];
      await failure(h, 'NO_ELIGIBLE_SERVICE');
      expect(h.sign).not.toHaveBeenCalled();
    }
  });

  it('strips untrusted extensions and diagnostics before official signing', async () => {
    const h = harness();
    changeOffer(h, (data) => ({
      ...data,
      error: 'SENSITIVE',
      extensions: { diagnostic: 'SENSITIVE' },
      accepts: data.accepts.map((offer) => ({
        ...offer,
        extra: { ...offer.extra, diagnostic: 'SENSITIVE' },
      })),
    }));
    const output = await h.prepare().execute();
    expect(output.status).toBe('COMPLETED');
    expect(JSON.stringify(h.sign.mock.calls)).not.toContain('SENSITIVE');
    expect(JSON.stringify(output)).not.toContain('SENSITIVE');
  });

  it.each([
    'payment-response',
    'x-proofserve-hedera-transaction-id',
    'x-proofserve-hedera-transaction-url',
  ])('rejects inconsistent settlement header %s', async (name) => {
    const h = harness();
    h.state.paid = (response) => {
      response.headers.set(name, 'SENSITIVE');
      return response;
    };
    expect((await failure(h)).paymentReceipt).toBeNull();
  });

  it('accepts the Y03 path transaction format and derives its URL', async () => {
    const h = harness();
    h.state.settlement = {
      success: true,
      network: 'hedera:testnet',
      transaction: '0.0.7162784-1788940800-123456789',
    };
    const output = await h.prepare().execute();
    expect(output.status).toBe('COMPLETED');
    expect(output.paymentReceipt?.transactionUrl).toBe(transactionUrl);
  });

  it('retains receipt on response-body timeout and aborts the paid request', async () => {
    const h = harness();
    await h.app.ready();
    vi.useFakeTimers();
    h.state.paid = (response) => {
      return new Response(
        new ReadableStream({ pull: () => new Promise(() => {}) }),
        { headers: response.headers },
      );
    };
    const pending = h.prepare().execute();
    await vi.advanceTimersByTimeAsync(30_001);
    const output = await pending;
    expect(output.status).toBe('FAILED');
    expect(output.error?.code).toBe('SERVICE_EXECUTION_FAILED');
    expect(output.paymentReceipt?.transactionId).toBe(transaction);
    expect(h.fetcher.mock.calls[5]?.[1]?.signal?.aborted).toBe(true);
    expect(h.sign).toHaveBeenCalledTimes(1);
  });

  it('times out signer initialization without late signing', async () => {
    const h = harness();
    await h.app.ready();
    vi.useFakeTimers();
    let finish:
      ((signer: ReturnType<typeof h.signerFactory>) => void) | undefined;
    h.options.signerFactory = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = h.prepare().execute();
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).status).toBe('FAILED');
    finish?.(h.signerFactory());
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([2, 3, 4, 5, 6])(
    'times out request %s without another payment or retry',
    async (at) => {
      const h = harness();
      await h.app.ready();
      vi.useFakeTimers();
      const original = h.fetcher.getMockImplementation()!;
      let count = 0;
      h.fetcher.mockImplementation((...args) =>
        ++count === at ? new Promise<Response>(() => {}) : original(...args),
      );
      const pending = h.prepare().execute();
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await pending).status).toBe('FAILED');
      expect(h.fetcher).toHaveBeenCalledTimes(at);
      expect(h.sign).toHaveBeenCalledTimes(at >= 5 ? 1 : 0);
      expect(h.fetcher.mock.calls[at - 1]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it('uses real T02/T03 exports, SDK 402, official signing and one paid retry', async () => {
    const discoverSpy = vi.spyOn(discovery, 'discoverServices');
    const selectSpy = vi.spyOn(selection, 'selectService');
    const h = harness();
    const output = await h.prepare().execute();
    expect(output.status).toBe('COMPLETED');
    expect(output.result).toEqual(result);
    expect(output.paymentReceipt).toEqual({
      id: expect.any(String),
      runId: h.options.runId,
      serviceId: h.entry.service.id,
      paymentRequirements: h.entry.service.paymentRequirements,
      transactionId: transaction,
      transactionUrl,
      settledAt: fixtureReferenceTime,
    });
    expect(output.events.map((event) => event.status)).toEqual([
      'CREATED',
      'DISCOVERING',
      'SELECTED',
      'PAYMENT_REQUIRED',
      'PAYING',
      'PAID',
      'EXECUTING',
      'COMPLETED',
    ]);
    expect(discoverSpy).toHaveBeenCalledTimes(4);
    expect(selectSpy).toHaveBeenCalled();
    expect(
      h.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      '/api/services',
      '/v1/triage',
      '/api/services',
      '/api/services',
      '/api/services',
      '/v1/triage',
    ]);
    expect(
      new Headers(h.fetcher.mock.calls[1]?.[1]?.headers).has(
        'payment-signature',
      ),
    ).toBe(false);
    const signed = new Headers(h.fetcher.mock.calls[5]?.[1]?.headers).get(
      'payment-signature',
    );
    expect(signed).toBeTruthy();
    expect(decodePaymentSignatureHeader(signed!)).toMatchObject({
      x402Version: 2,
      payload: { transaction: signingBytes },
    });
    expect(h.sign).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ amount: '1000000', extra: { feePayer } }),
    );
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(h.engine).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['1', '9007199254740993', '999999999999999999999999999999'])(
    'accepts exact atomic budget %s without precision loss',
    async (amount) => {
      const h = harness(amount);
      const output = await h.prepare().execute();
      expect(output.status).toBe('COMPLETED');
      expect(output.paymentReceipt?.paymentRequirements.amountAtomic).toBe(
        amount,
      );
      expect(h.sign.mock.calls[0]?.[0].amount).toBe(amount);
    },
  );

  it.each(['1000000', '9007199254740992'])(
    'rejects a 402 one atomic unit above remaining budget %s before signing',
    async (amount) => {
      const h = harness(amount);
      changeOffer(h, (value) => ({
        ...value,
        accepts: value.accepts.map((offer) => ({
          ...offer,
          amount: (BigInt(amount) + 1n).toString(),
        })),
      }));
      await failure(h, 'BUDGET_EXCEEDED');
      expect(h.signerFactory).not.toHaveBeenCalled();
      expect(h.fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['network', 'hedera:mainnet'],
    ['asset', '0.0.999'],
    ['payTo', '0.0.999'],
    ['scheme', 'upto'],
    ['amount', '999999'],
    ['amount', '0'],
    ['amount', '01'],
    ['amount', '1.5'],
    ['amount', '1e6'],
    ['amount', 1000000],
    ['maxTimeoutSeconds', 301],
    ['extra', {}],
    ['extra', { feePayer: 'SENSITIVE' }],
  ])(
    'rejects invalid or mismatched offer %s=%j without payment',
    async (field, value) => {
      const h = harness();
      changeOffer(h, (data) => ({
        ...data,
        accepts: data.accepts.map((offer) => ({ ...offer, [field]: value })),
      }));
      await failure(h);
      expect(h.sign).not.toHaveBeenCalled();
    },
  );

  it.each([
    'wrong endpoint',
    'multiple offers',
    'empty offers',
    'v1',
    'null',
    'wrong mime',
  ])('rejects %s challenge', async (kind) => {
    const h = harness();
    changeOffer(h, (data) =>
      kind === 'null'
        ? null
        : {
            ...data,
            ...(kind === 'v1' ? { x402Version: 1 } : {}),
            ...(kind === 'wrong endpoint'
              ? {
                  resource: {
                    ...data.resource,
                    url: 'https://other.example.test/v1/triage',
                  },
                }
              : {}),
            ...(kind === 'wrong mime'
              ? { resource: { ...data.resource, mimeType: 'text/html' } }
              : {}),
            ...(kind === 'multiple offers'
              ? { accepts: [...data.accepts, ...data.accepts] }
              : {}),
            ...(kind === 'empty offers' ? { accepts: [] } : {}),
          },
    );
    await failure(h);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it.each([200, 400, 403, 500, 302])(
    'requires actual HTTP 402, rejects initial %s',
    async (status) => {
      const h = harness();
      h.state.unpaid = (response) =>
        new Response('SENSITIVE', { status, headers: response.headers });
      await failure(h);
      expect(h.sign).not.toHaveBeenCalled();
    },
  );

  it.each([null, 'SENSITIVE-invalid', 'x'.repeat(16_385)])(
    'rejects missing, malformed or oversized PAYMENT-REQUIRED',
    async (header) => {
      const h = harness();
      h.state.unpaid = (response) => {
        if (header === null) response.headers.delete('payment-required');
        else response.headers.set('payment-required', header);
        return response;
      };
      await failure(h);
      expect(h.sign).not.toHaveBeenCalled();
    },
  );

  it.each(['initial', 'fresh'] as const)(
    'does not pay inactive, unverified or expired %s services',
    async (stage) => {
      for (const kind of [
        'inactive',
        'unverified',
        'expired',
        'expired date',
      ]) {
        const h = harness();
        const invalid = structuredClone(h.entry);
        if (kind === 'inactive') invalid.service.status = 'SUSPENDED';
        else if (kind === 'unverified')
          invalid.provider.verification = {
            ...invalid.provider.verification,
            status: 'UNVERIFIED',
            verifiedAt: null,
            expiresAt: null,
          };
        else
          invalid.provider.verification = {
            ...invalid.provider.verification,
            status: kind === 'expired' ? 'EXPIRED' : 'VERIFIED',
            verifiedAt: '2026-09-05T10:00:00.000Z',
            expiresAt: fixtureReferenceTime,
          };
        h.state[stage] = [invalid];
        await failure(h, 'NO_ELIGIBLE_SERVICE');
        expect(h.sign).not.toHaveBeenCalled();
        expect(h.fetcher).toHaveBeenCalledTimes(stage === 'initial' ? 1 : 3);
      }
    },
  );

  it.each(['id', 'endpoint', 'price', 'receiver', 'provider', 'createdAt'])(
    'refuses a changed selected service: %s',
    async (field) => {
      const h = harness();
      const fresh = structuredClone(h.entry);
      if (field === 'id') fresh.service.id = 'changed';
      if (field === 'endpoint')
        fresh.service.endpoint = 'https://other.example.test/v1/triage';
      if (field === 'price')
        fresh.service.paymentRequirements.amountAtomic = '999999';
      if (field === 'receiver')
        fresh.service.paymentRequirements.payTo = '0.0.555';
      if (field === 'provider') fresh.provider.payoutAccount = '0.0.555';
      if (field === 'createdAt')
        fresh.service.createdAt = '2026-09-06T10:00:01.000Z';
      h.state.fresh = [fresh];
      await failure(h, 'NO_ELIGIBLE_SERVICE');
      expect(h.sign).not.toHaveBeenCalled();
    },
  );

  it('rejects registry endpoints outside the trusted allowlist and payout inconsistency before initial POST', async () => {
    for (const kind of ['endpoint', 'receiver']) {
      const h = harness();
      if (kind === 'endpoint')
        h.entry.service.endpoint = 'https://attacker.example.test/v1/triage';
      else h.entry.provider.payoutAccount = '0.0.999';
      await failure(h, 'NO_ELIGIBLE_SERVICE');
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    'payment-response',
    'x-proofserve-hedera-transaction-id',
    'x-proofserve-hedera-transaction-url',
  ])('requires settlement header %s', async (name) => {
    const h = harness();
    h.state.paid = (response) => {
      response.headers.delete(name);
      return response;
    };
    const output = await failure(h);
    expect(output.paymentReceipt).toBeNull();
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.fetcher).toHaveBeenCalledTimes(6);
  });

  it.each([
    null,
    { success: false, network: 'hedera:testnet', transaction },
    { success: 'true', network: 'hedera:testnet', transaction },
    { success: true, network: 'hedera:mainnet', transaction },
    {
      success: true,
      network: 'hedera:testnet',
      transaction: 'FAKE-TRANSACTION',
    },
    {
      success: true,
      network: 'hedera:testnet',
      transaction: '0.0.999@1788940800.123456789',
    },
  ])('rejects malformed or inconsistent settlement %j', async (settlement) => {
    const h = harness();
    h.state.paid = (response) => {
      response.headers.set('payment-response', encode(settlement));
      return response;
    };
    const output = await failure(h);
    expect(output.paymentReceipt).toBeNull();
    expect(h.sign).toHaveBeenCalledTimes(1);
  });

  it('fails safely on genuine Y03 settlement failure with no second paid retry', async () => {
    const h = harness();
    h.state.settlement = {
      success: false,
      network: 'hedera:testnet',
      transaction: '',
      errorReason: 'SENSITIVE',
    };
    await failure(h);
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(h.engine).not.toHaveBeenCalled();
    expect(h.fetcher).toHaveBeenCalledTimes(6);
  });

  it('retains genuine settlement evidence when Y03 inference returns 502', async () => {
    const h = harness();
    h.engine.mockRejectedValue(new Error('SENSITIVE model failure'));
    const output = await failure(h, 'SERVICE_EXECUTION_FAILED');
    expect(output.paymentReceipt?.transactionId).toBe(transaction);
    expect(h.sign).toHaveBeenCalledTimes(1);
  });

  it.each(['invalid JSON', 'invalid result', 'reflected signing material'])(
    'rejects %s after settlement while retaining receipt',
    async (kind) => {
      const h = harness();
      h.state.paid = (response) =>
        new Response(
          kind === 'invalid JSON'
            ? 'SENSITIVE{'
            : JSON.stringify(
                kind === 'invalid result'
                  ? { ...result, urgency: 'SENSITIVE' }
                  : { ...result, summary: signingBytes },
              ),
          { status: 200, headers: response.headers },
        );
      const output = await failure(h, 'SERVICE_EXECUTION_FAILED');
      expect(output.paymentReceipt?.transactionId).toBe(transaction);
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    'fails closed on HTTP transport failure at request %s with safe errors',
    async (at) => {
      const h = harness();
      const original = h.fetcher.getMockImplementation()!;
      let count = 0;
      h.fetcher.mockImplementation((...args) =>
        ++count === at
          ? Promise.reject(new Error('SENSITIVE network error'))
          : original(...args),
      );
      await failure(h);
      expect(h.fetcher).toHaveBeenCalledTimes(at);
      expect(h.sign).toHaveBeenCalledTimes(at >= 5 ? 1 : 0);
    },
  );

  it('sanitizes signing failure and never retries or retains raw causes', async () => {
    const h = harness();
    h.sign.mockRejectedValue(new Error('SENSITIVE signing key'));
    const output = await failure(h);
    expect(output.error).not.toHaveProperty('cause');
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    expect(h.sign).toHaveBeenCalledTimes(1);
  });

  it('checks expiry again after slow signing and never sends the signature', async () => {
    const h = harness();
    h.sign.mockImplementation(async () => {
      h.state.time = '2026-09-07T10:00:00.000Z';
      return signingBytes;
    });
    await failure(h, 'NO_ELIGIBLE_SERVICE');
    expect(h.fetcher).toHaveBeenCalledTimes(5);
  });

  it('bounds a hung network request and aborts it', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fetcher.mockImplementation(() => new Promise<Response>(() => {}));
    const pending = h.prepare().execute();
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).status).toBe('FAILED');
    expect(h.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('times out signing without a late paid retry', async () => {
    const h = harness();
    await h.app.ready();
    vi.useFakeTimers();
    let finish: ((value: string) => void) | undefined;
    h.sign.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.prepare().execute();
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).status).toBe('FAILED');
    finish?.(signingBytes);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetcher).toHaveBeenCalledTimes(4);
  });

  it('shares concurrent and repeated execution, preserves nested inputs and detaches outputs', async () => {
    const h = harness();
    const before = structuredClone({ task: h.task, entry: h.entry });
    const run = h.prepare();
    const [first, second] = await Promise.all([run.execute(), run.execute()]);
    expect(first).toEqual(second);
    first.task.input.ticket = 'Changed output';
    const third = await run.execute();
    expect(third).toEqual(second);
    expect({ task: h.task, entry: h.entry }).toEqual(before);
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.fetcher).toHaveBeenCalledTimes(6);
  });

  it('does not retry a failed run handle', async () => {
    const h = harness();
    h.sign.mockRejectedValue(new Error('SENSITIVE'));
    const run = h.prepare();
    expect((await run.execute()).status).toBe('FAILED');
    expect((await run.execute()).status).toBe('FAILED');
    expect(h.sign).toHaveBeenCalledTimes(1);
  });

  it('does no I/O on import or preparation, and rejects invalid configuration safely', async () => {
    vi.resetModules();
    const module = await import('../src/index.js');
    const h = harness();
    module.createBuyerRun(h.task, h.options);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.signerFactory).not.toHaveBeenCalled();
    for (const allowedServiceEndpoint of [
      'http://example.test/v1/triage',
      'https://u:SENSITIVE@example.test/v1/triage',
      `${endpoint}?SENSITIVE`,
      'file:///SENSITIVE',
    ]) {
      expect(() =>
        createBuyerRun(h.task, { ...h.options, allowedServiceEndpoint }),
      ).toThrow(BuyerError);
    }
    expect(() =>
      Reflect.apply(createBuyerRun, undefined, [null, h.options]),
    ).toThrow('Invalid buyer task or configuration.');
  });
});

describe('approved ownership lifecycle', () => {
  it.each(['discovery', 'clock', 'initialization'] as const)(
    'releases repeated %s failures before signing',
    async (phase) => {
      const ownership = createInMemoryBuyerOwnership(1);
      for (let i = 0; i < 3; i++) {
        const h = harness();
        h.options.ownership = ownership;
        if (phase === 'discovery') h.state.initial = h.state.fresh = [];
        if (phase === 'clock')
          h.options.now = () => {
            throw new Error('clock');
          };
        if (phase === 'initialization')
          h.signerFactory.mockImplementation(() => {
            throw new Error('init');
          });
        await h
          .prepare()
          .execute()
          .catch(() => undefined);
        expect(h.sign).not.toHaveBeenCalled();
        const claim = ownership.claim(h.options.runId!);
        claim.release();
      }
      const healthy = harness();
      healthy.options.ownership = ownership;
      expect((await healthy.prepare().execute()).status).toBe('COMPLETED');
      expect(healthy.sign).toHaveBeenCalledTimes(1);
      expect(healthy.settle).toHaveBeenCalledTimes(1);
      const full = harness();
      full.options.ownership = ownership;
      expect((await full.prepare().execute()).status).toBe('FAILED');
      expect(full.sign).not.toHaveBeenCalled();
      expect(full.settle).not.toHaveBeenCalled();
    },
  );

  it('blocks independent concurrent and sequential handles with the same ID', async () => {
    const h = harness();
    h.options.ownership = createInMemoryBuyerOwnership(1);
    const first = h.prepare().execute();
    await expect(h.prepare().execute()).rejects.toBeInstanceOf(BuyerError);
    expect((await first).status).toBe('COMPLETED');
    await expect(h.prepare().execute()).rejects.toBeInstanceOf(BuyerError);
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it.each(['sign failure', 'sign timeout', 'paid timeout'] as const)(
    'keeps ownership after %s',
    async (kind) => {
      vi.useFakeTimers();
      const h = harness();
      h.options.ownership = createInMemoryBuyerOwnership(1);
      if (kind === 'sign failure')
        h.sign.mockRejectedValue(new Error('ambiguous'));
      if (kind === 'sign timeout')
        h.sign.mockImplementation(() => new Promise(() => {}));
      if (kind === 'paid timeout') {
        const transport = h.fetcher.getMockImplementation()!;
        h.fetcher.mockImplementation((url, init) =>
          new Headers(init?.headers).has('payment-signature')
            ? new Promise(() => {})
            : transport(url, init),
        );
      }
      const execution = h.prepare().execute();
      await vi.runAllTimersAsync();
      expect((await execution).status).toBe('FAILED');
      await expect(h.prepare().execute()).rejects.toBeInstanceOf(BuyerError);
      expect(h.sign).toHaveBeenCalledTimes(1);
      expect(
        h.fetcher.mock.calls.filter(([, init]) =>
          new Headers(init?.headers).has('payment-signature'),
        ),
      ).toHaveLength(kind === 'paid timeout' ? 1 : 0);
    },
  );
});

it('rejects runtime null runId while allowing omission', () => {
  const h = harness();
  expect(() =>
    Reflect.apply(createBuyerRun, undefined, [
      h.task,
      { ...h.options, runId: null },
    ]),
  ).toThrow(BuyerError);
  const options = { ...h.options };
  delete options.runId;
  expect(() => createBuyerRun(h.task, options)).not.toThrow();
});

it.each(['throwing', 'malformed', 'backward'] as const)(
  'preserves settlement at maximum timestamp with %s clock',
  async (kind) => {
    const h = harness();
    const maximum = '9999-12-31T23:59:59.999Z';
    // Keep eligibility valid, then advance to the range boundary at final submission.
    let received = false;
    const transport = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) => {
      const response = await transport(url, init);
      if (new Headers(init?.headers).has('payment-signature')) received = true;
      return response;
    });
    vi.spyOn(performance, 'now').mockImplementation(() => (received ? 10 : 0));
    let calls = 0;
    h.options.now = () => {
      if (received) {
        if (kind === 'throwing') throw new Error('clock');
        return kind === 'malformed' ? 'bad' : fixtureReferenceTime;
      }
      // Final revalidation selection is the last clock sample before submission.
      calls++;
      return calls >= 8 ? '9999-12-31T23:59:59.998Z' : fixtureReferenceTime;
    };
    h.entry.provider.verification.expiresAt = maximum;
    const output = await h.prepare().execute();
    expect(output.status).toBe('FAILED');
    expect(output.paymentReceipt?.transactionId).toBe(transaction);
    expect(output.paymentReceipt?.settledAt).toBe(maximum);
    expect(AgentRunSchema.safeParse(output).success).toBe(true);
  },
);
