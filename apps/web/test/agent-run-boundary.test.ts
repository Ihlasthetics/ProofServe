import { createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentRunSchema, ApiErrorResponseSchema } from '@proofserve/shared';
import { agentRunBoundary } from '../src/server/agent-run-boundary';
import { AGENT_RUN_SESSION_TTL_MS } from '../src/server/agent-run-session-cookie';
import * as collectionRoute from '../src/app/api/agent/runs/route';
import * as itemRoute from '../src/app/api/agent/runs/[runId]/route';
import { agentRun, agentTask } from './agent-run-fixtures';

const token = 'test-agent-run-token-000000000000000000000';
const access = 'test-demo-access-code';
const capabilitySecret = 'test-capability-secret-00000000000000000000';
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
function browser(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  runSession?: string,
  origin = 'http://web.example.test',
) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: 'browser-secret',
      Cookie: `browser-cookie=present${runSession ? `; proofserve_agent_run=${runSession}` : ''}`,
      'X-Forwarded-Host': 'evil.example.test',
      'X-ProofServe-Demo-Access': access,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function controlled(response: Response, hasSessionCookie = false) {
  const expectedHeaders = [
    'cache-control',
    'content-type',
    ...(hasSessionCookie ? ['set-cookie'] : []),
  ].sort();
  expect([...response.headers.keys()].sort()).toEqual(expectedHeaders);
  expect(response.headers.get('cache-control')).toBe('no-store');
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function configure() {
  vi.stubEnv('AGENT_RUN_API_TOKEN', token);
  vi.stubEnv('AGENT_RUN_WEB_ACCESS_TOKEN', access);
  vi.stubEnv('AGENT_RUN_CAPABILITY_SECRET', capabilitySecret);
}

async function sessionForRun(
  now = Date.now(),
  origin = 'http://web.example.test',
) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(json(agentRun(), 202));
  const response = await agentRunBoundary(
    browser('/api/agent/runs', 'POST', agentTask, undefined, origin),
    fetcher,
    () => now,
  );
  expect(response.status).toBe(202);
  const setCookie = response.headers.get('set-cookie');
  const session = /proofserve_agent_run=([^;]+)/.exec(setCookie ?? '')?.[1];
  expect(session).toBeTruthy();
  return { session: session!, setCookie: setCookie!, fetcher, now };
}

it('creates a validated run with only server-controlled credentials', async () => {
  vi.stubEnv('AGENT_RUN_API_ORIGIN', 'https://agent.example.test');
  configure();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      json(agentRun(), 202, { Authorization: 'upstream-secret' }),
    );
  const response = await agentRunBoundary(
    browser('/api/agent/runs', 'POST', agentTask),
    fetcher,
  );
  expect(response.status).toBe(202);
  const responseBody = await response.text();
  expect(JSON.parse(responseBody)).toEqual(agentRun());
  controlled(response, true);
  const setCookie = response.headers.get('set-cookie')!;
  expect(setCookie).toContain('proofserve_agent_run=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toMatch(/SameSite=Strict/i);
  expect(setCookie).toMatch(/Path=\/api\/agent\/runs\/(?:;|$)/);
  expect(setCookie).toContain(`Max-Age=${AGENT_RUN_SESSION_TTL_MS / 1000}`);
  expect(setCookie).toContain('Secure');
  expect(response.headers.has('x-proofserve-run-capability')).toBe(false);
  expect(responseBody).not.toContain(setCookie);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://agent.example.test/api/agent/runs');
  expect(init).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    redirect: 'manual',
    credentials: 'omit',
  });
  expect(init?.headers).toEqual({
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });
  expect(JSON.parse(String(init?.body))).toEqual(agentTask);
  expect(
    JSON.stringify(
      await agentRunBoundary(
        browser('/api/agent/runs', 'POST', agentTask),
        vi.fn<typeof fetch>().mockResolvedValue(json(agentRun(), 202)),
      ).then((value) => value.json()),
    ),
  ).not.toContain(token);
});

