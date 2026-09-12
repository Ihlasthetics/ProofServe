import type {
  IDKitRequestConfig,
  SelfieCheckLegacyPreset,
  WaitOptions,
} from '@worldcoin/idkit-core';
import type { WorldVerificationContextResponse } from '@proofserve/shared';

export type WorldIdKitCompletion =
  { success: true; result: unknown } | { success: false; error: string };

export interface WorldIdKitRequest {
  readonly connectorURI: string;
  pollUntilCompletion(options?: WaitOptions): Promise<WorldIdKitCompletion>;
}

export interface WorldIdKitSdk {
  IDKit: {
    request(config: IDKitRequestConfig): {
      preset(preset: SelfieCheckLegacyPreset): Promise<WorldIdKitRequest>;
    };
  };
  selfieCheckLegacy(options: { signal: string }): SelfieCheckLegacyPreset;
}

const connectorOrigins: Readonly<Record<string, string>> = {
  production: 'https://world.org',
  staging: 'https://staging.world.org',
  sandbox: 'https://sandbox.world.org',
};

function validateConnectorUri(
  value: string,
  environment: WorldVerificationContextResponse['environment'],
): string {
  const parsed = new URL(value);
  if (
    parsed.origin !== connectorOrigins[environment] ||
    parsed.pathname !== '/verify' ||
    parsed.search === '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('Invalid World connector URI');
  }
  return parsed.toString();
}

export async function createWorldRequestWithSdk(
  context: WorldVerificationContextResponse,
  sdk: WorldIdKitSdk,
): Promise<WorldIdKitRequest> {
  const request = await sdk.IDKit.request({
    app_id: context.app_id as `app_${string}`,
    action: context.action,
    environment: context.environment,
    rp_context: context.rp_context,
    allow_legacy_proofs: context.allow_legacy_proofs,
    require_user_presence: context.require_user_presence,
  }).preset(sdk.selfieCheckLegacy({ signal: context.signal }));
  const connectorURI = validateConnectorUri(
    request.connectorURI,
    context.environment,
  );
  return {
    connectorURI,
    pollUntilCompletion: (options) => request.pollUntilCompletion(options),
  };
}

export async function createWorldRequest(
  context: WorldVerificationContextResponse,
): Promise<WorldIdKitRequest> {
  const sdk = await import('@worldcoin/idkit-core');
  return createWorldRequestWithSdk(context, sdk);
}

export async function createConnectorQrCode(
  connectorURI: string,
): Promise<string> {
  const qrCode = await import('qrcode');
  return qrCode.toDataURL(connectorURI, {
    color: { dark: '#182F27FF', light: '#FFFFFFFF' },
    errorCorrectionLevel: 'M',
    margin: 4,
    type: 'image/png',
    width: 320,
  });
}
