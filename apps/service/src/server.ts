import { createProductionServiceApp } from './app.js';
import { loadServiceConfig } from './config.js';

async function start(): Promise<void> {
  const config = loadServiceConfig(process.env);
  const app = createProductionServiceApp(config);
  await app.listen({ port: config.port, host: config.host });
}

start().catch(() => {
  process.stderr.write(
    'Protected triage service failed to start. Check server configuration.\n',
  );
  process.exitCode = 1;
});
