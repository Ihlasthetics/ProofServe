import type { AtomicAmount } from '@proofserve/shared';

export function formatHbar(amountAtomic: AtomicAmount): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amountAtomic))
    throw new Error('Expected nonnegative atomic integer string.');
  const padded = amountAtomic.padStart(9, '0');
  const whole = padded.slice(0, -8);
  const fraction = padded.slice(-8).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
