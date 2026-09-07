import {
  AgentRunSchema,
  TimestampSchema,
  type AgentRun,
  type AgentRunStatus,
  type Timestamp,
} from '@proofserve/shared';

/** Local commands, not shared API requests. All domain data uses shared types. */
export type AgentTransition = { occurredAt: Timestamp } & (
  | { status: 'DISCOVERING' | 'PAYING' | 'EXECUTING' }
  | {
      status: 'SELECTED';
      selectedServiceId: NonNullable<AgentRun['selectedServiceId']>;
    }
  | {
      status: 'PAYMENT_REQUIRED';
      paymentRequirements: NonNullable<AgentRun['paymentRequirements']>;
    }
  | { status: 'PAID'; paymentReceipt: NonNullable<AgentRun['paymentReceipt']> }
  | { status: 'COMPLETED'; result: NonNullable<AgentRun['result']> }
  | { status: 'FAILED'; error: NonNullable<AgentRun['error']> }
);

const nextStatus: Record<AgentRunStatus, AgentRunStatus | null> = {
  CREATED: 'DISCOVERING',
  DISCOVERING: 'SELECTED',
  SELECTED: 'PAYMENT_REQUIRED',
  PAYMENT_REQUIRED: 'PAYING',
  PAYING: 'PAID',
  PAID: 'EXECUTING',
  EXECUTING: 'COMPLETED',
  COMPLETED: null,
  FAILED: null,
};

/** A rejected local command; never an invented shared/API error code. */
export class AgentTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTransitionError';
  }
}

/** Pure transition: caller supplies the time and evidence; no settlement is performed. */
export function transitionAgentRun(
  run: AgentRun,
  transition: AgentTransition,
): AgentRun {
  const input = AgentRunSchema.safeParse(run);
  if (!input.success) throw new AgentTransitionError('Invalid input run');
  const current = input.data;
  const next = nextStatus[current.status];
  if (
    next === null ||
    (transition.status !== next && transition.status !== 'FAILED')
  ) {
    throw new AgentTransitionError(
      `Illegal transition: ${current.status} -> ${transition.status}`,
    );
  }
  const time = TimestampSchema.safeParse(transition.occurredAt);
  if (!time.success)
    throw new AgentTransitionError('Invalid transition timestamp');
  // Shared schemas validate timestamp syntax but leave chronological ordering to T01.
  let previousTime = current.createdAt;
  for (const event of current.events) {
    if (event.occurredAt < previousTime)
      throw new AgentTransitionError('Nonchronological input events');
    previousTime = event.occurredAt;
  }
  if (time.data < current.updatedAt || time.data < previousTime) {
    throw new AgentTransitionError(
      'Transition timestamp precedes the run timeline',
    );
  }

  const snapshot = {
    ...current,
    status: transition.status,
    updatedAt: time.data,
    events: [
      ...current.events,
      { status: transition.status, occurredAt: time.data },
    ],
    // Explicit fields prevent commands from replacing unrelated known data.
    selectedServiceId:
      transition.status === 'SELECTED'
        ? transition.selectedServiceId
        : current.selectedServiceId,
    paymentRequirements:
      transition.status === 'PAYMENT_REQUIRED'
        ? transition.paymentRequirements
        : current.paymentRequirements,
    paymentReceipt:
      transition.status === 'PAID'
        ? transition.paymentReceipt
        : current.paymentReceipt,
    result: transition.status === 'COMPLETED' ? transition.result : null,
    error: transition.status === 'FAILED' ? transition.error : null,
  };
  // Also enforces required destination data and all six receipt matching fields.
  const output = AgentRunSchema.safeParse(snapshot);
  if (!output.success)
    throw new AgentTransitionError('Invalid destination data');
  return output.data;
}
