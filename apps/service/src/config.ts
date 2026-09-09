import {
  AtomicAmountSchema,
  EndpointUrlSchema,
  HederaAccountIdSchema,
} from '@proofserve/shared';

export interface ServiceConfig {
  host: string;
  port: number;
  publicUrl: string;
  receiverAccountId: string;
  priceTinybar: string;
  facilitatorUrl: string;
  modelProvider: 'openai';
  model: string;
  openAiApiKey: string;
}

export class ServiceConfigurationError extends Error {
  constructor() {
    super('Invalid protected service configuration.');
    this.name = 'ServiceConfigurationError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new ServiceConfigurationError();
  }
  return value;
}

function parsePort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new ServiceConfigurationError();
  }

  // Decimal port parsing is unrelated to payment amounts.
  let port = 0;
  for (const digit of value) port = port * 10 + digit.charCodeAt(0) - 48;
  if (port > 65535) throw new ServiceConfigurationError();
  return port;
}

function parseEndpoint(value: string): string {
  const result = EndpointUrlSchema.safeParse(value);
  if (!result.success) throw new ServiceConfigurationError();

  const url = new URL(result.data);
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/v1/triage'
  ) {
    throw new ServiceConfigurationError();
  }
  return url.href;
}

function parseFacilitatorUrl(value: string): string {
  const result = EndpointUrlSchema.safeParse(value);
  if (!result.success) throw new ServiceConfigurationError();

  const url = new URL(result.data);
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new ServiceConfigurationError();
  }
  return url.href.replace(/\/$/, '');
}

export function loadServiceConfig(environment: Environment): ServiceConfig {
  const host = required(environment, 'TRIAGE_SERVICE_HOST');
  if (/\s/.test(host)) throw new ServiceConfigurationError();

  const receiverAccountId = required(environment, 'X402_RECEIVER_ACCOUNT_ID');
  const priceTinybar = required(environment, 'X402_PRICE_TINYBAR');
  const modelProvider = required(environment, 'TRIAGE_MODEL_PROVIDER');
  const model = required(environment, 'TRIAGE_MODEL');

  if (
    !HederaAccountIdSchema.safeParse(receiverAccountId).success ||
    !AtomicAmountSchema.safeParse(priceTinybar).success ||
    modelProvider !== 'openai' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)
  ) {
    throw new ServiceConfigurationError();
  }

  return {
    host,
    port: parsePort(required(environment, 'TRIAGE_SERVICE_PORT')),
    publicUrl: parseEndpoint(required(environment, 'TRIAGE_SERVICE_ENDPOINT')),
    receiverAccountId,
    priceTinybar,
    facilitatorUrl: parseFacilitatorUrl(
      required(environment, 'BLOCKY402_FACILITATOR_URL'),
    ),
    modelProvider,
    model,
    openAiApiKey: required(environment, 'OPENAI_API_KEY'),
  };
}
