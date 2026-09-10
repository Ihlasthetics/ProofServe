import { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import {
  activeServiceFixture,
  agentTaskFixture,
  fixtureReferenceTime,
  verifiedProviderFixture,
} from '@proofserve/shared';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from '@x402/core/http';
import {
  PrivateKey,
  inspectHederaTransaction,
  Transaction,
} from '@x402/hedera';
import { createBuyerRun } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('constructs and signs through the real production SDK offline without submitting a transaction', async () => {
  const connect = vi
    .spyOn(Socket.prototype, 'connect')
    .mockImplementation(() => {
      throw new Error('Network forbidden');
    });
  const publicFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error('Network forbidden'));
  vi.stubGlobal('fetch', publicFetch);
  // Fresh, unfunded, ephemeral test key. No key is saved or printed.
  const key = PrivateKey.generateECDSA();
  vi.stubEnv('HEDERA_PAYER_ACCOUNT_ID', '0.0.654321');
  vi.stubEnv('HEDERA_PAYER_PRIVATE_KEY', key.toStringRaw());
  const parse = vi.spyOn(PrivateKey, 'fromStringECDSA');
  const sign = vi.spyOn(Transaction.prototype, 'sign');
  let capturedSignature = '';
  const destinations: string[] = [];
  const price = activeServiceFixture.paymentRequirements;
  let signedRequests = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (new URL(String(url)).origin === 'https://registry.example.test')
      return Response.json({
        services: [
          { service: activeServiceFixture, provider: verifiedProviderFixture },
        ],
      });
    destinations.push(String(url));
    const signature = new Headers(init?.headers).get('payment-signature');
    if (!signature)
      return new Response('', {
        status: 402,
        headers: {
          'payment-required': encodePaymentRequiredHeader({
            x402Version: 2,
            resource: {
              url: activeServiceFixture.endpoint,
              mimeType: 'application/json',
            },
            accepts: [
              {
                scheme: 'exact',
                network: price.network,
                asset: price.asset,
                amount: price.amountAtomic,
                payTo: price.payTo,
                maxTimeoutSeconds: 300,
                extra: { feePayer: '0.0.7162784' },
              },
            ],
          }),
        },
      });
    signedRequests++;
    capturedSignature = signature;
    // Deliberately no settlement. The signed bytes never leave this fake transport.
    return new Response('', { status: 502 });
  });
  const output = await createBuyerRun(agentTaskFixture, {
    registryBaseUrl: 'https://registry.example.test',
    allowedServiceEndpoint: activeServiceFixture.endpoint,
    now: () => fixtureReferenceTime,
    fetcher,
  }).execute();
  expect(signedRequests).toBe(1);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(destinations).toEqual([
    activeServiceFixture.endpoint,
    activeServiceFixture.endpoint,
  ]);
  const bytes =
    decodePaymentSignatureHeader(capturedSignature).payload.transaction;
  expect(typeof bytes).toBe('string');
  if (typeof bytes !== 'string') throw new Error('Missing signed transaction');
  const inspection = inspectHederaTransaction(bytes);
  expect(inspection.transactionIdAccountId).toBe('0.0.7162784');
  expect(inspection.hbarTransfers).toHaveLength(2);
  expect(inspection.hbarTransfers).toEqual(
    expect.arrayContaining([
      { accountId: '0.0.654321', amount: '-1000000' },
      { accountId: price.payTo, amount: '1000000' },
    ]),
  );
  const transaction = Transaction.fromBytes(Buffer.from(bytes, 'base64'));
  expect(transaction.isFrozen()).toBe(true);
  expect(key.publicKey.verifyTransaction(transaction)).toBe(true);
  expect(output.status).toBe('FAILED');
  expect(output.paymentReceipt).toBeNull();
  expect(JSON.stringify(output)).not.toContain(key.toStringRaw());
  expect(publicFetch).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
