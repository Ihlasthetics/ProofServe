import { describe, expect, it, vi } from 'vitest';
import {
  handleWorldProxyPost,
  worldProxyMethodNotAllowed,
  type WorldProxyOperation,
} from '../src/server/world-verification-proxy';
import {
  fictionalProviderId,
  fictionalVerifiedRecord,
  fictionalWorldContext,
  fictionalWorldResult,
} from './world-fixtures';

const apiOrigin = 'http://127.0.0.1:3999';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function browserRequest(
  body: string,
  options: { headers?: HeadersInit; query?: string } = {},
): Request {
  return new Request(
    `http://proofserve.local/api/world-selfie-test/${fictionalProviderId}${options.query ?? ''}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...Object.fromEntries(new Headers(options.headers)),
      },
      body,
    },
  );
}

async function body(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

function safeError(value: unknown) {
  expect(value).toEqual({
    error: {
      code: 'WORLD_VERIFICATION_UNAVAILABLE',
      message: 'Verification could not be completed.',
    },
  });
}

describe('World verification same-origin proxy', () => {
  it('proxies only the fixed context operation without forwarding browser headers', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        void _init;
        return jsonResponse(fictionalWorldContext);
      },
    );
    const response = await handleWorldProxyPost(
      browserRequest('{}', {
        headers: {
          authorization: 'Bearer browser-test-marker',
          cookie: 'session=browser-test-marker',
          host: 'attacker.example.test',
          'x-forwarded-for': '203.0.113.7',
        },
      }),
      fictionalProviderId,
      'context',
      { apiOrigin, fetch },
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(fictionalWorldContext);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `${apiOrigin}/api/providers/${fictionalProviderId}/verification/world/request`,
    );
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
    });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  it.each([
    ['invalid provider', '_invalid', '{}', 'context' as const],
    ['query string', fictionalProviderId, '{}', 'context' as const],
    [
      'unexpected context field',
      fictionalProviderId,
      '{"extra":true}',
      'context' as const,
    ],
    ['malformed JSON', fictionalProviderId, '{', 'context' as const],
    [
      'duplicate JSON key',
      fictionalProviderId,
      '{"x":1,"x":2}',
      'context' as const,
    ],
  ])(
    'rejects %s before contacting the backend',
    async (label, providerId, requestBody, operation) => {
      const fetch = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) => {
          void _input;
          void _init;
          return jsonResponse(fictionalWorldContext);
        },
      );
      const request = browserRequest(
        requestBody,
        label === 'query string' ? { query: '?unexpected=1' } : {},
      );
      const response = await handleWorldProxyPost(
        request,
        providerId,
        operation,
        { apiOrigin, fetch },
      );
      expect(response.status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed content types and oversized bodies', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        void _init;
        return jsonResponse(fictionalWorldContext);
      },
    );
    for (const request of [
      browserRequest('{}', { headers: { 'content-type': 'text/plain' } }),
      browserRequest(`{${' '.repeat(300)}}`),
      browserRequest('{}', { headers: { 'content-length': '01' } }),
    ]) {
      const response = await handleWorldProxyPost(
        request,
        fictionalProviderId,
        'context',
        { apiOrigin, fetch },
      );
      expect(response.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards the exact proof once and returns only a matching VERIFIED record', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        void _init;
        return jsonResponse(fictionalVerifiedRecord);
      },
    );
    const response = await handleWorldProxyPost(
      browserRequest(JSON.stringify(fictionalWorldResult)),
      fictionalProviderId,
      'verification',
      { apiOrigin, fetch },
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(fictionalVerifiedRecord);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `${apiOrigin}/api/providers/${fictionalProviderId}/verification/world`,
    );
    expect(JSON.parse(String(init?.body))).toEqual(fictionalWorldResult);
  });

  it.each([
    [
      'context binding mismatch',
      () =>
        jsonResponse({
          ...fictionalWorldContext,
          signal: 'proofserve:provider:different_fictional_provider',
        }),
    ],
    [
      'verified provider mismatch',
      () =>
        jsonResponse({
          ...fictionalVerifiedRecord,
          providerId: 'different_fictional_provider',
        }),
    ],
    [
      'invalid JSON',
      () =>
        new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    ['unexpected status', () => jsonResponse(fictionalWorldContext, 201)],
    ['redirect', () => jsonResponse({}, 302)],
    [
      'malformed content type',
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    ],
    [
      'unexpected fields',
      () =>
        jsonResponse({
          ...fictionalWorldContext,
          secret: 'upstream-test-marker',
        }),
    ],
  ])('fails closed for %s with a sanitized body', async (label, upstream) => {
    const operation: WorldProxyOperation = label.includes('verified')
      ? 'verification'
      : 'context';
    const requestBody =
      operation === 'verification' ? fictionalWorldResult : {};
    const response = await handleWorldProxyPost(
      browserRequest(JSON.stringify(requestBody)),
      fictionalProviderId,
      operation,
      { apiOrigin, fetch: async () => upstream() },
    );
    expect(response.status).toBe(502);
    const value = await body(response);
    safeError(value);
    expect(JSON.stringify(value)).not.toContain('upstream-test-marker');
  });

  it('strictly validates documented backend errors before sanitizing them', async () => {
    const valid = await handleWorldProxyPost(
      browserRequest('{}'),
      fictionalProviderId,
      'context',
      {
        apiOrigin,
        fetch: async () =>
          jsonResponse(
            {
              error: {
                code: 'PROVIDER_NOT_FOUND',
                message: 'upstream-test-marker',
              },
            },
            404,
          ),
      },
    );
    expect(valid.status).toBe(404);
    expect(JSON.stringify(await body(valid))).not.toContain(
      'upstream-test-marker',
    );

    const mismatched = await handleWorldProxyPost(
      browserRequest('{}'),
      fictionalProviderId,
      'context',
      {
        apiOrigin,
        fetch: async () =>
          jsonResponse(
            {
              error: {
                code: 'WORLD_PROOF_INVALID',
                message: 'upstream-test-marker',
              },
            },
            404,
          ),
      },
    );
    expect(mismatched.status).toBe(502);
    safeError(await body(mismatched));
  });

  it('bounds upstream waits, makes one attempt, and hides transport diagnostics', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('transport-test-marker')),
            { once: true },
          );
        }),
    );
    const response = await handleWorldProxyPost(
      browserRequest('{}'),
      fictionalProviderId,
      'context',
      { apiOrigin, fetch, timeoutMs: 5 },
    );
    expect(response.status).toBe(503);
    const value = await body(response);
    safeError(value);
    expect(JSON.stringify(value)).not.toContain('transport-test-marker');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported methods with JSON, no-store, and an Allow header', async () => {
    const response = worldProxyMethodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await body(response)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'This request method is not supported.',
      },
    });
  });
});
