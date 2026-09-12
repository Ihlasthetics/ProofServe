import { afterEach, expect, it, vi } from 'vitest';
import {
  CreateProviderRequestSchema,
  ListServicesResponseSchema,
  unverifiedProviderFixture,
} from '@proofserve/shared';
import { registryBoundary } from '../src/server/registry-boundary';
import {
  REGISTRY_REQUEST_BYTES,
  REGISTRY_RESPONSE_BYTES,
} from '../src/server/bounded-json';

const encoder = new TextEncoder();
function stream(bytes: Uint8Array, split: number) {
  const cancel = vi.fn();
  let offset = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, offset + split);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { body, cancel };
}
function browser(body: ReadableStream<Uint8Array>, length?: string) {
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    body,
    duplex: 'half',
    headers: {
      'Content-Type': 'application/json',
      ...(length === undefined ? {} : { 'Content-Length': length }),
    },
  };
  return new Request('http://web.example.test/api/providers', init);
}
function padded(json: string, size: number) {
  return encoder.encode(json + ' '.repeat(size - encoder.encode(json).length));
}
const provider = JSON.stringify({
  displayName: 'Operator 🌍',
  payoutAccount: '0.0.123',
});
function safe(response: Response) {
  expect(response.headers.get('Content-Type')).toBe(
    'application/json; charset=utf-8',
  );
  expect(response.headers.get('Cache-Control')).toBe('no-store');
}
afterEach(() => vi.restoreAllMocks());

it.each([-1, 0, 1])(
  'bounds streamed browser requests at limit %+i bytes before schema validation',
  async (delta) => {
    const input = stream(padded(provider, REGISTRY_REQUEST_BYTES + delta), 137);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(unverifiedProviderFixture), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const parse = vi.spyOn(CreateProviderRequestSchema, 'safeParse');
    const response = await registryBoundary(browser(input.body, '1'), fetcher);
    safe(response);
    if (delta <= 0) {
      expect(response.status).toBe(201);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(parse).toHaveBeenCalledOnce();
    } else {
      expect(response.status).toBe(413);
      expect(fetcher).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(input.cancel).toHaveBeenCalledOnce();
      expect(await response.text()).not.toContain('Operator');
    }
    expect(input.body.locked).toBe(false);
  },
);
it.each([-1, 0, 1])(
  'bounds upstream JSON at limit %+i bytes without trusting Content-Length',
  async (delta) => {
    const input = stream(
      padded('{"services":[]}', REGISTRY_RESPONSE_BYTES + delta),
      65536,
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(input.body, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '1',
          'X-Debug': 'secret',
        },
      }),
    );
    const parse = vi.spyOn(ListServicesResponseSchema, 'safeParse');
    const response = await registryBoundary(
      new Request('http://web.example.test/api/services'),
      fetcher,
    );
    safe(response);
    expect(response.headers.has('X-Debug')).toBe(false);
    expect(response.status).toBe(delta <= 0 ? 200 : 500);
    if (delta <= 0) expect(parse).toHaveBeenCalledOnce();
    else {
      expect(parse).not.toHaveBeenCalled();
      expect(input.cancel).toHaveBeenCalledOnce();
    }
    expect(input.body.locked).toBe(false);
  },
);
it('accepts multibyte browser fields split across single-byte chunks without Content-Length', async () => {
  const input = stream(encoder.encode(provider), 1);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(unverifiedProviderFixture), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  expect((await registryBoundary(browser(input.body), fetcher)).status).toBe(
    201,
  );
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).displayName).toBe(
    'Operator 🌍',
  );
});
it.each(['request', 'response'] as const)(
  'rejects excessive declared %s length before pulling',
  async (direction) => {
    const input = stream(encoder.encode('{}'), 1);
    const fetcher = vi.fn<typeof fetch>();
    const response =
      direction === 'request'
        ? await registryBoundary(
            browser(input.body, String(REGISTRY_REQUEST_BYTES + 1)),
            fetcher,
          )
        : await registryBoundary(
            new Request('http://web.example.test/api/services'),
            fetcher.mockResolvedValue(
              new Response(input.body, {
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': String(REGISTRY_RESPONSE_BYTES + 1),
                },
              }),
            ),
          );
    expect(response.status).toBe(direction === 'request' ? 413 : 500);
    expect(input.cancel).toHaveBeenCalledOnce();
    if (direction === 'request') expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each(['text/html', 'application/json'])(
  'sanitizes oversized upstream diagnostics with %s and no declared length',
  async (type) => {
    const input = stream(
      encoder.encode(
        '<html>secret-stack</html>' + 'x'.repeat(REGISTRY_RESPONSE_BYTES),
      ),
      128000,
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(input.body, {
        status: 500,
        headers: { 'Content-Type': type, 'Set-Cookie': 'secret' },
      }),
    );
    const response = await registryBoundary(
      new Request('http://web.example.test/api/services'),
      fetcher,
    );
    expect(response.status).toBe(500);
    safe(response);
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(await response.text()).not.toMatch(/secret|html|stack/);
    expect(input.cancel).toHaveBeenCalledOnce();
    expect(input.body.locked).toBe(false);
  },
);
it.each(['request', 'response'] as const)(
  'sanitizes malformed or failed streamed %s bodies',
  async (direction) => {
    for (const transportFailure of [false, true]) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('secret malformed'));
          if (transportFailure) controller.error(new Error('secret transport'));
          else controller.close();
        },
      });
      const fetcher = vi.fn<typeof fetch>();
      const response =
        direction === 'request'
          ? await registryBoundary(browser(body), fetcher)
          : await registryBoundary(
              new Request('http://web.example.test/api/services'),
              fetcher.mockResolvedValue(
                new Response(body, {
                  headers: { 'Content-Type': 'application/json' },
                }),
              ),
            );
      expect(response.status).toBe(direction === 'request' ? 400 : 500);
      expect(await response.text()).not.toContain('secret');
      if (direction === 'request') expect(fetcher).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    }
  },
);

it('decodes upstream multibyte JSON split across byte boundaries without declared length', async () => {
  const returned = {
    ...unverifiedProviderFixture,
    displayName: 'Operator 🌍é',
  };
  const input = stream(encoder.encode(JSON.stringify(returned)), 1);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(input.body, {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const response = await registryBoundary(
    browser(stream(encoder.encode(provider), 1).body),
    fetcher,
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(returned);
  expect(input.body.locked).toBe(false);
});
