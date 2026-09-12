import type {
  CreateProviderRequest,
  CreateServiceRequest,
  PaymentPrice,
  Provider,
  ServiceListing,
} from '@proofserve/shared';

// Call only with shared-schema parsed values. Amounts are canonical integer
// strings; equality never converts them to floating-point numbers.
function samePrice(left: PaymentPrice, right: PaymentPrice) {
  return (
    left.network === right.network &&
    left.asset === right.asset &&
    left.amountAtomic === right.amountAtomic
  );
}

export function bindsProvider(
  input: CreateProviderRequest,
  returned: Provider,
) {
  return (
    returned.verification.status === 'UNVERIFIED' &&
    returned.displayName === input.displayName &&
    returned.payoutAccount === input.payoutAccount
  );
}

export function bindsDraft(
  input: CreateServiceRequest,
  returned: ServiceListing,
) {
  return (
    returned.status === 'DRAFT' &&
    returned.providerId === input.providerId &&
    returned.name === input.name &&
    returned.description === input.description &&
    returned.capability === input.capability &&
    samePrice(returned.paymentRequirements, input.price)
  );
}

export function bindsDraftProvider(
  provider: Provider,
  returned: ServiceListing,
) {
  return (
    returned.providerId === provider.id &&
    returned.paymentRequirements.payTo === provider.payoutAccount
  );
}

export function bindsActivationId(id: string, returned: ServiceListing) {
  return returned.id === id && returned.status === 'ACTIVE';
}

export function bindsActivation(
  draft: ServiceListing,
  returned: ServiceListing,
) {
  // Exhaustive by schema type: newly added service fields require a binding rule.
  // The activation contract permits changes only to status and updatedAt.
  const immutable: Record<
    keyof Omit<ServiceListing, 'status' | 'updatedAt'>,
    boolean
  > = {
    id: returned.id === draft.id,
    providerId: returned.providerId === draft.providerId,
    name: returned.name === draft.name,
    description: returned.description === draft.description,
    capability: returned.capability === draft.capability,
    endpoint: returned.endpoint === draft.endpoint,
    createdAt: returned.createdAt === draft.createdAt,
    paymentRequirements:
      samePrice(returned.paymentRequirements, draft.paymentRequirements) &&
      returned.paymentRequirements.payTo === draft.paymentRequirements.payTo,
  };
  return (
    bindsActivationId(draft.id, returned) &&
    Object.values(immutable).every(Boolean)
  );
}
