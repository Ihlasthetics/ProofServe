import { pathToFileURL } from 'node:url';
import {
  createProductionBuyerSignerFactory,
  validateBuyerConfiguration,
} from '@proofserve/agent';
import { createApiApp, validateAgentRunApiToken } from './app.js';
import { createAgentRunService } from './agent-runs.js';
import { createPostgresAgentRunRepository } from './postgres-agent-run-repository.js';
import { createHederaSettlementReconciler } from './hedera-settlement-reconciler.js';
import {
  createWorldVerificationClient,
  readWorldConfiguration,
} from './world.js';

function required(value: string | undefined): string {
  if (!value) throw new Error('Missing server configuration');
  return value;
}

export async function startServer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const portText = environment.PORT ?? '3001';
  if (!/^[1-9][0-9]{0,4}$/.test(portText)) {
    throw new Error('Invalid PORT configuration');
  }
  // Decimal port parsing is unrelated to atomic amounts; no coercive parser.
  let port = 0;
  for (const digit of portText) port = port * 10 + digit.charCodeAt(0) - 48;
  if (port > 65535) throw new Error('Invalid PORT configuration');
  const endpoint = required(environment.TRIAGE_SERVICE_ENDPOINT);
  const registryBaseUrl = required(environment.AGENT_REGISTRY_BASE_URL);
  const agentRunApiToken = validateAgentRunApiToken(
    environment.AGENT_RUN_API_TOKEN,
  );
  const databaseUrl = required(environment.DATABASE_URL);
  const buyerConfiguration = validateBuyerConfiguration({
    registryBaseUrl,
    allowedServiceEndpoint: endpoint,
  });
  const worldVerification = createWorldVerificationClient(
    readWorldConfiguration(environment),
  );
  const signerFactory = await createProductionBuyerSignerFactory({
    accountId: environment.HEDERA_PAYER_ACCOUNT_ID,
    privateKey: environment.HEDERA_PAYER_PRIVATE_KEY,
  });
  const repository = createPostgresAgentRunRepository(databaseUrl);
  let agentRuns: ReturnType<typeof createAgentRunService>;
  try {
    agentRuns = createAgentRunService({
      repository,
      buyer: { ...buyerConfiguration, signerFactory },
      settlementReconciler: createHederaSettlementReconciler(),
    });
    await repository.assertReady();
  } catch {
    try {
      await repository.close();
    } catch {
      // Startup remains failed without exposing database diagnostics.
    }
    throw new Error('Agent run persistence unavailable');
  }
  const app = createApiApp({
    resolveEndpoint: (capability) =>
      capability === 'SUPPORT_TICKET_TRIAGE' ? endpoint : undefined,
    agentRuns,
    agentRunApiToken,
    worldVerification,
  });
  const reconciliation: {
    timer: ReturnType<typeof setInterval> | undefined;
  } = { timer: undefined };
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  app.addHook('onClose', async () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    clearInterval(reconciliation.timer);
    await repository.close();
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await app.listen({ port, host: environment.HOST ?? '0.0.0.0' });
    await agentRuns.reconcile();
  } catch {
    await app.close();
    throw new Error('Registry API startup failed');
  }
  reconciliation.timer = setInterval(() => {
    void agentRuns.reconcile().catch(() => {
      // A later interval retries; raw database diagnostics are never logged.
    });
  }, 10_000);
  reconciliation.timer.unref();
  return app;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href)
  void startServer().catch(() => {
    process.stderr.write(
      'Registry API failed to start. Check server configuration.\n',
    );
    process.exitCode = 1;
  });
