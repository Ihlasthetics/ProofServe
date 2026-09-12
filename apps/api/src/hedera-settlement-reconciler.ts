import {
  canonicalHederaTransactionId,
  hederaTransactionPath,
  type BuyerPaymentAttempt,
} from '@proofserve/agent';
import { TimestampSchema, type Timestamp } from '@proofserve/shared';

const MIRROR_NODE = 'https://testnet.mirrornode.hedera.com';
const MAX_RESPONSE_BYTES = 262_144;

export type SettlementReconciliation =
  | { status: 'CONFIRMED'; settledAt: Timestamp; transactionUrl: string }
  | { status: 'ABSENT' | 'REJECTED' | 'UNAVAILABLE' };

export interface SettlementReconciler {
  reconcile(attempt: BuyerPaymentAttempt): Promise<SettlementReconciliation>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestamp(value: unknown): Timestamp | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([1-9][0-9]*)\.([0-9]{1,9})$/.exec(value);
  if (!match) return undefined;
  const milliseconds =
    BigInt(match[1]!) * 1000n + BigInt(match[2]!.padEnd(9, '0')) / 1_000_000n;
  if (milliseconds > BigInt(Date.parse('9999-12-31T23:59:59.999Z')))
    return undefined;
  return TimestampSchema.safeParse(new Date(Number(milliseconds)).toISOString())
    .data;
}

function integer(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return BigInt(value);
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value))
    return BigInt(value);
  return undefined;
}

async function boundedText(response: Response, signal: AbortSignal) {
  const length = response.headers.get('content-length');
  if (
    length &&
    (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  )
    throw new Error();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Fixed testnet Mirror Node client. It never accepts a caller-controlled URL. */
export function createHederaSettlementReconciler(
  fetcher: typeof fetch = globalThis.fetch,
): SettlementReconciler {
  return {
    async reconcile(attempt) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      try {
        const transactionId = canonicalHederaTransactionId(
          attempt.transactionId,
        );
        if (
          transactionId !== attempt.transactionId ||
          attempt.network !== 'hedera:testnet' ||
          attempt.asset !== '0.0.0'
        )
          return { status: 'REJECTED' };
        timer = setTimeout(() => controller.abort(), 5_000);
        const response = await fetcher(
          `${MIRROR_NODE}/api/v1/transactions/${encodeURIComponent(hederaTransactionPath(transactionId))}`,
          {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'cache-control': 'no-store',
            },
            redirect: 'error',
            credentials: 'omit',
            signal: controller.signal,
          },
        );
        if (response.status === 404) return { status: 'ABSENT' };
        if (response.status !== 200) return { status: 'UNAVAILABLE' };
        const root = object(
          JSON.parse(await boundedText(response, controller.signal)),
        );
        if (!root || !Array.isArray(root.transactions))
          return { status: 'UNAVAILABLE' };
        const matches: Record<string, unknown>[] = [];
        for (const value of root.transactions) {
          const record = object(value);
          if (!record || typeof record.transaction_id !== 'string')
            return { status: 'UNAVAILABLE' };
          let id: string;
          try {
            id = canonicalHederaTransactionId(record.transaction_id);
          } catch {
            return { status: 'UNAVAILABLE' };
          }
          if (id === transactionId) matches.push(record);
        }
        if (matches.length === 0) return { status: 'ABSENT' };
        if (matches.length !== 1) return { status: 'UNAVAILABLE' };
        const record = matches[0]!;
        if (
          record.result !== 'SUCCESS' ||
          record.name !== 'CRYPTOTRANSFER' ||
          record.scheduled !== false ||
          record.nonce !== 0
        )
          return { status: 'REJECTED' };
        const settledAt = timestamp(record.consensus_timestamp);
        const validStart = timestamp(record.valid_start_timestamp);
        const duration = integer(record.valid_duration_seconds);
        if (
          !settledAt ||
          !validStart ||
          duration === undefined ||
          duration <= 0n
        )
          return { status: 'UNAVAILABLE' };
        const authoritativeExpiry = new Date(
          Date.parse(validStart) + Number(duration) * 1000,
        ).toISOString();
        if (authoritativeExpiry !== attempt.transactionValidUntil)
          return { status: 'REJECTED' };
        if (!Array.isArray(record.transfers)) return { status: 'UNAVAILABLE' };
        let payer = 0n;
        let receiver = 0n;
        for (const value of record.transfers) {
          const transfer = object(value);
          const amount = integer(transfer?.amount);
          if (
            !transfer ||
            typeof transfer.account !== 'string' ||
            amount === undefined
          )
            return { status: 'UNAVAILABLE' };
          if (transfer.account === attempt.payer) payer += amount;
          if (transfer.account === attempt.receiver) receiver += amount;
        }
        const expected = BigInt(attempt.amountAtomic);
        if (receiver !== expected || payer > -expected)
          return { status: 'REJECTED' };
        return {
          status: 'CONFIRMED',
          settledAt,
          transactionUrl: `https://hashscan.io/testnet/transaction/${hederaTransactionPath(transactionId)}`,
        };
      } catch {
        return { status: 'UNAVAILABLE' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
