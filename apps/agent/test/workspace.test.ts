import { expect, it } from 'vitest';

it('loads the agent entry point without runtime configuration', async () => {
  await expect(import('../src/index.js')).resolves.toBeDefined();
});
