import { readFile } from 'node:fs/promises';
import {
  TriageResultSchema,
  type TriageInput,
  type TriageResult,
} from '@proofserve/shared';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REQUEST_BODY_BYTES,
  createProductionServiceApp,
  createServiceApp,
} from '../src/app.js';
import type { ServiceConfig } from '../src/config.js';
import type { TriageEngine } from '../src/engine.js';

const TEST_PUBLIC_URL = 'https://triage.example.test/v1/triage';
const TEST_RECEIVER = '0.0.123456';
const TEST_PRICE = '1000000';
const TEST_FEE_PAYER = '0.0.7162784';
const TEST_TRANSACTION_ID = '0.0.7162784@1788940800.123456789';

const deterministicResult: TriageResult = {
  category: 'account-access',
  urgency: 'high',
  summary: 'The customer cannot access their account.',
  suggestedAction: 'Verify account ownership and restore access.',
};

class FakeTriageEngine implements TriageEngine {
  readonly calls: TriageInput[] = [];

  constructor(
    private readonly beforeReturn: (() => void) | undefined = undefined,
  ) {}

  async triage(input: TriageInput): Promise<TriageResult> {
    this.calls.push(input);
    this.beforeReturn?.();
    return deterministicResult;
  }
}

class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;

  constructor(
    private readonly verifyResponse: VerifyResponse = {
      isValid: true,
      payer: '0.0.654321',
    },
    private readonly settleResponse: SettleResponse = {
      success: true,
      payer: '0.0.654321',
      transaction: TEST_TRANSACTION_ID,
      network: 'hedera:testnet',
    },
  ) {}

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'hedera:testnet',
          extra: { feePayer: TEST_FEE_PAYER },
        },
      ],
      extensions: [],
      signers: { 'hedera:*': [TEST_FEE_PAYER] },
    };
  }

  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    return this.verifyResponse;
  }

  async settle(): Promise<SettleResponse> {
    this.settleCalls += 1;
    return this.settleResponse;
  }
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function testApp(engine: TriageEngine, facilitator: FacilitatorClient) {
  const app = createServiceApp({
    engine,
    facilitator,
    publicUrl: TEST_PUBLIC_URL,
    receiverAccountId: TEST_RECEIVER,
    priceTinybar: TEST_PRICE,
  });
  openApps.push(app);
  return app;
}

async function requestPayment(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/triage',
    payload: { ticket: 'I cannot access my account.' },
  });
  const header = response.headers['payment-required'];
  if (typeof header !== 'string') {
    throw new Error('Expected PAYMENT-REQUIRED header.');
  }
  return {
    response,
    paymentRequired: decodePaymentRequiredHeader(header),
  };
}

function paidHeader(paymentRequirements: PaymentRequirements): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: paymentRequirements,
    payload: { transaction: 'dGVzdC10cmFuc2FjdGlvbg==' },
  });
}

function v1PaymentHeader(): string {
  return encodePaymentSignatureHeader({
    x402Version: 1,
    scheme: 'exact',
    network: 'hedera:testnet',
    payload: { transaction: 'dGVzdA==' },
  } as unknown as PaymentPayload);
}

describe('service boundary', () => {
  it('serves health without reading runtime environment configuration', async () => {
    const app = testApp(new FakeTriageEngine(), new FakeFacilitator());

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('rejects malformed JSON before payment or inference', async () => {
    const engine = new FakeTriageEngine();
    const facilitator = new FakeFacilitator();
    const app = testApp(engine, facilitator);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: { 'content-type': 'application/json' },
      payload: '{"ticket":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' },
    });
    expect(facilitator.verifyCalls).toBe(0);
    expect(engine.calls).toHaveLength(0);
  });

  it('rejects oversized bodies safely', async () => {
    const app = testApp(new FakeTriageEngine(), new FakeFacilitator());

    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ticket: 'x'.repeat(MAX_REQUEST_BODY_BYTES) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' },
    });
  });

  it('rejects unknown fields and tickets outside the shared limit', async () => {
    const app = testApp(new FakeTriageEngine(), new FakeFacilitator());

    const unknownField = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      payload: { ticket: 'Help', priority: 'high' },
    });
    const tooLong = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      payload: { ticket: 'x'.repeat(10_001) },
    });

    expect(unknownField.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
  });

  it('rejects unsupported content types and query parameters', async () => {
    const app = testApp(new FakeTriageEngine(), new FakeFacilitator());

    const unsupported = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: { 'content-type': 'text/plain' },
      payload: '{"ticket":"Help"}',
    });
    const query = await app.inject({
      method: 'POST',
      url: '/v1/triage?extra=true',
      payload: { ticket: 'Help' },
    });

    expect(unsupported.statusCode).toBe(415);
    expect(query.statusCode).toBe(400);
  });
});

