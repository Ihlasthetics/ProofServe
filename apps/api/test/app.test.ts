import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeServiceFixture,
  ApiErrorResponseSchema,
  CreateProviderRequestSchema,
  CreateServiceRequestSchema,
  fixtureReferenceTime,
  ListServicesResponseSchema,
  ProviderSchema,
  ServiceListingSchema,
  unverifiedProviderFixture,
  verifiedProviderFixture,
  type ApiErrorCode,
  type Provider,
  type ServiceListing,
} from '@proofserve/shared';
import {
  createApiApp,
  InMemoryRegistryRepository,
  type RegistryOptions,
  type RegistryRepository,
} from '../src/index.js';

const apps: ReturnType<typeof createApiApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

const providerRequest = CreateProviderRequestSchema.parse({
  displayName: 'Test operator',
  payoutAccount: '0.0.345678',
});
const serviceRequest = CreateServiceRequestSchema.parse({
  providerId: verifiedProviderFixture.id,
  name: 'Test triage',
  description: 'Test service',
  capability: 'SUPPORT_TICKET_TRIAGE',
  price: { network: 'hedera:testnet', asset: '0.0.0', amountAtomic: '1234567' },
});
function setup(options: RegistryOptions = {}) {
  const repository = options.repository ?? new InMemoryRegistryRepository();
  const app = createApiApp({
    now: () => fixtureReferenceTime,
    providerId: () => 'provider_generated',
    serviceId: () => 'service_generated',
    resolveEndpoint: () => activeServiceFixture.endpoint,
    ...options,
    repository,
  });
  apps.push(app);
  return { app, repository };
}
function seed(
  repository: RegistryRepository,
  provider: Provider = verifiedProviderFixture,
  service: ServiceListing = ServiceListingSchema.parse({
    ...activeServiceFixture,
    status: 'DRAFT',
  }),
) {
  repository.createProvider(provider);
  repository.createService(service);
}
function expectError(
  response: { statusCode: number; json(): unknown; body: string },
  status: number,
  code: ApiErrorCode,
) {
  expect(response.statusCode).toBe(status);
  const body = ApiErrorResponseSchema.parse(response.json());
  expect(body.error.code).toBe(code);
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
  expect(response.body).not.toMatch(
    /stack|ZodError|issues|sensitive-internal|TRIAGE_SERVICE_ENDPOINT/,
  );
  return body;
}
async function expectEmptyDiscovery(
  app: ReturnType<typeof createApiApp>,
  url = '/api/services',
) {
  const response = await app.inject(url);
  expect(response.statusCode).toBe(200);
  expect(ListServicesResponseSchema.parse(response.json()).services).toEqual(
    [],
  );
}

describe('health and providers', () => {
  it('health is independent of endpoint, time, and repository failures', async () => {
    const repository = new InMemoryRegistryRepository();
    vi.spyOn(repository, 'listServices').mockImplementation(() => {
      throw new Error('sensitive-internal');
    });
    const { app, repository: selectedRepository } = setup({
      repository,
      resolveEndpoint: () => {
        throw new Error('sensitive-internal');
      },
      now: () => {
        throw new Error('sensitive-internal');
      },
    });
    expect(selectedRepository).toBe(repository);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
  it('registers and retrieves an unverified provider using injected IDs and time', async () => {
    const { app, repository } = setup({ resolveEndpoint: () => undefined });
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: providerRequest,
    });
    expect(response.statusCode).toBe(201);
    const provider = ProviderSchema.parse(response.json());
    expect(provider).toEqual({
      ...providerRequest,
      id: 'provider_generated',
      createdAt: fixtureReferenceTime,
      updatedAt: fixtureReferenceTime,
      verification: {
        providerId: 'provider_generated',
        method: 'WORLD_SELFIE_CHECK',
        status: 'UNVERIFIED',
        verifiedAt: null,
        expiresAt: null,
      },
    });
    expect(repository.getProvider(provider.id)).toEqual(provider);
    const retrieved = await app.inject({
      method: 'GET',
      url: `/api/providers/${provider.id}`,
    });
    expect(retrieved.statusCode).toBe(200);
    expect(ProviderSchema.parse(retrieved.json())).toEqual(provider);
  });
  it.each([
    { ...providerRequest, payoutAccount: 'invalid' },
    {},
    { displayName: 'Missing payout' },
    { payoutAccount: '0.0.1' },
    ...['id', 'status', 'createdAt', 'updatedAt', 'unknown'].map((key) => ({
      ...providerRequest,
      [key]: 'client',
    })),
    { ...providerRequest, verification: verifiedProviderFixture.verification },
  ])('rejects invalid provider input %j', async (payload) => {
    const { app, repository } = setup();
    expectError(
      await app.inject({ method: 'POST', url: '/api/providers', payload }),
      400,
      'VALIDATION_ERROR',
    );
    expect(repository.getProvider('provider_generated')).toBeUndefined();
  });
  it.each([
    ['bad%20id', 400, 'VALIDATION_ERROR'],
    ['unknown_valid', 404, 'PROVIDER_NOT_FOUND'],
  ] as const)('handles provider ID %s', async (id, status, code) => {
    const { app } = setup();
    expectError(
      await app.inject({ method: 'GET', url: `/api/providers/${id}` }),
      status,
      code,
    );
  });
});

