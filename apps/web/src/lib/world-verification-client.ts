import {
  ProviderParamsSchema,
  WorldVerificationContextResponseSchema,
  WorldVerificationRequestSchema,
  WorldVerificationResponseSchema,
  type WorldVerificationContextResponse,
  type WorldVerificationRequest,
  type WorldVerificationResponse,
} from '@proofserve/shared';
import {
  isJsonContentType,
  parseJsonWithUniqueMembers,
  readBoundedUtf8,
} from './strict-json';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16_384;
const SAFE_ERROR_MESSAGE = 'Verification could not be completed.';

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WorldVerificationApiClientDependencies {
  fetch?: FetchImplementation;
  timeoutMs?: number;
}

export interface WorldVerificationApiClient {
  fetchContext(
    providerId: string,
    signal: AbortSignal,
  ): Promise<WorldVerificationContextResponse>;
  submitVerification(
    providerId: string,
    result: unknown,
    signal: AbortSignal,
  ): Promise<WorldVerificationResponse>;
}

export class WorldVerificationApiClientError extends Error {
  constructor() {
    super(SAFE_ERROR_MESSAGE);
  }
}

function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new WorldVerificationApiClientError();
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function endpoint(providerId: string, operation: 'context' | 'verification') {
  const provider = encodeURIComponent(providerId);
  return operation === 'context'
    ? `/api/world-selfie-test/${provider}/context`
    : `/api/world-selfie-test/${provider}/verification`;
}

function responseLengthAllowed(response: Response): boolean {
  const value = response.headers.get('content-length');
  if (value === null) return true;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  const length = Number(value);
  return Number.isSafeInteger(length) && length <= MAX_RESPONSE_BYTES;
}

async function responseJson(response: Response): Promise<unknown> {
  if (
    response.status !== 200 ||
    response.redirected ||
    !isJsonContentType(response.headers.get('content-type')) ||
    !responseLengthAllowed(response)
  ) {
    throw new WorldVerificationApiClientError();
  }
  try {
    const source = await readBoundedUtf8(response.body, MAX_RESPONSE_BYTES);
    return parseJsonWithUniqueMembers(source);
  } catch {
    throw new WorldVerificationApiClientError();
  }
}

async function postJson(
  fetchImplementation: FetchImplementation,
  url: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: requestSignal(signal, timeoutMs),
    });
  } catch {
    throw new WorldVerificationApiClientError();
  }
  return responseJson(response);
}

export function createWorldVerificationApiClient(
  dependencies: WorldVerificationApiClientDependencies = {},
): WorldVerificationApiClient {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async fetchContext(providerId, signal) {
      const provider = ProviderParamsSchema.safeParse({ id: providerId });
      if (!provider.success) throw new WorldVerificationApiClientError();
      const value = await postJson(
        fetchImplementation,
        endpoint(provider.data.id, 'context'),
        {},
        signal,
        timeoutMs,
      );
      const context = WorldVerificationContextResponseSchema.safeParse(value);
      if (
        !context.success ||
        context.data.signal !== `proofserve:provider:${provider.data.id}`
      ) {
        throw new WorldVerificationApiClientError();
      }
      return context.data;
    },
    async submitVerification(providerId, result, signal) {
      const provider = ProviderParamsSchema.safeParse({ id: providerId });
      const proof = WorldVerificationRequestSchema.safeParse(result);
      if (!provider.success || !proof.success)
        throw new WorldVerificationApiClientError();
      const value = await postJson(
        fetchImplementation,
        endpoint(provider.data.id, 'verification'),
        proof.data,
        signal,
        timeoutMs,
      );
      const verification = WorldVerificationResponseSchema.safeParse(value);
      if (
        !verification.success ||
        verification.data.providerId !== provider.data.id
      ) {
        throw new WorldVerificationApiClientError();
      }
      return verification.data;
    },
  };
}

export type {
  WorldVerificationContextResponse,
  WorldVerificationRequest,
  WorldVerificationResponse,
};