describe('x402 payment gate', () => {
  it('returns a genuine SDK payment requirement for an unpaid request', async () => {
    const facilitator = new FakeFacilitator();
    const engine = new FakeTriageEngine();
    const app = testApp(engine, facilitator);

    const { response, paymentRequired } = await requestPayment(app);

    expect(response.statusCode).toBe(402);
    expect(paymentRequired.x402Version).toBe(2);
    expect(paymentRequired.resource.url).toBe(TEST_PUBLIC_URL);
    expect(paymentRequired.accepts).toEqual([
      expect.objectContaining({
        scheme: 'exact',
        network: 'hedera:testnet',
        asset: '0.0.0',
        amount: TEST_PRICE,
        payTo: TEST_RECEIVER,
        extra: expect.objectContaining({ feePayer: TEST_FEE_PAYER }),
      }),
    ]);
    expect(facilitator.verifyCalls).toBe(0);
    expect(facilitator.settleCalls).toBe(0);
    expect(engine.calls).toHaveLength(0);
  });

  it('does not settle or infer when facilitator verification fails', async () => {
    const sentinel = 'SENSITIVE_VERIFY_SENTINEL';
    const facilitator = new FakeFacilitator({
      isValid: false,
      invalidReason: sentinel,
      invalidMessage: sentinel,
    });
    const engine = new FakeTriageEngine();
    const app = testApp(engine, facilitator);
    const { paymentRequired } = await requestPayment(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: {
        'payment-signature': paidHeader(paymentRequired.accepts[0]!),
      },
      payload: { ticket: 'I cannot access my account.' },
    });

    expect(response.statusCode).toBe(402);
    expect(response.body).not.toContain(sentinel);
    const requiredHeader = response.headers['payment-required'];
    if (typeof requiredHeader !== 'string') {
      throw new Error('Expected PAYMENT-REQUIRED header.');
    }
    const decoded = decodePaymentRequiredHeader(requiredHeader);
    expect(decoded.error).toBe('Payment could not be accepted.');
    expect(JSON.stringify(decoded)).not.toContain(sentinel);
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(0);
    expect(engine.calls).toHaveLength(0);
  });

  it.each([
    ['malformed', () => 'not-a-valid-x402-header'],
    [
      'duplicate',
      (requirements: PaymentRequirements) => [
        paidHeader(requirements),
        paidHeader(requirements),
      ],
    ],
    ['v1', () => v1PaymentHeader()],
    [
      'wrong-network',
      (requirements: PaymentRequirements) =>
        paidHeader({ ...requirements, network: 'hedera:mainnet' }),
    ],
    [
      'wrong-price',
      (requirements: PaymentRequirements) =>
        paidHeader({ ...requirements, amount: '1000001' }),
    ],
    [
      'wrong-recipient',
      (requirements: PaymentRequirements) =>
        paidHeader({ ...requirements, payTo: '0.0.999999' }),
    ],
  ] as const)(
    'rejects a %s payment header before verification',
    async (_label, headerFor) => {
      const facilitator = new FakeFacilitator();
      const engine = new FakeTriageEngine();
      const app = testApp(engine, facilitator);
      const { paymentRequired } = await requestPayment(app);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/triage',
        headers: {
          'payment-signature': headerFor(paymentRequired.accepts[0]!),
        },
        payload: { ticket: 'I cannot access my account.' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid payment header.',
        },
      });
      expect(facilitator.verifyCalls).toBe(0);
      expect(facilitator.settleCalls).toBe(0);
      expect(engine.calls).toHaveLength(0);
    },
  );

  it('has no production payment-success fallback when Blocky402 is unavailable', async () => {
    const fetchedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url === 'https://blocky.example.test/supported') {
          return new Response(
            JSON.stringify({
              kinds: [
                {
                  x402Version: 2,
                  scheme: 'exact',
                  network: 'hedera:testnet',
                  extra: { feePayer: TEST_FEE_PAYER },
                },
              ],
              extensions: [],
              signers: { 'hedera:*': [TEST_FEE_PAYER] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error('facilitator unavailable');
      }),
    );
    const productionConfig: ServiceConfig = {
      host: '127.0.0.1',
      port: 3002,
      publicUrl: TEST_PUBLIC_URL,
      receiverAccountId: TEST_RECEIVER,
      priceTinybar: TEST_PRICE,
      facilitatorUrl: 'https://blocky.example.test',
      modelProvider: 'gemini',
      model: 'gemini-3.8-flash',
      geminiApiKey: 'fictional-placeholder',
    };
    const app = createProductionServiceApp(productionConfig);
    openApps.push(app);
    const { paymentRequired } = await requestPayment(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: {
        'payment-signature': paidHeader(paymentRequired.accepts[0]!),
      },
      payload: { ticket: 'I cannot access my account.' },
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({
      error: {
        code: 'PAYMENT_FAILED',
        message: 'Payment is required and must settle successfully.',
      },
    });
    expect(fetchedUrls).toEqual([
      'https://blocky.example.test/supported',
      'https://blocky.example.test/verify',
    ]);
    expect(fetchedUrls).not.toContain(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    );
  });

  it('sanitizes SDK initialization failures before they reach logs or the app', async () => {
    const sentinel = 'SENSITIVE_SUPPORTED_SENTINEL';
    const output: string[] = [];
    for (const method of ['warn', 'error', 'log', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        output.push(values.map(String).join(' '));
      });
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sentinel, { status: 500 })),
    );
    const app = createProductionServiceApp({
      host: '127.0.0.1',
      port: 3002,
      publicUrl: TEST_PUBLIC_URL,
      receiverAccountId: TEST_RECEIVER,
      priceTinybar: TEST_PRICE,
      facilitatorUrl: 'https://blocky.example.test',
      modelProvider: 'gemini',
      model: 'gemini-3.8-flash',
      geminiApiKey: 'fictional-placeholder',
    });
    openApps.push(app);

    await expect(app.ready()).rejects.toMatchObject({
      name: 'PaymentProcessingError',
      message: 'Payment processing failed.',
    });
    expect(output.join('\n')).not.toContain(sentinel);
  });

  it('does not infer when settlement fails', async () => {
    const facilitator = new FakeFacilitator(
      { isValid: true, payer: '0.0.654321' },
      {
        success: false,
        errorReason: 'transaction_failed',
        errorMessage: 'sensitive facilitator diagnostic',
        transaction: '',
        network: 'hedera:testnet',
      },
    );
    const engine = new FakeTriageEngine();
    const app = testApp(engine, facilitator);
    const { paymentRequired } = await requestPayment(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: {
        'payment-signature': paidHeader(paymentRequired.accepts[0]!),
      },
      payload: { ticket: 'I cannot access my account.' },
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({
      error: {
        code: 'PAYMENT_FAILED',
        message: 'Payment is required and must settle successfully.',
      },
    });
    expect(response.body).not.toContain('sensitive facilitator diagnostic');
    const settlementHeader = response.headers['payment-response'];
    if (typeof settlementHeader !== 'string') {
      throw new Error('Expected PAYMENT-RESPONSE header.');
    }
    expect(decodePaymentResponseHeader(settlementHeader)).toEqual({
      success: false,
      errorReason: 'payment_failed',
      errorMessage: 'Payment settlement failed.',
      transaction: '',
      network: 'hedera:testnet',
    });
    expect(
      JSON.stringify(decodePaymentResponseHeader(settlementHeader)),
    ).not.toContain('sensitive facilitator diagnostic');
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);
    expect(engine.calls).toHaveLength(0);
  });

  it('rejects an unexpected settlement network before inference', async () => {
    const facilitator = new FakeFacilitator(
      { isValid: true, payer: '0.0.654321' },
      {
        success: true,
        payer: '0.0.654321',
        transaction: TEST_TRANSACTION_ID,
        network: 'hedera:mainnet',
      },
    );
    const engine = new FakeTriageEngine();
    const app = testApp(engine, facilitator);
    const { paymentRequired } = await requestPayment(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: {
        'payment-signature': paidHeader(paymentRequired.accepts[0]!),
      },
      payload: { ticket: 'I cannot access my account.' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: 'PAYMENT_FAILED',
        message: 'Payment processing failed.',
      },
    });
    expect(engine.calls).toHaveLength(0);
  });

  it('settles before inference and returns a schema-valid result and receipt', async () => {
    const sentinel = 'SENSITIVE_SUCCESS_SENTINEL';
    const facilitator = new FakeFacilitator(
      { isValid: true, payer: '0.0.654321' },
      {
        success: true,
        payer: '0.0.654321',
        transaction: TEST_TRANSACTION_ID,
        network: 'hedera:testnet',
        errorMessage: sentinel,
        extra: { diagnostic: sentinel },
      },
    );
    const engine = new FakeTriageEngine(() => {
      expect(facilitator.verifyCalls).toBe(1);
      expect(facilitator.settleCalls).toBe(1);
    });
    const app = testApp(engine, facilitator);
    const { paymentRequired } = await requestPayment(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: {
        'payment-signature': paidHeader(paymentRequired.accepts[0]!),
      },
      payload: { ticket: 'I cannot access my account.' },
    });

    expect(response.statusCode).toBe(200);
    expect(TriageResultSchema.parse(response.json())).toEqual(
      deterministicResult,
    );
    expect(engine.calls).toEqual([{ ticket: 'I cannot access my account.' }]);
    expect(response.headers['x-proofserve-hedera-transaction-id']).toBe(
      TEST_TRANSACTION_ID,
    );
    expect(response.headers['x-proofserve-hedera-transaction-url']).toBe(
      'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
    );

    const settlementHeader = response.headers['payment-response'];
    if (typeof settlementHeader !== 'string') {
      throw new Error('Expected PAYMENT-RESPONSE header.');
    }
    const decodedSettlement = decodePaymentResponseHeader(settlementHeader);
    expect(decodedSettlement).toEqual({
      success: true,
      transaction: TEST_TRANSACTION_ID,
      network: 'hedera:testnet',
    });
    expect(response.body).not.toContain(sentinel);
    expect(JSON.stringify(response.headers)).not.toContain(sentinel);
    expect(JSON.stringify(decodedSettlement)).not.toContain(sentinel);
    const httpClient = new x402HTTPClient(new x402Client());
    expect(
      httpClient.getPaymentSettleResponse((name) => {
        const value = response.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      }),
    ).toEqual(decodedSettlement);
  });

  it('reports a completed settlement safely when inference fails afterward', async () => {
    const facilitator = new FakeFacilitator();
    const engine: TriageEngine = {
      triage: async () => {
        throw new Error('model provider internals');
      },
    };
    const app = testApp(engine, facilitator);
    const { paymentRequired } = await requestPayment(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/triage',
      headers: {
        'payment-signature': paidHeader(paymentRequired.accepts[0]!),
      },
      payload: { ticket: 'I cannot access my account.' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: 'SERVICE_EXECUTION_FAILED',
        message: 'Triage inference failed.',
      },
    });
    expect(response.body).not.toContain('model provider internals');
    expect(response.headers['payment-response']).toBeTypeOf('string');
    expect(response.headers['x-proofserve-hedera-transaction-id']).toBe(
      TEST_TRANSACTION_ID,
    );
  });
});

