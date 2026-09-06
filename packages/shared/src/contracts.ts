import { z } from 'zod';

export const IdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const TimestampSchema = z.iso.datetime({ precision: 3 });
export const HederaNetworkSchema = z.enum(['hedera:testnet']);
export const AssetIdentifierSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
export const HederaAccountIdSchema = AssetIdentifierSchema;
export const HbarAssetSchema = z.literal('0.0.0');
// Canonical positive integers avoid floating-point conversion and ambiguous leading zeros.
export const AtomicAmountSchema = z.string().regex(/^[1-9][0-9]*$/);
export const EndpointUrlSchema = z.url({ protocol: /^https?$/ });
export const VerificationStatusSchema = z.enum([
  'UNVERIFIED',
  'VERIFIED',
  'EXPIRED',
]);
export const ServiceStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'SUSPENDED']);
export const AgentRunStatusSchema = z.enum([
  'CREATED',
  'DISCOVERING',
  'SELECTED',
  'PAYMENT_REQUIRED',
  'PAYING',
  'PAID',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
]);
export const ServiceCapabilitySchema = z.enum(['SUPPORT_TICKET_TRIAGE']);

export const PaymentPriceSchema = z.strictObject({
  network: HederaNetworkSchema,
  asset: HbarAssetSchema,
  amountAtomic: AtomicAmountSchema,
});
export const PaymentRequirementsSchema = PaymentPriceSchema.extend({
  payTo: HederaAccountIdSchema,
});
export const PaymentBudgetSchema = z.strictObject({
  network: HederaNetworkSchema,
  asset: HbarAssetSchema,
  maxAmountAtomic: AtomicAmountSchema,
});

