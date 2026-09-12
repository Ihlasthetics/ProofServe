import type { WorldVerificationResponse } from '@proofserve/shared';
import type { WorldSelfieFlow } from './world-selfie-flow';

export type ProviderWorldVerificationOutcome =
  'not-started' | 'incomplete' | 'accepted' | 'rejected';

export async function runProviderWorldVerification(
  flow: WorldSelfieFlow,
  providerId: string,
  onVerified: (verification: WorldVerificationResponse) => boolean,
): Promise<ProviderWorldVerificationOutcome> {
  const started = await flow.start(providerId);
  if (!started) return 'not-started';
  const completed = flow.getSnapshot();
  if (completed.status !== 'verified' || completed.verification === undefined) {
    return 'incomplete';
  }
  return onVerified(completed.verification) ? 'accepted' : 'rejected';
}
