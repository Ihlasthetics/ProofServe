import {
  ActivateServiceRequestSchema,
  ActivateServiceResponseSchema,
  ApiErrorResponseSchema,
  CreateProviderRequestSchema,
  CreateProviderResponseSchema,
  CreateServiceRequestSchema,
  CreateServiceResponseSchema,
  ListServicesResponseSchema,
  ServiceParamsSchema,
  type ApiErrorCode,
} from '@proofserve/shared';

// Imported only by the server route. No request value controls this setting.
function registryOrigin() {
  const value = process.env.REGISTRY_API_ORIGIN ?? 'http://127.0.0.1:3001';
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid registry configuration');
  return url.origin;
}

const errors: Partial<Record<ApiErrorCode, readonly [number, string]>> = {
  VALIDATION_ERROR: [400, 'Invalid registry request.'],
  UNAUTHORIZED: [401, 'Registry authorization is required.'],
  FORBIDDEN: [403, 'The registry request is forbidden.'],
  PROVIDER_NOT_FOUND: [404, 'Provider not found.'],
  SERVICE_NOT_FOUND: [404, 'Service not found.'],
  PROVIDER_VERIFICATION_REQUIRED: [
    403,
    'Current provider verification is required.',
  ],
  ENDPOINT_NOT_ALLOWED: [403, 'Service endpoint is not approved.'],
  SERVICE_STATE_CONFLICT: [409, 'Service state conflict.'],
  INTERNAL_ERROR: [500, 'The registry request could not be completed.'],
};
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
function failure(code: ApiErrorCode = 'INTERNAL_ERROR', status?: number) {
  const controlled = errors[code] ?? errors.INTERNAL_ERROR!;
  return json(
    ApiErrorResponseSchema.parse({ error: { code, message: controlled[1] } }),
    status ?? controlled[0],
  );
}

// A closed dispatcher: even methods routed here by Next cannot extend forwarding.
export async function registryBoundary(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.search || url.hash || url.username || url.password)
      return failure('VALIDATION_ERROR');
    const path = url.pathname;
    const activation = /^\/api\/services\/([^/]+)\/activate$/.exec(path);
    if (path !== '/api/providers' && path !== '/api/services' && !activation)
      return failure('VALIDATION_ERROR', 404);
    if (!(
      (path === '/api/services' && request.method === 'GET') ||
      request.method === 'POST'
    ))
      return failure('VALIDATION_ERROR', 405);

    let id: string | undefined;
    if (activation) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(activation[1]!);
      } catch {
        return failure('VALIDATION_ERROR');
      }
      const params = ServiceParamsSchema.safeParse({ id: decoded });
      if (!params.success) return failure('VALIDATION_ERROR');
      id = params.data.id;
    }
    let body: unknown;
    if (request.method === 'POST') {
      if (
        request.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      )
        return failure('VALIDATION_ERROR');
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return failure('VALIDATION_ERROR');
      }
      const schema =
        id !== undefined
          ? ActivateServiceRequestSchema
          : path === '/api/providers'
            ? CreateProviderRequestSchema
            : CreateServiceRequestSchema;
      const parsed = schema.safeParse(input);
      if (!parsed.success) return failure('VALIDATION_ERROR');
      body = parsed.data;
    } else if (
      request.body !== null ||
      request.headers.has('transfer-encoding') ||
      (request.headers.has('content-length') &&
        request.headers.get('content-length') !== '0')
    )
      return failure('VALIDATION_ERROR');

    const upstreamPath =
      id !== undefined
        ? `/api/services/${encodeURIComponent(id)}/activate`
        : path === '/api/providers'
          ? '/api/providers'
          : '/api/services';
    const upstream = await fetcher(`${registryOrigin()}${upstreamPath}`, {
      method: request.method,
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(10000),
    });
    if (
      upstream.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    )
      return failure();
    const data: unknown = await upstream.json();
    if (!upstream.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(data);
      if (
        !parsed.success ||
        errors[parsed.data.error.code]?.[0] !== upstream.status
      )
        return failure();
      // Never echo upstream error.message: the schema cannot detect secrets in text.
      return failure(parsed.data.error.code);
    }
    if (id !== undefined) {
      const parsed = ActivateServiceResponseSchema.safeParse(data);
      return upstream.status === 200 &&
        parsed.success &&
        parsed.data.id === id &&
        parsed.data.status === 'ACTIVE'
        ? json(parsed.data, 200)
        : failure();
    }
    if (path === '/api/providers') {
      const parsed = CreateProviderResponseSchema.safeParse(data);
      return upstream.status === 201 &&
        parsed.success &&
        parsed.data.verification.status === 'UNVERIFIED'
        ? json(parsed.data, 201)
        : failure();
    }
    if (request.method === 'POST') {
      const parsed = CreateServiceResponseSchema.safeParse(data);
      const input = CreateServiceRequestSchema.parse(body);
      return upstream.status === 201 &&
        parsed.success &&
        parsed.data.status === 'DRAFT' &&
        parsed.data.providerId === input.providerId
        ? json(parsed.data, 201)
        : failure();
    }
    const parsed = ListServicesResponseSchema.safeParse(data);
    return upstream.status === 200 && parsed.success
      ? json(parsed.data, 200)
      : failure();
  } catch {
    // Network, parsing, configuration and unexpected failures all remain private.
    return failure();
  }
}
