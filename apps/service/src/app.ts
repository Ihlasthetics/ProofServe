import {
  ApiErrorResponseSchema,
  TriageInputSchema,
  TriageResultSchema,
  type ApiErrorCode,
} from '@proofserve/shared';
import {
  HTTPFacilitatorClient,
  type FacilitatorClient,
} from '@x402/core/server';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { ServiceConfig } from './config.js';
import {
  GeminiTriageEngine,
  TriageEngineError,
  type TriageEngine,
} from './engine.js';
import { hashScanTestnetTransactionUrl } from './hashscan.js';
import {
  PaymentHeaderError,
  PaymentProcessingError,
  X402PaymentGate,
} from './payment.js';

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface ServiceAppOptions {
  engine: TriageEngine;
  facilitator: FacilitatorClient;
  publicUrl: string;
  receiverAccountId: string;
  priceTinybar: string;
}

class ServiceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceHttpError';
  }
}

function apiError(code: ApiErrorCode, message: string) {
  return ApiErrorResponseSchema.parse({ error: { code, message } });
}

function rawQuery(request: FastifyRequest): URLSearchParams {
  return new URLSearchParams(request.raw.url?.split('?').slice(1).join('?'));
}

async function validateTriageFraming(request: FastifyRequest): Promise<void> {
  if ([...rawQuery(request).keys()].length !== 0) {
    throw new ServiceHttpError(400, 'VALIDATION_ERROR', 'Invalid request.');
  }

  const contentType = request.headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new ServiceHttpError(
      415,
      'VALIDATION_ERROR',
      'Content-Type must be application/json.',
    );
  }
}

function fastifyErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  if (typeof code !== 'string') return undefined;

  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return 413;
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return 415;
  if (
    [
      'FST_ERR_CTP_INVALID_JSON_BODY',
      'FST_ERR_CTP_EMPTY_JSON_BODY',
      'FST_ERR_CTP_INVALID_CONTENT_LENGTH',
      'FST_ERR_BAD_URL',
    ].includes(code)
  ) {
    return 400;
  }
  return undefined;
}

function sendInstructions(
  reply: FastifyReply,
  instructions: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
  },
) {
  return reply
    .headers(instructions.headers)
    .code(instructions.status)
    .send(instructions.body);
}

function settledResponseHeaders(
  settlementHeaders: Record<string, string>,
  transaction: string,
  transactionUrl: string,
): Record<string, string> {
  return {
    ...settlementHeaders,
    'cache-control': 'private, no-store',
    'x-proofserve-hedera-transaction-id': transaction,
    'x-proofserve-hedera-transaction-url': transactionUrl,
  };
}

export function createServiceApp(options: ServiceAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_REQUEST_BODY_BYTES,
    frameworkErrors: (_error, _request, reply: FastifyReply) =>
      reply.code(400).send(apiError('VALIDATION_ERROR', 'Invalid request.')),
  });
  const paymentGate = new X402PaymentGate(options);

  app.addHook('onReady', async () => paymentGate.initialize());

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceHttpError) {
      return reply.code(error.status).send(apiError(error.code, error.message));
    }

    const boundaryStatus = fastifyErrorStatus(error);
    if (boundaryStatus !== undefined) {
      return reply
        .code(boundaryStatus)
        .send(apiError('VALIDATION_ERROR', 'Invalid request.'));
    }

    if (error instanceof PaymentProcessingError) {
      return reply
        .code(502)
        .send(apiError('PAYMENT_FAILED', 'Payment processing failed.'));
    }

    if (error instanceof PaymentHeaderError) {
      return reply
        .code(400)
        .send(apiError('VALIDATION_ERROR', 'Invalid payment header.'));
    }

    if (error instanceof TriageEngineError) {
      return reply
        .code(502)
        .send(apiError('SERVICE_EXECUTION_FAILED', 'Triage inference failed.'));
    }

    return reply
      .code(500)
      .send(apiError('INTERNAL_ERROR', 'Internal service error.'));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(apiError('VALIDATION_ERROR', 'Route not found.')),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  app.post(
    '/v1/triage',
    { onRequest: validateTriageFraming },
    async (request, reply) => {
      const parsedInput = TriageInputSchema.safeParse(request.body);
      if (!parsedInput.success) {
        throw new ServiceHttpError(
          400,
          'VALIDATION_ERROR',
          'Invalid triage request.',
        );
      }

      const authorization = await paymentGate.authorize(request);
      if (authorization.type === 'response') {
        return sendInstructions(reply, authorization.response);
      }

      const settlement = await paymentGate.settle(authorization);
      if (!settlement.success) {
        return sendInstructions(reply, settlement.response);
      }
      if (settlement.network !== 'hedera:testnet') {
        throw new PaymentProcessingError();
      }

      let transactionUrl: string;
      try {
        transactionUrl = hashScanTestnetTransactionUrl(settlement.transaction);
      } catch {
        return reply
          .headers({
            ...settlement.headers,
            'cache-control': 'private, no-store',
          })
          .code(502)
          .send(
            apiError(
              'PAYMENT_FAILED',
              'Payment settled but its transaction could not be reported.',
            ),
          );
      }

      const responseHeaders = settledResponseHeaders(
        settlement.headers,
        settlement.transaction,
        transactionUrl,
      );

      let engineResult: unknown;
      try {
        engineResult = await options.engine.triage(parsedInput.data);
      } catch {
        return reply
          .headers(responseHeaders)
          .code(502)
          .send(
            apiError('SERVICE_EXECUTION_FAILED', 'Triage inference failed.'),
          );
      }
      const result = TriageResultSchema.safeParse(engineResult);
      if (!result.success) {
        return reply
          .headers(responseHeaders)
          .code(502)
          .send(
            apiError('SERVICE_EXECUTION_FAILED', 'Triage inference failed.'),
          );
      }

      return reply.headers(responseHeaders).code(200).send(result.data);
    },
  );

  return app;
}

export function createProductionServiceApp(
  config: ServiceConfig,
): FastifyInstance {
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
  });
  const engine = new GeminiTriageEngine({
    apiKey: config.geminiApiKey,
    model: config.model,
  });

  return createServiceApp({
    engine,
    facilitator,
    publicUrl: config.publicUrl,
    receiverAccountId: config.receiverAccountId,
    priceTinybar: config.priceTinybar,
  });
}
