import type { AgentTask } from '@proofserve/shared';

export function agentRunFormData(data: FormData): AgentTask {
  const ticket = data.get('ticket');
  const maxAmountAtomic = data.get('maxAmountAtomic');
  return {
    capability: 'SUPPORT_TICKET_TRIAGE',
    input: { ticket: typeof ticket === 'string' ? ticket : '' },
    budget: {
      network: 'hedera:testnet',
      asset: '0.0.0',
      maxAmountAtomic:
        typeof maxAmountAtomic === 'string' ? maxAmountAtomic : '',
    },
  };
}
