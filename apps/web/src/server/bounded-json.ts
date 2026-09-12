// Web boundary resource limits, not alternate domain schemas.
export const REGISTRY_REQUEST_BYTES = 16 * 1024;
export const REGISTRY_RESPONSE_BYTES = 1024 * 1024;

export class BoundedJsonError extends Error {
  constructor(readonly reason: 'too-large' | 'invalid') {
    super('Registry body could not be read.');
  }
}

export async function readBoundedJson(
  message: { body: ReadableStream<Uint8Array> | null; headers: Headers },
  maxBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new BoundedJsonError('invalid');
  const reader = message.body?.getReader();
  try {
    const declared = message.headers.get('content-length');
    if (declared !== null) {
      if (!/^\d+$/.test(declared)) throw new BoundedJsonError('invalid');
      const length = declared.replace(/^0+/, '') || '0';
      const limit = String(maxBytes);
      if (
        length.length > limit.length ||
        (length.length === limit.length && length > limit)
      )
        throw new BoundedJsonError('too-large');
    }
    if (!reader) throw new BoundedJsonError('invalid');
    const bytes = new Uint8Array(maxBytes);
    let used = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - used)
        throw new BoundedJsonError('too-large');
      bytes.set(value, used);
      used += value.byteLength;
    }
    // Decode only bounded bytes, after assembling split UTF-8 sequences. Fatal
    // decoding rejects corrupt/truncated UTF-8 rather than replacing characters.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, used),
    );
    return JSON.parse(text) as unknown;
  } catch (error) {
    // Do not let cancellation failure replace the controlled error or retain the lock.
    void reader?.cancel().catch(() => {});
    throw error instanceof BoundedJsonError
      ? error
      : new BoundedJsonError('invalid');
  } finally {
    reader?.releaseLock();
  }
}
