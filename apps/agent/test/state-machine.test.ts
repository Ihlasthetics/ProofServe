import { describe, expect, it } from 'vitest';
import {
  AgentRunSchema,
  AgentRunStatusSchema,
  activeServiceFixture,
  apiErrorFixture,
  completedAgentRunFixture,
  createdAgentRunFixture,
  fictionalPaymentReceiptFixture,
  fixtureReferenceTime,
  type AgentRun,
} from '@proofserve/shared';
import {
  AgentTransitionError,
  transitionAgentRun,
  type AgentTransition,
} from '../src/index.js';

const time = (seconds: number) =>
  new Date(Date.parse(fixtureReferenceTime) + seconds * 1000).toISOString();
const initial = AgentRunSchema.parse({
  ...createdAgentRunFixture,
  id: fictionalPaymentReceiptFixture.runId,
});
const result = completedAgentRunFixture.result;
if (result === null) throw new Error('Completed fixture must contain a result');
const commands: AgentTransition[] = [
  { status: 'DISCOVERING', occurredAt: time(1) },
  {
    status: 'SELECTED',
    occurredAt: time(2),
    selectedServiceId: activeServiceFixture.id,
  },
  {
    status: 'PAYMENT_REQUIRED',
    occurredAt: time(3),
    paymentRequirements: activeServiceFixture.paymentRequirements,
  },
  { status: 'PAYING', occurredAt: time(4) },
  {
    status: 'PAID',
    occurredAt: time(5),
    paymentReceipt: fictionalPaymentReceiptFixture,
  },
  { status: 'EXECUTING', occurredAt: time(6) },
  {
    status: 'COMPLETED',
    occurredAt: time(7),
    result,
  },
];
const runs: AgentRun[] = [initial];
let latest = initial;
for (const command of commands) {
  latest = transitionAgentRun(latest, command);
  runs.push(latest);
}
const failure: AgentTransition = {
  status: 'FAILED',
  occurredAt: time(10),
  error: apiErrorFixture.error,
};
const failed = transitionAgentRun(initial, failure);

// Exercise malformed JavaScript callers without casting invalid data to shared types.
const rejectCommand = (run: AgentRun, command: unknown) => {
  expect(() =>
    Reflect.apply(transitionAgentRun, undefined, [run, command]),
  ).toThrow(AgentTransitionError);
};

