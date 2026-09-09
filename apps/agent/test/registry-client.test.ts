import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ListServicesResponseSchema,
  activeServiceFixture,
  agentTaskFixture,
  apiErrorFixture,
  fixtureReferenceTime,
  verifiedProviderFixture,
} from '@proofserve/shared';
import {
  RegistryDiscoveryError,
  discoverServices,
  selectService,
} from '../src/index.js';

const baseUrl = 'https://registry.example.test/prefix?old=value#fragment';
const payload = () => ({
  services: [
    {
      service: structuredClone(activeServiceFixture),
      provider: structuredClone(verifiedProviderFixture),
    },
    {
      service: {
        ...structuredClone(activeServiceFixture),
        id: 'second_service',
      },
      provider: structuredClone(verifiedProviderFixture),
    },
  ],
});
const respond = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
const safeFailure = async (
  request: Promise<unknown>,
  code: RegistryDiscoveryError['code'],
  message: string,
  status: number | undefined = undefined,
  apiErrorCode: RegistryDiscoveryError['apiErrorCode'] = undefined,
) => {
  await expect(request).rejects.toBeInstanceOf(RegistryDiscoveryError);
  await expect(request).rejects.toMatchObject({
    name: 'RegistryDiscoveryError',
    code,
    message,
    status,
    apiErrorCode,
  });
  await expect(request).rejects.not.toHaveProperty('cause');
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('T03 registry discovery client', () => {
  it('uses the built-in fetch boundary for the exact GET route and all four encoded filters', async () => {
    const fetcher = respond(payload());
    vi.stubGlobal('fetch', fetcher);
    const query = Object.freeze({
      capability: agentTaskFixture.capability,
      ...agentTaskFixture.budget,
    });
    const before = structuredClone(query);
    const base = new URL(baseUrl);
    await discoverServices(base, query);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL(
        'https://registry.example.test/api/services?capability=SUPPORT_TICKET_TRIAGE&network=hedera%3Atestnet&asset=0.0.0&maxAmountAtomic=2000000',
      ),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
      },
    );
    expect(query).toEqual(before);
    expect(base.href).toBe(baseUrl);
  });

  it.each([
    {},
    {
      capability: undefined,
      network: undefined,
      asset: undefined,
      maxAmountAtomic: undefined,
    },
  ])('omits absent or undefined optional filters', async (query) => {
    const fetcher = respond({ services: [] });
    await expect(discoverServices(baseUrl, query, fetcher)).resolves.toEqual(
      [],
    );
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL('https://registry.example.test/api/services'),
    );
  });

  it.each([
    { capability: agentTaskFixture.capability },
    { network: agentTaskFixture.budget.network },
    { asset: agentTaskFixture.budget.asset },
    { maxAmountAtomic: '9007199254740993123456789' },
  ])(
    'sends each filter independently without coercing atomic amounts',
    async (query) => {
      const fetcher = respond({ services: [] });
      await discoverServices(baseUrl, query, fetcher);
      const url = fetcher.mock.calls[0]?.[0];
      if (!(url instanceof URL)) throw new Error('Expected URL request');
      expect(Object.fromEntries(url.searchParams)).toEqual(query);
    },
  );

  it('returns multiple shared-validated candidates directly consumable by the real T02 selector', async () => {
    const body = payload();
    const before = structuredClone(body);
    // Returning the same object at the JSON boundary tests schema detachment.
    const response = Response.json(body);
    vi.spyOn(response, 'json').mockResolvedValue(body);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const candidates = await discoverServices(baseUrl, {}, fetcher);
    expect(candidates).toEqual(ListServicesResponseSchema.parse(body).services);
    const snapshot = structuredClone(candidates);
    expect(
      selectService(agentTaskFixture, candidates, fixtureReferenceTime),
    ).toEqual(body.services[1]);
    expect(candidates).toEqual(snapshot);
    const first = candidates[0];
    if (!first) throw new Error('Expected discovery candidate');
    first.service.paymentRequirements.amountAtomic = '123';
    first.provider.verification.providerId = 'changed_provider';
    expect(body).toEqual(before);
    const secondSource = body.services[1];
    if (!secondSource) throw new Error('Expected second source candidate');
    secondSource.service.name = 'Changed source';
    expect(candidates[1]?.service.name).toBe(activeServiceFixture.name);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('allows a valid empty response with the default query', async () => {
    const fetcher = respond({ services: [] });
    vi.stubGlobal('fetch', fetcher);
    await expect(discoverServices(baseUrl)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://registry.example.test/api/services'),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
      },
    );
  });

  it.each([
    null,
    [],
    {},
    { services: null },
    { services: [], secret: 'PRIVATE_PAYLOAD' },
    { services: [{ service: activeServiceFixture }] },
    {
      services: [
        {
          service: { ...activeServiceFixture, providerId: 'wrong_provider' },
          provider: verifiedProviderFixture,
        },
      ],
    },
    {
      services: [
        {
          service: {
            ...activeServiceFixture,
            paymentRequirements: {
              ...activeServiceFixture.paymentRequirements,
              amountAtomic: '1.5',
            },
          },
          provider: verifiedProviderFixture,
        },
      ],
    },
    {
      services: [
        {
          service: activeServiceFixture,
          provider: { ...verifiedProviderFixture, secret: 'PRIVATE_PAYLOAD' },
        },
      ],
    },
    { services: [...payload().services, { secret: 'PRIVATE_PAYLOAD' }] },
  ])(
    'rejects malformed success bodies without exposing candidate data',
    async (body) => {
      await safeFailure(
        discoverServices(baseUrl, {}, respond(body)),
        'INVALID_RESPONSE',
        'Registry response does not match the discovery contract',
        200,
      );
    },
  );

  it('rejects invalid JSON with a safe local error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('PRIVATE_PAYLOAD{'));
    await safeFailure(
      discoverServices(baseUrl, {}, fetcher),
      'INVALID_JSON',
      'Registry response is not valid JSON',
      200,
    );
  });

  it.each([
    new TypeError('PRIVATE_PAYLOAD connection terminated'),
    new Error('PRIVATE_PAYLOAD body read failed'),
    'PRIVATE_PAYLOAD non-error rejection',
  ])(
    'classifies non-syntax body read failures as safe transport errors',
    async (error) => {
      const response = Response.json({ services: [] });
      const readBody = vi.spyOn(response, 'json').mockRejectedValue(error);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await safeFailure(
        discoverServices(baseUrl, {}, fetcher),
        'NETWORK_ERROR',
        'Registry request failed',
        200,
      );
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        new URL('https://registry.example.test/api/services'),
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
        },
      );
      expect(readBody).toHaveBeenCalledTimes(1);
    },
  );

  it('parses a shared API error but retains only its validated code and HTTP status', async () => {
    const body = {
      error: {
        ...apiErrorFixture.error,
        message: 'PRIVATE_PAYLOAD secret stack trace',
      },
    };
    await safeFailure(
      discoverServices(baseUrl, {}, respond(body, 503)),
      'HTTP_ERROR',
      'Registry returned an unsuccessful response',
      503,
      apiErrorFixture.error.code,
    );
  });

  it.each([
    { error: { code: 'PRIVATE_PAYLOAD', message: 'secret' } },
    {
      error: { ...apiErrorFixture.error, message: 'secret' },
      extra: 'PRIVATE_PAYLOAD',
    },
    payload(),
    null,
  ])(
    'rejects unexpected non-2xx bodies without trusting server data',
    async (body) => {
      await safeFailure(
        discoverServices(baseUrl, {}, respond(body, 500)),
        'HTTP_ERROR',
        'Registry returned an unsuccessful response',
        500,
      );
    },
  );

  it('preserves HTTP failure for non-JSON error bodies', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('PRIVATE_PAYLOAD', { status: 502 }));
    await safeFailure(
      discoverServices(baseUrl, {}, fetcher),
      'HTTP_ERROR',
      'Registry returned an unsuccessful response',
      502,
    );
  });

  it('handles fetch rejection without retaining the original error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('PRIVATE_PAYLOAD secret stack trace'));
    await safeFailure(
      discoverServices(baseUrl, {}, fetcher),
      'NETWORK_ERROR',
      'Registry request failed',
    );
  });

  it.each([
    null,
    [],
    { unknown: 'PRIVATE_PAYLOAD' },
    { capability: 'ticket-triage' },
    { network: 'hedera:mainnet' },
    { asset: '0.0.1' },
    { maxAmountAtomic: 123 },
    { maxAmountAtomic: '01' },
    { maxAmountAtomic: '1&asset=0.0.1' },
  ])('rejects invalid query input before making a request', async (query) => {
    const fetcher = respond({ services: [] });
    const before = structuredClone(query);
    const request: Promise<unknown> = Reflect.apply(
      discoverServices,
      undefined,
      [baseUrl, query, fetcher],
    );
    await safeFailure(
      request,
      'INVALID_QUERY',
      'Invalid registry discovery query',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(query).toEqual(before);
  });

  it.each([
    'PRIVATE_PAYLOAD',
    'file:///private',
    'https://user:secret@registry.example.test',
  ])('rejects invalid base configuration safely before fetch', async (base) => {
    const fetcher = respond({ services: [] });
    await safeFailure(
      discoverServices(base, {}, fetcher),
      'INVALID_BASE_URL',
      'Invalid registry base URL configuration',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not request the network on module import', async () => {
    vi.resetModules();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await import('../src/index.js');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