describe('service registration', () => {
  it('derives endpoint and payout from the server and creates only a draft', async () => {
    const resolver = vi.fn(() => activeServiceFixture.endpoint);
    const { app, repository } = setup({ resolveEndpoint: resolver });
    repository.createProvider(unverifiedProviderFixture);
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { ...serviceRequest, providerId: unverifiedProviderFixture.id },
    });
    expect(response.statusCode).toBe(201);
    const service = ServiceListingSchema.parse(response.json());
    expect(service).toEqual({
      id: 'service_generated',
      providerId: unverifiedProviderFixture.id,
      name: serviceRequest.name,
      description: serviceRequest.description,
      capability: serviceRequest.capability,
      endpoint: activeServiceFixture.endpoint,
      status: 'DRAFT',
      paymentRequirements: {
        ...serviceRequest.price,
        payTo: unverifiedProviderFixture.payoutAccount,
      },
      createdAt: fixtureReferenceTime,
      updatedAt: fixtureReferenceTime,
    });
    expect(resolver).toHaveBeenCalledWith('SUPPORT_TICKET_TRIAGE');
    expect(repository.getService(service.id)).toEqual(service);
    expect(repository.getProvider(unverifiedProviderFixture.id)).toEqual(
      unverifiedProviderFixture,
    );
  });
  it('returns 404 for an unknown provider', async () => {
    const { app } = setup();
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/services',
        payload: serviceRequest,
      }),
      404,
      'PROVIDER_NOT_FOUND',
    );
  });
  it.each([undefined, '', 'not-a-url', 'file:///tmp/triage'])(
    'rejects missing or invalid configured endpoint %s',
    async (endpoint) => {
      const { app, repository } = setup({ resolveEndpoint: () => endpoint });
      repository.createProvider(verifiedProviderFixture);
      expectError(
        await app.inject({
          method: 'POST',
          url: '/api/services',
          payload: serviceRequest,
        }),
        403,
        'ENDPOINT_NOT_ALLOWED',
      );
      expect(repository.listServices()).toEqual([]);
    },
  );
  it.each([
    {},
    { ...serviceRequest, capability: 'ticket-triage' },
    ...[
      'endpoint',
      'payTo',
      'status',
      'id',
      'createdAt',
      'updatedAt',
      'verification',
      'unknown',
    ].map((key) => ({ ...serviceRequest, [key]: 'client' })),
    { ...serviceRequest, price: { ...serviceRequest.price, payTo: '0.0.999' } },
    { ...serviceRequest, price: { ...serviceRequest.price, unknown: true } },
    {
      ...serviceRequest,
      price: { ...serviceRequest.price, amountAtomic: 100 },
    },
  ])('rejects invalid service body %j', async (payload) => {
    const { app, repository } = setup();
    repository.createProvider(verifiedProviderFixture);
    expectError(
      await app.inject({ method: 'POST', url: '/api/services', payload }),
      400,
      'VALIDATION_ERROR',
    );
    expect(repository.listServices()).toEqual([]);
  });
});

