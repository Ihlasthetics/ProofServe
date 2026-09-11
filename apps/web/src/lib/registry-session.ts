import type {
  CreateProviderRequest,
  CreateServiceRequest,
  ListServicesResponse,
  Provider,
  ServiceListing,
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
    createDraft(input: Omit<CreateServiceRequest, 'providerId'>) {
      const provider = state.provider;
      if (!provider || state.draft) return Promise.resolve();
      return run('draft', async () => {
        update({
          draft: await client.createService({
            ...input,
            providerId: provider.id,
          }),
        });
      });
    },
    activate() {
      const draft = state.draft;
      if (!draft) return Promise.resolve();
      return run('activation', async () => {
        await client.activateService(draft.id);
        // I03 has no verified provider flow. Even a schema-valid ACTIVE response
        // cannot promote this unverified session or establish payment eligibility.
        throw new RegistryRequestError(
          'The registry returned an unexpected activation success for this unverified session. No local activation was applied.',
        );
      });
    },
    refresh() {
      return run('listing', async () => {
        update({ listing: null });
        const listing = await client.listServices();
        update({ listing, listingCheckedAt: now() });
      });
    },
  };
}
