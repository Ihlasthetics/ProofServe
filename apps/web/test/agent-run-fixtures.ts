import { AgentRunSchema, type AgentRunStatus } from '@proofserve/shared';

export const agentTask = {
  capability: 'SUPPORT_TICKET_TRIAGE' as const,
  input: { ticket: 'My card was charged twice.' },
  budget: {
    network: 'hedera:testnet' as const,
    asset: '0.0.0' as const,
    maxAmountAtomic: '2000000',
  },
};

const transactionId = '0.0.7162784@1788940800.123456789';
const requirements = {
  network: 'hedera:testnet' as const,
  asset: '0.0.0' as const,
  amountAtomic: '1000000',
  payTo: '0.0.123456',
};
const times = [
  '2026-09-12T10:00:00.000Z',
  '2026-09-12T10:00:01.000Z',
  '2026-09-12T10:00:02.000Z',
  '2026-09-12T10:00:03.000Z',
  '2026-09-12T10:00:04.000Z',
  '2026-09-12T10:00:05.000Z',
  '2026-09-12T10:00:06.000Z',
  '2026-09-12T10:00:07.000Z',
];
const normal: readonly AgentRunStatus[] = [
  'CREATED',
  'DISCOVERING',
  'SELECTED',
  'PAYMENT_REQUIRED',
  'PAYING',
  'PAID',
  'EXECUTING',
  'COMPLETED',
];

export function agentRun(status: AgentRunStatus = 'CREATED') {
  if (status === 'FAILED') return failedAgentRunAfter('DISCOVERING');
  return runThrough(status, status, null);
}

export function failedAgentRunAfter(
  lastStatus: Exclude<AgentRunStatus, 'COMPLETED' | 'FAILED'>,
) {
  return runThrough(lastStatus, 'FAILED', {
    code:
      lastStatus === 'DISCOVERING'
        ? 'NO_ELIGIBLE_SERVICE'
        : normal.indexOf(lastStatus) >= normal.indexOf('PAID')
          ? 'SERVICE_EXECUTION_FAILED'
          : 'PAYMENT_FAILED',
    message: 'backend diagnostic must not be rendered',
  });
}

function runThrough(
  lastStatus: Exclude<AgentRunStatus, 'FAILED'>,
  status: AgentRunStatus,
  error: {
    code: 'NO_ELIGIBLE_SERVICE' | 'PAYMENT_FAILED' | 'SERVICE_EXECUTION_FAILED';
    message: string;
  } | null,
) {
  const statusIndex = normal.indexOf(lastStatus);
  const statuses: readonly AgentRunStatus[] = [
    ...normal.slice(0, statusIndex + 1),
    ...(status === 'FAILED' ? (['FAILED'] as const) : []),
  ];
  const hasSelection = statusIndex >= 2;
  const hasRequirements = statusIndex >= 3;
  const hasReceipt = statusIndex >= 5;
  return AgentRunSchema.parse({
    id: 'run_live_123',
    task: agentTask,
    status,
    selectedServiceId: hasSelection ? 'service_live_123' : null,
    paymentRequirements: hasRequirements ? requirements : null,
    paymentReceipt: hasReceipt
      ? {
          id: 'receipt_live_123',
          runId: 'run_live_123',
          serviceId: 'service_live_123',
          paymentRequirements: requirements,
          transactionId,
          transactionUrl:
            'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
          settledAt: times[5],
        }
      : null,
    result:
      status === 'COMPLETED'
        ? {
            category: 'billing',
            urgency: 'high',
            summary: 'Possible duplicate payment',
            suggestedAction: 'Review payment records and contact the customer',
          }
        : null,
    error,
    events: statuses.map((eventStatus, index) => ({
      status: eventStatus,
      occurredAt: times[index],
    })),
    createdAt: times[0],
    updatedAt: times[statuses.length - 1],
  });
}
