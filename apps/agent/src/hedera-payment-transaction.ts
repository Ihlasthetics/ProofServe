import {
  HederaAccountIdSchema,
  PaymentRequirementsSchema,
  TimestampSchema,
  type PaymentRequirements,
} from '@proofserve/shared';
import {
  Transaction,
  TransactionId,
  getNetForAccount,
  inspectHederaTransaction,
} from '@x402/hedera';
import { BuyerError } from './buyer-payment.js';
import type {
  BuyerPaymentAttempt,
  BuyerPaymentExpectation,
} from './buyer-ownership.js';

const nativeTransactionId =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)@([1-9][0-9]*)\.([0-9]{1,9})$/;
const pathTransactionId =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-([1-9][0-9]*)-([0-9]{1,9})$/;

export function canonicalHederaTransactionId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) throw new BuyerError();
  const match =
    nativeTransactionId.exec(value) ?? pathTransactionId.exec(value);
  if (!match) throw new BuyerError();
  const native = `${match[1]}.${match[2]}.${match[3]}@${match[4]}.${match[5]?.padStart(9, '0')}`;
  try {
    return TransactionId.fromString(native).toString();
  } catch {
    throw new BuyerError();
  }
}

export function hederaTransactionPath(value: unknown): string {
  return canonicalHederaTransactionId(value)
    .replace('@', '-')
    .replace(/\.(\d{9})$/, '-$1');
}

export function paymentExpectation(
  payer: unknown,
  requirements: PaymentRequirements,
): BuyerPaymentExpectation {
  const parsedPayer = HederaAccountIdSchema.parse(payer);
  const parsed = PaymentRequirementsSchema.parse(requirements);
  return {
    payer: parsedPayer,
    receiver: parsed.payTo,
    amountAtomic: parsed.amountAtomic,
    asset: parsed.asset,
    network: parsed.network,
  };
}

export function inspectSignedPaymentTransaction(
  signedTransaction: string,
  expected: BuyerPaymentExpectation,
): BuyerPaymentAttempt {
  try {
    const bytes = Buffer.from(signedTransaction, 'base64');
    if (!signedTransaction || bytes.length === 0) throw new BuyerError();
    const transaction = Transaction.fromBytes(bytes);
    const transactionId = transaction.transactionId;
    const validStart = transactionId?.validStart;
    const duration = transaction.transactionValidDuration;
    if (!transactionId || !validStart || !duration) throw new BuyerError();
    const durationSeconds = BigInt(duration);
    if (durationSeconds <= 0n || durationSeconds > 300n) throw new BuyerError();
    const startSeconds = BigInt(validStart.seconds.toString());
    const nanos = BigInt(validStart.nanos.toString());
    const validUntilMilliseconds =
      (startSeconds + durationSeconds) * 1000n + nanos / 1_000_000n;
    if (
      validUntilMilliseconds < 0n ||
      validUntilMilliseconds > BigInt(Date.parse('9999-12-31T23:59:59.999Z'))
    )
      throw new BuyerError();
    const inspected = inspectHederaTransaction(signedTransaction);
    const transactionTransfers =
      expected.asset === '0.0.0'
        ? inspected.hbarTransfers
        : inspected.tokenTransfers[expected.asset];
    if (
      !transactionTransfers ||
      getNetForAccount(transactionTransfers, expected.payer) !==
        -BigInt(expected.amountAtomic) ||
      getNetForAccount(transactionTransfers, expected.receiver) !==
        BigInt(expected.amountAtomic)
    )
      throw new BuyerError();
    return {
      ...expected,
      transactionId: canonicalHederaTransactionId(transactionId.toString()),
      transactionValidUntil: TimestampSchema.parse(
        new Date(Number(validUntilMilliseconds)).toISOString(),
      ),
    };
  } catch {
    throw new BuyerError();
  }
}
