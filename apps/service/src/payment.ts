import { HederaAccountIdSchema } from '@proofserve/shared';
import {
  PAYMENT_REQUIRED_CACHE_CONTROL,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  x402HTTPResourceServer,
  type HTTPAdapter,
  type HTTPProcessResult,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type ProcessSettleResultResponse,
} from '@x402/core/http';
import { parsePaymentPayload, parsePaymentRequired } from '@x402/core/schemas';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import type { FastifyRequest } from 'fastify';

const TRIAGE_ROUTE = 'POST /v1/triage';
const TRIAGE_DESCRIPTION = 'ProofServe support-ticket triage';
const MAX_PAYMENT_TIMEOUT_SECONDS = 300;
const HEDERA_TESTNET_CAIP2 = 'hedera:testnet';
const HBAR_ASSET_ID = '0.0.0';
const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';
const SAFE_PAYMENT_REQUIRED_ERROR = 'Payment could not be accepted.';
const SAFE_SETTLEMENT_ERROR = 'Payment settlement failed.';

const safePaymentError = {
  error: {
    code: 'PAYMENT_FAILED',
    message: 'Payment is required and must settle successfully.',
  },
};

export class PaymentProcessingError extends Error {
  constructor() {
    super('Payment processing failed.');
    this.name = 'PaymentProcessingError';
  }
}

export class PaymentHeaderError extends Error {
  constructor() {
    super('Invalid payment header.');
    this.name = 'PaymentHeaderError';
  }
}

export interface X402PaymentGateOptions {
  facilitator: FacilitatorClient;
  publicUrl: string;
  receiverAccountId: string;
  priceTinybar: string;
}

type VerifiedPayment = Extract<HTTPProcessResult, { type: 'payment-verified' }>;
type SuccessfulSettlement = Extract<
  ProcessSettleResultResponse,
  { success: true }
>;
type FailedSettlement = Extract<
  ProcessSettleResultResponse,
  { success: false }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyHeader(
  headers: Record<string, string>,
  expectedName: string,
): string {
  const matches = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase(),
  );
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    throw new PaymentProcessingError();
  }
  return match[1];
}

function decodeSettlementHeader(
  headers: Record<string, string>,
): Record<string, unknown> {
  try {
    const decoded = decodePaymentResponseHeader(
      onlyHeader(headers, PAYMENT_RESPONSE_HEADER),
    );
    if (!isRecord(decoded)) throw new PaymentProcessingError();
    return decoded;
  } catch (error) {
    if (error instanceof PaymentProcessingError) throw error;
    throw new PaymentProcessingError();
  }
}

