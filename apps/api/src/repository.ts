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
  | 'WORLD_PROOF_INVALID'
  | 'WORLD_PROOF_REPLAYED';

export interface WorldVerificationContextIssue {
  canonicalRequestNonce: string;
  providerId: Identifier;
  issuedAt: string;
  expiresAt: string;
}

export interface WorldVerificationEpoch {
  verifiedAt: string | null;
  expiresAt: string | null;
}

export interface IssuedWorldVerificationContext extends WorldVerificationContextIssue {
  verificationEpoch: WorldVerificationEpoch;
}

export interface WorldVerificationReplayClaim {
  canonicalNullifier: string;
  canonicalRequestNonce: string;
}

export type WorldVerificationContextStatus =
  'ISSUED' | 'WORLD_PROOF_INVALID' | 'WORLD_PROOF_REPLAYED';

export type WorldVerificationContextIssueResult =
  'ISSUED' | 'PROVIDER_NOT_FOUND' | 'PROVIDER_ALREADY_VERIFIED';

function verificationEpoch(provider: Provider): WorldVerificationEpoch {
  return provider.verification.status === 'UNVERIFIED'
    ? { verifiedAt: null, expiresAt: null }
    : {
        verifiedAt: provider.verification.verifiedAt,
        expiresAt: provider.verification.expiresAt,
      };
}

function canIssueOrConsume(provider: Provider, now: string): boolean {
  return (
    provider.verification.status === 'UNVERIFIED' ||
    now >= provider.verification.expiresAt
  );
}

export interface WorldReplayStore {
  issue(context: IssuedWorldVerificationContext): void;
  status(
    providerId: Identifier,
    canonicalRequestNonce: string,
    now: string,
    verificationEpoch: WorldVerificationEpoch,
  ): WorldVerificationContextStatus;
  /** Atomically bind a nullifier owner, reserve a request, and update state. */
  claimAndCommit(
    providerId: Identifier,
    claim: WorldVerificationReplayClaim,
    now: string,
    verificationEpoch: WorldVerificationEpoch,
    commit: () => void,
  ): WorldVerificationContextStatus;
}

export class InMemoryWorldReplayStore implements WorldReplayStore {
  private readonly nullifierOwners = new Map<string, Identifier>();
  private readonly contexts = new Map<
    string,
    IssuedWorldVerificationContext & {
      consumedAt: string | null;
      nullifier: string | null;
    }
  >();

  issue(context: IssuedWorldVerificationContext): void {
    if (this.contexts.has(context.canonicalRequestNonce))
      throw new Error('Duplicate World request nonce');
    this.contexts.set(context.canonicalRequestNonce, {
      ...structuredClone(context),
      consumedAt: null,
      nullifier: null,
    });
  }

  status(
    providerId: Identifier,
    canonicalRequestNonce: string,
    now: string,
    currentEpoch: WorldVerificationEpoch,
  ): WorldVerificationContextStatus {
    const context = this.contexts.get(canonicalRequestNonce);
    if (!context || context.providerId !== providerId)
      return 'WORLD_PROOF_INVALID';
    if (context.consumedAt !== null) return 'WORLD_PROOF_REPLAYED';
    if (
      context.verificationEpoch.verifiedAt !== currentEpoch.verifiedAt ||
      context.verificationEpoch.expiresAt !== currentEpoch.expiresAt
    )
      return 'WORLD_PROOF_INVALID';
    return now < context.expiresAt ? 'ISSUED' : 'WORLD_PROOF_INVALID';
  }

  claimAndCommit(
    providerId: Identifier,
    claim: WorldVerificationReplayClaim,
    now: string,
    currentEpoch: WorldVerificationEpoch,
    commit: () => void,
  ): WorldVerificationContextStatus {
    const status = this.status(
      providerId,
      claim.canonicalRequestNonce,
      now,
      currentEpoch,
    );
    if (status !== 'ISSUED') return status;
    const owner = this.nullifierOwners.get(claim.canonicalNullifier);
    if (owner !== undefined && owner !== providerId)
      return 'WORLD_PROOF_REPLAYED';
    const context = this.contexts.get(claim.canonicalRequestNonce);
    if (!context) return 'WORLD_PROOF_INVALID';
    const createdOwner = owner === undefined;
    if (createdOwner)
      this.nullifierOwners.set(claim.canonicalNullifier, providerId);
    context.consumedAt = now;
    context.nullifier = claim.canonicalNullifier;
    try {
      commit();
      return 'ISSUED';
    } catch (error) {
      context.consumedAt = null;
      context.nullifier = null;
      if (createdOwner) this.nullifierOwners.delete(claim.canonicalNullifier);
      throw error;
    }
  }
}

