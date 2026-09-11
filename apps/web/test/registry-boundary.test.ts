import { afterEach, expect, it, vi } from 'vitest';
import {
  activeServiceFixture,
  draftServiceFixture,
  unverifiedProviderFixture,
  verifiedProviderFixture,
  ApiErrorResponseSchema,
} from '@proofserve/shared';
import { registryBoundary } from '../src/server/registry-boundary';
import * as route from '../src/app/api/[...registry]/route';

const providerBody = { displayName: 'Operator', payoutAccount: '0.0.123457' };
const serviceBody = {
  providerId: unverifiedProviderFixture.id,
  name: 'Triage',
  description: 'Support',
  capability: 'SUPPORT_TICKET_TRIAGE',
  price: { network: 'hedera:testnet', asset: '0.0.0', amountAtomic: '1000000' },
};
const activationPath = `/api/services/${activeServiceFixture.id}/activate`;
const operations = [
  {
    path: '/api/providers',
    method: 'POST',
    body: providerBody,
    data: unverifiedProviderFixture,
    status: 201,
  },
  {
    path: '/api/services',
    method: 'POST',
    body: serviceBody,
    data: draftServiceFixture,
    status: 201,
  },
  {
    path: '/api/services',
    method: 'GET',
    body: undefined,
    data: { services: [] },
    status: 200,
  },
  {
    path: activationPath,
    method: 'POST',
    body: {},
    data: activeServiceFixture,
    status: 200,
  },
];
function request(path: string, method = 'POST', body: unknown = {}) {
  return new Request(`http://web.example.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'secret-auth',
      Cookie: 'secret-cookie',
      'X-Forwarded-Host': 'evil.example.test',
    },
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : { body: JSON.stringify(body) }),
  });
}
function upstream(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'secret-cookie',
      Authorization: 'secret-auth',
      'X-Debug': 'secret-stack',
      Location: 'https://evil.example.test',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
function controlled(response: Response) {
  expect([...response.headers.keys()].sort()).toEqual([
    'cache-control',
    'content-type',
  ]);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toBe(
    'application/json; charset=utf-8',
  );
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(operations)(
  'validates and forwards $method $path with only controlled headers',
  async ({ path, method, body, data, status }) => {
    vi.stubEnv('REGISTRY_API_ORIGIN', 'https://registry.example.test');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(upstream(data, status));
    const response = await registryBoundary(
      request(path, method, body),
      fetcher,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(data);
    controlled(response);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://registry.example.test${path}`);
    expect(init).toMatchObject({
      method,
      cache: 'no-store',
      redirect: 'manual',
      credentials: 'omit',
    });
    expect(init?.headers).toEqual(
      method === 'GET'
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
    );
    expect(
      init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    ).toEqual(body);
  },
);

it.each([
  ['/api/providers', 'GET'],
  ['/api/providers', 'PUT'],
  ['/api/providers', 'DELETE'],
  ['/api/services', 'PUT'],
  ['/api/services', 'PATCH'],
  ['/api/services', 'DELETE'],
  ['/api/services', 'HEAD'],
  ['/api/services', 'OPTIONS'],
  [activationPath, 'GET'],
  [activationPath, 'PUT'],
  [activationPath, 'HEAD'],
  ['/api/providers/id/verification/world', 'POST'],
  ['/api/anything', 'POST'],
  ['/api/services/id/activate/extra', 'POST'],
])('does not forward unsupported %s %s', async (path, method) => {
  const fetcher = vi.fn<typeof fetch>();
  const response = await registryBoundary(request(path, method), fetcher);
  expect([404, 405]).toContain(response.status);
  expect(fetcher).not.toHaveBeenCalled();
  controlled(response);
});

it.each([
  ['/api/providers', {}],
  ['/api/providers', { ...providerBody, origin: 'https://evil.example.test' }],
  ['/api/providers', { ...providerBody, verification: 'VERIFIED' }],
  ['/api/services', { ...serviceBody, endpoint: 'https://evil.example.test' }],
  [
    '/api/services',
    { ...serviceBody, price: { ...serviceBody.price, amountAtomic: '1.5' } },
  ],
  [activationPath, { status: 'ACTIVE' }],
  ['/api/services/bad%2Fid/activate', {}],
  ['/api/services/bad%ZZid/activate', {}],
  ['/api/services/bad%3Fid/activate', {}],
  ['/api/services/bad%23id/activate', {}],
  ['/api/services/bad%40id/activate', {}],
  [`/api/services/${'a'.repeat(129)}/activate`, {}],
])('rejects invalid body or ID for %s before fetch', async (path, body) => {
  const fetcher = vi.fn<typeof fetch>();
  const response = await registryBoundary(request(path, 'POST', body), fetcher);
  expect(response.status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  '/api/services?origin=https://evil.example.test',
  '/api/services?capability=SUPPORT_TICKET_TRIAGE',
  '/api/services#secret',
  '/api/https://evil.example.test',
  '/api/services/https%3A%2F%2Fevil.example.test/activate',
])('does not accept destination or path injection: %s', async (path) => {
  const fetcher = vi.fn<typeof fetch>();
  const response = await registryBoundary(request(path), fetcher);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  new Response('<html>secret-stack</html>', {
    status: 500,
    headers: { 'Content-Type': 'text/html' },
  }),
  new Response('secret-stack', {
    headers: { 'Content-Type': 'application/json' },
  }),
  upstream({ ...unverifiedProviderFixture, stack: 'secret-stack' }, 201),
  upstream(
    {
      error: { code: 'INTERNAL_ERROR', message: 'secret-stack' },
      secret: 'private',
    },
    500,
  ),
  upstream(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'secret-stack',
        stack: 'private',
      },
    },
    500,
  ),
  upstream(
    {
      error: {
        code: 'PROVIDER_VERIFICATION_REQUIRED',
        message: 'secret-stack',
      },
    },
    200,
  ),
  upstream(unverifiedProviderFixture, 202),
  upstream(unverifiedProviderFixture, 302),
])('sanitizes malformed or unsafe upstream response %#', async (raw) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(raw);
  const response = await registryBoundary(
    request('/api/providers', 'POST', providerBody),
    fetcher,
  );
  expect(response.status).toBe(500);
  controlled(response);
  const text = await response.text();
  expect(text).not.toMatch(/secret|private|html|stack/);
  expect(ApiErrorResponseSchema.parse(JSON.parse(text)).error.code).toBe(
    'INTERNAL_ERROR',
  );
});

