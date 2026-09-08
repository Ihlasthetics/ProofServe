import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ActivateServiceRequestSchema,
  CreateProviderRequestSchema,
  CreateServiceRequestSchema,
  ListServicesQuerySchema,
  ProviderParamsSchema,
  ServiceParamsSchema,
} from '@proofserve/shared';
import {
  apiError,
  createRegistry,
  RegistryError,
  type RegistryOptions,
} from './registry.js';

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

export function createApiApp(options: RegistryOptions = {}) {
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
  const registry = createRegistry(options);

  app.setErrorHandler((error, _request, reply) => {
    const code =
      error instanceof RegistryError
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
  return app;
}
