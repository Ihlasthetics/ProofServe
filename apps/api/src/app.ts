import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ActivateServiceRequestSchema,
  AgentRunParamsSchema,
  CreateAgentRunRequestSchema,
  CreateProviderRequestSchema,
  CreateServiceRequestSchema,
  ListServicesQuerySchema,
  ProviderParamsSchema,
  ServiceParamsSchema,
  WorldVerificationContextRequestSchema,
  WorldVerificationRequestSchema,
} from '@proofserve/shared';
import { AgentRunServiceError, type AgentRunService } from './agent-runs.js';
import {
  apiError,
  createRegistry,
  RegistryError,
  type RegistryOptions,
} from './registry.js';
import { parseJsonWithUniqueMembers } from './json.js';

// Only boundary failures become 400; invalid generated/stored records become 500.
function requestData<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RegistryError('VALIDATION_ERROR');
  return result.data;
}

function rawQuery(request: FastifyRequest) {
  return new URLSearchParams(request.raw.url?.split('?').slice(1).join('?'));
}

async function rejectQueryParameters(request: FastifyRequest) {
  if ([...rawQuery(request).keys()].length !== 0)
    throw new RegistryError('VALIDATION_ERROR');
}

async function rejectGetBodyAndQuery(request: FastifyRequest) {
  await rejectQueryParameters(request);
  if (
    request.headers['transfer-encoding'] !== undefined ||
    (request.headers['content-length'] !== undefined &&
      request.headers['content-length'] !== '0')
  )
    throw new RegistryError('VALIDATION_ERROR');
}

async function rejectAgentRunCreationMetadata(request: FastifyRequest) {
  await rejectQueryParameters(request);
  for (const name of [
    'proxy-authorization',
    'cookie',
    'x-api-key',
    'payment-signature',
    'payment-required',
    'payment-response',
    'x-proofserve-hedera-transaction-id',
    'x-proofserve-hedera-transaction-url',
  ])
    if (request.headers[name] !== undefined)
      throw new RegistryError('VALIDATION_ERROR');
}

export function validateAgentRunApiToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 512 ||
    /\s/.test(value)
  )
    throw new Error('Invalid agent run authentication configuration');
  return value;
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export interface ApiAppOptions extends RegistryOptions {
  agentRuns?: AgentRunService;
  agentRunApiToken?: string;
}

