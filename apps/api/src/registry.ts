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
  VerifiedVerificationRecordSchema,
  type ApiErrorCode,
  type CreateProviderRequest,
  type CreateServiceRequest,
  type Identifier,
  type ListServicesQuery,
  type Provider,
  type ServiceCapability,
  type WorldVerificationRequest,
} from '@proofserve/shared';
import {
  InMemoryRegistryRepository,
  type RegistryRepository,
} from './repository.js';
import {
  WorldVerificationFailure,
  type WorldVerificationClient,
} from './world.js';

const errors = {
  VALIDATION_ERROR: [400, 'Invalid request.'],
  PROVIDER_NOT_FOUND: [404, 'Provider not found.'],
  SERVICE_NOT_FOUND: [404, 'Service not found.'],
  PROVIDER_VERIFICATION_REQUIRED: [
    403,
    'Current provider verification is required; suspended service reactivation requires renewed verification.',
  ],
  SERVICE_STATE_CONFLICT: [409, 'Service is already active.'],
  ENDPOINT_NOT_ALLOWED: [403, 'Service endpoint is not approved.'],
  WORLD_PROOF_INVALID: [400, 'World verification result is invalid.'],
  WORLD_PROOF_REPLAYED: [
    409,
    'World verification result has already been used.',
  ],
  PROVIDER_ALREADY_VERIFIED: [
    409,
    'Provider verification is current and renewal is not required.',
  ],
  WORLD_VERIFICATION_UNAVAILABLE: [
    503,
    'World verification is temporarily unavailable.',
  ],
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
  /** Server-only World adapter. Tests inject a deterministic implementation. */
  worldVerification?: WorldVerificationClient;
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
  const worldVerification = options.worldVerification;
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
  const requireRenewal = (provider: Provider, now: string) => {
    if (isCurrentlyVerified(provider, now))
      throw new RegistryError('PROVIDER_ALREADY_VERIFIED');
  };
  const configuredWorld = () => {
    if (!worldVerification)
      throw new RegistryError('WORLD_VERIFICATION_UNAVAILABLE');
    return worldVerification;
  };
  const verificationExpiration = (now: string, freshnessSeconds: number) => {
    if (
      !Number.isSafeInteger(freshnessSeconds) ||
      freshnessSeconds < 1 ||
      freshnessSeconds > 31_536_000
    ) {
      throw new RegistryError('INTERNAL_ERROR');
    }
    return TimestampSchema.parse(
      new Date(Date.parse(now) + freshnessSeconds * 1_000).toISOString(),
    );
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
    createWorldVerificationRequest(id: Identifier) {
      const provider = getProvider(id);
      requireRenewal(provider, currentTime());
      try {
        return configuredWorld().createRequest(provider.id);
      } catch (error) {
        if (error instanceof WorldVerificationFailure)
          throw new RegistryError(error.code);
        throw error;
      }
    },
    async verifyWorld(id: Identifier, result: WorldVerificationRequest) {
      const provider = getProvider(id);
      requireRenewal(provider, currentTime());
      const world = configuredWorld();
      let canonicalNullifier: string;
      try {
        canonicalNullifier = await world.verify(provider.id, result);
      } catch (error) {
        if (error instanceof WorldVerificationFailure)
          throw new RegistryError(error.code);
        throw error;
      }
      const now = currentTime();
      const verification = VerifiedVerificationRecordSchema.parse({
        providerId: provider.id,
        method: 'WORLD_SELFIE_CHECK',
        status: 'VERIFIED',
        verifiedAt: now,
        expiresAt: verificationExpiration(now, world.freshnessSeconds),
      });
      const committed = repository.commitWorldVerification(
        provider.id,
        canonicalNullifier,
        verification,
        now,
      );
      if (committed !== 'VERIFIED') throw new RegistryError(committed);
      return verification;
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
