import {
  WorldVerificationContextResponseSchema,
  WorldVerificationRequestSchema,
  WorldVerificationResponseSchema,
} from '@proofserve/shared';
import { hashSignal } from '@worldcoin/idkit-core/hashing';

export const fictionalProviderId = 'provider_i04_fictional';
export const fictionalWorldNonce = `0x${'AB'.repeat(32)}`;

export const fictionalWorldContext =
  WorldVerificationContextResponseSchema.parse({
    app_id: 'app_sandbox_00000000000000000000000000000000',
    action: 'proofserve-provider-verification',
    signal: `proofserve:provider:${fictionalProviderId}:nonce:${fictionalWorldNonce.toLowerCase()}`,
    environment: 'sandbox',
    rp_context: {
      rp_id: 'rp_00000000000000000000000000000000',
      nonce: fictionalWorldNonce,
      created_at: 1_789_034_400,
      expires_at: 1_789_034_700,
      signature: `0x${'22'.repeat(65)}`,
    },
    allow_legacy_proofs: true,
    require_user_presence: true,
  });

export const fictionalWorldResult = WorldVerificationRequestSchema.parse({
  protocol_version: '3.0',
  nonce: fictionalWorldNonce,
  action: fictionalWorldContext.action,
  responses: [
    {
      identifier: 'selfie',
      signal_hash: hashSignal(fictionalWorldContext.signal),
      proof: `0x${'55'.repeat(256)}`,
      merkle_root: `0x${'66'.repeat(32)}`,
      nullifier: `0x${'77'.repeat(32)}`,
    },
  ],
  user_presence_completed: true,
  environment: 'sandbox',
});

export const fictionalVerifiedRecord = WorldVerificationResponseSchema.parse({
  providerId: fictionalProviderId,
  method: 'WORLD_SELFIE_CHECK',
  status: 'VERIFIED',
  verifiedAt: '2026-09-12T10:00:00.000Z',
  expiresAt: '2026-09-13T10:00:00.000Z',
});

export const fictionalConnectorUri =
  'https://sandbox.world.org/verify?t=fictional-encrypted-request';