describe('T01 buyer-agent state machine', () => {
  it('reaches the exact shared completed fixture through the full success sequence', () => {
    expect(latest).toEqual(completedAgentRunFixture);
  });

  it.each(commands)(
    'appends one chronological event for $status and preserves inputs deterministically',
    (command) => {
      const index = commands.indexOf(command);
      const run = runs[index];
      if (!run) throw new Error('Missing test run');
      const before = structuredClone(run);
      const commandBefore = structuredClone(command);
      const output = transitionAgentRun(run, command);
      expect(output.events).toEqual([
        ...before.events,
        { status: command.status, occurredAt: command.occurredAt },
      ]);
      expect(output.status).toBe(command.status);
      expect(output.updatedAt).toBe(command.occurredAt);
      expect(output.createdAt).toBe(run.createdAt);
      expect(output.task).toEqual(run.task);
      expect(output.result !== null).toBe(output.status === 'COMPLETED');
      expect(output.error).toBeNull();
      expect(AgentRunSchema.parse(output)).toEqual(output);
      expect(transitionAgentRun(run, command)).toEqual(output);
      expect(run).toEqual(before);
      expect(command).toEqual(commandBefore);
      expect(output).not.toBe(run);
      expect(output.events).not.toBe(run.events);
      const firstEvent = output.events[0];
      if (!firstEvent) throw new Error('Missing output event');
      firstEvent.occurredAt = time(20);
      output.task.input.ticket = 'Changed output only';
      expect(run).toEqual(before);
    },
  );

  it.each(runs.filter((run) => run.status !== 'COMPLETED'))(
    'accepts FAILED from $status and retains all known payment fields',
    (run) => {
      const before = structuredClone(run);
      const output = transitionAgentRun(run, failure);
      expect(output).toEqual({
        ...before,
        status: 'FAILED',
        error: apiErrorFixture.error,
        result: null,
        updatedAt: time(10),
        events: [...before.events, { status: 'FAILED', occurredAt: time(10) }],
      });
      expect(AgentRunSchema.parse(output)).toEqual(output);
      expect(run).toEqual(before);
      expect(output.events).not.toBe(run.events);
    },
  );

  it.each([...runs, failed])(
    'rejects every illegal destination from $status, including terminal, skipped, reversed and repeated transitions',
    (run) => {
      const sequence = runs.map((entry) => entry.status);
      const next = sequence[sequence.indexOf(run.status) + 1];
      for (const status of AgentRunStatusSchema.options) {
        if (
          run.status !== 'COMPLETED' &&
          run.status !== 'FAILED' &&
          (status === next || status === 'FAILED')
        )
          continue;
        rejectCommand(run, {
          ...completedAgentRunFixture,
          status,
          occurredAt: time(10),
        });
      }
    },
  );

  it.each(
    commands.filter(
      (command) =>
        !['DISCOVERING', 'PAYING', 'EXECUTING'].includes(command.status),
    ),
  )('rejects missing destination data for $status', (command) => {
    const run = runs[commands.indexOf(command)];
    if (!run) throw new Error('Missing test run');
    rejectCommand(run, {
      status: command.status,
      occurredAt: command.occurredAt,
    });
  });

  it('rejects missing FAILED error', () => {
    rejectCommand(initial, { status: 'FAILED', occurredAt: time(1) });
  });

  it.each(['runId', 'serviceId', 'network', 'asset', 'amountAtomic', 'payTo'])(
    'rejects mismatched receipt %s',
    (field) => {
      const paying = runs.find((run) => run.status === 'PAYING');
      if (!paying) throw new Error('Missing PAYING run');
      const receipt = fictionalPaymentReceiptFixture;
      const badReceipt =
        field === 'runId' || field === 'serviceId'
          ? { ...receipt, [field]: 'different_id' }
          : {
              ...receipt,
              paymentRequirements: {
                ...receipt.paymentRequirements,
                [field]:
                  field === 'network'
                    ? 'hedera:mainnet'
                    : field === 'amountAtomic'
                      ? '999'
                      : '0.0.999',
              },
            };
      rejectCommand(paying, {
        status: 'PAID',
        occurredAt: time(5),
        paymentReceipt: badReceipt,
      });
    },
  );

  it('rejects timestamps before updatedAt or event time, including FAILED commands', () => {
    rejectCommand(initial, { status: 'DISCOVERING', occurredAt: time(-1) });
    rejectCommand(
      { ...initial, updatedAt: time(5) },
      { status: 'DISCOVERING', occurredAt: time(4) },
    );
    rejectCommand(
      { ...initial, events: [{ status: 'CREATED', occurredAt: time(5) }] },
      { status: 'DISCOVERING', occurredAt: time(4) },
    );
    rejectCommand(initial, { ...failure, occurredAt: time(-1) });
  });

  it('allows equal timestamps', () => {
    expect(
      transitionAgentRun(initial, {
        status: 'DISCOVERING',
        occurredAt: fixtureReferenceTime,
      }).updatedAt,
    ).toBe(fixtureReferenceTime);
  });

  it('rejects malformed timestamps, malformed inputs and nonchronological input events', () => {
    rejectCommand(initial, { status: 'DISCOVERING', occurredAt: 'invalid' });
    rejectCommand({ ...initial, events: [] }, commands[0]);
    rejectCommand(
      {
        ...initial,
        events: [
          { status: 'CREATED', occurredAt: time(2) },
          { status: 'CREATED', occurredAt: time(1) },
        ],
      },
      commands[0],
    );
  });

  it('does not mutate inputs when a transition is rejected', () => {
    const run = structuredClone(initial);
    const before = structuredClone(run);
    rejectCommand(run, { status: 'SELECTED', occurredAt: time(1) });
    expect(run).toEqual(before);
  });
});
