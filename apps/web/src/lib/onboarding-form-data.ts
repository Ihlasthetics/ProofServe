import type {
  CreateProviderRequest,
  CreateServiceRequest,
} from '@proofserve/shared';

function text(data: FormData, name: string) {
  const values = data.getAll(name);
  // Missing, duplicate and non-text values become invalid input for shared schemas.
  return values.length === 1 && typeof values[0] === 'string'
    ? values[0].trim()
    : '';
}
export function providerFormData(data: FormData): CreateProviderRequest {
  return {
    displayName: text(data, 'displayName'),
    payoutAccount: text(data, 'payoutAccount'),
  };
}
export function draftFormData(
  data: FormData,
): Omit<CreateServiceRequest, 'providerId'> {
  return {
    name: text(data, 'name'),
    description: text(data, 'description'),
    capability: 'SUPPORT_TICKET_TRIAGE',
    price: {
      network: 'hedera:testnet',
      asset: '0.0.0',
      amountAtomic: text(data, 'amountAtomic'),
    },
  };
}