const verificationMetadata = {
  providerId: IdentifierSchema,
  method: z.literal('WORLD_SELFIE_CHECK'),
};
export const VerificationRecordSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...verificationMetadata,
    status: z.literal(VerificationStatusSchema.enum.UNVERIFIED),
    verifiedAt: z.null(),
    expiresAt: z.null(),
  }),
  z
    .strictObject({
      ...verificationMetadata,
      status: z.enum([
        VerificationStatusSchema.enum.VERIFIED,
        VerificationStatusSchema.enum.EXPIRED,
      ]),
      verifiedAt: TimestampSchema,
      expiresAt: TimestampSchema,
    })
    .refine((record) => record.expiresAt > record.verifiedAt, {
      message: 'expiresAt must be after verifiedAt',
      path: ['expiresAt'],
    }),
]);
export const ProviderSchema = z
  .strictObject({
    id: IdentifierSchema,
    displayName: z.string().min(1).max(120),
    payoutAccount: HederaAccountIdSchema,
    verification: VerificationRecordSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .refine((provider) => provider.id === provider.verification.providerId, {
    message: 'Verification must belong to this provider',
    path: ['verification', 'providerId'],
  });
export const ServiceListingSchema = z.strictObject({
  id: IdentifierSchema,
  providerId: IdentifierSchema,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  capability: ServiceCapabilitySchema,
  endpoint: EndpointUrlSchema,
  status: ServiceStatusSchema,
  paymentRequirements: PaymentRequirementsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const TriageInputSchema = z.strictObject({
  ticket: z.string().min(1).max(10000),
});
export const TriageResultSchema = z.strictObject({
  category: z.string().min(1).max(120),
  urgency: z.enum(['low', 'medium', 'high']),
  summary: z.string().min(1).max(1000),
  suggestedAction: z.string().min(1).max(2000),
});
export const AgentTaskSchema = z.strictObject({
  capability: ServiceCapabilitySchema,
  input: TriageInputSchema,
  budget: PaymentBudgetSchema,
});
export const PaymentReceiptSchema = z.strictObject({
  id: IdentifierSchema,
  runId: IdentifierSchema,
  serviceId: IdentifierSchema,
  paymentRequirements: PaymentRequirementsSchema,
  transactionId: z.string().min(1).max(256),
  transactionUrl: EndpointUrlSchema,
  settledAt: TimestampSchema,
});
export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'PROVIDER_NOT_FOUND',
  'SERVICE_NOT_FOUND',
  'RUN_NOT_FOUND',
  'PROVIDER_VERIFICATION_REQUIRED',
  'SERVICE_STATE_CONFLICT',
  'ENDPOINT_NOT_ALLOWED',
  'NO_ELIGIBLE_SERVICE',
  'BUDGET_EXCEEDED',
  'PAYMENT_FAILED',
  'SERVICE_EXECUTION_FAILED',
  'WORLD_PROOF_INVALID',
  'WORLD_PROOF_REPLAYED',
  'PROVIDER_ALREADY_VERIFIED',
  'WORLD_VERIFICATION_UNAVAILABLE',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INTERNAL_ERROR',
]);
export const ApiErrorSchema = z.strictObject({
  code: ApiErrorCodeSchema,
  message: z.string().min(1).max(1000),
});
export const ApiErrorResponseSchema = z.strictObject({ error: ApiErrorSchema });
export const AgentRunEventSchema = z.strictObject({
  status: AgentRunStatusSchema,
  occurredAt: TimestampSchema,
});
export const AgentRunSchema = z
  .strictObject({
    id: IdentifierSchema,
    task: AgentTaskSchema,
    status: AgentRunStatusSchema,
    selectedServiceId: IdentifierSchema.nullable(),
    paymentRequirements: PaymentRequirementsSchema.nullable(),
    paymentReceipt: PaymentReceiptSchema.nullable(),
    result: TriageResultSchema.nullable(),
    error: ApiErrorSchema.nullable(),
    events: z.array(AgentRunEventSchema).min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .superRefine((run, ctx) => {
    const status = AgentRunStatusSchema.enum;
    const needsSelection = [
      status.SELECTED,
      status.PAYMENT_REQUIRED,
      status.PAYING,
      status.PAID,
      status.EXECUTING,
      status.COMPLETED,
    ];
    const needsRequirements = needsSelection.filter(
      (value) => value !== status.SELECTED,
    );
    const needsReceipt = [status.PAID, status.EXECUTING, status.COMPLETED];
    const requireField = (missing: boolean, field: string) => {
      if (missing)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `Invalid ${field} for run state`,
        });
    };
    requireField(
      needsSelection.some((value) => value === run.status) &&
        run.selectedServiceId === null,
      'selectedServiceId',
    );
    requireField(
      needsRequirements.some((value) => value === run.status) &&
        run.paymentRequirements === null,
      'paymentRequirements',
    );
    requireField(
      needsReceipt.some((value) => value === run.status) &&
        run.paymentReceipt === null,
      'paymentReceipt',
    );
    requireField(
      (run.status === status.COMPLETED) !== (run.result !== null),
      'result',
    );
    requireField(
      (run.status === status.FAILED) !== (run.error !== null),
      'error',
    );
    requireField(run.events.at(-1)?.status !== run.status, 'events');
    if (run.paymentReceipt !== null) {
      requireField(
        run.paymentReceipt.runId !== run.id ||
          run.paymentReceipt.serviceId !== run.selectedServiceId,
        'paymentReceipt',
      );
    }
  });

export type Identifier = z.infer<typeof IdentifierSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type HederaNetwork = z.infer<typeof HederaNetworkSchema>;
export type AssetIdentifier = z.infer<typeof AssetIdentifierSchema>;
export type HederaAccountId = z.infer<typeof HederaAccountIdSchema>;
export type HbarAsset = z.infer<typeof HbarAssetSchema>;
export type AtomicAmount = z.infer<typeof AtomicAmountSchema>;
export type EndpointUrl = z.infer<typeof EndpointUrlSchema>;
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export type ServiceCapability = z.infer<typeof ServiceCapabilitySchema>;
export type PaymentPrice = z.infer<typeof PaymentPriceSchema>;
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;
export type PaymentBudget = z.infer<typeof PaymentBudgetSchema>;
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type ServiceListing = z.infer<typeof ServiceListingSchema>;
export type TriageInput = z.infer<typeof TriageInputSchema>;
export type TriageResult = z.infer<typeof TriageResultSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
