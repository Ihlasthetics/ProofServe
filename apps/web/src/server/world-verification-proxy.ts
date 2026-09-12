import {
  ApiErrorResponseSchema,
  ProviderParamsSchema,
  WorldVerificationContextRequestSchema,
  WorldVerificationContextResponseSchema,
  WorldVerificationRequestSchema,
  WorldVerificationResponseSchema,
  type ApiErrorCode,
} from '@proofserve/shared';
import {
  isJsonContentType,
  parseJsonWithUniqueMembers,
  readBoundedUtf8,
} from '../lib/strict-json';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CONTEXT_REQUEST_BYTES = 256;
const MAX_VERIFICATION_REQUEST_BYTES = 1_048_576;
const MAX_UPSTREAM_RESPONSE_BYTES = 16_384;
const SAFE_FAILURE_MESSAGE = 'Verification could not be completed.';

export type WorldProxyOperation = 'context' | 'verification';

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WorldProxyDependencies {
  apiOrigin?: string;
  fetch?: FetchImplementation;
  timeoutMs?: number;
}

const expectedErrorCodes: Readonly<
  Record<WorldProxyOperation, Readonly<Record<number, readonly ApiErrorCode[]>>>
> = {
  context: {
    400: ['VALIDATION_ERROR'],
    404: ['PROVIDER_NOT_FOUND'],
    409: ['PROVIDER_ALREADY_VERIFIED'],
    500: ['INTERNAL_ERROR'],
    503: ['WORLD_VERIFICATION_UNAVAILABLE'],
  },
  verification: {
    400: ['WORLD_PROOF_INVALID'],
    404: ['PROVIDER_NOT_FOUND'],
    409: ['WORLD_PROOF_REPLAYED', 'PROVIDER_ALREADY_VERIFIED'],
    500: ['INTERNAL_ERROR'],
    503: ['WORLD_VERIFICATION_UNAVAILABLE'],
  },
};

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function safeFailure(status = 502): Response {
  return jsonResponse(
    {
      error: {
        code: 'WORLD_VERIFICATION_UNAVAILABLE',
        message: SAFE_FAILURE_MESSAGE,
      },
    },
    status,
  );
}

function validationFailure(status = 400): Response {
  return jsonResponse(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The verification request is invalid.',
      },
    },
    status,
  );
}

export function worldProxyMethodNotAllowed(): Response {
  return jsonResponse(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'This request method is not supported.',
      },
    },
    405,
    { allow: 'POST' },
  );
}

function configuredApiOrigin(value: string | undefined): string {
  if (value === undefined) throw new Error('Invalid API configuration');
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('Invalid API configuration');
  }
  return parsed.origin;
}

function requestLimit(operation: WorldProxyOperation): number {
  return operation === 'context'
    ? MAX_CONTEXT_REQUEST_BYTES
    : MAX_VERIFICATION_REQUEST_BYTES;
}

function hasPermittedContentLength(request: Request, limit: number): boolean {
  const value = request.headers.get('content-length');
  if (value === null) return true;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  const length = Number(value);
  return Number.isSafeInteger(length) && length <= limit;
}

async function validatedRequestBody(
  request: Request,
  operation: WorldProxyOperation,
): Promise<unknown> {
  const limit = requestLimit(operation);
  if (
    !isJsonContentType(request.headers.get('content-type')) ||
    !hasPermittedContentLength(request, limit)
  ) {
    throw new SyntaxError('Invalid JSON request');
  }
  const source = await readBoundedUtf8(request.body, limit);
  const value = parseJsonWithUniqueMembers(source);
  const schema =
    operation === 'context'
      ? WorldVerificationContextRequestSchema
      : WorldVerificationRequestSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SyntaxError('Invalid JSON request');
  return parsed.data;
}

function upstreamPath(
  operation: WorldProxyOperation,
  providerId: string,
): string {
  const provider = encodeURIComponent(providerId);
  return operation === 'context'
    ? `/api/providers/${provider}/verification/world/request`
    : `/api/providers/${provider}/verification/world`;
}

function validTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS)
    throw new Error('Invalid timeout configuration');
  return value;
}

function isExpectedError(
  operation: WorldProxyOperation,
  status: number,
  value: unknown,
): value is { error: { code: ApiErrorCode; message: string } } {
  const parsed = ApiErrorResponseSchema.safeParse(value);
  if (!parsed.success) return false;
  return (
    expectedErrorCodes[operation][status]?.includes(parsed.data.error.code) ===
    true
  );
}

function sanitizedUpstreamError(
  operation: WorldProxyOperation,
  status: number,
  value: unknown,
): Response {
  if (!isExpectedError(operation, status, value)) return safeFailure();
  return jsonResponse(
    {
      error: {
        code: value.error.code,
        message: SAFE_FAILURE_MESSAGE,
      },
    },
    status,
  );
}

function validatedSuccess(
  operation: WorldProxyOperation,
  providerId: string,
  value: unknown,
): unknown | undefined {
  if (operation === 'context') {
    const parsed = WorldVerificationContextResponseSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.signal !== `proofserve:provider:${providerId}`
    ) {
      return undefined;
    }
    return parsed.data;
  }
  const parsed = WorldVerificationResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.providerId !== providerId)
    return undefined;
  return parsed.data;
}

export async function handleWorldProxyPost(
  request: Request,
  providerIdInput: unknown,
  operation: WorldProxyOperation,
  dependencies: WorldProxyDependencies = {},
): Promise<Response> {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return validationFailure();
  }
  if (requestUrl.search !== '') return validationFailure();

  const provider = ProviderParamsSchema.safeParse({ id: providerIdInput });
  if (!provider.success) return validationFailure();

  let body: unknown;
  try {
    body = await validatedRequestBody(request, operation);
  } catch {
    return validationFailure();
  }

  let apiOrigin: string;
  let timeoutMs: number;
  try {
    apiOrigin = configuredApiOrigin(
      dependencies.apiOrigin ?? process.env.PROOFSERVE_API_ORIGIN,
    );
    timeoutMs = validTimeout(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch {
    return safeFailure(503);
  }

  let upstream: Response;
  try {
    upstream = await (dependencies.fetch ?? globalThis.fetch)(
      `${apiOrigin}${upstreamPath(operation, provider.data.id)}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    return safeFailure(503);
  }

  if (
    upstream.redirected ||
    !isJsonContentType(upstream.headers.get('content-type'))
  )
    return safeFailure();

  let responseBody: unknown;
  try {
    const source = await readBoundedUtf8(
      upstream.body,
      MAX_UPSTREAM_RESPONSE_BYTES,
    );
    responseBody = parseJsonWithUniqueMembers(source);
  } catch {
    return safeFailure();
  }

  if (upstream.status === 200) {
    const success = validatedSuccess(operation, provider.data.id, responseBody);
    return success === undefined ? safeFailure() : jsonResponse(success, 200);
  }
  return sanitizedUpstreamError(operation, upstream.status, responseBody);
}
