import { describe, expect, it, vi } from 'vitest';
import { createHederaSettlementReconciler } from '../src/hedera-settlement-reconciler.js';

const attempt = {
  payer: '0.0.654321',
  receiver: '0.0.123456',
  amountAtomic: '1000000',
  asset: '0.0.0',
  network: 'hedera:testnet',
  transactionId: '0.0.7162784@1788940800.123456789',
  transactionValidUntil: '2026-09-09T08:02:00.123Z',
};

function mirrorTransaction(overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: '0.0.7162784-1788940800-123456789',
    result: 'SUCCESS',
    name: 'CRYPTOTRANSFER',
    scheduled: false,
    nonce: 0,
    consensus_timestamp: '1788940801.123456789',
    valid_start_timestamp: '1788940800.123456789',
    valid_duration_seconds: '120',
    transfers: [
      { account: '0.0.654321', amount: -1000001 },
      { account: '0.0.123456', amount: 1000000 },
      { account: '0.0.98', amount: 1 },
    ],
    ...overrides,
  };
}

describe('Hedera settlement reconciliation', () => {
  it('confirms only the exact successful transaction and expected transfer', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ transactions: [mirrorTransaction()] }),
    );
    const result =
      await createHederaSettlementReconciler(fetcher).reconcile(attempt);
    expect(result).toEqual({
      status: 'CONFIRMED',
      settledAt: '2026-09-09T08:00:01.123Z',
      transactionUrl:
        'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788940800-123456789',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
      }),
    );
  });

  it('rejects a successful exact transaction whose transfer does not match', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        transactions: [
          mirrorTransaction({
            transfers: [
              { account: '0.0.654321', amount: -999999 },
              { account: '0.0.123456', amount: 999999 },
            ],
          }),
        ],
      }),
    );
    await expect(
      createHederaSettlementReconciler(fetcher).reconcile(attempt),
    ).resolves.toEqual({ status: 'REJECTED' });
  });

  it('distinguishes authoritative absence from a temporary outage', async () => {
    await expect(
      createHederaSettlementReconciler(
        async () => new Response('', { status: 404 }),
      ).reconcile(attempt),
    ).resolves.toEqual({ status: 'ABSENT' });
    await expect(
      createHederaSettlementReconciler(async () => {
        throw new Error('temporary outage');
      }).reconcile(attempt),
    ).resolves.toEqual({ status: 'UNAVAILABLE' });
  });
});