const verificationCases = [
  {
    label: 'UNVERIFIED',
    provider: unverifiedProviderFixture,
    now: fixtureReferenceTime,
  },
  {
    label: 'expired by clock',
    provider: verifiedProviderFixture,
    now: '2026-09-08T10:00:00.000Z',
  },
  {
    label: 'future verifiedAt',
    provider: verifiedProviderFixture,
    now: '2026-09-06T09:59:59.999Z',
  },
  {
    label: 'exact expiry boundary',
    provider: verifiedProviderFixture,
    now: '2026-09-07T10:00:00.000Z',
  },
  {
    label: 'EXPIRED status',
    provider: ProviderSchema.parse({
      ...verifiedProviderFixture,
      verification: {
        ...verifiedProviderFixture.verification,
        status: 'EXPIRED',
      },
    }),
    now: fixtureReferenceTime,
  },
];
describe('activation', () => {
  it('activates a draft at verifiedAt and updates only status and updatedAt', async () => {
    const now = '2026-09-06T10:00:01.000Z';
    const { app, repository } = setup({ now: () => now });
    const draft = ServiceListingSchema.parse({
      ...activeServiceFixture,
      status: 'DRAFT',
    });
    seed(repository, verifiedProviderFixture, draft);
    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${draft.id}/activate`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(ServiceListingSchema.parse(response.json())).toEqual({
      ...draft,
      status: 'ACTIVE',
      updatedAt: now,
    });
    expect(repository.getService(draft.id)).toEqual(response.json());
    expect(repository.getProvider(verifiedProviderFixture.id)).toEqual(
      verifiedProviderFixture,
    );
  });
  it('accepts the inclusive verifiedAt boundary', async () => {
    const { app, repository } = setup();
    seed(repository);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/services/${activeServiceFixture.id}/activate`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });
  it.each(verificationCases)('blocks $label', async ({ provider, now }) => {
    const { app, repository } = setup({ now: () => now });
    const draft = ServiceListingSchema.parse({
      ...activeServiceFixture,
      providerId: provider.id,
      status: 'DRAFT',
    });
    seed(repository, provider, draft);
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/services/${draft.id}/activate`,
        payload: {},
      }),
      403,
      'PROVIDER_VERIFICATION_REQUIRED',
    );
    expect(repository.getService(draft.id)).toEqual(draft);
  });
  it.each(['ACTIVE', 'SUSPENDED'] as const)(
    'blocks %s activation',
    async (status) => {
      const { app, repository } = setup();
      const service = ServiceListingSchema.parse({
        ...activeServiceFixture,
        status,
      });
      seed(repository, verifiedProviderFixture, service);
      expectError(
        await app.inject({
          method: 'POST',
          url: `/api/services/${service.id}/activate`,
          payload: {},
        }),
        status === 'ACTIVE' ? 409 : 403,
        status === 'ACTIVE'
          ? 'SERVICE_STATE_CONFLICT'
          : 'PROVIDER_VERIFICATION_REQUIRED',
      );
      expect(repository.getService(service.id)).toEqual(service);
    },
  );
  it.each([
    {
      label: 'ACTIVE with expired verification',
      status: 'ACTIVE',
      now: '2026-09-08T10:00:00.000Z',
      endpoint: activeServiceFixture.endpoint,
      expectedStatus: 409,
      expectedCode: 'SERVICE_STATE_CONFLICT',
    },
    {
      label: 'ACTIVE with a changed endpoint',
      status: 'ACTIVE',
      now: fixtureReferenceTime,
      endpoint: 'https://replacement.example.test/v1/triage',
      expectedStatus: 409,
      expectedCode: 'SERVICE_STATE_CONFLICT',
    },
    {
      label: 'SUSPENDED with a changed endpoint',
      status: 'SUSPENDED',
      now: fixtureReferenceTime,
      endpoint: 'https://replacement.example.test/v1/triage',
      expectedStatus: 403,
      expectedCode: 'PROVIDER_VERIFICATION_REQUIRED',
    },
    {
      label: 'SUSPENDED with expired verification',
      status: 'SUSPENDED',
      now: '2026-09-08T10:00:00.000Z',
      endpoint: activeServiceFixture.endpoint,
      expectedStatus: 403,
      expectedCode: 'PROVIDER_VERIFICATION_REQUIRED',
    },
  ] as const)(
    'preserves state error precedence for $label',
    async ({ status, now, endpoint, expectedStatus, expectedCode }) => {
      const { app, repository } = setup({
        now: () => now,
        resolveEndpoint: () => endpoint,
      });
      const service = ServiceListingSchema.parse({
        ...activeServiceFixture,
        status,
      });
      seed(repository, verifiedProviderFixture, service);
      const body = expectError(
        await app.inject({
          method: 'POST',
          url: `/api/services/${service.id}/activate`,
          payload: {},
        }),
        expectedStatus,
        expectedCode,
      );
      if (status === 'SUSPENDED') {
        expect(body.error.message).toContain('renewed verification');
        expect(body.error.message).toContain('reactivation');
      }
      expect(repository.getService(service.id)).toEqual(service);
    },
  );
  it('returns 404 for an unknown service', async () => {
    const { app } = setup();
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/services/unknown/activate',
        payload: {},
      }),
      404,
      'SERVICE_NOT_FOUND',
    );
  });
  it('returns 404 when the provider is missing', async () => {
    const { app, repository } = setup();
    repository.createService(activeServiceFixture);
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/services/${activeServiceFixture.id}/activate`,
        payload: {},
      }),
      404,
      'PROVIDER_NOT_FOUND',
    );
  });
  it('rejects a malformed service ID', async () => {
    const { app } = setup();
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/services/bad%20id/activate',
        payload: {},
      }),
      400,
      'VALIDATION_ERROR',
    );
  });
  it.each(['{"status":"ACTIVE"}', '[]', 'null', 'true', '"text"', '', '{'])(
    'requires an empty JSON object: %s',
    async (payload) => {
      const { app } = setup();
      expectError(
        await app.inject({
          method: 'POST',
          url: '/api/services/unknown/activate',
          payload,
          headers: { 'content-type': 'application/json' },
        }),
        400,
        'VALIDATION_ERROR',
      );
    },
  );
  it('rejects an absent activation body', async () => {
    const { app } = setup();
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/services/unknown/activate',
      }),
      400,
      'VALIDATION_ERROR',
    );
  });
  it.each([undefined, 'https://replacement.example.test/v1/triage'])(
    'rechecks endpoint approval %s',
    async (endpoint) => {
      const { app, repository } = setup({ resolveEndpoint: () => endpoint });
      seed(repository);
      expectError(
        await app.inject({
          method: 'POST',
          url: `/api/services/${activeServiceFixture.id}/activate`,
          payload: {},
        }),
        403,
        'ENDPOINT_NOT_ALLOWED',
      );
      expect(repository.getService(activeServiceFixture.id)?.status).toBe(
        'DRAFT',
      );
    },
  );
});

