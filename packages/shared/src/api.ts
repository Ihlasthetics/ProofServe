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
  VerificationRecordSchema,
  VerificationStatusSchema,
} from './contracts.js';

export const ProviderParamsSchema = z.strictObject({ id: IdentifierSchema });
export const ServiceParamsSchema = z.strictObject({ id: IdentifierSchema });
export const AgentRunParamsSchema = z.strictObject({ runId: IdentifierSchema });
export const CreateProviderRequestSchema = z.strictObject({
  displayName: ProviderSchema.shape.displayName,
  payoutAccount: HederaAccountIdSchema,
});
export const CreateProviderResponseSchema = ProviderSchema;
// Y04 defines the World request with the pinned SDK; never accept a guessed proof shape here.
export const WorldVerificationResponseSchema = VerificationRecordSchema.refine(
  (record) => record.status === VerificationStatusSchema.enum.VERIFIED,
  {
    message: 'Successful World verification must return VERIFIED metadata',
    path: ['status'],
  },
);
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
