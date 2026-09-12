import { afterEach, expect, it, vi } from 'vitest';
import {
  activeServiceFixture,
  agentTaskFixture,
  fixtureReferenceTime,
  verifiedProviderFixture,
} from '@proofserve/shared';
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { ClientHederaSigner } from '@x402/hedera';
import { createBuyerRun } from '../src/index.js';

afterEach(() => {
  vi.doUnmock('@x402/hedera');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('production defaults lazily use official ECDSA signer exports and built-in fetch without exposing credentials', async () => {
  const privateKey = 'SENSITIVE-test-only-invalid-key';
  const keyObject = { testOnly: true };
  const fromStringECDSA = vi.fn(() => keyObject);
  const createClientHederaSigner = vi.fn((): ClientHederaSigner => ({
    accountId: '0.0.654321',
    createPartiallySignedTransferTransaction: async () => 'dGVzdA==',
  }));
  // The real x402Client and ExactHederaScheme still execute; only key handling is injected.
  vi.doMock('@x402/hedera', () => ({
    PrivateKey: { fromStringECDSA },
    createClientHederaSigner,
  }));
  vi.stubEnv('HEDERA_PAYER_ACCOUNT_ID', '0.0.654321');
  vi.stubEnv('HEDERA_PAYER_PRIVATE_KEY', privateKey);
  const endpoint = activeServiceFixture.endpoint;
  const amount = activeServiceFixture.paymentRequirements;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).startsWith('https://registry.example.test/'))
      return Response.json({
        services: [
          { service: activeServiceFixture, provider: verifiedProviderFixture },
        ],
      });
    expect(String(url)).toBe(endpoint);
    expect(JSON.stringify(init)).not.toContain(privateKey);
    if (!new Headers(init?.headers).has('payment-signature'))
      return new Response('', {
        status: 402,
        headers: {
          'payment-required': encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: endpoint, mimeType: 'application/json' },
            accepts: [
              {
                scheme: 'exact',
                network: amount.network,
                asset: amount.asset,
                amount: amount.amountAtomic,
                payTo: amount.payTo,
                maxTimeoutSeconds: 300,
                extra: { feePayer: '0.0.7162784' },
              },
            ],
          }),
        },
      });
    return Response.json(
      {
        category: 'account',
        urgency: 'low',
        summary: 'Access issue',
        suggestedAction: 'Contact support',
      },
      {
        headers: {
          'payment-response': encodePaymentResponseHeader({
            success: true,
            network: 'hedera:testnet',
            transaction: '0.0.7162784@1788940800.123456789',
          }),
          'x-proofserve-hedera-transaction-id':
            '0.0.7162784@1788940800.123456789',
          'x-proofserve-hedera-transaction-url':
            'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
        },
      },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const options = {
    registryBaseUrl: 'https://registry.example.test',
    allowedServiceEndpoint: endpoint,
    now: () => fixtureReferenceTime,
    paymentTransaction: async (
      _signedTransaction: string,
      expected: {
        payer: string;
        receiver: string;
        amountAtomic: string;
        asset: string;
        network: string;
      },
    ) => ({
      ...expected,
      transactionId: '0.0.7162784@1788940800.123456789',
      transactionValidUntil: '2099-09-06T10:00:00.000Z',
    }),
  };
  const run = createBuyerRun(agentTaskFixture, options);
  expect(fetcher).not.toHaveBeenCalled();
  expect(createClientHederaSigner).not.toHaveBeenCalled();
  const output = await run.execute();
  expect(output.status).toBe('COMPLETED');
  expect(fromStringECDSA).toHaveBeenCalledExactlyOnceWith(privateKey);
  expect(createClientHederaSigner).toHaveBeenCalledExactlyOnceWith(
    '0.0.654321',
    keyObject,
    { network: 'hedera:testnet' },
  );
  expect(JSON.stringify(output)).not.toContain(privateKey);
  fromStringECDSA.mockImplementation(() => {
    throw new Error(privateKey);
  });
  const failed = await createBuyerRun(agentTaskFixture, options).execute();
  expect(failed.status).toBe('FAILED');
  expect(failed.error?.code).toBe('PAYMENT_FAILED');
  expect(JSON.stringify(failed)).not.toContain(privateKey);
});
