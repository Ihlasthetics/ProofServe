import {
  AgentRunSchema,
  AgentRunStatusSchema,
  AgentTaskSchema,
  ApiErrorResponseSchema,
  PaymentReceiptSchema,
  ProviderSchema,
  ServiceListingSchema,
  VerificationRecordSchema,
} from './contracts.js';

/** Development/test data only. No verification, inference, or payment occurred. */
export const fixtureNotice =
  'FICTIONAL DEVELOPMENT/TEST DATA — never evidence of verification or payment.';
const createdAt = '2026-09-06T10:00:00.000Z';
export const verifiedVerificationFixture = VerificationRecordSchema.parse({
  providerId: 'provider_example_verified',
  method: 'WORLD_SELFIE_CHECK',
  status: 'VERIFIED',
  verifiedAt: createdAt,
  expiresAt: '2026-09-07T10:00:00.000Z',
});
export const unverifiedVerificationFixture = VerificationRecordSchema.parse({
  providerId: 'provider_example_unverified',
  method: 'WORLD_SELFIE_CHECK',
  status: 'UNVERIFIED',
  verifiedAt: null,
  expiresAt: null,
});
export const verifiedProviderFixture = ProviderSchema.parse({
  id: verifiedVerificationFixture.providerId,
  displayName: 'Fictional verified operator',
  payoutAccount: '0.0.123456',
  verification: verifiedVerificationFixture,
  createdAt,
  updatedAt: createdAt,
});
export const unverifiedProviderFixture = ProviderSchema.parse({
  id: unverifiedVerificationFixture.providerId,
  displayName: 'Fictional unverified operator',
  payoutAccount: '0.0.123457',
  verification: unverifiedVerificationFixture,
  createdAt,
  updatedAt: createdAt,
});
export const activeServiceFixture = ServiceListingSchema.parse({
  id: 'service_example_active',
  providerId: verifiedProviderFixture.id,
  name: 'Example support ticket triage',
  description: 'Fictional development/test service.',
  capability: 'SUPPORT_TICKET_TRIAGE',
  endpoint: 'https://triage.example.test/v1/triage',
  status: 'ACTIVE',
  paymentRequirements: {
    network: 'hedera:testnet',
    asset: '0.0.0',
    amountAtomic: '1000000',
    payTo: verifiedProviderFixture.payoutAccount,
  },
  createdAt,
  updatedAt: createdAt,
});
export const draftServiceFixture = ServiceListingSchema.parse({
  ...activeServiceFixture,
  id: 'service_example_draft',
  providerId: unverifiedProviderFixture.id,
  status: 'DRAFT',
  paymentRequirements: {
    ...activeServiceFixture.paymentRequirements,
    payTo: unverifiedProviderFixture.payoutAccount,
  },
});
export const agentTaskFixture = AgentTaskSchema.parse({
  capability: activeServiceFixture.capability,
  input: { ticket: 'My payment was taken twice and nobody answered me.' },
  budget: {
    network: 'hedera:testnet',
    asset: '0.0.0',
    maxAmountAtomic: '2000000',
  },
});
export const fictionalPaymentReceiptFixture = PaymentReceiptSchema.parse({
  id: 'receipt_fictional_example',
  runId: 'run_example_completed',
  serviceId: activeServiceFixture.id,
  paymentRequirements: activeServiceFixture.paymentRequirements,
  transactionId: 'FICTIONAL-NOT-A-HEDERA-TRANSACTION',
  transactionUrl: 'https://explorer.example.test/fictional-transaction',
  settledAt: '2026-09-06T10:00:05.000Z',
});
export const createdAgentRunFixture = AgentRunSchema.parse({
  id: 'run_example_created',
  task: agentTaskFixture,
  status: 'CREATED',
  selectedServiceId: null,
  paymentRequirements: null,
  paymentReceipt: null,
  result: null,
  error: null,
  events: [{ status: 'CREATED', occurredAt: createdAt }],
  createdAt,
  updatedAt: createdAt,
});
export const completedAgentRunFixture = AgentRunSchema.parse({
  ...createdAgentRunFixture,
  id: fictionalPaymentReceiptFixture.runId,
  status: 'COMPLETED',
  selectedServiceId: activeServiceFixture.id,
  paymentRequirements: activeServiceFixture.paymentRequirements,
  paymentReceipt: fictionalPaymentReceiptFixture,
  result: {
    category: 'billing',
    urgency: 'high',
    summary: 'Possible duplicate payment',
    suggestedAction: 'Review payment records and contact the customer',
  },
  events: AgentRunStatusSchema.options
    .filter((status) => status !== 'FAILED')
    .map((status, index) => ({
      status,
      occurredAt: `2026-09-06T10:00:0${index}.000Z`,
    })),
  updatedAt: '2026-09-06T10:00:07.000Z',
});
export const apiErrorFixture = ApiErrorResponseSchema.parse({
  error: {
    code: 'PROVIDER_VERIFICATION_REQUIRED',
    message: 'Current provider verification is required.',
  },
});