describe('guarded real-payment smoke client', () => {
  const loadSmokeDiagnosticsModule = async () => {
    const smokeScriptUrl = new URL(
      '../scripts/real-payment-smoke.mjs',
      import.meta.url,
    ).href;
    return (await import(smokeScriptUrl)) as unknown as {
      formatPaidFailureDiagnostics(options: {
        paidBody: unknown;
        paidResponse: Response;
        httpClient: x402HTTPClient;
      }): string;
    };
  };

  it('formats only allowlisted smoke failure diagnostics', async () => {
    const smokeScriptUrl = new URL(
      '../scripts/real-payment-smoke.mjs',
      import.meta.url,
    ).href;
    const smokeModule = (await import(smokeScriptUrl)) as unknown as {
      formatSmokeFailure(context: {
        stage: string;
        httpStatus?: number;
      }): string;
    };
    const sentinel = 'SENSITIVE_RAW_SMOKE_ERROR';

    expect(
      smokeModule.formatSmokeFailure({ stage: 'signer initialization' }),
    ).toBe('Real-payment smoke test failed. Stage: signer initialization.');
    expect(
      smokeModule.formatSmokeFailure({
        stage: 'paid request',
        httpStatus: 503,
      }),
    ).toBe(
      'Real-payment smoke test failed. Stage: paid request. HTTP status: 503.',
    );
    expect(
      smokeModule.formatSmokeFailure({
        stage: sentinel,
        httpStatus: 999,
      }),
    ).toBe('Real-payment smoke test failed. Stage: configuration.');
  });

  it('parses a fictional raw payer key explicitly as ECDSA', async () => {
    const fictionalRawPrivateKey =
      '0000000000000000000000000000000000000000000000000000000000000001';
    const smokeScriptUrl = new URL(
      '../scripts/real-payment-smoke.mjs',
      import.meta.url,
    ).href;
    const smokeModule = (await import(smokeScriptUrl)) as unknown as {
      parseSmokePayerPrivateKey(value: string): {
        readonly type: string;
      };
    };
    const explicitEcdsaKey = smokeModule.parseSmokePayerPrivateKey(
      fictionalRawPrivateKey,
    );
    const smokeScriptSource = await readFile(
      new URL('../scripts/real-payment-smoke.mjs', import.meta.url),
      'utf8',
    );

    expect(explicitEcdsaKey.type).toBe('secp256k1');
    expect(smokeScriptSource).toContain(
      'PrivateKey.fromStringECDSA(payerPrivateKey)',
    );
    expect(smokeScriptSource).not.toContain(
      'PrivateKey.fromString(payerPrivateKey)',
    );
    expect(smokeScriptSource).toContain(
      'parseSmokePayerPrivateKey(payerPrivateKey)',
    );
    expect(() =>
      smokeModule.parseSmokePayerPrivateKey('fictional-invalid-ecdsa-key'),
    ).toThrow();
  });

  it.each(['SERVICE_EXECUTION_FAILED', 'PAYMENT_FAILED'])(
    'reports allowlisted paid-response error code %s',
    async (code) => {
      const smokeModule = await loadSmokeDiagnosticsModule();
      const diagnostics = smokeModule.formatPaidFailureDiagnostics({
        paidBody: { error: { code, message: 'Fictional safe message.' } },
        paidResponse: new Response(null, { status: 502 }),
        httpClient: new x402HTTPClient(new x402Client()),
      });

      expect(diagnostics).toBe(`Paid response error code: ${code}`);
      expect(diagnostics).not.toContain('Fictional safe message.');
    },
  );

  it('does not leak unknown or malformed paid-response bodies', async () => {
    const sentinel = 'SENSITIVE_UNKNOWN_PAID_RESPONSE';
    const smokeModule = await loadSmokeDiagnosticsModule();
    const response = new Response(null, { status: 502 });
    const httpClient = new x402HTTPClient(new x402Client());
    const bodies: unknown[] = [
      sentinel,
      { error: sentinel },
      { error: { code: `UNKNOWN_${sentinel}`, message: sentinel } },
      { error: { code: 502, message: sentinel } },
    ];

    for (const paidBody of bodies) {
      const diagnostics = smokeModule.formatPaidFailureDiagnostics({
        paidBody,
        paidResponse: response,
        httpClient,
      });
      expect(diagnostics).toBe('Paid response error code: unavailable');
      expect(diagnostics).not.toContain(sentinel);
    }
  });

  it('retains validated settlement evidence from a 502 response', async () => {
    const smokeModule = await loadSmokeDiagnosticsModule();
    const settlementHeader = encodePaymentResponseHeader({
      success: true,
      transaction: TEST_TRANSACTION_ID,
      network: 'hedera:testnet',
    });
    const paidResponse = new Response(null, {
      status: 502,
      headers: { 'payment-response': settlementHeader },
    });

    expect(
      smokeModule.formatPaidFailureDiagnostics({
        paidBody: { error: { code: 'SERVICE_EXECUTION_FAILED' } },
        paidResponse,
        httpClient: new x402HTTPClient(new x402Client()),
      }),
    ).toBe(
      [
        'Paid response error code: SERVICE_EXECUTION_FAILED',
        `Settlement transaction: ${TEST_TRANSACTION_ID}`,
        'HashScan: https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
      ].join('\n'),
    );
  });

  it.each([
    ['a malformed settlement header', 'SENSITIVE_MALFORMED_SETTLEMENT_HEADER'],
    [
      'an unsafe settlement transaction',
      encodePaymentResponseHeader({
        success: true,
        transaction: '0.0.1@1.2\r\nSENSITIVE_UNSAFE_TRANSACTION',
        network: 'hedera:testnet',
      }),
    ],
  ])('never prints %s', async (_name, settlementHeader) => {
    const smokeModule = await loadSmokeDiagnosticsModule();
    const diagnostics = smokeModule.formatPaidFailureDiagnostics({
      paidBody: { error: { code: 'SERVICE_EXECUTION_FAILED' } },
      paidResponse: new Response(null, {
        status: 502,
        headers: { 'payment-response': settlementHeader },
      }),
      httpClient: new x402HTTPClient(new x402Client()),
    });

    expect(diagnostics).toBe(
      'Paid response error code: SERVICE_EXECUTION_FAILED',
    );
    expect(diagnostics).not.toContain(settlementHeader);
    expect(diagnostics).not.toContain('SENSITIVE');
  });

  it('cannot execute a request or payment when smoke helpers are imported', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('A request must not be attempted.'));
    const smokeScriptUrl = new URL(
      `../scripts/real-payment-smoke.mjs?import-safety=${Date.now()}`,
      import.meta.url,
    ).href;

    await import(smokeScriptUrl);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('signs only the exact configured Hedera HBAR requirement', async () => {
    const smokeScriptUrl = new URL(
      '../scripts/real-payment-smoke.mjs',
      import.meta.url,
    ).href;
    const smokeModule = (await import(smokeScriptUrl)) as unknown as {
      createSmokePaymentClient(options: {
        signer: {
          readonly accountId: string;
          createPartiallySignedTransferTransaction(
            requirement: PaymentRequirements,
          ): Promise<string>;
        };
        expectedReceiver: string;
        expectedAmount: string;
      }): {
        createPaymentPayload(
          paymentRequired: PaymentRequired,
        ): Promise<PaymentPayload>;
      };
    };
    const signingCalls: PaymentRequirements[] = [];
    const client = smokeModule.createSmokePaymentClient({
      signer: {
        accountId: '0.0.654321',
        createPartiallySignedTransferTransaction: async (requirement) => {
          signingCalls.push(requirement);
          return 'dGVzdA==';
        },
      },
      expectedReceiver: TEST_RECEIVER,
      expectedAmount: TEST_PRICE,
    });
    const expectedRequirement: PaymentRequirements = {
      scheme: 'exact',
      network: 'hedera:testnet',
      asset: '0.0.0',
      amount: TEST_PRICE,
      payTo: TEST_RECEIVER,
      maxTimeoutSeconds: 300,
      extra: { feePayer: TEST_FEE_PAYER },
    };
    const paymentRequired = (
      requirement: PaymentRequirements,
    ): PaymentRequired => ({
      x402Version: 2,
      resource: {
        url: TEST_PUBLIC_URL,
        description: 'ProofServe support-ticket triage',
        mimeType: 'application/json',
      },
      accepts: [requirement],
    });

    await expect(
      client.createPaymentPayload(paymentRequired(expectedRequirement)),
    ).resolves.toEqual(
      expect.objectContaining({
        x402Version: 2,
        accepted: expectedRequirement,
        payload: { transaction: 'dGVzdA==' },
      }),
    );

    const rejectedRequirements: PaymentRequirements[] = [
      { ...expectedRequirement, network: 'hedera:mainnet' },
      { ...expectedRequirement, asset: '0.0.456789' },
      { ...expectedRequirement, payTo: '0.0.999999' },
      { ...expectedRequirement, amount: '1000001' },
      { ...expectedRequirement, amount: '999999' },
    ];
    for (const requirement of rejectedRequirements) {
      await expect(
        client.createPaymentPayload(paymentRequired(requirement)),
      ).rejects.toBeInstanceOf(Error);
    }

    expect(signingCalls).toEqual([expectedRequirement]);
  });
});
