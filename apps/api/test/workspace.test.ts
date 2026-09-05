import { expect, it } from 'vitest';

it('loads the api entry point without runtime configuration', async () => {
  await expect(import('../src/index.js')).resolves.toBeDefined();
});
