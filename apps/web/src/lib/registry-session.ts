import {
  ProviderSchema,
  WorldVerificationResponseSchema,
  type CreateProviderRequest,
  type CreateServiceRequest,
  type ListServicesResponse,
  type Provider,
  type ServiceListing,
  type WorldVerificationResponse,
} from '@proofserve/shared';
import { createRegistryClient, RegistryRequestError } from './registry-client';

type Operation = 'provider' | 'draft' | 'activation' | 'listing';
export interface RegistryState {
  provider: Provider | null;
  draft: ServiceListing | null;
  listing: ListServicesResponse | null;
  listingCheckedAt: string | null;
  pending: Partial<Record<Operation, boolean>>;
  errors: Partial<Record<Operation, string>>;
}

// The synchronous pending gate also covers repeated events before React renders.
export function createRegistrySession(
  client = createRegistryClient(),
  now = () => new Date().toISOString(),
) {
  let state: RegistryState = {
    provider: null,
    draft: null,
    listing: null,
    listingCheckedAt: null,
    pending: {},
    errors: {},
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<RegistryState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  async function run(operation: Operation, work: () => Promise<void>) {
    if (state.pending[operation]) return;
    update({
      pending: { ...state.pending, [operation]: true },
      errors: { ...state.errors, [operation]: undefined },
    });
    try {
      await work();
    } catch (error) {
      update({
        errors: {
          ...state.errors,
          [operation]:
            error instanceof RegistryRequestError
              ? error.message
              : 'The request could not be completed. No local success was applied.',
        },
      });
    } finally {
      update({ pending: { ...state.pending, [operation]: false } });
    }
  }
  let listingRequest: Promise<void> | null = null;
  let listingVersion = 0;
  let activationResponsePending = false;
  function refresh(): Promise<void> {
    if (listingRequest || activationResponsePending) return Promise.resolve();
    const version = ++listingVersion;
    listingRequest = run('listing', async () => {
      update({ listing: null });
      const listing = await client.listServices();
      if (version === listingVersion)
        update({ listing, listingCheckedAt: now() });
    }).finally(() => {
      listingRequest = null;
    });
    return listingRequest;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    createProvider(input: CreateProviderRequest) {
      if (state.provider) return Promise.resolve();
      return run('provider', async () => {
        update({ provider: await client.createProvider(input) });
      });
    },
    applyWorldVerification(verificationInput: WorldVerificationResponse) {
      const provider = state.provider;
      const verification =
        WorldVerificationResponseSchema.safeParse(verificationInput);
      if (
        provider === null ||
        provider.verification.status !== 'UNVERIFIED' ||
        !verification.success ||
        verification.data.providerId !== provider.id
      ) {
        return false;
      }
      const updatedProvider = ProviderSchema.safeParse({
        ...provider,
        verification: verification.data,
      });
      if (!updatedProvider.success) return false;
      update({ provider: updatedProvider.data });
      return true;
    },
    createDraft(input: Omit<CreateServiceRequest, 'providerId'>) {
      const provider = state.provider;
      if (!provider || state.draft) return Promise.resolve();
      return run('draft', async () => {
        update({
          draft: await client.createService(
            {
              ...input,
              providerId: provider.id,
            },
            provider,
          ),
        });
      });
    },
    activate() {
      const draft = state.draft;
      if (!draft || draft.status === 'ACTIVE') return Promise.resolve();
      return run('activation', async () => {
        // Invalidate snapshots (including in-flight reads) before attempting a
        // mutation. A rejected response must not leave old eligibility visible.
        ++listingVersion;
        update({ listing: null });
        activationResponsePending = true;
        let activated: ServiceListing;
        try {
          activated = await client.activateService(draft);
        } finally {
          activationResponsePending = false;
        }
        // The validated service is authoritative; it does not establish a provider
        // verification record or payment eligibility. Those require registry reads.
        ++listingVersion;
        update({ draft: activated, listing: null });
        // Discard any pre-activation listing and ensure reconciliation starts after
        // activation, even when a user-triggered refresh was already pending.
        await listingRequest;
        await refresh();
      });
    },
    refresh,
  };
}
