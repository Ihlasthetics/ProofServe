import { afterEach, expect, it, vi } from 'vitest';
import { BoundedJsonError, readBoundedJson } from '../src/server/bounded-json';

const encode = (text: string) => new TextEncoder().encode(text);
function message(chunks: Uint8Array[], length?: string) {
  let index = 0;
  const cancel = vi.fn();
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  );
  const body = new ReadableStream<Uint8Array>(
    { pull, cancel },
    { highWaterMark: 0 },
  );
  return {
    body,
    headers: new Headers(
      length === undefined ? {} : { 'Content-Length': length },
    ),
    cancel,
    pull,
  };
}
afterEach(() => vi.restoreAllMocks());

it.each([7, 8, 9])(
  'enforces the actual %s-byte body against an 8-byte limit',
  async (size) => {
    const input = message([encode('"' + 'a'.repeat(size - 2) + '"')]);
    if (size <= 8)
      expect(await readBoundedJson(input, 8)).toBe('a'.repeat(size - 2));
    else {
      await expect(readBoundedJson(input, 8)).rejects.toMatchObject({
        reason: 'too-large',
      });
      expect(input.cancel).toHaveBeenCalledOnce();
    }
    expect(input.body.locked).toBe(false);
  },
);
it.each([undefined, '1', '0'])(
  'enforces bytes with absent or misleading length %s across chunks',
  async (length) => {
    const input = message(
      [encode('"aaaa'), encode('aaa"'), encode('unread-secret')],
      length,
    );
    const parse = vi.spyOn(JSON, 'parse');
    await expect(readBoundedJson(input, 8)).rejects.toMatchObject({
      reason: 'too-large',
    });
    expect(input.pull).toHaveBeenCalledTimes(2);
    expect(input.cancel).toHaveBeenCalledOnce();
    expect(input.body.locked).toBe(false);
    expect(parse).not.toHaveBeenCalled();
  },
);
it('rejects oversized declared length before reading or parsing', async () => {
  const input = message([encode('{}')], '999999999999999999999999999');
  const parse = vi.spyOn(JSON, 'parse');
  await expect(readBoundedJson(input, 8)).rejects.toMatchObject({
    reason: 'too-large',
  });
  expect(input.pull).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
  expect(input.cancel).toHaveBeenCalledOnce();
  expect(input.body.locked).toBe(false);
});
it('decodes UTF-8 split into single-byte chunks at the exact byte limit', async () => {
  const bytes = encode('"🌍é"');
  const input = message(Array.from(bytes, (byte) => new Uint8Array([byte])));
  expect(await readBoundedJson(input, bytes.byteLength)).toBe('🌍é');
  expect(input.body.locked).toBe(false);
  await expect(
    readBoundedJson(message([bytes]), bytes.byteLength - 1),
  ).rejects.toMatchObject({ reason: 'too-large' });
});
it.each([
  encode('{bad-json'),
  new Uint8Array([34, 0xff, 34]),
  new Uint8Array([34, 0xf0, 0x9f]),
])('rejects malformed JSON or invalid UTF-8 %# safely', async (bytes) => {
  const input = message([bytes]);
  await expect(readBoundedJson(input, 32)).rejects.toBeInstanceOf(
    BoundedJsonError,
  );
  expect(input.body.locked).toBe(false);
});
it('releases an errored stream and does not expose its transport diagnostics', async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('secret transport'));
    },
  });
  await expect(
    readBoundedJson({ body, headers: new Headers() }, 8),
  ).rejects.toThrow('Registry body could not be read.');
  expect(body.locked).toBe(false);
});
it('ignores cancellation rejection and releases the lock', async () => {
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(encode('too-large'));
      },
      cancel() {
        return Promise.reject(new Error('secret cancel'));
      },
    },
    { highWaterMark: 0 },
  );
  await expect(
    readBoundedJson({ body, headers: new Headers() }, 2),
  ).rejects.toMatchObject({ reason: 'too-large' });
  expect(body.locked).toBe(false);
});

it('rejects an oversized declaration even when the stream is absent', async () => {
  await expect(
    readBoundedJson(
      { body: null, headers: new Headers({ 'Content-Length': '9' }) },
      8,
    ),
  ).rejects.toMatchObject({ reason: 'too-large' });
});
