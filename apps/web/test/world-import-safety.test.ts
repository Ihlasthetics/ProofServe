import { expect, it, vi } from 'vitest';

it('imports I04 modules without contacting World or another live service', async () => {
  const fetch = vi.fn(async () => {
    throw new Error('A live request must never occur during module import.');
  });
  vi.stubGlobal('fetch', fetch);
  vi.resetModules();
  await import('../src/lib/world-idkit');
  await import('../src/lib/world-selfie-flow');
  await import('../src/lib/world-verification-client');
  await import('../src/server/world-verification-proxy');
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
