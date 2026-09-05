import { expect, it } from 'vitest';

it('loads the web entry point without runtime configuration', async () => {
  await expect(import('../src/index.js')).resolves.toBeDefined();
});
