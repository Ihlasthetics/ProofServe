import { describe, expect, it, vi } from 'vitest';
import {
  createWorldVerificationApiClient,
  WorldVerificationApiClientError,
} from '../src/lib/world-verification-client';
import {
  fictionalProviderId,
  fictionalVerifiedRecord,
  fictionalWorldContext,
  fictionalWorldResult,
} from './world-fixtures';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function controllerSignal() {
  return new AbortController().signal;
}

describe('same-origin World verification client', () => {
  it('requests and strictly validates provider-bound context', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        void _init;
        return jsonResponse(fictionalWorldContext);
      },
    );
    const client = createWorldVerificationApiClient({ fetch });
    await expect(
      client.fetchContext(fictionalProviderId, controllerSignal()),
    ).resolves.toEqual(fictionalWorldContext);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`/api/world-selfie-test/${fictionalProviderId}/context`);
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    expect(new Headers(init?.headers)).toEqual(
      new Headers({
        accept: 'application/json',
        'content-type': 'application/json',
      }),
    );
  });

  it.each([
    [
      'provider mismatch',
      () =>
        jsonResponse({
          ...fictionalWorldContext,
          signal: 'proofserve:provider:different_fictional_provider',
        }),
    ],
    [
      'unknown context field',
      () => jsonResponse({ ...fictionalWorldContext, unexpected: true }),
    ],
    [
      'invalid JSON',
      () =>
        new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'duplicate JSON member',
      () =>
        new Response('{"app_id":"a","app_id":"b"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    ['unexpected status', () => jsonResponse(fictionalWorldContext, 201)],
    [
      'malformed content type',
      () =>
        new Response(JSON.stringify(fictionalWorldContext), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    ],
  ])('rejects %s with one safe error', async (_label, response) => {
    const client = createWorldVerificationApiClient({
      fetch: async () => response(),
    });
    await expect(
      client.fetchContext(fictionalProviderId, controllerSignal()),
    ).rejects.toEqual(new WorldVerificationApiClientError());
  });

  it('rejects redirected responses even if their final body looks valid', async () => {
    const response = jsonResponse(fictionalWorldContext);
    Object.defineProperty(response, 'redirected', { value: true });
    const client = createWorldVerificationApiClient({
      fetch: async () => response,
    });
    await expect(
      client.fetchContext(fictionalProviderId, controllerSignal()),
    ).rejects.toEqual(new WorldVerificationApiClientError());
  });

  it('submits the exact validated IDKit result and accepts only a matching VERIFIED record', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        void _init;
        return jsonResponse(fictionalVerifiedRecord);
      },
    );
    const client = createWorldVerificationApiClient({ fetch });
    await expect(
      client.submitVerification(
        fictionalProviderId,
        fictionalWorldResult,
        controllerSignal(),
      ),
    ).resolves.toEqual(fictionalVerifiedRecord);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `/api/world-selfie-test/${fictionalProviderId}/verification`,
    );
    expect(JSON.parse(String(init?.body))).toEqual(fictionalWorldResult);

    const mismatch = createWorldVerificationApiClient({
      fetch: async () =>
        jsonResponse({
          ...fictionalVerifiedRecord,
          providerId: 'different_fictional_provider',
        }),
    });
    await expect(
      mismatch.submitVerification(
        fictionalProviderId,
        fictionalWorldResult,
        controllerSignal(),
      ),
    ).rejects.toEqual(new WorldVerificationApiClientError());
  });

  it('bounds same-origin network waits and never exposes diagnostics', async () => {
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
    const client = createWorldVerificationApiClient({ fetch, timeoutMs: 5 });
    let thrown: unknown;
    try {
      await client.fetchContext(fictionalProviderId, controllerSignal());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new WorldVerificationApiClientError());
    expect(String(thrown)).not.toContain('transport-test-marker');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
