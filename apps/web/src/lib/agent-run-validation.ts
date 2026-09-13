import type {
  AgentRun,
  AgentRunStatus,
  AgentTask,
  ApiErrorCode,
} from '@proofserve/shared';

const orderedStatuses: readonly AgentRunStatus[] = [
  'CREATED',
  'DISCOVERING',
  'SELECTED',
  'PAYMENT_REQUIRED',
  'PAYING',
  'PAID',
  'EXECUTING',
  'COMPLETED',
];

type AgentRunFailureCode = Extract<
  ApiErrorCode,
  | 'VALIDATION_ERROR'
  | 'NO_ELIGIBLE_SERVICE'
  | 'BUDGET_EXCEEDED'
  | 'PAYMENT_FAILED'
  | 'SERVICE_EXECUTION_FAILED'
>;

/** Earliest status present when the merged T04/Y05 backend can emit each run failure. */
export const minimumFailureStage = {
  VALIDATION_ERROR: 'CREATED',
  NO_ELIGIBLE_SERVICE: 'DISCOVERING',
  BUDGET_EXCEEDED: 'SELECTED',
  PAYMENT_FAILED: 'CREATED',
  SERVICE_EXECUTION_FAILED: 'PAID',
} as const satisfies Record<AgentRunFailureCode, AgentRunStatus>;

function reachedStatus(run: AgentRun, status: AgentRunStatus): boolean {
  return run.events.some((event) => event.status === status);
}

function sameTask(left: AgentTask, right: AgentTask): boolean {
  return (
    left.capability === right.capability &&
    left.input.ticket === right.input.ticket &&
    left.budget.network === right.budget.network &&
    left.budget.asset === right.budget.asset &&
    left.budget.maxAmountAtomic === right.budget.maxAmountAtomic
  );
}

export function taskMatches(left: AgentTask, right: AgentTask): boolean {
  return sameTask(left, right);
}

export function safeHashScanTransactionUrl(run: AgentRun): string | null {
  const receipt = run.paymentReceipt;
  if (!receipt || receipt.paymentRequirements.network !== 'hedera:testnet')
    return null;
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)@([1-9][0-9]*)\.([0-9]{1,9})$/.exec(
      receipt.transactionId,
    );
  if (!match) return null;
  const transactionPath = `${match[1]}.${match[2]}.${match[3]}-${match[4]}-${match[5]!.padStart(9, '0')}`;
  const expected = `https://hashscan.io/testnet/transaction/${transactionPath}`;
  return receipt.transactionUrl === expected ? expected : null;
}

export function runReachedStatus(
  run: AgentRun,
  status: AgentRunStatus,
): boolean {
  return reachedStatus(run, status);
}

export function isSemanticallyValidRun(run: AgentRun): boolean {
  const finalEvent = run.events.at(-1);
  if (
    run.events[0]?.status !== 'CREATED' ||
    run.events[0].occurredAt !== run.createdAt ||
    finalEvent?.status !== run.status ||
    finalEvent.occurredAt !== run.updatedAt ||
    run.updatedAt < run.createdAt
  )
    return false;
  if (run.status === 'FAILED') {
    const code = run.error?.code;
    if (!code || !(code in minimumFailureStage)) return false;
    const required =
      minimumFailureStage[code as keyof typeof minimumFailureStage];
    if (!reachedStatus(run, required)) return false;
  }
  let previousIndex = -1;
  let previousTime = run.createdAt;
  for (const [index, event] of run.events.entries()) {
    if (
      event.occurredAt < previousTime ||
      event.occurredAt < run.createdAt ||
      event.occurredAt > run.updatedAt
    )
      return false;
    if (event.status === 'FAILED') {
      if (index !== run.events.length - 1) return false;
    } else {
      const statusIndex = orderedStatuses.indexOf(event.status);
      if (statusIndex !== previousIndex + 1) return false;
      previousIndex = statusIndex;
    }
    previousTime = event.occurredAt;
  }
  const reachedSelection = reachedStatus(run, 'SELECTED');
  const reachedRequirements = reachedStatus(run, 'PAYMENT_REQUIRED');
  const reachedSettlement = reachedStatus(run, 'PAID');
  if (
    (run.selectedServiceId !== null) !== reachedSelection ||
    (run.paymentRequirements !== null) !== reachedRequirements ||
    (run.paymentReceipt !== null) !== reachedSettlement ||
    (run.status === 'FAILED' && reachedStatus(run, 'COMPLETED'))
  )
    return false;
  if (
    run.paymentRequirements &&
    (run.paymentRequirements.network !== run.task.budget.network ||
      run.paymentRequirements.asset !== run.task.budget.asset ||
      BigInt(run.paymentRequirements.amountAtomic) >
        BigInt(run.task.budget.maxAmountAtomic))
  )
    return false;
  if (run.paymentReceipt) {
    const paidAt = run.events.find(
      (event) => event.status === 'PAID',
    )?.occurredAt;
    if (
      !paidAt ||
      run.paymentReceipt.settledAt < run.createdAt ||
      run.paymentReceipt.settledAt > paidAt ||
      safeHashScanTransactionUrl(run) === null
    )
      return false;
  }
  return true;
}

export function isValidRunAdvance(previous: AgentRun, next: AgentRun): boolean {
  if (
    previous.id !== next.id ||
    !sameTask(previous.task, next.task) ||
    previous.createdAt !== next.createdAt ||
    next.updatedAt < previous.updatedAt ||
    next.events.length < previous.events.length
  )
    return false;
  for (const [index, event] of previous.events.entries()) {
    const candidate = next.events[index];
    if (
      candidate?.status !== event.status ||
      candidate.occurredAt !== event.occurredAt
    )
      return false;
  }
  if (
    previous.selectedServiceId !== null &&
    previous.selectedServiceId !== next.selectedServiceId
  )
    return false;
  if (
    previous.paymentRequirements !== null &&
    JSON.stringify(previous.paymentRequirements) !==
      JSON.stringify(next.paymentRequirements)
  )
    return false;
  if (
    previous.paymentReceipt !== null &&
    JSON.stringify(previous.paymentReceipt) !==
      JSON.stringify(next.paymentReceipt)
  )
    return false;
  return isSemanticallyValidRun(next);
}

export function isTerminalRun(run: AgentRun): boolean {
  return run.status === 'COMPLETED' || run.status === 'FAILED';
}
