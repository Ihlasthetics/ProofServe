import { Server } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('loads the api entry point without runtime configuration', async () => {
  vi.resetModules();
  vi.stubEnv('PORT', undefined);
  vi.stubEnv('HOST', undefined);
  vi.stubEnv('TRIAGE_SERVICE_ENDPOINT', undefined);
  vi.stubEnv('WORLD_APP_ID', undefined);
  vi.stubEnv('WORLD_RP_ID', undefined);
  vi.stubEnv('WORLD_RP_SIGNING_KEY', undefined);
  vi.stubEnv('WORLD_ACTION', undefined);
  vi.stubEnv('WORLD_ENVIRONMENT', undefined);
  vi.stubEnv('WORLD_VERIFICATION_FRESHNESS_SECONDS', undefined);
  const listener = vi
    .spyOn(Server.prototype, 'listen')
    .mockImplementation(() => {
      throw new Error('Import must not listen');
    });
  const fetch = vi.fn(() => {
    throw new Error('Import must not fetch');
  });
  vi.stubGlobal('fetch', fetch);
  const entry = await import('../src/index.js');
  expect(entry.createApiApp).toBeTypeOf('function');
  expect(listener).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
