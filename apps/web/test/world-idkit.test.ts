import { describe, expect, it, vi } from 'vitest';
import {
  createConnectorQrCode,
  createWorldRequestWithSdk,
  type WorldIdKitSdk,
} from '../src/lib/world-idkit';
import { fictionalConnectorUri, fictionalWorldContext } from './world-fixtures';

describe('pinned IDKit request adapter', () => {
  it('passes only the exact backend settings and provider signal to IDKit 4.2.4', async () => {
    const request = {
      connectorURI: fictionalConnectorUri,
      pollUntilCompletion: vi.fn(async () => ({
        success: false as const,
        error: 'cancelled' as const,
      })),
    };
    const preset = vi.fn(
      async (_preset: ReturnType<WorldIdKitSdk['selfieCheckLegacy']>) => {
        void _preset;
        return request;
      },
    );
    const requestBuilder = vi.fn(
      (_config: Parameters<WorldIdKitSdk['IDKit']['request']>[0]) => {
        void _config;
        return { preset };
      },
    );
    const selfieCheckLegacy = vi.fn((options: { signal: string }) => ({
      type: 'SelfieCheckLegacy' as const,
      signal: options.signal,
    }));
    const sdk: WorldIdKitSdk = {
      IDKit: { request: requestBuilder },
      selfieCheckLegacy,
    };

    const created = await createWorldRequestWithSdk(fictionalWorldContext, sdk);

    expect(requestBuilder).toHaveBeenCalledExactlyOnceWith({
      app_id: fictionalWorldContext.app_id,
      action: fictionalWorldContext.action,
      environment: fictionalWorldContext.environment,
      rp_context: fictionalWorldContext.rp_context,
      allow_legacy_proofs: fictionalWorldContext.allow_legacy_proofs,
      require_user_presence: fictionalWorldContext.require_user_presence,
    });
    expect(selfieCheckLegacy).toHaveBeenCalledExactlyOnceWith({
      signal: fictionalWorldContext.signal,
    });
    expect(preset).toHaveBeenCalledExactlyOnceWith({
      type: 'SelfieCheckLegacy',
      signal: fictionalWorldContext.signal,
    });
    expect(created.connectorURI).toBe(fictionalConnectorUri);
  });

  it('rejects a connector URI outside the backend-selected World environment', async () => {
    const sdk: WorldIdKitSdk = {
      IDKit: {
        request: () => ({
          preset: async () => ({
            connectorURI:
              'https://untrusted.example.test/verify?t=fictional-request',
            pollUntilCompletion: async () => ({
              success: false,
              error: 'cancelled',
            }),
          }),
        }),
      },
      selfieCheckLegacy: ({ signal }) => ({
        type: 'SelfieCheckLegacy',
        signal,
      }),
    };
    await expect(
      createWorldRequestWithSdk(fictionalWorldContext, sdk),
    ).rejects.toThrow('Invalid World connector URI');
  });

  it('renders the connector locally as a usable PNG data URL', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const qrCode = await createConnectorQrCode(fictionalConnectorUri);
    expect(qrCode).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