// Default repositories share issued contexts and nullifier ownership per process.
const processWorldReplayStore = new InMemoryWorldReplayStore();

/** Registry storage; production is durable, while tests may use synchronous memory. */
export interface RegistryRepository {
  createProvider(provider: Provider): void | Promise<void>;
  getProvider(
    id: Identifier,
  ): Provider | undefined | Promise<Provider | undefined>;
  createWorldVerificationContext(
    context: WorldVerificationContextIssue,
  ):
    | WorldVerificationContextIssueResult
    | Promise<WorldVerificationContextIssueResult>;
  createService(service: ServiceListing): void | Promise<void>;
  getService(
    id: Identifier,
  ): ServiceListing | undefined | Promise<ServiceListing | undefined>;
  worldVerificationContextStatus(
    providerId: Identifier,
    canonicalRequestNonce: string,
    now: string,
  ): WorldVerificationContextStatus | Promise<WorldVerificationContextStatus>;
  commitWorldVerification(
    providerId: Identifier,
    claim: WorldVerificationReplayClaim,
    verification: VerifiedVerificationRecord,
    now: string,
  ): WorldVerificationCommitResult | Promise<WorldVerificationCommitResult>;
  updateService(service: ServiceListing): boolean | Promise<boolean>;
  listServices(): ServiceListing[] | Promise<ServiceListing[]>;
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

  createWorldVerificationContext(
    context: WorldVerificationContextIssue,
  ): WorldVerificationContextIssueResult {
    if (!/^0x[0-9a-f]{64}$/.test(context.canonicalRequestNonce))
      throw new Error('Invalid canonical World request nonce');
    if (context.providerId.length === 0)
      throw new Error('Invalid World request provider');
    const provider = this.providers.get(context.providerId);
    if (!provider) return 'PROVIDER_NOT_FOUND';
    if (!canIssueOrConsume(provider, context.issuedAt))
      return 'PROVIDER_ALREADY_VERIFIED';
    this.worldReplayStore.issue({
      ...context,
      verificationEpoch: verificationEpoch(provider),
    });
    return 'ISSUED';
  }

  worldVerificationContextStatus(
    providerId: Identifier,
    canonicalRequestNonce: string,
    now: string,
  ): WorldVerificationContextStatus {
    if (!/^0x[0-9a-f]{64}$/.test(canonicalRequestNonce))
      throw new Error('Invalid canonical World request nonce');
    const provider = this.providers.get(providerId);
    if (!provider) return 'WORLD_PROOF_INVALID';
    const status = this.worldReplayStore.status(
      providerId,
      canonicalRequestNonce,
      now,
      verificationEpoch(provider),
    );
    if (status !== 'ISSUED') return status;
    return canIssueOrConsume(provider, now) ? 'ISSUED' : 'WORLD_PROOF_INVALID';
  }

  commitWorldVerification(
    providerId: Identifier,
    claim: WorldVerificationReplayClaim,
    verification: VerifiedVerificationRecord,
    now: string,
  ): WorldVerificationCommitResult {
    const provider = this.providers.get(providerId);
    if (!provider) return 'PROVIDER_NOT_FOUND';
    if (!/^(0|[1-9][0-9]*)$/.test(claim.canonicalNullifier))
      throw new Error('Invalid canonical World nullifier');
    if (!/^0x[0-9a-f]{64}$/.test(claim.canonicalRequestNonce))
      throw new Error('Invalid canonical World request nonce');
    const previous = structuredClone(provider);
    const currentEpoch = verificationEpoch(provider);
    const contextStatus = this.worldReplayStore.status(
      providerId,
      claim.canonicalRequestNonce,
      now,
      currentEpoch,
    );
    if (contextStatus !== 'ISSUED') return contextStatus;
    if (!canIssueOrConsume(provider, now)) return 'WORLD_PROOF_INVALID';
    try {
      const claimed = this.worldReplayStore.claimAndCommit(
        providerId,
        claim,
        now,
        currentEpoch,
        () => {
          const updated = ProviderSchema.parse({
            ...provider,
            verification,
            updatedAt: now,
          });
          this.storeWorldVerifiedProvider(providerId, updated);
        },
      );
      return claimed === 'ISSUED' ? 'VERIFIED' : claimed;
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

  updateService(service: ServiceListing): boolean | Promise<boolean> {
    const current = this.services.get(service.id);
    if (!current) throw new Error('Missing service');
    if (current.status !== 'DRAFT' || current.providerId !== service.providerId)
      return false;
    this.services.set(service.id, structuredClone(service));
    return true;
  }

  listServices(): ServiceListing[] {
    return structuredClone([...this.services.values()]);
  }
}