describe('discovery', () => {
  it('returns eligible services paired with their own provider', async () => {
    const { app, repository } = setup();
    seed(repository, verifiedProviderFixture, activeServiceFixture);
    const second = ProviderSchema.parse({
      ...verifiedProviderFixture,
      id: 'second_provider',
      verification: {
        ...verifiedProviderFixture.verification,
        providerId: 'second_provider',
      },
    });
    seed(
      repository,
      second,
      ServiceListingSchema.parse({
        ...activeServiceFixture,
        id: 'second_service',
        providerId: second.id,
      }),
    );
    const response = await app.inject({ method: 'GET', url: '/api/services' });
    expect(response.statusCode).toBe(200);
    const result = ListServicesResponseSchema.parse(response.json());
    expect(result.services).toHaveLength(2);
    expect(result.services[0]).toEqual({
      service: activeServiceFixture,
      provider: verifiedProviderFixture,
    });
    expect(result.services[1]?.provider).toEqual(second);
    for (const entry of result.services)
      expect(entry.service.providerId).toBe(entry.provider.id);
  });
  it('returns an empty array from an empty repository', async () => {
    const { app } = setup();
    await expectEmptyDiscovery(app);
  });
  it.each(['DRAFT', 'SUSPENDED'] as const)(
    'excludes %s services',
    async (status) => {
      const { app, repository } = setup();
      seed(
        repository,
        verifiedProviderFixture,
        ServiceListingSchema.parse({ ...activeServiceFixture, status }),
      );
      await expectEmptyDiscovery(app);
    },
  );
  it.each(verificationCases)('excludes $label', async ({ provider, now }) => {
    const { app, repository } = setup({ now: () => now });
    seed(
      repository,
      provider,
      ServiceListingSchema.parse({
        ...activeServiceFixture,
        providerId: provider.id,
      }),
    );
    await expectEmptyDiscovery(app);
  });
  it('excludes a service with no provider', async () => {
    const { app, repository } = setup();
    repository.createService(activeServiceFixture);
    await expectEmptyDiscovery(app);
  });
  it('excludes a mismatched provider returned by storage', async () => {
    const { app, repository } = setup();
    repository.createService(activeServiceFixture);
    vi.spyOn(repository, 'getProvider').mockReturnValue(
      unverifiedProviderFixture,
    );
    await expectEmptyDiscovery(app);
  });
  it('rechecks approval on every discovery request', async () => {
    let endpoint: string | undefined = activeServiceFixture.endpoint;
    const { app, repository } = setup({ resolveEndpoint: () => endpoint });
    seed(repository, verifiedProviderFixture, activeServiceFixture);
    const included = await app.inject('/api/services');
    expect(included.statusCode).toBe(200);
    expect(
      ListServicesResponseSchema.parse(included.json()).services,
    ).toHaveLength(1);
    endpoint = 'https://replacement.example.test/v1/triage';
    await expectEmptyDiscovery(app);
    endpoint = undefined;
    await expectEmptyDiscovery(app);
  });
  it.each([
    'capability=SUPPORT_TICKET_TRIAGE',
    'network=hedera%3Atestnet',
    'asset=0.0.0',
    'maxAmountAtomic=1000000',
    'capability=SUPPORT_TICKET_TRIAGE&network=hedera%3Atestnet&asset=0.0.0&maxAmountAtomic=1000000',
  ])('applies valid filters including equal maximum: %s', async (query) => {
    const { app, repository } = setup();
    seed(repository, verifiedProviderFixture, activeServiceFixture);
    const response = await app.inject(`/api/services?${query}`);
    expect(response.statusCode).toBe(200);
    expect(ListServicesResponseSchema.parse(response.json()).services).toEqual([
      { service: activeServiceFixture, provider: verifiedProviderFixture },
    ]);
  });
  it.each([
    ['1000000', '999999', 0],
    ['1000000', '1000000', 1],
    ['1000000', '1000001', 1],
    [
      '900719925474099300000000000000000001',
      '900719925474099300000000000000000000',
      0,
    ],
    [
      '900719925474099300000000000000000001',
      '900719925474099300000000000000000001',
      1,
    ],
  ] as const)(
    'compares price %s with maximum %s',
    async (amountAtomic, maximum, count) => {
      const { app, repository } = setup();
      seed(
        repository,
        verifiedProviderFixture,
        ServiceListingSchema.parse({
          ...activeServiceFixture,
          paymentRequirements: {
            ...activeServiceFixture.paymentRequirements,
            amountAtomic,
          },
        }),
      );
      const response = await app.inject(
        `/api/services?maxAmountAtomic=${maximum}`,
      );
      expect(response.statusCode).toBe(200);
      const result = ListServicesResponseSchema.parse(response.json());
      if (count === 0) expect(result.services).toEqual([]);
      else expect(result.services).toHaveLength(count);
    },
  );
  it.each([
    'capability=ticket-triage',
    'unknown=value',
    '__proto__=x',
    'constructor=x',
    'network=hedera:mainnet',
    'asset=0.0.123',
    'maxAmountAtomic=0',
    'maxAmountAtomic=01',
    'maxAmountAtomic=-1',
    'maxAmountAtomic=1.5',
    'maxAmountAtomic=1e6',
    'maxAmountAtomic=%201',
    'maxAmountAtomic=',
    ...[
      'capability=SUPPORT_TICKET_TRIAGE',
      'network=hedera:testnet',
      'asset=0.0.0',
      'maxAmountAtomic=1',
    ].map((pair) => `${pair}&${pair}`),
    'asset=0.0.0&%61sset=0.0.0',
  ])('rejects invalid query %s', async (query) => {
    const { app } = setup();
    expectError(
      await app.inject(`/api/services?${query}`),
      400,
      'VALIDATION_ERROR',
    );
  });
  it('rejects a GET request body', async () => {
    const { app } = setup();
    expectError(
      await app.inject({ method: 'GET', url: '/api/services', payload: {} }),
      400,
      'VALIDATION_ERROR',
    );
  });
});

