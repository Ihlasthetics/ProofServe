import { expect, it } from 'vitest';
import { createInMemoryBuyerOwnership } from '../src/buyer-ownership.js';

it('releases temporary claims without consuming capacity and fences stale claims', () => {
  const owner = createInMemoryBuyerOwnership(1);
  for (let i = 0; i < 10; i++) owner.claim(`failed_${i}`).release();
  const old = owner.claim('retry');
  old.release();
  const current = owner.claim('retry');
  old.release();
  expect(() => old.beginSigning()).toThrow();
  expect(() => owner.claim('retry')).toThrow();
  current.beginSigning();
  current.release();
  expect(() => owner.claim('retry')).toThrow();
  const full = owner.claim('new');
  expect(() => full.beginSigning()).toThrow();
  full.release();
});

it.each([0, -1, 1.5, NaN, Infinity])(
  'rejects invalid capacity %s',
  (capacity) => {
    expect(() => createInMemoryBuyerOwnership(capacity)).toThrow();
  },
);
