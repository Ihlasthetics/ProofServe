import {
  ActivateServiceRequestSchema,
  ActivateServiceResponseSchema,
  ApiErrorResponseSchema,
  CreateProviderRequestSchema,
  CreateProviderResponseSchema,
  CreateServiceRequestSchema,
  CreateServiceResponseSchema,
  ListServicesResponseSchema,
  ServiceParamsSchema,
  type ApiErrorCode,
  type CreateProviderRequest,
  type CreateServiceRequest,
} from '@proofserve/shared';

// Error bodies are validated, but arbitrary backend text is never rendered.
const safeErrors: Partial<Record<ApiErrorCode, string>> = {
  VALIDATION_ERROR: 'Check the submitted fields and try again.',
  PROVIDER_NOT_FOUND:
    'The provider was not found. The registry may have restarted.',
  SERVICE_NOT_FOUND:
    'The service was not found. The registry may have restarted.',
  PROVIDER_VERIFICATION_REQUIRED:
    'Activation blocked: current provider verification is required. The service remains draft and is not discoverable or payable.',
  ENDPOINT_NOT_ALLOWED:
    'The service endpoint is not approved. Contact the registry operator.',
  SERVICE_STATE_CONFLICT:
    'The registry reports a service state conflict. No local activation was applied.',
};
const uncertainMutation =
  'The request outcome is uncertain and may have been saved. Check the current state with the registry operator before retrying.';

export class RegistryRequestError extends Error {}

export function createRegistryClient(fetcher: typeof fetch = fetch) {
  async function request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    body?: unknown,
    expectedStatus?: number,
  ): Promise<T> {
    // A POST may have completed upstream even when its response is unavailable.
    const recovery =
      body === undefined ? 'Try again later.' : uncertainMutation;
    let response: Response;
    try {
      response = await fetcher(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers:
          body === undefined
            ? { Accept: 'application/json' }
            : {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new RegistryRequestError(
        `The registry could not be reached. ${recovery}`,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new RegistryRequestError(
        `The registry returned an unreadable response. No local success was applied. ${recovery}`,
      );
    }
    if (!response.ok) {
      const error = ApiErrorResponseSchema.safeParse(data);
      throw new RegistryRequestError(
        error.success
          ? (safeErrors[error.data.error.code] ?? recovery)
          : `The registry returned an invalid error response. No local success was applied. ${recovery}`,
      );
    }
    try {
      if (expectedStatus !== undefined && response.status !== expectedStatus)
        throw new Error('Unexpected status');
      return schema.parse(data);
    } catch {
      throw new RegistryRequestError(
        `The registry returned an invalid response. No local success was applied. ${recovery}`,
      );
    }
  }
  return {
    async createProvider(input: CreateProviderRequest) {
      const parsed = CreateProviderRequestSchema.safeParse(input);
      if (!parsed.success)
        throw new RegistryRequestError(
          'Enter a display name (1–120 characters) and a valid Hedera payout account such as 0.0.123456.',
        );
      const provider = await request(
        '/api/providers',
        CreateProviderResponseSchema,
        parsed.data,
      );
      if (provider.verification.status !== 'UNVERIFIED')
        throw new RegistryRequestError(
          `Unexpected provider verification status. No local success was applied. ${uncertainMutation}`,
        );
      return provider;
    },
    async createService(input: CreateServiceRequest) {
      const parsed = CreateServiceRequestSchema.safeParse(input);
      if (!parsed.success)
        throw new RegistryRequestError(
          'Enter a service name (1–120 characters), description (1–1000 characters), and a positive whole-number price in tinybars.',
        );
      const service = await request(
        '/api/services',
        CreateServiceResponseSchema,
        parsed.data,
      );
      if (service.status !== 'DRAFT' || service.providerId !== input.providerId)
        throw new RegistryRequestError(
          `Unexpected draft-service response. No local success was applied. ${uncertainMutation}`,
        );
      return service;
    },
    listServices: () => request('/api/services', ListServicesResponseSchema),
    async activateService(id: string) {
      const service = await request(
        `/api/services/${encodeURIComponent(ServiceParamsSchema.parse({ id }).id)}/activate`,
        ActivateServiceResponseSchema,
        ActivateServiceRequestSchema.parse({}),
        200,
      );
      if (service.id !== id || service.status !== 'ACTIVE')
        throw new RegistryRequestError(
          `Unexpected activation response. No local success was applied. ${uncertainMutation}`,
        );
      return service;
    },
  };
}