const unsupportedQueries = ['unknown=1', 'unknown=1&unknown=2'] as const;
describe('queryless route boundaries', () => {
  it.each(unsupportedQueries)('rejects /health query %s', async (query) => {
    const { app } = setup();
    expectError(await app.inject(`/health?${query}`), 400, 'VALIDATION_ERROR');
  });
  it.each(unsupportedQueries)(
    'rejects provider registration query %s without mutation',
    async (query) => {
      const { app, repository } = setup();
      expectError(
        await app.inject({
          method: 'POST',
          url: `/api/providers?${query}`,
          payload: providerRequest,
        }),
        400,
        'VALIDATION_ERROR',
      );
      expect(repository.getProvider('provider_generated')).toBeUndefined();
    },
  );
  it.each(unsupportedQueries)(
    'rejects provider retrieval query %s before lookup',
    async (query) => {
      const { app, repository } = setup();
      repository.createProvider(verifiedProviderFixture);
      const lookup = vi.spyOn(repository, 'getProvider');
      expectError(
        await app.inject(
          `/api/providers/${verifiedProviderFixture.id}?${query}`,
        ),
        400,
        'VALIDATION_ERROR',
      );
      expect(lookup).not.toHaveBeenCalled();
    },
  );
  it.each(unsupportedQueries)(
    'rejects service registration query %s without mutation',
    async (query) => {
      const { app, repository } = setup();
      repository.createProvider(verifiedProviderFixture);
      expectError(
        await app.inject({
          method: 'POST',
          url: `/api/services?${query}`,
          payload: serviceRequest,
        }),
        400,
        'VALIDATION_ERROR',
      );
      expect(repository.listServices()).toEqual([]);
    },
  );
  it.each(unsupportedQueries)(
    'rejects service activation query %s without activation',
    async (query) => {
      const { app, repository } = setup();
      const draft = ServiceListingSchema.parse({
        ...activeServiceFixture,
        status: 'DRAFT',
      });
      seed(repository, verifiedProviderFixture, draft);
      expectError(
        await app.inject({
          method: 'POST',
          url: `/api/services/${draft.id}/activate?${query}`,
          payload: {},
        }),
        400,
        'VALIDATION_ERROR',
      );
      expect(repository.getService(draft.id)).toEqual(draft);
    },
  );
});

