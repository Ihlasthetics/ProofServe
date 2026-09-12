import { randomUUID } from 'node:crypto';
import {
  ApiErrorResponseSchema,
  AtomicAmountSchema,
  EndpointUrlSchema,
  ListServicesResponseSchema,
  ProviderSchema,
  ServiceListingSchema,
  TimestampSchema,
  VerificationRecordSchema,
  type ApiErrorCode,
  type CreateProviderRequest,
  type CreateServiceRequest,
  type Identifier,
  type ListServicesQuery,
  type Provider,
  type ServiceCapability,
} from '@proofserve/shared';
import {
  InMemoryRegistryRepository,
  type RegistryRepository,
} from './repository.js';

const errors = {
  VALIDATION_ERROR: [400, 'Invalid request.'],
  UNAUTHORIZED: [401, 'Authentication is required.'],
  PROVIDER_NOT_FOUND: [404, 'Provider not found.'],
  SERVICE_NOT_FOUND: [404, 'Service not found.'],
  RUN_NOT_FOUND: [404, 'Agent run not found.'],
  PROVIDER_VERIFICATION_REQUIRED: [
    403,
    'Current provider verification is required; suspended service reactivation requires renewed verification.',
  ],
  SERVICE_STATE_CONFLICT: [409, 'Service is already active.'],
  ENDPOINT_NOT_ALLOWED: [403, 'Service endpoint is not approved.'],
  INTERNAL_ERROR: [500, 'An internal error occurred.'],
} as const satisfies Partial<Record<ApiErrorCode, readonly [number, string]>>;

export class RegistryError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
  }
}

export function apiError(code: keyof typeof errors) {
  const [status, message] = errors[code];
  return {
    status,
    body: ApiErrorResponseSchema.parse({ error: { code, message } }),
  };
}

export interface RegistryOptions {
  repository?: RegistryRepository;
  now?: () => string;
  providerId?: () => Identifier;
  serviceId?: () => Identifier;
  /** Trusted server configuration only; called again at each eligibility check. */
  resolveEndpoint?: (capability: ServiceCapability) => string | undefined;
}

function isCurrentlyVerified(provider: Provider, now: string): boolean {
  const parsed = VerificationRecordSchema.safeParse(provider.verification);
  if (!parsed.success) return false;
  const record = parsed.data;
  return (
    record.providerId === provider.id &&
    record.status === 'VERIFIED' &&
    record.verifiedAt <= now &&
    now < record.expiresAt
  );
}

export function createRegistry(options: RegistryOptions = {}) {
  const repository = options.repository ?? new InMemoryRegistryRepository();
  const clock = options.now ?? (() => new Date().toISOString());
  const providerId = options.providerId ?? randomUUID;
  const serviceId = options.serviceId ?? randomUUID;
  const resolveEndpoint = options.resolveEndpoint ?? (() => undefined);
  const currentTime = () => TimestampSchema.parse(clock());
  const approvedEndpoint = (capability: ServiceCapability) => {
    const endpoint = EndpointUrlSchema.safeParse(resolveEndpoint(capability));
    return endpoint.success ? endpoint.data : undefined;
  };
  const getProvider = (id: Identifier) => {
    const provider = repository.getProvider(id);
    if (!provider) throw new RegistryError('PROVIDER_NOT_FOUND');
    const result = ProviderSchema.parse(provider);
    if (result.id !== id) throw new RegistryError('INTERNAL_ERROR');
    return result;
  };

  return {
    getProvider,
    createProvider(request: CreateProviderRequest) {
      const id = providerId();
      const now = currentTime();
      const provider = ProviderSchema.parse({
        ...request,
        id,
        createdAt: now,
        updatedAt: now,
        verification: {
          providerId: id,
          method: 'WORLD_SELFIE_CHECK',
          status: 'UNVERIFIED',
          verifiedAt: null,
          expiresAt: null,
        },
      });
      repository.createProvider(provider);
      return provider;
    },
    createService(request: CreateServiceRequest) {
      const provider = getProvider(request.providerId);
      const endpoint = approvedEndpoint(request.capability);
      if (!endpoint) throw new RegistryError('ENDPOINT_NOT_ALLOWED');
      const now = currentTime();
      const service = ServiceListingSchema.parse({
        id: serviceId(),
        providerId: provider.id,
        name: request.name,
        description: request.description,
        capability: request.capability,
        endpoint,
        status: 'DRAFT',
        createdAt: now,
        updatedAt: now,
        paymentRequirements: {
          ...request.price,
          payTo: provider.payoutAccount,
        },
      });
      repository.createService(service);
      return service;
    },
    activateService(id: Identifier) {
      const stored = repository.getService(id);
      if (!stored) throw new RegistryError('SERVICE_NOT_FOUND');
      const service = ServiceListingSchema.parse(stored);
      if (service.id !== id) throw new RegistryError('INTERNAL_ERROR');
      const provider = repository.getProvider(service.providerId);
      if (!provider || provider.id !== service.providerId)
        throw new RegistryError('PROVIDER_NOT_FOUND');
      if (service.status === 'ACTIVE')
        throw new RegistryError('SERVICE_STATE_CONFLICT');
      if (service.status === 'SUSPENDED')
        throw new RegistryError('PROVIDER_VERIFICATION_REQUIRED');
      if (service.endpoint !== approvedEndpoint(service.capability))
        throw new RegistryError('ENDPOINT_NOT_ALLOWED');
      const validatedProvider = ProviderSchema.parse(provider);
      const now = currentTime();
      if (!isCurrentlyVerified(validatedProvider, now)) {
        throw new RegistryError('PROVIDER_VERIFICATION_REQUIRED');
      }
      const activated = ServiceListingSchema.parse({
        ...service,
        status: 'ACTIVE',
        updatedAt: now,
      });
      repository.updateService(activated);
      return activated;
    },
    listServices(query: ListServicesQuery) {
      const now = currentTime();
      const services = repository.listServices().flatMap((stored) => {
        const service = ServiceListingSchema.parse(stored);
        if (service.status !== 'ACTIVE') return [];
        const provider = repository.getProvider(service.providerId);
        if (
          !provider ||
          provider.id !== service.providerId ||
          !isCurrentlyVerified(provider, now) ||
          service.endpoint !== approvedEndpoint(service.capability)
        )
          return [];
        const price = service.paymentRequirements;
        if (
          (query.capability !== undefined &&
            query.capability !== service.capability) ||
          (query.network !== undefined && query.network !== price.network) ||
          (query.asset !== undefined && query.asset !== price.asset)
        )
          return [];
        if (
          query.maxAmountAtomic !== undefined &&
          BigInt(AtomicAmountSchema.parse(price.amountAtomic)) >
            BigInt(AtomicAmountSchema.parse(query.maxAmountAtomic))
        )
          return [];
        return [{ service, provider }];
      });
      return ListServicesResponseSchema.parse({ services });
    },
  };
}
