import {
  ProviderSchema,
  type Identifier,
  type Provider,
  type ServiceListing,
  type VerifiedVerificationRecord,
} from '@proofserve/shared';

export type WorldVerificationCommitResult =
  | 'VERIFIED'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_ALREADY_VERIFIED'
  | 'WORLD_PROOF_REPLAYED';

export interface WorldReplayStore {
  has(canonicalReplayIdentifier: string): boolean;
  /** Atomically reserve an identifier and run its synchronous state update. */
  claimAndCommit(
    canonicalReplayIdentifier: string,
    commit: () => void,
  ): boolean;
}

export class InMemoryWorldReplayStore implements WorldReplayStore {
  private readonly claimedIdentifiers = new Set<string>();

  has(canonicalReplayIdentifier: string): boolean {
    return this.claimedIdentifiers.has(canonicalReplayIdentifier);
  }

  claimAndCommit(
    canonicalReplayIdentifier: string,
    commit: () => void,
  ): boolean {
    if (this.claimedIdentifiers.has(canonicalReplayIdentifier)) return false;
    this.claimedIdentifiers.add(canonicalReplayIdentifier);
    try {
      commit();
      return true;
    } catch (error) {
      this.claimedIdentifiers.delete(canonicalReplayIdentifier);
      throw error;
    }
  }
}

// Default repositories share replay claims for the lifetime of this Node process.
const processWorldReplayStore = new InMemoryWorldReplayStore();

/** Synchronous storage for Y02; provider and service records remain per instance. */
export interface RegistryRepository {
  createProvider(provider: Provider): void;
  getProvider(id: Identifier): Provider | undefined;
  createService(service: ServiceListing): void;
  getService(id: Identifier): ServiceListing | undefined;
  commitWorldVerification(
    providerId: Identifier,
    canonicalNullifier: string,
    verification: VerifiedVerificationRecord,
    now: string,
  ): WorldVerificationCommitResult;
  updateService(service: ServiceListing): void;
  listServices(): ServiceListing[];
}

export class InMemoryRegistryRepository implements RegistryRepository {
  private readonly providers = new Map<Identifier, Provider>();
  private readonly services = new Map<Identifier, ServiceListing>();

  constructor(
    private readonly worldReplayStore: WorldReplayStore = processWorldReplayStore,
  ) {}

  createProvider(provider: Provider): void {
    if (this.providers.has(provider.id))
      throw new Error('Duplicate provider ID');
    this.providers.set(provider.id, structuredClone(provider));
  }

  getProvider(id: Identifier): Provider | undefined {
    return structuredClone(this.providers.get(id));
  }

  commitWorldVerification(
    providerId: Identifier,
    canonicalNullifier: string,
    verification: VerifiedVerificationRecord,
    now: string,
  ): WorldVerificationCommitResult {
    const provider = this.providers.get(providerId);
    if (!provider) return 'PROVIDER_NOT_FOUND';
    if (!/^(0|[1-9][0-9]*)$/.test(canonicalNullifier))
      throw new Error('Invalid canonical World nullifier');
    if (this.worldReplayStore.has(canonicalNullifier))
      return 'WORLD_PROOF_REPLAYED';
    if (
      provider.verification.status === 'VERIFIED' &&
      provider.verification.verifiedAt <= now &&
      now < provider.verification.expiresAt
    ) {
      return 'PROVIDER_ALREADY_VERIFIED';
    }
    const updated = ProviderSchema.parse({
      ...provider,
      verification,
      updatedAt: now,
    });
    const previous = structuredClone(provider);
    try {
      const claimed = this.worldReplayStore.claimAndCommit(
        canonicalNullifier,
        () => this.storeWorldVerifiedProvider(providerId, updated),
      );
      return claimed ? 'VERIFIED' : 'WORLD_PROOF_REPLAYED';
    } catch (error) {
      // Restore the provider even if an injected writer failed after a partial write.
      this.providers.set(providerId, previous);
      throw error;
    }
  }

  protected storeWorldVerifiedProvider(
    providerId: Identifier,
    provider: Provider,
  ): void {
    this.providers.set(providerId, structuredClone(provider));
  }

  createService(service: ServiceListing): void {
    if (this.services.has(service.id)) throw new Error('Duplicate service ID');
    this.services.set(service.id, structuredClone(service));
  }

  getService(id: Identifier): ServiceListing | undefined {
    return structuredClone(this.services.get(id));
  }

  updateService(service: ServiceListing): void {
    if (!this.services.has(service.id)) throw new Error('Missing service');
    this.services.set(service.id, structuredClone(service));
  }

  listServices(): ServiceListing[] {
    return structuredClone([...this.services.values()]);
  }
}