describe('safe failures and isolation', () => {
  it('handles malformed URL encoding with the standard error envelope', async () => {
    const { app } = setup();
    expectError(
      await app.inject('/api/providers/%ZZ'),
      400,
      'VALIDATION_ERROR',
    );
  });
  it.each(['/api/providers', '/api/services', '/api/services/valid/activate'])(
    'handles malformed JSON at %s',
    async (url) => {
      const { app } = setup();
      expectError(
        await app.inject({
          method: 'POST',
          url,
          payload: '{"sensitive-internal":',
          headers: { 'content-type': 'application/json' },
        }),
        400,
        'VALIDATION_ERROR',
      );
    },
  );
  it('handles unsupported content types safely', async () => {
    const { app } = setup();
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/providers',
        payload: '<xml/>',
        headers: { 'content-type': 'application/xml' },
      }),
      400,
      'VALIDATION_ERROR',
    );
  });
  it('turns repository failures into a safe 500', async () => {
    const { app, repository } = setup();
    vi.spyOn(repository, 'createProvider').mockImplementation(() => {
      throw new Error('sensitive-internal');
    });
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/providers',
        payload: providerRequest,
      }),
      500,
      'INTERNAL_ERROR',
    );
  });
  it('does not misclassify repository schema errors as request errors', async () => {
    const { app, repository } = setup();
    vi.spyOn(repository, 'getProvider').mockImplementation(() =>
      ProviderSchema.parse({}),
    );
    expectError(
      await app.inject('/api/providers/valid'),
      500,
      'INTERNAL_ERROR',
    );
  });
  it('validates generated IDs before storage', async () => {
    const { app, repository } = setup({ providerId: () => 'invalid id' });
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/providers',
        payload: providerRequest,
      }),
      500,
      'INTERNAL_ERROR',
    );
    expect(repository.getProvider('invalid id')).toBeUndefined();
  });
  it('handles an unexpected endpoint resolver failure safely', async () => {
    const { app, repository } = setup({
      resolveEndpoint: () => {
        throw new Error('sensitive-internal');
      },
    });
    repository.createProvider(verifiedProviderFixture);
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/services',
        payload: serviceRequest,
      }),
      500,
      'INTERNAL_ERROR',
    );
  });
  it('does not share default repository state between apps', async () => {
    const first = createApiApp({
      now: () => fixtureReferenceTime,
      providerId: () => 'isolated',
    });
    const second = createApiApp({ now: () => fixtureReferenceTime });
    apps.push(first, second);
    expect(
      (
        await first.inject({
          method: 'POST',
          url: '/api/providers',
          payload: providerRequest,
        })
      ).statusCode,
    ).toBe(201);
    expectError(
      await second.inject('/api/providers/isolated'),
      404,
      'PROVIDER_NOT_FOUND',
    );
  });
  it('uses a safe shared error for unknown routes', async () => {
    const { app } = setup();
    expectError(await app.inject('/not-a-route'), 400, 'VALIDATION_ERROR');
  });
});
