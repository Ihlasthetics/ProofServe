import { describe, expect, it } from 'vitest';
import {
  MAX_JSON_NESTING_DEPTH,
  parseJsonWithUniqueMembers,
} from '../src/json.js';

describe('duplicate-safe JSON parser', () => {
  it('preserves native JSON number, escape, Unicode, array, and scalar behavior', () => {
    const source =
      '{"number":-12.5e+2,"escape":"line\\nquote\\"","unicode":"\\uD834\\uDD1E","values":[true,false,null]}';
    expect(parseJsonWithUniqueMembers(source)).toEqual(
      JSON.parse(source) as unknown,
    );
  });

  it.each([
    '{"key":1,"key":2}',
    '{"outer":{"key":1,"key":2}}',
    '{"action":1,"\\u0061ction":2}',
    '{"__proto__":1,"\\u005f_proto__":2}',
  ])('rejects decoded duplicate members in %s', (source) => {
    expect(() => parseJsonWithUniqueMembers(source)).toThrow(SyntaxError);
  });

  it('treats prototype-like names as inert data properties', () => {
    const parsed = parseJsonWithUniqueMembers(
      '{"__proto__":{"polluted":true},"constructor":"data"}',
    );
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    const record = parsed as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(record, '__proto__')).toBe(
      true,
    );
    expect(record.__proto__).toEqual({ polluted: true });
    expect(record.constructor).toBe('data');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('enforces a bounded nesting depth before native object construction', () => {
    const nested = (depth: number) =>
      '{"nested":'.repeat(depth) + 'null' + '}'.repeat(depth);
    expect(parseJsonWithUniqueMembers(nested(MAX_JSON_NESTING_DEPTH))).toEqual(
      JSON.parse(nested(MAX_JSON_NESTING_DEPTH)) as unknown,
    );
    expect(() =>
      parseJsonWithUniqueMembers(nested(MAX_JSON_NESTING_DEPTH + 1)),
    ).toThrow(SyntaxError);
  });

  it.each(['', '{', '[1,]', '{"a":01}', '"bad\nstring"', 'true false'])(
    'rejects invalid JSON syntax in %j',
    (source) => {
      expect(() => parseJsonWithUniqueMembers(source)).toThrow(SyntaxError);
    },
  );
});