export function createApiApp(options: ApiAppOptions = {}) {
  const app = Fastify({
    logger: false,
    // Router decoding failures happen before the ordinary error handler.
    frameworkErrors: (error, _request, reply: FastifyReply) => {
      const response = apiError(
        error.code === 'FST_ERR_BAD_URL'
          ? 'VALIDATION_ERROR'
          : 'INTERNAL_ERROR',
      );
      return reply.code(response.status).send(response.body);
    },
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        if (typeof body !== 'string')
          throw new RegistryError('VALIDATION_ERROR');
        done(null, parseJsonWithUniqueMembers(body));
      } catch {
        done(new RegistryError('VALIDATION_ERROR'));
      }
    },
  );
  const registry = createRegistry(options);
  const agentRuns = options.agentRuns;
  let expectedTokenDigest: Buffer | undefined;
  try {
    expectedTokenDigest = tokenDigest(
      validateAgentRunApiToken(options.agentRunApiToken),
    );
  } catch {
    // The standalone server validates eagerly; an unconfigured injected app
    // still fails closed if an agent-run route is reached.
  }
  const authorizeAgentRun = async (request: FastifyRequest) => {
    if (!expectedTokenDigest) throw new RegistryError('INTERNAL_ERROR');
    const header = request.headers.authorization;
    const match =
      typeof header === 'string' && header.length <= 520
        ? /^Bearer ([^\s]+)$/.exec(header)
        : null;
    const supplied = tokenDigest(match?.[1] ?? '');
    if (!timingSafeEqual(expectedTokenDigest, supplied))
      throw new RegistryError('UNAUTHORIZED');
  };

  app.setErrorHandler((error, _request, reply) => {
    const code =
      error instanceof RegistryError
        ? error.code
        : error instanceof AgentRunServiceError
          ? error.code
          : error instanceof Error &&
              'code' in error &&
              typeof error.code === 'string' &&
              [
                'FST_ERR_CTP_INVALID_JSON_BODY',
                'FST_ERR_CTP_EMPTY_JSON_BODY',
                'FST_ERR_CTP_INVALID_MEDIA_TYPE',
                'FST_ERR_CTP_BODY_TOO_LARGE',
                'FST_ERR_CTP_INVALID_CONTENT_LENGTH',
                'FST_ERR_BAD_URL',
              ].includes(error.code)
            ? 'VALIDATION_ERROR'
            : 'INTERNAL_ERROR';
    const response = apiError(code);
    return reply.code(response.status).send(response.body);
  });
  app.setNotFoundHandler((_request, reply) => {
    const response = apiError('VALIDATION_ERROR');
    return reply.code(response.status).send(response.body);
  });

  app.get('/health', { onRequest: rejectQueryParameters }, async () => ({
    status: 'ok',
  }));
  app.post(
    '/api/providers',
    { onRequest: rejectQueryParameters },
    async (request, reply) => {
      const body = requestData(CreateProviderRequestSchema, request.body);
      return reply.code(201).send(registry.createProvider(body));
    },
  );
  app.get<{ Params: { providerId: string } }>(
    '/api/providers/:providerId',
    { onRequest: rejectQueryParameters },
    async (request) => {
      const { id } = requestData(ProviderParamsSchema, {
        id: request.params.providerId,
      });
      return registry.getProvider(id);
    },
  );
  app.post<{ Params: { providerId: string } }>(
    '/api/providers/:providerId/verification/world/request',
    { onRequest: rejectQueryParameters },
    async (request) => {
      const { id } = requestData(ProviderParamsSchema, {
        id: request.params.providerId,
      });
      requestData(WorldVerificationContextRequestSchema, request.body);
      return registry.createWorldVerificationRequest(id);
    },
  );
  app.post<{ Params: { providerId: string } }>(
    '/api/providers/:providerId/verification/world',
    { onRequest: rejectQueryParameters },
    async (request) => {
      const { id } = requestData(ProviderParamsSchema, {
        id: request.params.providerId,
      });
      const body = requestData(WorldVerificationRequestSchema, request.body);
      return registry.verifyWorld(id, body);
    },
  );
  app.post(
    '/api/services',
    { onRequest: rejectQueryParameters },
    async (request, reply) => {
      const body = requestData(CreateServiceRequestSchema, request.body);
      return reply.code(201).send(registry.createService(body));
    },
  );
  app.post<{ Params: { serviceId: string } }>(
    '/api/services/:serviceId/activate',
    { onRequest: rejectQueryParameters },
    async (request) => {
      const { id } = requestData(ServiceParamsSchema, {
        id: request.params.serviceId,
      });
      requestData(ActivateServiceRequestSchema, request.body);
      return registry.activateService(id);
    },
  );
  app.get(
    '/api/services',
    {
      onRequest: async (request) => {
        // Fastify does not parse GET bodies, so reject their framing before routing.
        if (
          request.headers['transfer-encoding'] !== undefined ||
          (request.headers['content-length'] !== undefined &&
            request.headers['content-length'] !== '0')
        ) {
          throw new RegistryError('VALIDATION_ERROR');
        }
      },
    },
    async (request) => {
      // Preserve every decoded key, including duplicates and prototype-like names.
      const params = rawQuery(request);
      const keys = [...params.keys()];
      if (new Set(keys).size !== keys.length)
        throw new RegistryError('VALIDATION_ERROR');
      const query = requestData(
        ListServicesQuerySchema,
        Object.fromEntries(params),
      );
      return registry.listServices(query);
    },
  );
  app.post(
    '/api/agent/runs',
    {
      onRequest: async (request) => {
        await authorizeAgentRun(request);
        await rejectAgentRunCreationMetadata(request);
      },
    },
    async (request, reply) => {
      if (!agentRuns) throw new RegistryError('INTERNAL_ERROR');
      const task = requestData(CreateAgentRunRequestSchema, request.body);
      return reply.code(202).send(await agentRuns.createRun(task));
    },
  );
  app.get<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId',
    {
      onRequest: async (request) => {
        await authorizeAgentRun(request);
        await rejectGetBodyAndQuery(request);
      },
    },
    async (request) => {
      if (!agentRuns) throw new RegistryError('INTERNAL_ERROR');
      const { runId } = requestData(AgentRunParamsSchema, {
        runId: request.params.runId,
      });
      return agentRuns.getRun(runId);
    },
  );
  return app;
}
