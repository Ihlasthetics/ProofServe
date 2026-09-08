import {
  AgentTaskSchema,
  DiscoveryServiceSchema,
  TimestampSchema,
  type AgentTask,
  type DiscoveryService,
  type Timestamp,
} from '@proofserve/shared';

/** A local selection failure, not a shared API error code. */
export class ServiceSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceSelectionError';
  }
}

/** Returns a validated snapshot; the caller supplies the selection time. */
export function selectService(
  task: Readonly<AgentTask>,
  candidates: readonly DiscoveryService[],
  asOf: Timestamp,
): DiscoveryService {
  const parsedTask = AgentTaskSchema.safeParse(task);
  const parsedTime = TimestampSchema.safeParse(asOf);
  const parsedCandidates = DiscoveryServiceSchema.array().safeParse(candidates);
  if (!parsedTask.success || !parsedTime.success || !parsedCandidates.success) {
    throw new ServiceSelectionError('Invalid selector input');
  }

  // Reject duplicates across the whole collection before checking eligibility.
  const ids = new Set<string>();
  for (const { service } of parsedCandidates.data) {
    if (ids.has(service.id)) {
      throw new ServiceSelectionError('Duplicate service ID');
    }
    ids.add(service.id);
  }

  const currentTask = parsedTask.data;
  const time = parsedTime.data;
  const maximum = BigInt(currentTask.budget.maxAmountAtomic);
  let selected: DiscoveryService | undefined;
  let selectedPrice: bigint | undefined;
  for (const candidate of parsedCandidates.data) {
    const { service, provider } = candidate;
    const verification = provider.verification;
    const payment = service.paymentRequirements;
    // Shared timestamps are canonical UTC strings with millisecond precision.
    if (
      service.status !== 'ACTIVE' ||
      service.capability !== currentTask.capability ||
      verification.status !== 'VERIFIED' ||
      verification.verifiedAt > time ||
      time >= verification.expiresAt ||
      payment.network !== currentTask.budget.network ||
      payment.asset !== currentTask.budget.asset
    ) {
      continue;
    }
    const price = BigInt(payment.amountAtomic);
    if (price > maximum) continue;
    if (
      selected === undefined ||
      selectedPrice === undefined ||
      price < selectedPrice ||
      (price === selectedPrice && service.id < selected.service.id)
    ) {
      selected = candidate;
      selectedPrice = price;
    }
  }
  if (selected === undefined) {
    throw new ServiceSelectionError('No eligible service');
  }
  return selected;
}
