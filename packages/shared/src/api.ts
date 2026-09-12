import { z } from 'zod';
import {
  AgentRunSchema,
  AgentTaskSchema,
  AtomicAmountSchema,
  HederaAccountIdSchema,
  HederaNetworkSchema,
  IdentifierSchema,
  PaymentPriceSchema,
  ProviderSchema,
  ServiceCapabilitySchema,
  ServiceListingSchema,
  VerifiedVerificationRecordSchema,
} from './contracts.js';

export const ProviderParamsSchema = z.strictObject({ id: IdentifierSchema });
export const ServiceParamsSchema = z.strictObject({ id: IdentifierSchema });
export const AgentRunParamsSchema = z.strictObject({ runId: IdentifierSchema });
export const CreateProviderRequestSchema = z.strictObject({
  displayName: ProviderSchema.shape.displayName,
  payoutAccount: HederaAccountIdSchema,
});
export const CreateProviderResponseSchema = ProviderSchema;
const WorldHexBytesSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/);
const WorldFieldElementSchema = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const WorldEnvironmentSchema = z.enum(['production', 'staging', 'sandbox']);
const WorldActionSchema = z.string().min(1).max(128);
const WorldIntegritySignatureSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[0-9a-fA-F]+$/)
  .refine((signature) => signature.length % 2 === 0);
const WorldIntegrityBundleSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    signature_format: z.enum(['apple_app_attest', 'android_keystore']),
    timestamp: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    signature: WorldIntegritySignatureSchema,
    jwt: z.string().min(1).max(8192),
  })
  .refine(
    (bundle) =>
      new TextEncoder().encode(JSON.stringify(bundle)).byteLength <= 8192,
  );
const WorldSelfieResponseSchema = z.strictObject({
  identifier: z.literal('selfie'),
  signal_hash: WorldFieldElementSchema,
  proof: WorldHexBytesSchema,
  merkle_root: WorldFieldElementSchema,
  nullifier: WorldFieldElementSchema,
});

/** IDKit 4.x currently returns this legacy 3.0 result for selfieCheckLegacy. */
export const WorldVerificationRequestSchema = z.strictObject({
  protocol_version: z.literal('3.0'),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  action: WorldActionSchema,
  action_description: z.string().optional(),
  responses: z.tuple([WorldSelfieResponseSchema]),
  user_presence_completed: z.literal(true),
  environment: WorldEnvironmentSchema,
  integrity_bundle: WorldIntegrityBundleSchema.optional(),
});
export const WorldVerificationContextRequestSchema = z.strictObject({});
export const WorldVerificationContextResponseSchema = z.strictObject({
  app_id: z.string().regex(/^app_[A-Za-z0-9_-]{1,128}$/),
  action: WorldActionSchema,
  signal: z.string().min(1).max(256),
  environment: WorldEnvironmentSchema,
  rp_context: z
    .strictObject({
      rp_id: z.string().regex(/^rp_[A-Za-z0-9_-]{1,128}$/),
      nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      created_at: z.number().int().nonnegative(),
      expires_at: z.number().int().nonnegative(),
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    })
    .refine((context) => context.expires_at > context.created_at, {
      message: 'expires_at must be after created_at',
      path: ['expires_at'],
    }),
  allow_legacy_proofs: z.literal(true),
  require_user_presence: z.literal(true),
});
export const WorldVerificationResponseSchema = VerifiedVerificationRecordSchema;
export const CreateServiceRequestSchema = z.strictObject({
  providerId: IdentifierSchema,
  name: ServiceListingSchema.shape.name,
  description: ServiceListingSchema.shape.description,
  capability: ServiceCapabilitySchema,
  price: PaymentPriceSchema,
});
export const CreateServiceResponseSchema = ServiceListingSchema;
export const ActivateServiceRequestSchema = z.strictObject({});
export const ActivateServiceResponseSchema = ServiceListingSchema;
export const ListServicesQuerySchema = z.strictObject({
  capability: ServiceCapabilitySchema.optional(),
  network: HederaNetworkSchema.optional(),
  asset: PaymentPriceSchema.shape.asset.optional(),
  maxAmountAtomic: AtomicAmountSchema.optional(),
});
export const DiscoveryServiceSchema = z
  .strictObject({ service: ServiceListingSchema, provider: ProviderSchema })
  .refine((entry) => entry.service.providerId === entry.provider.id, {
    message: 'Service must belong to the paired provider',
    path: ['provider', 'id'],
  });
export const ListServicesResponseSchema = z.strictObject({
  services: z.array(DiscoveryServiceSchema),
});
export const CreateAgentRunRequestSchema = AgentTaskSchema;
export const CreateAgentRunResponseSchema = AgentRunSchema;
export const GetAgentRunResponseSchema = AgentRunSchema;

export type ProviderParams = z.infer<typeof ProviderParamsSchema>;
export type ServiceParams = z.infer<typeof ServiceParamsSchema>;
export type AgentRunParams = z.infer<typeof AgentRunParamsSchema>;
export type CreateProviderRequest = z.infer<typeof CreateProviderRequestSchema>;
export type CreateProviderResponse = z.infer<
  typeof CreateProviderResponseSchema
>;
export type WorldVerificationRequest = z.infer<
  typeof WorldVerificationRequestSchema
>;
export type WorldVerificationContextRequest = z.infer<
  typeof WorldVerificationContextRequestSchema
>;
export type WorldVerificationContextResponse = z.infer<
  typeof WorldVerificationContextResponseSchema
>;
export type WorldVerificationResponse = z.infer<
  typeof WorldVerificationResponseSchema
>;
export type CreateServiceRequest = z.infer<typeof CreateServiceRequestSchema>;
export type CreateServiceResponse = z.infer<typeof CreateServiceResponseSchema>;
export type ActivateServiceRequest = z.infer<
  typeof ActivateServiceRequestSchema
>;
export type ActivateServiceResponse = z.infer<
  typeof ActivateServiceResponseSchema
>;
export type ListServicesQuery = z.infer<typeof ListServicesQuerySchema>;
export type DiscoveryService = z.infer<typeof DiscoveryServiceSchema>;
export type ListServicesResponse = z.infer<typeof ListServicesResponseSchema>;
export type CreateAgentRunRequest = z.infer<typeof CreateAgentRunRequestSchema>;
export type CreateAgentRunResponse = z.infer<
  typeof CreateAgentRunResponseSchema
>;
export type GetAgentRunResponse = z.infer<typeof GetAgentRunResponseSchema>;
