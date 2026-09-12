import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AgentRunSchema,
  ApiErrorCodeSchema,
  type AgentRun,
  type AgentRunStatus,
} from '@proofserve/shared';
import {
  AgentRunView,
  scheduleAgentRunPoll,
} from '../src/components/agent-run-demo';
import { createAgentRunClient } from '../src/lib/agent-run-client';
import { createAgentRunSession } from '../src/lib/agent-run-session';
import {
  isSemanticallyValidRun,
  isValidRunAdvance,
  minimumFailureStage,
  safeHashScanTransactionUrl,
} from '../src/lib/agent-run-validation';
import { agentRunBoundary } from '../src/server/agent-run-boundary';
import {
  AGENT_RUN_SESSION_TTL_MS,
  issueAgentRunSession,
} from '../src/server/agent-run-session-cookie';
import { agentRun, agentTask, failedAgentRunAfter } from './agent-run-fixtures';

const access = 'test-demo-access-code';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function setup() {
  const fetcher = vi.fn<typeof fetch>();
  const session = createAgentRunSession(createAgentRunClient(fetcher));
  const view = () =>
    renderToStaticMarkup(
      <AgentRunView state={session.getSnapshot()} session={session} />,
    );
  return { fetcher, session, view };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function pricedRun(maxAmountAtomic: string, amountAtomic: string): AgentRun {
  const completed = agentRun('COMPLETED');
  const paymentRequirements = {
    ...completed.paymentRequirements!,
    amountAtomic,
  };
  return AgentRunSchema.parse({
    ...completed,
    task: {
      ...completed.task,
      budget: { ...completed.task.budget, maxAmountAtomic },
    },
    paymentRequirements,
    paymentReceipt: {
      ...completed.paymentReceipt!,
      paymentRequirements,
    },
  });
}

type RealRunFailureCode = keyof typeof minimumFailureStage;
type PreFailureStatus = Exclude<AgentRunStatus, 'COMPLETED' | 'FAILED'>;

function failureWithCode(
  lastStatus: PreFailureStatus,
  code: RealRunFailureCode,
): AgentRun {
  const failed = failedAgentRunAfter(lastStatus);
  return AgentRunSchema.parse({
    ...failed,
    error: { code, message: 'backend message is not rendered' },
  });
}

function failureWithoutCreated(code: RealRunFailureCode): AgentRun {
  const failed = failureWithCode('CREATED', code);
  return AgentRunSchema.parse({
    ...failed,
    events: [{ status: 'FAILED', occurredAt: failed.updatedAt }],
  });
}

it('creates one production-path run without sending credentials from the browser', async () => {
  const { fetcher, session, view } = setup();
  fetcher.mockResolvedValue(json(agentRun(), 202));
  await session.start(agentTask, access);
  expect(fetcher).toHaveBeenCalledOnce();
  const [path, init] = fetcher.mock.calls[0]!;
  expect(path).toBe('/api/agent/runs');
  expect(init?.method).toBe('POST');
  expect(init?.credentials).toBe('same-origin');
  expect(init?.headers).toEqual({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-ProofServe-Demo-Access': access,
  });
  expect(JSON.stringify(init)).not.toMatch(/authorization|bearer|api.token/i);
  expect(JSON.parse(String(init?.body))).toEqual(agentTask);
  expect(session.getSnapshot().run).toEqual(agentRun());
  expect(view()).toContain('My card was charged twice.');
  expect(view()).toContain('0.02 HBAR');
  expect(view()).not.toContain('Selected price</span><strong>0.01 HBAR');
});

it('prevents double submission synchronously while creation is pending', async () => {
  const { fetcher, session, view } = setup();
  let resolve!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const first = session.start(agentTask, access);
  await session.start(agentTask, access);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(view()).toContain('Creating one agent run. Do not resubmit.');
  expect(view()).toContain('<fieldset disabled="">');
  resolve(json(agentRun(), 202));
  await first;
  await session.start(agentTask, access);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('blocks retry after uncertain creation but allows retry after a certain rejection', async () => {
  const uncertain = setup();
  uncertain.fetcher.mockRejectedValue(new Error('secret network'));
  await uncertain.session.start(agentTask, access);
  expect(uncertain.session.getSnapshot().creationUncertain).toBe(true);
  expect(uncertain.view()).toContain('outcome is uncertain');
  await uncertain.session.start(agentTask, access);
  expect(uncertain.fetcher).toHaveBeenCalledOnce();

  const rejected = setup();
  rejected.fetcher
    .mockResolvedValueOnce(
      json(
        { error: { code: 'VALIDATION_ERROR', message: 'secret backend' } },
        400,
      ),
    )
    .mockResolvedValueOnce(json(agentRun(), 202));
  await rejected.session.start(agentTask, access);
  expect(rejected.session.getSnapshot().creationUncertain).toBe(false);
  expect(rejected.view()).not.toContain('secret backend');
  await rejected.session.start(agentTask, access);
  expect(rejected.fetcher).toHaveBeenCalledTimes(2);
});

it('polls the server-issued ID, applies authoritative advances, and stops terminal polling', async () => {
  const { fetcher, session, view } = setup();
  fetcher
    .mockResolvedValueOnce(json(agentRun(), 202))
    .mockResolvedValueOnce(json(agentRun('PAYMENT_REQUIRED')))
    .mockResolvedValueOnce(json(agentRun('COMPLETED')));
  await session.start(agentTask, access);
  expect(session.canPoll()).toBe(true);
  await Promise.all([session.refresh(), session.refresh()]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/agent/runs/run_live_123',
    expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
    }),
  );
  expect(view()).toContain('HTTP 402 · Payment required');
  expect(view()).toContain('0.01 HBAR');
  await session.refresh();
  expect(session.getSnapshot().run?.status).toBe('COMPLETED');
  expect(session.canPoll()).toBe(false);
  await session.refresh();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each(['expired cookie', 'cross-tab cookie rotation'])(
  'stops all automatic and manual polling after one unauthorized GET: %s',
  async (sessionFailure) => {
    vi.useFakeTimers();
    const { fetcher, session, view } = setup();
    const now = 1_788_940_800_000;
    const secret = 'test-capability-secret-00000000000000000000';
    vi.stubEnv(
      'AGENT_RUN_API_TOKEN',
      'test-agent-run-token-000000000000000000000',
    );
    vi.stubEnv('AGENT_RUN_WEB_ACCESS_TOKEN', access);
    vi.stubEnv('AGENT_RUN_CAPABILITY_SECRET', secret);
    const cookie = issueAgentRunSession(
      sessionFailure === 'expired cookie' ? 'run_live_123' : 'run_other_456',
      secret,
      sessionFailure === 'expired cookie'
        ? now - AGENT_RUN_SESSION_TTL_MS
        : now,
    );
    const upstreamLookup = vi.fn<typeof fetch>();
    fetcher
      .mockResolvedValueOnce(json(agentRun(), 202))
      .mockImplementationOnce((_url, init) =>
        agentRunBoundary(
          new Request('http://web.example.test/api/agent/runs/run_live_123', {
            method: 'GET',
            headers: {
              ...(init?.headers as Record<string, string>),
              Cookie: `proofserve_agent_run=${cookie}`,
            },
          }),
          upstreamLookup,
          () => now,
        ),
      );
    await session.start(agentTask, access);
    expect(session.pollDelayMs()).toBe(1500);

    scheduleAgentRunPoll(
      session,
      (callback, delayMs) => {
        setTimeout(callback, delayMs);
        return 1;
      },
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(1500);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(upstreamLookup).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
    expect(session.getSnapshot().run).toEqual(agentRun());
    expect(session.getSnapshot().pollingPermanentlyStopped).toBe(true);
    expect(session.canPoll()).toBe(false);
    expect(view()).toContain(
      'This local run view is no longer authorized and automatic polling has stopped.',
    );
    expect(view()).toContain('reconcile this existing run');
    expect(view()).not.toContain('Retry status refresh');

    expect(
      scheduleAgentRunPoll(
        session,
        (callback, delayMs) => {
          setTimeout(callback, delayMs);
          return 2;
        },
        () => undefined,
      ),
    ).toBeUndefined();
    await session.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it.each([
  [403, '<html>forbidden</html>', 'text/html'],
  [
    500,
    JSON.stringify({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Agent-run authorization is unavailable.',
      },
    }),
    'application/json',
  ],
])(
  'permanently stops polling for status %i or the exact session-invalid contract',
  async (status, body, contentType) => {
    const { fetcher, session } = setup();
    fetcher.mockResolvedValueOnce(json(agentRun(), 202)).mockResolvedValueOnce(
      new Response(body, {
        status,
        headers: { 'Content-Type': contentType },
      }),
    );
    await session.start(agentTask, access);
    await session.refresh();
    expect(session.getSnapshot().pollingPermanentlyStopped).toBe(true);
    expect(session.getSnapshot().run).toEqual(agentRun());
    await session.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it('uses bounded backoff only for transient polling failures', async () => {
  const { fetcher, session } = setup();
  fetcher
    .mockResolvedValueOnce(json(agentRun(), 202))
    .mockRejectedValueOnce(new Error('temporary network failure'))
    .mockResolvedValueOnce(json({ error: { code: 'INTERNAL_ERROR' } }, 500))
    .mockResolvedValueOnce(json(agentRun('DISCOVERING')));
  await session.start(agentTask, access);
  await session.refresh();
  expect(session.pollDelayMs()).toBe(3000);
  expect(session.canPoll()).toBe(true);
  await session.refresh();
  expect(session.pollDelayMs()).toBe(6000);
  expect(session.canPoll()).toBe(true);
  await session.refresh();
  expect(session.pollDelayMs()).toBe(1500);
});

it('rejects polling regressions and preserves the last authoritative snapshot', async () => {
  const { fetcher, session, view } = setup();
  fetcher
    .mockResolvedValueOnce(json(agentRun(), 202))
    .mockResolvedValueOnce(json(agentRun('PAYMENT_REQUIRED')))
    .mockResolvedValueOnce(json(agentRun('CREATED')));
  await session.start(agentTask, access);
  await session.refresh();
  await session.refresh();
  expect(session.getSnapshot().run?.status).toBe('PAYMENT_REQUIRED');
  expect(view()).toContain('continuity checks');
});

it('renders only recorded events and all authoritative completed stages', () => {
  const session = createAgentRunSession();
  const completed = agentRun('COMPLETED');
  const markup = renderToStaticMarkup(
    <AgentRunView
      state={{
        run: completed,
        creating: false,
        refreshing: false,
        creationUncertain: false,
        pollingPermanentlyStopped: false,
        error: null,
      }}
      session={session}
    />,
  );
  for (const label of [
    'Request accepted',
    'Discovering eligible services',
    'Verified provider service selected',
    'HTTP 402 · Payment required',
    'Signing and submitting payment',
    'Settlement confirmed',
    'AI service executing',
    'Result ready',
  ])
    expect(markup).toContain(label);
  expect(markup).toContain('service_live_123');
  expect(markup).toContain('0.02 HBAR');
  expect(markup).toContain('0.01 HBAR');
  expect(markup).toContain('Possible duplicate payment');
  expect(markup).toContain('Review payment records');
  expect(markup).toContain('receipt_live_123');
  expect(markup).toContain(
    'href="https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789"',
  );
  expect(markup).toContain('rel="noopener noreferrer"');

  const createdMarkup = renderToStaticMarkup(
    <AgentRunView
      state={{
        run: agentRun(),
        creating: false,
        refreshing: false,
        creationUncertain: false,
        pollingPermanentlyStopped: false,
        error: null,
      }}
      session={session}
    />,
  );
  const createdTimeline = createdMarkup.match(
    /<ol class="run-timeline">[\s\S]*?<\/ol>/,
  )?.[0];
  expect(createdTimeline).toBeDefined();
  expect(createdTimeline).not.toMatch(
    /HTTP 402|Signing and submitting|Settlement confirmed|AI service executing|Result ready|Payment receipt/,
  );
});

it('renders failure as failure without backend diagnostics or false success', () => {
  const markup = renderToStaticMarkup(
    <AgentRunView
      state={{
        run: agentRun('FAILED'),
        creating: false,
        refreshing: false,
        creationUncertain: false,
        pollingPermanentlyStopped: false,
        error: null,
      }}
      session={createAgentRunSession()}
    />,
  );
  expect(markup).toContain('Run failed');
  expect(markup).toContain('NO ELIGIBLE SERVICE');
  expect(markup).not.toMatch(
    /backend diagnostic|Result ready|AI result|Payment receipt|Settlement confirmed/,
  );
  expect(markup).toContain('Start a new run after reviewing failure');
});

it('accepts only the exact transaction-bound testnet HashScan link', () => {
  const completed = agentRun('COMPLETED');
  expect(safeHashScanTransactionUrl(completed)).toBe(
    completed.paymentReceipt?.transactionUrl,
  );
  for (const transactionUrl of [
    'https://hashscan.io/mainnet/transaction/0.0.7162784-1788940800-123456789',
    'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789?redirect=evil',
    'https://hashscan.io.evil.test/testnet/transaction/0.0.7162784-1788940800-123456789',
    'http://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
  ]) {
    const unsafe = {
      ...completed,
      paymentReceipt: { ...completed.paymentReceipt!, transactionUrl },
    } as AgentRun;
    expect(safeHashScanTransactionUrl(unsafe)).toBeNull();
    expect(isSemanticallyValidRun(unsafe)).toBe(false);
    const markup = renderToStaticMarkup(
      <AgentRunView
        state={{
          run: unsafe,
          creating: false,
          refreshing: false,
          creationUncertain: false,
          pollingPermanentlyStopped: false,
          error: null,
        }}
        session={createAgentRunSession()}
      />,
    );
    expect(markup).not.toContain(`href="${transactionUrl}"`);
    expect(markup).toContain('failed safety validation');
  }
});

it('accepts a reconciled receipt settled within creation and PAID chronology', () => {
  const completed = agentRun('COMPLETED');
  const reconciled = AgentRunSchema.parse({
    ...completed,
    paymentReceipt: {
      ...completed.paymentReceipt!,
      settledAt: '2026-09-12T10:00:04.500Z',
    },
  });
  expect(isSemanticallyValidRun(reconciled)).toBe(true);
  const markup = renderToStaticMarkup(
    <AgentRunView
      state={{
        run: reconciled,
        creating: false,
        refreshing: false,
        creationUncertain: false,
        pollingPermanentlyStopped: false,
        error: null,
      }}
      session={createAgentRunSession()}
    />,
  );
  expect(markup).toContain('2026-09-12T10:00:04.500Z');
  expect(markup).toContain('Payment receipt');
});

it.each([
  '2026-09-12T09:59:59.999Z',
  '2026-09-12T10:00:05.001Z',
  '2026-09-12T10:00:08.000Z',
  'not-a-timestamp',
])(
  'rejects receipt settlement time %s before session mutation or rendering',
  async (settledAt) => {
    const completed = agentRun('COMPLETED');
    const invalid = {
      ...completed,
      paymentReceipt: { ...completed.paymentReceipt!, settledAt },
    };
    const { fetcher, session, view } = setup();
    fetcher
      .mockResolvedValueOnce(json(agentRun(), 202))
      .mockResolvedValueOnce(json(invalid));
    await session.start(agentTask, access);
    const retained = session.getSnapshot().run;
    await session.refresh();
    expect(session.getSnapshot().run).toEqual(retained);
    expect(view()).not.toContain('Payment receipt');

    const renderMarkup = renderToStaticMarkup(
      <AgentRunView
        state={{
          run: invalid as AgentRun,
          creating: false,
          refreshing: false,
          creationUncertain: false,
          pollingPermanentlyStopped: false,
          error: null,
        }}
        session={createAgentRunSession()}
      />,
    );
    expect(renderMarkup).toContain('failed safety validation');
    expect(renderMarkup).not.toContain('Payment receipt');
  },
);

it.each([
  [
    'invalid JSON',
    new Response('{', {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }),
  ],
  [
    'invalid content type',
    new Response(JSON.stringify(agentRun()), {
      status: 202,
      headers: { 'Content-Type': 'text/plain' },
    }),
  ],
  ['malformed successful 202', json({}, 202)],
  [
    '5xx response',
    json(
      { error: { code: 'INTERNAL_ERROR', message: 'infrastructure failure' } },
      500,
    ),
  ],
])('keeps creation locked after %s', async (_kind, response) => {
  const { fetcher, session, view } = setup();
  fetcher.mockResolvedValue(response);
  await session.start(agentTask, access);
  expect(session.getSnapshot().creationUncertain).toBe(true);
  expect(view()).toContain('do not resubmit');
  await session.start(agentTask, access);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  ['CREATED', false, false, false, false],
  ['DISCOVERING', false, false, false, false],
  ['SELECTED', true, false, false, false],
  ['PAYMENT_REQUIRED', true, true, false, false],
  ['PAYING', true, true, false, false],
  ['PAID', true, true, true, false],
  ['EXECUTING', true, true, true, true],
] as const)(
  'retains only authoritative evidence when failure follows %s',
  (lastStatus, selected, priced, receipted, executed) => {
    const run = failedAgentRunAfter(lastStatus);
    expect(isSemanticallyValidRun(run)).toBe(true);
    const markup = renderToStaticMarkup(
      <AgentRunView
        state={{
          run,
          creating: false,
          refreshing: false,
          creationUncertain: false,
          pollingPermanentlyStopped: false,
          error: null,
        }}
        session={createAgentRunSession()}
      />,
    );
    expect(markup.includes('Selected service:')).toBe(selected);
    expect(markup.includes('HTTP 402 · Payment required')).toBe(priced);
    expect(markup.includes('Payment receipt')).toBe(receipted);
    expect(markup.includes('AI service executing')).toBe(executed);
    expect(markup).toContain('Run failed');
    expect(markup).not.toContain('AI result');
  },
);

it.each([
  ['VALIDATION_ERROR', 'CREATED', null],
  ['PAYMENT_FAILED', 'CREATED', null],
  ['NO_ELIGIBLE_SERVICE', 'DISCOVERING', 'CREATED'],
  ['BUDGET_EXCEEDED', 'SELECTED', 'DISCOVERING'],
  ['SERVICE_EXECUTION_FAILED', 'PAID', 'PAYING'],
] as const)(
  'requires the real minimum stage for failure code %s',
  (code, earliest, oneStageEarly) => {
    const supported = failureWithCode(earliest, code);
    expect(isSemanticallyValidRun(supported)).toBe(true);

    const unsupported = oneStageEarly
      ? failureWithCode(oneStageEarly, code)
      : failureWithoutCreated(code);
    expect(isSemanticallyValidRun(unsupported)).toBe(false);
    const markup = renderToStaticMarkup(
      <AgentRunView
        state={{
          run: unsupported,
          creating: false,
          refreshing: false,
          creationUncertain: false,
          pollingPermanentlyStopped: false,
          error: null,
        }}
        session={createAgentRunSession()}
      />,
    );
    expect(markup).toContain('failed safety validation');
    expect(markup).not.toContain(code.replaceAll('_', ' '));
  },
);

it('rejects misleading execution and budget failures without their evidence', () => {
  const executionBeforePayment = failureWithCode(
    'PAYING',
    'SERVICE_EXECUTION_FAILED',
  );
  const budgetWithoutSelection = failureWithCode(
    'DISCOVERING',
    'BUDGET_EXCEEDED',
  );
  expect(isSemanticallyValidRun(executionBeforePayment)).toBe(false);
  expect(isSemanticallyValidRun(budgetWithoutSelection)).toBe(false);
});

it.each(
  ApiErrorCodeSchema.options.filter((code) => !(code in minimumFailureStage)),
)(
  'rejects non-agent-run error code %s even with late-stage history',
  (code) => {
    const failed = failedAgentRunAfter('EXECUTING');
    const schemaValid = AgentRunSchema.parse({
      ...failed,
      error: { code, message: 'not a real run failure' },
    });
    expect(isSemanticallyValidRun(schemaValid)).toBe(false);
  },
);

it('rejects schema-valid failed runs with evidence for stages never reached', () => {
  const earlyFailure = failedAgentRunAfter('CREATED');
  const paidFailure = failedAgentRunAfter('PAID');
  const fabricated = [
    { ...earlyFailure, selectedServiceId: 'service_live_123' },
    {
      ...earlyFailure,
      paymentRequirements: paidFailure.paymentRequirements,
    },
    {
      ...earlyFailure,
      selectedServiceId: paidFailure.selectedServiceId,
      paymentRequirements: paidFailure.paymentRequirements,
      paymentReceipt: paidFailure.paymentReceipt,
    },
  ];
  for (const value of fabricated) {
    const schemaValid = AgentRunSchema.parse(value);
    expect(isSemanticallyValidRun(schemaValid)).toBe(false);
    const markup = renderToStaticMarkup(
      <AgentRunView
        state={{
          run: schemaValid,
          creating: false,
          refreshing: false,
          creationUncertain: false,
          pollingPermanentlyStopped: false,
          error: null,
        }}
        session={createAgentRunSession()}
      />,
    );
    expect(markup).toContain('failed safety validation');
    expect(markup).not.toMatch(/Selected service:|Payment receipt|HashScan/);
  }
});

it('requires authoritative snapshot and polling timestamps to stay monotonic', () => {
  const paymentRequired = agentRun('PAYMENT_REQUIRED');
  const updatedAtMismatch = AgentRunSchema.parse({
    ...paymentRequired,
    updatedAt: '2026-09-12T10:00:04.000Z',
  });
  expect(isSemanticallyValidRun(updatedAtMismatch)).toBe(false);

  const timestampRegression = AgentRunSchema.parse({
    ...paymentRequired,
    events: paymentRequired.events.map((event, index) =>
      index === 2
        ? { ...event, occurredAt: '2026-09-12T10:00:00.500Z' }
        : event,
    ),
  });
  expect(isSemanticallyValidRun(timestampRegression)).toBe(false);

  const paying = agentRun('PAYING');
  expect(
    isValidRunAdvance(
      paying,
      AgentRunSchema.parse({
        ...paying,
        events: paying.events.slice(0, -1),
        status: 'PAYMENT_REQUIRED',
        updatedAt: paying.events.at(-2)!.occurredAt,
      }),
    ),
  ).toBe(false);
  expect(isValidRunAdvance(paying, paymentRequired)).toBe(false);
});

it.each([
  {
    field: 'task',
    previous: agentRun(),
    next: AgentRunSchema.parse({
      ...agentRun('DISCOVERING'),
      task: {
        ...agentTask,
        input: { ticket: 'A different retained task' },
      },
    }),
  },
  {
    field: 'createdAt',
    previous: agentRun(),
    next: AgentRunSchema.parse({
      ...agentRun('DISCOVERING'),
      createdAt: '2026-09-12T09:59:59.000Z',
    }),
  },
  {
    field: 'historical event',
    previous: agentRun('SELECTED'),
    next: AgentRunSchema.parse({
      ...agentRun('PAYMENT_REQUIRED'),
      events: agentRun('PAYMENT_REQUIRED').events.map((event, index) =>
        index === 1
          ? { ...event, occurredAt: '2026-09-12T10:00:01.500Z' }
          : event,
      ),
    }),
  },
  {
    field: 'selected service',
    previous: agentRun('SELECTED'),
    next: AgentRunSchema.parse({
      ...agentRun('PAYMENT_REQUIRED'),
      selectedServiceId: 'service_other_456',
    }),
  },
  {
    field: 'payment requirements',
    previous: agentRun('PAYMENT_REQUIRED'),
    next: AgentRunSchema.parse({
      ...agentRun('PAYING'),
      paymentRequirements: {
        ...agentRun('PAYING').paymentRequirements!,
        amountAtomic: '999999',
      },
    }),
  },
  {
    field: 'receipt',
    previous: agentRun('PAID'),
    next: AgentRunSchema.parse({
      ...agentRun('EXECUTING'),
      paymentReceipt: {
        ...agentRun('EXECUTING').paymentReceipt!,
        id: 'receipt_other_456',
      },
    }),
  },
])(
  'preserves state when polling mutates $field',
  async ({ previous, next }) => {
    const { fetcher, session } = setup();
    fetcher.mockResolvedValueOnce(json(agentRun(), 202));
    if (previous.status !== 'CREATED')
      fetcher.mockResolvedValueOnce(json(previous));
    fetcher.mockResolvedValueOnce(json(next));
    await session.start(agentTask, access);
    if (previous.status !== 'CREATED') await session.refresh();
    expect(session.getSnapshot().run).toEqual(previous);
    await session.refresh();
    expect(session.getSnapshot().run).toEqual(previous);
    expect(session.getSnapshot().error).toBeTruthy();
  },
);

it.each([
  ['2000000', '1000000'],
  ['2000000', '2000000'],
  ['900719925474099312345678', '900719925474099312345678'],
])('accepts canonical budget %s with price %s', (max, price) => {
  expect(isSemanticallyValidRun(pricedRun(max, price))).toBe(true);
});

it.each([
  ['1999999', '2000000'],
  ['900719925474099312345678', '900719925474099312345679'],
])('rejects a canonical over-budget price losslessly', async (max, price) => {
  const run = pricedRun(max, price);
  expect(isSemanticallyValidRun(run)).toBe(false);
  const { fetcher, session, view } = setup();
  const initial = AgentRunSchema.parse({ ...agentRun(), task: run.task });
  fetcher
    .mockResolvedValueOnce(json(initial, 202))
    .mockResolvedValueOnce(json(run));
  await session.start(run.task, access);
  await session.refresh();
  expect(session.getSnapshot().run).toEqual(initial);
  expect(view()).not.toMatch(/Payment receipt|Result ready|AI result/);
});

it.each([
  [{}, 400],
  [{ error: { code: 'RUN_NOT_FOUND', message: 'not created' } }, 404],
  [{ error: { code: 'VALIDATION_ERROR', message: 'wrong status' } }, 409],
  [{ error: { code: 'INTERNAL_ERROR', message: 'infrastructure' } }, 429],
])(
  'keeps creation locked for an ambiguous 4xx response %#',
  async (body, status) => {
    const { fetcher, session, view } = setup();
    fetcher.mockResolvedValue(json(body, status));
    await session.start(agentTask, access);
    expect(session.getSnapshot().creationUncertain).toBe(true);
    expect(view()).toContain('do not resubmit');
    await session.start(agentTask, access);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

it.each([
  ['VALIDATION_ERROR', 400],
  ['UNAUTHORIZED', 401],
  ['FORBIDDEN', 403],
] as const)(
  'unlocks only the allowlisted pre-creation rejection %s/%s',
  async (code, status) => {
    const { fetcher, session } = setup();
    fetcher
      .mockResolvedValueOnce(json({ error: { code, message: 'safe' } }, status))
      .mockResolvedValueOnce(json(agentRun(), 202));
    await session.start(agentTask, access);
    expect(session.getSnapshot().creationUncertain).toBe(false);
    await session.start(agentTask, access);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it('keeps the run layout shrinkable for the 390px mobile target', () => {
  const css = readFileSync(
    new URL('../src/app/globals.css', import.meta.url),
    'utf8',
  );
  expect(css).toContain('.run-output > section');
  expect(css).toMatch(/\.run-output > section,[\s\S]*min-width: 0/);
  expect(css).toMatch(
    /\.run-timeline li \{[\s\S]*grid-template-columns: 2\.25rem minmax\(0, 1fr\)/,
  );
  expect(css).toContain('overflow-wrap: anywhere');
  expect(css).toContain('@media (min-width: 42rem)');
});
