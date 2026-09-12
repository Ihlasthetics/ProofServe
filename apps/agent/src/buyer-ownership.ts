import { BuyerError } from './buyer-payment.js';

export interface BuyerClaim {
  /** Atomically retain a permanent tombstone before invoking any signer. */
  beginSigning(): void;
  /** Release only temporary ownership; never remove a tombstone. */
  release(): void;
}

/** Trusted synchronous ownership boundary. Durable coordination belongs to Y05. */
export interface BuyerOwnership {
  claim(runId: string): BuyerClaim;
}

export function createInMemoryBuyerOwnership(capacity = 4096): BuyerOwnership {
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
        release() {
          if (temporary.get(runId) === token) temporary.delete(runId);
        },
      };
    },
  };
}

export const defaultBuyerOwnership = createInMemoryBuyerOwnership();
