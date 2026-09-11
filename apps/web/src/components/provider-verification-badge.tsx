import type { Timestamp, VerificationRecord } from '@proofserve/shared';

export function ProviderVerificationBadge({
  verification,
  referenceTime,
}: {
  verification: VerificationRecord;
  referenceTime: Timestamp;
}) {
  const current =
    verification.status === 'VERIFIED' &&
    verification.verifiedAt <= referenceTime &&
    referenceTime < verification.expiresAt;
  return (
    <span className="badge">
      {current ? 'Liveness verified' : 'No current liveness verification'}
    </span>
  );
}
