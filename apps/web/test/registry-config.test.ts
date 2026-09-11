import { expect, it } from 'vitest';
import config from '../next.config';

it('has no upstream rewrite that could bypass the server boundary', () => {
  expect(config.rewrites).toBeUndefined();
});
