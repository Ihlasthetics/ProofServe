import { createApiApp } from './app.js';
import {
  createWorldVerificationClient,
  readWorldConfiguration,
} from './world.js';

async function start() {
  const portText = process.env.PORT ?? '3001';
  if (!/^[1-9][0-9]{0,4}$/.test(portText)) {
    throw new Error('Invalid PORT configuration');
  }
  // Decimal port parsing is unrelated to atomic amounts; no coercive parser.
  let port = 0;
  for (const digit of portText) port = port * 10 + digit.charCodeAt(0) - 48;
  if (port > 65535) throw new Error('Invalid PORT configuration');
  const endpoint = process.env.TRIAGE_SERVICE_ENDPOINT;
  const worldVerification = createWorldVerificationClient(
    readWorldConfiguration(process.env),
  );
  const app = createApiApp({
    resolveEndpoint: (capability) =>
      capability === 'SUPPORT_TICKET_TRIAGE' ? endpoint : undefined,
    worldVerification,
  });
  await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
}

start().catch(() => {
  process.stderr.write(
    'Registry API failed to start. Check server configuration.\n',
  );
  process.exitCode = 1;
});