it('polls only a validated path run ID and binds the response ID', async () => {
  configure();
  const { session } = await sessionForRun();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(json(agentRun())));
  const response = await agentRunBoundary(
    browser('/api/agent/runs/run_live_123', 'GET', undefined, session),
    fetcher,
  );
  expect(response.status).toBe(200);
  expect(fetcher).toHaveBeenCalledWith(
    'http://127.0.0.1:3001/api/agent/runs/run_live_123',
    expect.objectContaining({ method: 'GET' }),
  );
  expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  });
  controlled(response);
  expect(
    (
      await agentRunBoundary(
        browser('/api/agent/runs/run_live_123', 'GET', undefined, session),
        fetcher,
      )
    ).status,
  ).toBe(200);
  fetcher.mockResolvedValueOnce(json({ ...agentRun(), id: 'different_run' }));
  expect(
    (
      await agentRunBoundary(
        browser('/api/agent/runs/run_live_123', 'GET', undefined, session),
        fetcher,
      )
    ).status,
  ).toBe(500);
});

it('omits Secure only for permitted loopback HTTP development', async () => {
  configure();
  const { setCookie } = await sessionForRun(
    Date.now(),
    'http://127.0.0.1:3000',
  );
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).not.toContain('Secure');
});

it('rotates one browser session to the latest created run', async () => {
  configure();
  const now = Date.now();
  const first = await sessionForRun(now);
  const secondRun = { ...agentRun(), id: 'run_second_456' };
  const secondResponse = await agentRunBoundary(
    browser('/api/agent/runs', 'POST', agentTask),
    vi.fn<typeof fetch>().mockResolvedValue(json(secondRun, 202)),
    () => now + 1,
  );
  const secondCookie = secondResponse.headers.get('set-cookie')!;
  const secondSession = /proofserve_agent_run=([^;]+)/.exec(secondCookie)![1]!;
  expect(secondSession).not.toBe(first.session);
  expect(secondCookie).toMatch(/Path=\/api\/agent\/runs\/(?:;|$)/);

  const rejectedLookup = vi.fn<typeof fetch>();
  expect(
    (
      await agentRunBoundary(
        browser(
          '/api/agent/runs/run_live_123',
          'GET',
          undefined,
          secondSession,
        ),
        rejectedLookup,
        () => now + 1,
      )
    ).status,
  ).toBe(401);
  expect(rejectedLookup).not.toHaveBeenCalled();

  const acceptedLookup = vi
    .fn<typeof fetch>()
    .mockResolvedValue(json(secondRun));
  expect(
    (
      await agentRunBoundary(
        browser(
          '/api/agent/runs/run_second_456',
          'GET',
          undefined,
          secondSession,
        ),
        acceptedLookup,
        () => now + 1,
      )
    ).status,
  ).toBe(200);
});

