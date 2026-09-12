import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  AgentRunParamsSchema,
  ApiErrorResponseSchema,
  CreateAgentRunRequestSchema,
  CreateAgentRunResponseSchema,
  GetAgentRunResponseSchema,
  type ApiErrorCode,
} from '@proofserve/shared';
import {
  BoundedJsonError,
  readBoundedJson,
  REGISTRY_REQUEST_BYTES,
  REGISTRY_RESPONSE_BYTES,
} from './bounded-json';
import {
  isSemanticallyValidRun,
  taskMatches,
} from '../lib/agent-run-validation';
import {
  AGENT_RUN_SESSION_COOKIE,
  AGENT_RUN_SESSION_COOKIE_PATH,
  AGENT_RUN_SESSION_TTL_MS,
  agentRunSessionFromCookie,
  issueAgentRunSession,
  verifyAgentRunSession,
} from './agent-run-session-cookie';

const errors: Partial<Record<ApiErrorCode, readonly [number, string]>> = {
  VALIDATION_ERROR: [400, 'Invalid agent-run request.'],
  UNAUTHORIZED: [401, 'Agent-run authorization is unavailable.'],
  FORBIDDEN: [403, 'The agent-run request is forbidden.'],
  RUN_NOT_FOUND: [404, 'Agent run not found.'],
  INTERNAL_ERROR: [500, 'The agent-run request could not be completed.'],
};
function json(body: unknown, status: number, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
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

function isPermittedLoopbackDevelopment(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  );
}

function jsonWithRunSession(
  body: unknown,
  runId: string,
  secret: string,
  requestUrl: URL,
  now: number,
): Response {
  const response = NextResponse.json(body, {
    status: 202,
    headers: { 'Cache-Control': 'no-store' },
  });
  response.cookies.set({
    name: AGENT_RUN_SESSION_COOKIE,
    value: issueAgentRunSession(runId, secret, now),
    httpOnly: true,
    sameSite: 'strict',
    secure: !isPermittedLoopbackDevelopment(requestUrl),
    path: AGENT_RUN_SESSION_COOKIE_PATH,
    maxAge: AGENT_RUN_SESSION_TTL_MS / 1000,
  });
  // Route handlers send Set-Cookie directly; do not expose Next's internal copy.
  response.headers.delete('x-middleware-set-cookie');
  return response;
}

function agentApiConfiguration() {
  const originValue =
    process.env.AGENT_RUN_API_ORIGIN ??
    process.env.REGISTRY_API_ORIGIN ??
    'http://127.0.0.1:3001';
  const origin = new URL(originValue);
  const token = process.env.AGENT_RUN_API_TOKEN;
  const webAccessToken = process.env.AGENT_RUN_WEB_ACCESS_TOKEN;
  const capabilitySecret = process.env.AGENT_RUN_CAPABILITY_SECRET;
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    (origin.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    typeof token !== 'string' ||
    token.length < 32 ||
    token.length > 512 ||
    /\s/.test(token) ||
    typeof webAccessToken !== 'string' ||
    webAccessToken.length < 16 ||
    webAccessToken.length > 256 ||
    /[\r\n]/.test(webAccessToken) ||
    typeof capabilitySecret !== 'string' ||
    capabilitySecret.length < 32 ||
    capabilitySecret.length > 512 ||
    /\s/.test(capabilitySecret) ||
    capabilitySecret === token ||
    capabilitySecret === webAccessToken
  )
    throw new Error('Invalid agent-run configuration');
  return { origin: origin.origin, token, webAccessToken, capabilitySecret };
}

function matchesAccessToken(
  supplied: string | null,
  expected: string,
): boolean {
  if (!supplied || supplied.length > 256) return false;
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function hasBody(request: Request): boolean {
  return (
    request.body !== null ||
    request.headers.has('transfer-encoding') ||
    (request.headers.has('content-length') &&
      request.headers.get('content-length') !== '0')
  );
}

export async function agentRunBoundary(
  request: Request,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.search || url.hash || url.username || url.password)
      return failure('VALIDATION_ERROR');
    const collection = url.pathname === '/api/agent/runs';
    const item = /^\/api\/agent\/runs\/([^/]+)$/.exec(url.pathname);
    if (!collection && !item) return failure('VALIDATION_ERROR', 404);
    if (
      (collection && request.method !== 'POST') ||
      (item && request.method !== 'GET')
    )
      return failure('VALIDATION_ERROR', 405);

    let runId: string | undefined;
    if (item) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(item[1]!);
      } catch {
        return failure('VALIDATION_ERROR');
      }
      const params = AgentRunParamsSchema.safeParse({ runId: decoded });
      if (!params.success || hasBody(request))
        return failure('VALIDATION_ERROR');
      runId = params.data.runId;
    }

    let task: ReturnType<typeof CreateAgentRunRequestSchema.parse> | undefined;
    if (collection) {
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
        input = await readBoundedJson(request, REGISTRY_REQUEST_BYTES);
      } catch (error) {
        return failure(
          'VALIDATION_ERROR',
          error instanceof BoundedJsonError && error.reason === 'too-large'
            ? 413
            : 400,
        );
      }
      const parsed = CreateAgentRunRequestSchema.safeParse(input);
      if (!parsed.success) return failure('VALIDATION_ERROR');
      task = parsed.data;
    }

    const configuration = agentApiConfiguration();
    if (
      !matchesAccessToken(
        request.headers.get('x-proofserve-demo-access'),
        configuration.webAccessToken,
      )
    )
      return failure('UNAUTHORIZED');
    if (
      runId &&
      !verifyAgentRunSession(
        agentRunSessionFromCookie(request),
        runId,
        configuration.capabilitySecret,
        now(),
      )
    )
      return failure('UNAUTHORIZED');
    const upstreamPath = runId
      ? `/api/agent/runs/${encodeURIComponent(runId)}`
      : '/api/agent/runs';
    const upstream = await fetcher(`${configuration.origin}${upstreamPath}`, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${configuration.token}`,
        ...(task ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(task ? { body: JSON.stringify(task) } : {}),
      cache: 'no-store',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
    });
    const data = await readBoundedJson(upstream, REGISTRY_RESPONSE_BYTES);
    if (
      upstream.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    )
      return failure();
    if (!upstream.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(data);
      if (
        !parsed.success ||
        errors[parsed.data.error.code]?.[0] !== upstream.status
      )
        return failure();
      return failure(parsed.data.error.code);
    }

    const parsed = task
      ? CreateAgentRunResponseSchema.safeParse(data)
      : GetAgentRunResponseSchema.safeParse(data);
    if (
      !parsed.success ||
      !isSemanticallyValidRun(parsed.data) ||
      (task &&
        (upstream.status !== 202 ||
          parsed.data.status !== 'CREATED' ||
          parsed.data.events.length !== 1 ||
          !taskMatches(task, parsed.data.task))) ||
      (runId && (upstream.status !== 200 || parsed.data.id !== runId))
    )
      return failure();
    return task
      ? jsonWithRunSession(
          parsed.data,
          parsed.data.id,
          configuration.capabilitySecret,
          url,
          now(),
        )
      : json(parsed.data, 200);
  } catch {
    return failure();
  }
}
