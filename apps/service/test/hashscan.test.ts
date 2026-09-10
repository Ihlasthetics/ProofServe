import { describe, expect, it } from 'vitest';
import {
  hashScanTestnetTransactionUrl,
  parseHederaTransactionId,
} from '../src/hashscan.js';

describe('HashScan helpers', () => {
  it('extracts the genuine Blocky402 Hedera settlement transaction format', () => {
    expect(
      parseHederaTransactionId('0.0.7162784@1788940800.123456789'),
    ).toEqual({
      accountId: '0.0.7162784',
      seconds: '1788940800',
      nanos: '123456789',
    });
  });

  it('builds the canonical Hedera-testnet HashScan URL', () => {
    expect(
      hashScanTestnetTransactionUrl('0.0.7162784@1788940800.123456789'),
    ).toBe(
      'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
    );
  });

  it.each([
    '',
    '0.0.1@1.2\r\nx-injected: true',
    '../mainnet/account/0.0.1',
    '00.0.1@1.000000001',
    '0.0.1@0.000000001',
  ])('rejects unsafe transaction id %j', (transactionId) => {
    expect(() => hashScanTestnetTransactionUrl(transactionId)).toThrow(
      'Invalid Hedera transaction ID.',
    );
  });
});
