import { BuyerError } from './buyer-payment.js';

/** Limit streamed bytes before allocating a JSON object, even without Content-Length. */
export async function readBuyerBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    (!/^[0-9]{1,20}$/.test(length) || BigInt(length) > BigInt(maximum))
  ) {
    void response.body?.cancel().catch(() => {});
    throw new BuyerError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BuyerError();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new BuyerError();
      if (value.byteLength) chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, size),
    );
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