it('rejects cross-run, missing, altered, and expired sessions before lookup', async () => {
  configure();
  const { session, now } = await sessionForRun();
  const altered = `${session.slice(0, -1)}${session.endsWith('a') ? 'b' : 'a'}`;
  const attempts = [
    {
      path: '/api/agent/runs/run_other_456',
      session,
      observedAt: now,
    },
    {
      path: '/api/agent/runs/run_live_123',
      session: undefined,
      observedAt: now,
    },
    {
      path: '/api/agent/runs/run_live_123',
      session: altered,
      observedAt: now,
    },
    {
      path: '/api/agent/runs/run_live_123',
      session: `${session}; proofserve_agent_run=${session}`,
      observedAt: now,
    },
    {
      path: '/api/agent/runs/run_live_123',
      session,
      observedAt: now + AGENT_RUN_SESSION_TTL_MS,
    },
  ];
  for (const attempt of attempts) {
    const fetcher = vi.fn<typeof fetch>();
    const response = await agentRunBoundary(
      browser(attempt.path, 'GET', undefined, attempt.session),
      fetcher,
      () => attempt.observedAt,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Agent-run authorization is unavailable.',
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    controlled(response);
  }
});

it('rejects a valid signature over a noncanonical payload before lookup', async () => {
  configure();
  const now = 1_788_940_800_000;
  const payload = Buffer.from(
    `{"runId":"run_live_123","version":1,"expiresAt":${now + AGENT_RUN_SESSION_TTL_MS}}`,
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', capabilitySecret)
    .update(payload, 'utf8')
    .digest('base64url');
  const fetcher = vi.fn<typeof fetch>();
  const response = await agentRunBoundary(
    browser(
      '/api/agent/runs/run_live_123',
      'GET',
      undefined,
      `${payload}.${signature}`,
    ),
    fetcher,
    () => now,
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Agent-run authorization is unavailable.',
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  controlled(response);
});

it.each([
  ['/api/agent/runs', 'GET'],
  ['/api/agent/runs/run_live_123', 'POST'],
  ['/api/agent/runs/run_live_123', 'DELETE'],
  ['/api/agent/runs/run_live_123/extra', 'GET'],
  ['/api/agent/runs/bad%2Fid', 'GET'],
  ['/api/agent/runs/run_live_123?origin=https://evil.test', 'GET'],
])(
  'rejects method, path, ID, or destination injection for %s %s',
  async (path, method) => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await agentRunBoundary(
      browser(path, method as 'GET' | 'POST'),
      fetcher,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fetcher).not.toHaveBeenCalled();
    controlled(response);
  },
);

it.each([
  {},
  { ...agentTask, selectedServiceId: 'browser-choice' },
  { ...agentTask, budget: { ...agentTask.budget, maxAmountAtomic: '1.5' } },
  { ...agentTask, input: { ticket: '' } },
])('rejects invalid creation body before forwarding', async (body) => {
  const fetcher = vi.fn<typeof fetch>();
  const response = await agentRunBoundary(
    browser('/api/agent/runs', 'POST', body),
    fetcher,
  );
  expect(response.status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  json({ secret: 'stack' }, 202),
  json(
    { ...agentRun(), task: { ...agentTask, input: { ticket: 'changed' } } },
    202,
  ),
  json({ ...agentRun(), status: 'DISCOVERING' }, 202),
  json({ ...agentRun(), selectedServiceId: 'premature-service' }, 202),
  json(agentRun(), 200),
  new Response('<html>secret-stack</html>', { status: 500 }),
])(
  'sanitizes malformed, unbound, or unexpected creation response %#',
  async (upstream) => {
    configure();
    const response = await agentRunBoundary(
      browser('/api/agent/runs', 'POST', agentTask),
      vi.fn<typeof fetch>().mockResolvedValue(upstream),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/secret|stack|changed|html/);
    controlled(response);
  },
);

it('rejects an otherwise valid receipt with a noncanonical HashScan URL', async () => {
  configure();
  const { session } = await sessionForRun();
  const completed = agentRun('COMPLETED');
  const unsafe = {
    ...completed,
    paymentReceipt: {
      ...completed.paymentReceipt!,
      transactionUrl: 'https://evil.example.test/transaction',
    },
  };
  const response = await agentRunBoundary(
    browser('/api/agent/runs/run_live_123', 'GET', undefined, session),
    vi.fn<typeof fetch>().mockResolvedValue(json(unsafe)),
  );
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('evil.example.test');
});

it.each([
  '2026-09-12T09:59:59.999Z',
  '2026-09-12T10:00:05.001Z',
  '2026-09-12T10:00:08.000Z',
  'not-a-timestamp',
])(
  'rejects an invalid receipt settlement time %s at the boundary',
  async (settledAt) => {
    configure();
    const { session } = await sessionForRun();
    const completed = agentRun('COMPLETED');
    const invalid = {
      ...completed,
      paymentReceipt: { ...completed.paymentReceipt!, settledAt },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(invalid));
    const response = await agentRunBoundary(
      browser('/api/agent/runs/run_live_123', 'GET', undefined, session),
      fetcher,
    );
    expect(response.status).toBe(500);
    expect(fetcher).toHaveBeenCalledOnce();
    controlled(response);
  },
);

it('accepts reconciliation settlement before the PAID persistence event', async () => {
  configure();
  const { session } = await sessionForRun();
  const completed = agentRun('COMPLETED');
  const reconciled = AgentRunSchema.parse({
    ...completed,
    paymentReceipt: {
      ...completed.paymentReceipt!,
      settledAt: '2026-09-12T10:00:04.500Z',
    },
  });
  const response = await agentRunBoundary(
    browser('/api/agent/runs/run_live_123', 'GET', undefined, session),
    vi.fn<typeof fetch>().mockResolvedValue(json(reconciled)),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(reconciled);
});

it('returns sanitized no-store errors for configuration, transport, and upstream failures', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const mode of ['configuration', 'transport', 'upstream'] as const) {
    configure();
    vi.stubEnv(
      'AGENT_RUN_API_TOKEN',
      mode === 'configuration' ? 'short' : token,
    );
    fetcher.mockReset();
    if (mode === 'transport') fetcher.mockRejectedValue(new Error('secret'));
    if (mode === 'upstream')
      fetcher.mockResolvedValue(
        json(
          { error: { code: 'INTERNAL_ERROR', message: 'secret stack' } },
          500,
        ),
      );
    const response = await agentRunBoundary(
      browser('/api/agent/runs', 'POST', agentTask),
      fetcher,
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toMatch(/secret|stack|short/);
    expect(ApiErrorResponseSchema.parse(JSON.parse(text)).error.code).toBe(
      'INTERNAL_ERROR',
    );
    controlled(response);
  }
});

it('fails closed without the separate Web authorization and never calls upstream', async () => {
  configure();
  const fetcher = vi.fn<typeof fetch>();
  const request = browser('/api/agent/runs', 'POST', agentTask);
  request.headers.delete('x-proofserve-demo-access');
  const response = await agentRunBoundary(request, fetcher);
  expect(response.status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain(token);
  controlled(response);
});

it('refuses to send the backend bearer token to a non-loopback HTTP origin', async () => {
  configure();
  vi.stubEnv('AGENT_RUN_API_ORIGIN', 'http://agent.example.test');
  const fetcher = vi.fn<typeof fetch>();
  const response = await agentRunBoundary(
    browser('/api/agent/runs', 'POST', agentTask),
    fetcher,
  );
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(fetcher).not.toHaveBeenCalled();
});

it('bounds the streamed upstream response before schema validation', async () => {
  configure();
  const response = await agentRunBoundary(
    browser('/api/agent/runs', 'POST', agentTask),
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        status: 202,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(1024 * 1024 + 1),
        },
      }),
    ),
  );
  expect(response.status).toBe(500);
  controlled(response);
});

it('rejects an oversized upstream body whose decoded value is schema-valid', async () => {
  configure();
  const oversized = {
    ...agentRun(),
    events: Array.from({ length: 35_000 }, () => agentRun().events[0]),
  };
  expect(AgentRunSchema.safeParse(oversized).success).toBe(true);
  const serialized = JSON.stringify(oversized);
  expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(
    1024 * 1024,
  );
  const response = await agentRunBoundary(
    browser('/api/agent/runs', 'POST', agentTask),
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(serialized, {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  expect(response.status).toBe(500);
  controlled(response);
});

it('exports explicit handlers so framework fallbacks cannot broaden the allowlist', () => {
  for (const route of [collectionRoute, itemRoute]) {
    for (const method of [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ])
      expect(route[method as keyof typeof route]).toBeTypeOf('function');
  }
});