function safeSettlementSuccess(
  result: SuccessfulSettlement,
): ProcessSettleResultResponse {
  const decoded = decodeSettlementHeader(result.headers);
  if (
    decoded.success !== true ||
    decoded.transaction !== result.transaction ||
    decoded.network !== result.network
  ) {
    throw new PaymentProcessingError();
  }

  const safeResponse: SettleResponse = {
    success: true,
    transaction: result.transaction,
    network: result.network,
  };

  return {
    success: true,
    transaction: result.transaction,
    network: result.network,
    requirements: result.requirements,
    headers: {
      [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(safeResponse),
    },
  };
}

function safeSettlementFailure(
  result: FailedSettlement,
): ProcessSettleResultResponse {
  const decoded = decodeSettlementHeader(result.headers);
  if (decoded.success !== false) throw new PaymentProcessingError();

  const safeResponse: SettleResponse = {
    success: false,
    errorReason: 'payment_failed',
    errorMessage: SAFE_SETTLEMENT_ERROR,
    transaction: '',
    network: HEDERA_TESTNET_CAIP2,
  };
  const safeHeaders = {
    [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(safeResponse),
  };

  return {
    ...safeResponse,
    success: false,
    errorReason: 'payment_failed',
    errorMessage: SAFE_SETTLEMENT_ERROR,
    headers: safeHeaders,
    response: {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        ...safeHeaders,
        'Cache-Control': PAYMENT_REQUIRED_CACHE_CONTROL,
      },
      body: safePaymentError,
      isHtml: false,
    },
  };
}

function safePaymentRequiredResponse(
  response: HTTPResponseInstructions,
  options: X402PaymentGateOptions,
): HTTPResponseInstructions {
  let decoded: unknown;
  try {
    decoded = decodePaymentRequiredHeader(
      onlyHeader(response.headers, PAYMENT_REQUIRED_HEADER),
    );
  } catch (error) {
    if (error instanceof PaymentProcessingError) throw error;
    throw new PaymentProcessingError();
  }

  const parsed = parsePaymentRequired(decoded);
  if (!parsed.success || parsed.data.x402Version !== 2) {
    throw new PaymentProcessingError();
  }
  const accepted = parsed.data.accepts[0];
  const feePayer = accepted?.extra?.feePayer;
  if (
    parsed.data.accepts.length !== 1 ||
    accepted === undefined ||
    parsed.data.resource.url !== options.publicUrl ||
    accepted.scheme !== 'exact' ||
    accepted.network !== HEDERA_TESTNET_CAIP2 ||
    accepted.asset !== HBAR_ASSET_ID ||
    accepted.amount !== options.priceTinybar ||
    accepted.payTo !== options.receiverAccountId ||
    accepted.maxTimeoutSeconds !== MAX_PAYMENT_TIMEOUT_SECONDS ||
    typeof feePayer !== 'string' ||
    !HederaAccountIdSchema.safeParse(feePayer).success
  ) {
    throw new PaymentProcessingError();
  }

  const safePaymentRequired: PaymentRequired = {
    x402Version: 2,
    ...(parsed.data.error === undefined
      ? {}
      : { error: SAFE_PAYMENT_REQUIRED_ERROR }),
    resource: {
      url: options.publicUrl,
      description: TRIAGE_DESCRIPTION,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: HEDERA_TESTNET_CAIP2,
        asset: HBAR_ASSET_ID,
        amount: options.priceTinybar,
        payTo: options.receiverAccountId,
        maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS,
        extra: { feePayer },
      },
    ],
  };

  return {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      [PAYMENT_REQUIRED_HEADER]:
        encodePaymentRequiredHeader(safePaymentRequired),
      'Cache-Control': PAYMENT_REQUIRED_CACHE_CONTROL,
    },
    body: safePaymentError,
    isHtml: false,
  };
}

function paymentSignatureHeader(request: FastifyRequest): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const name = request.raw.rawHeaders[index];
    const value = request.raw.rawHeaders[index + 1];
    if (name?.toLowerCase() === 'payment-signature' && value !== undefined) {
      values.push(value);
    }
  }

  if (values.length > 1) throw new PaymentHeaderError();

  const normalized = request.headers['payment-signature'];
  if (normalized === undefined) return undefined;
  if (typeof normalized !== 'string' || normalized.length === 0) {
    throw new PaymentHeaderError();
  }

  return values[0] ?? normalized;
}

function validatePaymentSignature(
  request: FastifyRequest,
  options: X402PaymentGateOptions,
): void {
  const header = paymentSignatureHeader(request);
  if (header === undefined) return;

  let decoded: unknown;
  try {
    decoded = decodePaymentSignatureHeader(header);
  } catch {
    throw new PaymentHeaderError();
  }

  const parsed = parsePaymentPayload(decoded);
  if (!parsed.success || parsed.data.x402Version !== 2) {
    throw new PaymentHeaderError();
  }
  const { accepted, resource } = parsed.data;
  if (
    accepted.scheme !== 'exact' ||
    accepted.network !== HEDERA_TESTNET_CAIP2 ||
    accepted.asset !== HBAR_ASSET_ID ||
    accepted.amount !== options.priceTinybar ||
    accepted.payTo !== options.receiverAccountId ||
    (resource !== undefined && resource.url !== options.publicUrl)
  ) {
    throw new PaymentHeaderError();
  }
}

