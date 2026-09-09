import {
  ApiErrorResponseSchema,
  ListServicesQuerySchema,
  ListServicesResponseSchema,
  type ApiErrorCode,
  type DiscoveryService,
  type ListServicesQuery,
} from '@proofserve/shared';

const messages = {
  INVALID_QUERY: 'Invalid registry discovery query',
  INVALID_BASE_URL: 'Invalid registry base URL configuration',
  NETWORK_ERROR: 'Registry request failed',
  HTTP_ERROR: 'Registry returned an unsuccessful response',
  INVALID_JSON: 'Registry response is not valid JSON',
  INVALID_RESPONSE: 'Registry response does not match the discovery contract',
};

/** Local failure classification; server messages and causes are never retained. */
export class RegistryDiscoveryError extends Error {
  constructor(
    public readonly code: keyof typeof messages,
    public readonly status: number | undefined = undefined,
    public readonly apiErrorCode: ApiErrorCode | undefined = undefined,
  ) {
    super(messages[code]);
    this.name = 'RegistryDiscoveryError';
  }
}

/**
 * Discover snapshots from a trusted, caller-configured registry origin.
 * The absolute /api/services route replaces any base path, query or fragment.
 * Eligibility remains the responsibility of selectService; no candidate is called.
 */
export async function discoverServices(
  baseUrl: string | URL,
  query: Readonly<ListServicesQuery> = {},
  fetcher: typeof fetch = globalThis.fetch,
): Promise<DiscoveryService[]> {
  const parsedQuery = ListServicesQuerySchema.safeParse(query);
  if (!parsedQuery.success) throw new RegistryDiscoveryError('INVALID_QUERY');

  let url: URL;
  try {
    url = new URL('/api/services', baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
  } catch {
    throw new RegistryDiscoveryError('INVALID_BASE_URL');
  }
  for (const [key, value] of Object.entries(parsedQuery.data)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
  } catch {
    throw new RegistryDiscoveryError('NETWORK_ERROR');
  }

  if (!response.ok) {
    let apiErrorCode: ApiErrorCode | undefined;
    try {
      const body: unknown = await response.json();
      const parsedError = ApiErrorResponseSchema.safeParse(body);
      if (parsedError.success) apiErrorCode = parsedError.data.error.code;
    } catch {
      // HTTP failure takes precedence when its error body cannot be decoded.
    }
    throw new RegistryDiscoveryError(
      'HTTP_ERROR',
      response.status,
      apiErrorCode,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new RegistryDiscoveryError(
      error instanceof SyntaxError ? 'INVALID_JSON' : 'NETWORK_ERROR',
      response.status,
    );
  }
  const parsedResponse = ListServicesResponseSchema.safeParse(body);
  if (!parsedResponse.success)
    throw new RegistryDiscoveryError('INVALID_RESPONSE', response.status);
  return parsedResponse.data.services;
}
