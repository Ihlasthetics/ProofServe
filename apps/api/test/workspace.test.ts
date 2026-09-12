import { Server, Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@proofserve/agent');
  vi.doUnmock('../src/agent-runs.js');
  vi.doUnmock('../src/app.js');
  vi.doUnmock('../src/postgres-agent-run-repository.js');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('loads the api entry point without runtime configuration', async () => {
  vi.resetModules();
  vi.stubEnv('PORT', undefined);
  vi.stubEnv('HOST', undefined);
  vi.stubEnv('TRIAGE_SERVICE_ENDPOINT', undefined);
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubEnv('AGENT_REGISTRY_BASE_URL', undefined);
  vi.stubEnv('AGENT_RUN_API_TOKEN', undefined);
  const sigtermListeners = process.listenerCount('SIGTERM');
  const sigintListeners = process.listenerCount('SIGINT');
  const listener = vi
    .spyOn(Server.prototype, 'listen')
    .mockImplementation(() => {
      throw new Error('Import must not listen');
    });
  const fetch = vi.fn(() => {
    throw new Error('Import must not fetch');
  });
  vi.stubGlobal('fetch', fetch);
  const connect = vi.spyOn(Socket.prototype, 'connect');
  const entry = await import('../src/index.js');
  const server = await import('../src/server.js');
  expect(entry.createApiApp).toBeTypeOf('function');
  expect(server.startServer).toBeTypeOf('function');
  expect(listener).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
});

it('fails closed on missing production database configuration without connecting', async () => {
  const connect = vi.spyOn(Socket.prototype, 'connect');
  const { startServer } = await import('../src/server.js');
  await expect(
    startServer({
      PORT: '3001',
      TRIAGE_SERVICE_ENDPOINT: 'https://triage.example.test/v1/triage',
      AGENT_REGISTRY_BASE_URL: 'https://api.example.test',
      AGENT_RUN_API_TOKEN: 'test-only-agent-run-token-00000000000000000000',
    }),
  ).rejects.toThrow('Missing server configuration');
  expect(connect).not.toHaveBeenCalled();
});

it.each([
  {
    name: 'short API token',
    override: { AGENT_RUN_API_TOKEN: 'too-short' },
  },
  {
    name: 'credentialed registry URL',
    override: {
      AGENT_REGISTRY_BASE_URL: 'https://user:secret@api.example.test',
    },
  },
  {
    name: 'remote plain HTTP registry URL',
    override: { AGENT_REGISTRY_BASE_URL: 'http://api.example.test' },
  },
  {
    name: 'credentialed service URL',
    override: {
      TRIAGE_SERVICE_ENDPOINT:
        'https://user:secret@triage.example.test/v1/triage',
    },
  },
  {
    name: 'unsupported service protocol',
    override: {
      TRIAGE_SERVICE_ENDPOINT: 'ftp://triage.example.test/v1/triage',
    },
  },
  {
    name: 'missing payer configuration',
    override: { HEDERA_PAYER_PRIVATE_KEY: undefined },
  },
])(
  'fails closed before listening or connecting for $name',
  async ({ override }) => {
    vi.resetModules();
    const listener = vi.spyOn(Server.prototype, 'listen');
    const connect = vi.spyOn(Socket.prototype, 'connect');
    const { startServer } = await import('../src/server.js');
    await expect(
      startServer({
        PORT: '3001',
        DATABASE_URL:
          'postgresql://proofserve:fictional@127.0.0.1:5432/proofserve',
        TRIAGE_SERVICE_ENDPOINT: 'https://triage.example.test/v1/triage',
        AGENT_REGISTRY_BASE_URL: 'https://api.example.test',
        AGENT_RUN_API_TOKEN: 'test-only-agent-run-token-00000000000000000000',
        HEDERA_PAYER_ACCOUNT_ID: '0.0.654321',
        HEDERA_PAYER_PRIVATE_KEY: 'not-used-by-this-test',
        ...override,
      }),
    ).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  },
);

it('preserves canonical local HTTP buyer URLs for development', async () => {
  const { validateBuyerConfiguration } = await import('@proofserve/agent');
  expect(
    validateBuyerConfiguration({
      registryBaseUrl: 'http://127.0.0.1:3001/',
      allowedServiceEndpoint: 'http://localhost:3002/v1/triage',
    }),
  ).toEqual({
    registryBaseUrl: 'http://127.0.0.1:3001/',
    allowedServiceEndpoint: 'http://localhost:3002/v1/triage',
  });
});

it('closes Fastify and PostgreSQL through import-local signal handlers', async () => {
  vi.resetModules();
  let closeHook: (() => Promise<void>) | undefined;
  const repository = {
    assertReady: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const close = vi.fn(async () => closeHook?.());
  const listen = vi.fn(async () => 'http://127.0.0.1:3001');
  const reconcile = vi.fn(async () => undefined);
  vi.doMock('@proofserve/agent', () => ({
    createProductionBuyerSignerFactory: vi.fn(async () => () => ({
      accountId: '0.0.654321',
      createPartiallySignedTransferTransaction: vi.fn(),
    })),
    validateBuyerConfiguration: vi.fn((configuration) => configuration),
  }));
  vi.doMock('../src/postgres-agent-run-repository.js', () => ({
    createPostgresAgentRunRepository: vi.fn(() => repository),
  }));
  vi.doMock('../src/agent-runs.js', () => ({
    createAgentRunService: vi.fn(() => ({ reconcile })),
  }));
  vi.doMock('../src/app.js', () => ({
    validateAgentRunApiToken: vi.fn((token) => token),
    createApiApp: vi.fn(() => ({
      addHook: vi.fn((name, hook) => {
        if (name === 'onClose') closeHook = hook;
      }),
      close,
      listen,
    })),
  }));
  const sigtermBefore = new Set(process.listeners('SIGTERM'));
  const sigintBefore = new Set(process.listeners('SIGINT'));
  const { startServer } = await import('../src/server.js');
  await startServer({
    PORT: '3001',
    DATABASE_URL: 'postgresql://proofserve:fictional@127.0.0.1:5432/proofserve',
    TRIAGE_SERVICE_ENDPOINT: 'https://triage.example.test/v1/triage',
    AGENT_REGISTRY_BASE_URL: 'https://api.example.test',
    AGENT_RUN_API_TOKEN: 'test-only-agent-run-token-00000000000000000000',
    HEDERA_PAYER_ACCOUNT_ID: '0.0.654321',
    HEDERA_PAYER_PRIVATE_KEY: 'fictional',
  });
  const shutdown = process
    .listeners('SIGTERM')
    .find((listener) => !sigtermBefore.has(listener));
  expect(shutdown).toBeDefined();
  shutdown?.('SIGTERM');
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(repository.close).toHaveBeenCalledOnce();
  expect(process.listeners('SIGTERM')).toEqual([...sigtermBefore]);
  expect(process.listeners('SIGINT')).toEqual([...sigintBefore]);
});