it.each([
  [400, 'VALIDATION_ERROR'],
  [401, 'UNAUTHORIZED'],
  [403, 'PROVIDER_VERIFICATION_REQUIRED'],
  [403, 'ENDPOINT_NOT_ALLOWED'],
  [404, 'SERVICE_NOT_FOUND'],
  [409, 'SERVICE_STATE_CONFLICT'],
  [500, 'INTERNAL_ERROR'],
])(
  'preserves validated error status %s and code %s but replaces its message',
  async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      upstream(
        {
          error: {
            code,
            message: 'Error: secret-stack\n at internal-file:123',
          },
        },
        Number(status),
      ),
    );
    const response = await registryBoundary(request(activationPath), fetcher);
    expect(response.status).toBe(status);
    controlled(response);
    const data = ApiErrorResponseSchema.parse(await response.json());
    expect(data.error.code).toBe(code);
    expect(data.error.message).not.toMatch(/secret|stack|internal-file/);
  },
);

it('rejects mismatched upstream error status and network failures', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      upstream({ error: { code: 'VALIDATION_ERROR', message: 'secret' } }, 403),
    )
    .mockRejectedValueOnce(new Error('secret-network'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await registryBoundary(
      request('/api/services', 'GET'),
      fetcher,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
    controlled(response);
  }
});

it.each([
  'ftp://registry.example.test',
  'https://user:secret@registry.example.test',
  'https://registry.example.test/path',
  'https://registry.example.test?secret=1',
  'https://registry.example.test#secret',
  'not a URL',
])(
  'rejects invalid server configuration without leaking it: %s',
  async (origin) => {
    vi.stubEnv('REGISTRY_API_ORIGIN', origin);
    const fetcher = vi.fn<typeof fetch>();
    const response = await registryBoundary(
      request('/api/services', 'GET'),
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(origin);
  },
);

it('ignores browser host and forwarding headers when choosing the default upstream', async () => {
  vi.stubEnv('REGISTRY_API_ORIGIN', undefined);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(upstream({ services: [] }));
  await registryBoundary(
    new Request('https://evil.example.test/api/services', {
      headers: {
        Host: 'evil.example.test',
        'X-Registry-Origin': 'https://evil.example.test',
      },
    }),
    fetcher,
  );
  expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3001/api/services');
});

it('rejects malformed browser JSON and non-JSON media types before forwarding', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const contentType of ['text/plain', 'application/json']) {
    const response = await registryBoundary(
      new Request('http://web.example.test/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: 'not-json',
      }),
      fetcher,
    );
    expect(response.status).toBe(400);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('wires all framework handlers to the boundary, including HEAD and OPTIONS', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(upstream({ services: [] }));
  vi.stubGlobal('fetch', fetcher);
  expect(route.dynamic).toBe('force-dynamic');
  expect((await route.GET(request('/api/services', 'GET'))).status).toBe(200);
  for (const method of ['HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) {
    expect((await route[method](request('/api/services', method))).status).toBe(
      405,
    );
  }
  expect(fetcher).toHaveBeenCalledOnce();
});

it('validates a nonempty listing and rejects nested unexpected fields', async () => {
  const entry = {
    service: activeServiceFixture,
    provider: verifiedProviderFixture,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(upstream({ services: [entry] }))
    .mockResolvedValueOnce(
      upstream({
        services: [
          { ...entry, provider: { ...entry.provider, secret: 'private' } },
        ],
      }),
    );
  const valid = await registryBoundary(
    request('/api/services', 'GET'),
    fetcher,
  );
  expect(await valid.json()).toEqual({ services: [entry] });
  const invalid = await registryBoundary(
    request('/api/services', 'GET'),
    fetcher,
  );
  expect(invalid.status).toBe(500);
  expect(await invalid.text()).not.toContain('private');
});

it.each([
  [
    '/api/providers',
    providerBody,
    {
      ...unverifiedProviderFixture,
      verification: verifiedProviderFixture.verification,
    },
    201,
  ],
  [
    '/api/services',
    serviceBody,
    { ...draftServiceFixture, status: 'ACTIVE' },
    201,
  ],
  [
    '/api/services',
    serviceBody,
    { ...draftServiceFixture, providerId: 'other' },
    201,
  ],
  [activationPath, {}, { ...activeServiceFixture, id: 'other' }, 200],
  [activationPath, {}, { ...activeServiceFixture, status: 'DRAFT' }, 200],
])('rejects inconsistent success for %s', async (path, body, data, status) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(upstream(data, Number(status)));
  const response = await registryBoundary(
    request(String(path), 'POST', body),
    fetcher,
  );
  expect(response.status).toBe(500);
  expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
    'INTERNAL_ERROR',
  );
});
