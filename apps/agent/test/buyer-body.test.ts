import { expect, it, vi } from 'vitest';
import { readBuyerBody } from '../src/buyer-body.js';

it('counts multibyte bytes across chunks and releases the reader', async () => {
  const bytes = new TextEncoder().encode('€🙂');
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  );
  expect(await readBuyerBody(response, 7, new AbortController().signal)).toBe(
    '€🙂',
  );
  expect(response.body?.locked).toBe(false);
});

it.each(['overflow', 'malformed', 'abort'] as const)(
  'cleans up readers after %s',
  async (kind) => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            kind === 'malformed'
              ? Uint8Array.of(255)
              : new TextEncoder().encode('€🙂'),
          );
          if (kind === 'malformed') controller.close();
        },
        cancel,
      }),
    );
    if (kind === 'abort') abort.abort();
    await expect(
      readBuyerBody(response, kind === 'overflow' ? 6 : 7, abort.signal),
    ).rejects.toThrow();
    expect(response.body?.locked).toBe(false);
    if (kind !== 'malformed') expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it('fails closed without a response stream', async () => {
  await expect(
    readBuyerBody(new Response(null), 10, new AbortController().signal),
  ).rejects.toThrow();
});

it('releases the lock even when cancellation rejects', async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
      },
      cancel() {
        throw new Error('cancel failed');
      },
    }),
  );
  await expect(
    readBuyerBody(response, 1, new AbortController().signal),
  ).rejects.toThrow();
  expect(response.body?.locked).toBe(false);
});
