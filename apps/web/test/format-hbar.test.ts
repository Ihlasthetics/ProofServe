import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { formatHbar } from '../src/lib/format-hbar';

it.each([
  ['100000000', '1'],
  ['123456789', '1.23456789'],
  ['1', '0.00000001'],
  ['123', '0.00000123'],
  ['123400000', '1.234'],
  ['1000000', '0.01'],
  ['0', '0'],
  ['900719925474099312345678', '9007199254740993.12345678'],
])('formats %s tinybars as %s HBAR', (atomic, expected) => {
  expect(formatHbar(atomic)).toBe(expected);
});

it.each(['', '-1', '1.5', '1e8', '01', ' 1'])(
  'rejects malformed atomic string %j',
  (atomic) => {
    expect(() => formatHbar(atomic)).toThrow(
      'Expected nonnegative atomic integer string.',
    );
  },
);

it('does not convert atomic strings to floating point', () => {
  const source = readFileSync(
    new URL('../src/lib/format-hbar.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/\b(?:Number|parseFloat|parseInt)\s*\(/);
});
