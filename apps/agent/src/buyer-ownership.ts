import { BuyerError } from './buyer-payment.js';
import type { AgentRun } from '@proofserve/shared';

export interface BuyerPaymentExpectation {
  payer: string;
  receiver: string;
  amountAtomic: string;
  asset: string;
  network: string;
}

export interface BuyerPaymentAttempt extends BuyerPaymentExpectation {
  transactionId: string;
  transactionValidUntil: string;
}

export interface BuyerClaim {
  /** Durable owners may resume the latest validated pre-signing snapshot. */
  readonly initialRun?: AgentRun;
  /** Atomically persist a validated monotonic snapshot before continuing. */
  persist?(snapshot: AgentRun): void | Promise<void>;
  /** Atomically retain a permanent tombstone before invoking any signer. */
  beginSigning(expectation: BuyerPaymentExpectation): void | Promise<void>;
  /** Persist only authoritative, non-secret transaction metadata. */
  recordPaymentAttempt?(attempt: BuyerPaymentAttempt): void | Promise<void>;
  /** Final atomic ownership/version/validity fence immediately before submit. */
  authorizeSubmission?(transactionId: string): void | Promise<void>;
  /** Release only temporary ownership; never remove a tombstone. */
  release(): void | Promise<void>;
}

/** Trusted synchronous ownership boundary. Durable coordination belongs to Y05. */
export interface BuyerOwnership {
  claim(runId: string): BuyerClaim | Promise<BuyerClaim>;
}

export interface SynchronousBuyerOwnership extends BuyerOwnership {
  claim(runId: string): BuyerClaim;
}

export function createInMemoryBuyerOwnership(
  capacity = 4096,
): SynchronousBuyerOwnership {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new BuyerError('VALIDATION_ERROR');
  const temporary = new Map<string, symbol>();
  const tombstones = new Set<string>();
  return {
    claim(runId) {
      if (temporary.has(runId) || tombstones.has(runId))
        throw new BuyerError('VALIDATION_ERROR');
      const token = Symbol();
      temporary.set(runId, token);
      return {
        beginSigning() {
          if (temporary.get(runId) !== token || tombstones.size >= capacity)
            throw new BuyerError('VALIDATION_ERROR');
          tombstones.add(runId);
          temporary.delete(runId);
        },
        recordPaymentAttempt() {
          if (!tombstones.has(runId)) throw new BuyerError('VALIDATION_ERROR');
        },
        authorizeSubmission() {
          if (!tombstones.has(runId)) throw new BuyerError('VALIDATION_ERROR');
        },
        release() {
          if (temporary.get(runId) === token) temporary.delete(runId);
        },
      };
    },
  };
}

export const defaultBuyerOwnership = createInMemoryBuyerOwnership();