class InitializationSafeFacilitator implements FacilitatorClient {
  constructor(private readonly facilitator: FacilitatorClient) {}

  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  async getSupported(): Promise<SupportedResponse> {
    try {
      return await this.facilitator.getSupported();
    } catch {
      throw new PaymentProcessingError();
    }
  }
}

export type PaymentAuthorization =
  | { type: 'response'; response: HTTPResponseInstructions }
  | {
      type: 'verified';
      context: HTTPRequestContext;
      payment: VerifiedPayment;
    };

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function fastifyAdapter(
  request: FastifyRequest,
  publicUrl: string,
): HTTPAdapter {
  return {
    getHeader: (name) => firstHeader(request.headers[name.toLowerCase()]),
    getMethod: () => request.method,
    getPath: () => '/v1/triage',
    getUrl: () => publicUrl,
    getAcceptHeader: () => firstHeader(request.headers.accept) ?? '',
    getUserAgent: () => firstHeader(request.headers['user-agent']) ?? '',
    getBody: () => request.body,
  };
}

export class X402PaymentGate {
  readonly #server: x402HTTPResourceServer;
  readonly #options: X402PaymentGateOptions;

  constructor(options: X402PaymentGateOptions) {
    this.#options = options;
    const facilitator = new InitializationSafeFacilitator(options.facilitator);
    const resourceServer = new x402ResourceServer(facilitator).register(
      'hedera:*',
      new ExactHederaScheme(),
    );

    this.#server = new x402HTTPResourceServer(resourceServer, {
      [TRIAGE_ROUTE]: {
        accepts: {
          scheme: 'exact',
          network: HEDERA_TESTNET_CAIP2,
          payTo: options.receiverAccountId,
          price: {
            asset: HBAR_ASSET_ID,
            amount: options.priceTinybar,
          },
          maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS,
        },
        resource: options.publicUrl,
        description: TRIAGE_DESCRIPTION,
        mimeType: 'application/json',
        unpaidResponseBody: () => ({
          contentType: 'application/json',
          body: safePaymentError,
        }),
        settlementFailedResponseBody: () => ({
          contentType: 'application/json',
          body: safePaymentError,
        }),
      },
    });
  }

  async initialize(): Promise<void> {
    try {
      await this.#server.initialize();
    } catch {
      throw new PaymentProcessingError();
    }
  }

  async authorize(request: FastifyRequest): Promise<PaymentAuthorization> {
    validatePaymentSignature(request, this.#options);
    const context: HTTPRequestContext = {
      adapter: fastifyAdapter(request, this.#options.publicUrl),
      path: '/v1/triage',
      method: 'POST',
    };

    let result: HTTPProcessResult;
    try {
      result = await this.#server.processHTTPRequest(context);
    } catch {
      throw new PaymentProcessingError();
    }

    if (result.type === 'payment-error') {
      if (result.response.status !== 402) throw new PaymentProcessingError();
      return {
        type: 'response',
        response: safePaymentRequiredResponse(result.response, this.#options),
      };
    }
    if (result.type !== 'payment-verified') {
      throw new PaymentProcessingError();
    }

    return { type: 'verified', context, payment: result };
  }

  async settle(
    authorization: Extract<PaymentAuthorization, { type: 'verified' }>,
  ): Promise<ProcessSettleResultResponse> {
    const { payment, context } = authorization;
    try {
      const result = await this.#server.processSettlement(
        payment.paymentPayload,
        payment.paymentRequirements,
        payment.declaredExtensions,
        { request: context },
        undefined,
        payment.beforeHandlerSettlement,
      );
      return result.success
        ? safeSettlementSuccess(result)
        : safeSettlementFailure(result);
    } catch (error) {
      if (error instanceof PaymentProcessingError) throw error;
      throw new PaymentProcessingError();
    }
  }
}
