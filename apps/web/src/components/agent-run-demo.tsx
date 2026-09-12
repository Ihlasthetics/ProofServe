'use client';

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import {
  AgentRunSchema,
  type AgentRun,
  type AgentRunStatus,
} from '@proofserve/shared';
import { agentRunFormData } from '../lib/agent-run-form-data';
import {
  createAgentRunSession,
  type AgentRunState,
} from '../lib/agent-run-session';
import {
  isSemanticallyValidRun,
  isTerminalRun,
  runReachedStatus,
  safeHashScanTransactionUrl,
} from '../lib/agent-run-validation';
import { formatHbar } from '../lib/format-hbar';

const statusLabels: Record<AgentRunStatus, string> = {
  CREATED: 'Request accepted',
  DISCOVERING: 'Discovering eligible services',
  SELECTED: 'Verified provider service selected',
  PAYMENT_REQUIRED: 'HTTP 402 · Payment required',
  PAYING: 'Signing and submitting payment',
  PAID: 'Settlement confirmed',
  EXECUTING: 'AI service executing',
  COMPLETED: 'Result ready',
  FAILED: 'Run failed',
};

const failureDescriptions: Record<string, string> = {
  NO_ELIGIBLE_SERVICE:
    'No currently eligible service was available for this request.',
  BUDGET_EXCEEDED:
    'The agent rejected an over-budget payment challenge before signing.',
  PAYMENT_FAILED:
    'Payment could not be confirmed. This page will not retry the payment.',
  SERVICE_EXECUTION_FAILED:
    'The paid service did not return a valid execution result.',
  VALIDATION_ERROR: 'The agent could not process the submitted task safely.',
};

function RunDetails({ run }: { run: AgentRun }) {
  if (!AgentRunSchema.safeParse(run).success || !isSemanticallyValidRun(run))
    return (
      <p className="notice" role="alert">
        The run snapshot failed safety validation and cannot be displayed.
      </p>
    );
  const receiptUrl = safeHashScanTransactionUrl(run);
  const selected = runReachedStatus(run, 'SELECTED');
  const paymentRequired = runReachedStatus(run, 'PAYMENT_REQUIRED');
  const settled = runReachedStatus(run, 'PAID');
  return (
    <div className="run-output">
      <div className="run-summary" aria-label="Agent run summary">
        <div>
          <span>Current status</span>
          <strong>{statusLabels[run.status]}</strong>
        </div>
        <div>
          <span>Maximum budget</span>
          <strong>{formatHbar(run.task.budget.maxAmountAtomic)} HBAR</strong>
        </div>
        <div>
          <span>Selected price</span>
          <strong>
            {paymentRequired && run.paymentRequirements
              ? `${formatHbar(run.paymentRequirements.amountAtomic)} HBAR`
              : 'Awaiting service selection'}
          </strong>
        </div>
      </div>

      <section className="run-task" aria-labelledby="run-task-heading">
        <h3 id="run-task-heading">Task</h3>
        <p>{run.task.input.ticket}</p>
        <p className="reference">
          Run ID: <code>{run.id}</code>
        </p>
        {selected && run.selectedServiceId && (
          <p>
            Selected service: <code>{run.selectedServiceId}</code>. The agent
            backend performs the current provider-verification and eligibility
            checks before selection and again before payment.
          </p>
        )}
      </section>

      <section aria-labelledby="timeline-heading">
        <h3 id="timeline-heading">Authoritative execution timeline</h3>
        <ol className="run-timeline">
          {run.events.map((event, index) => (
            <li
              key={`${event.status}-${event.occurredAt}`}
              className={
                event.status === 'FAILED'
                  ? 'timeline-failure'
                  : event.status === 'COMPLETED'
                    ? 'timeline-success'
                    : ''
              }
            >
              <span className="timeline-marker" aria-hidden="true">
                {event.status === 'FAILED'
                  ? '×'
                  : event.status === 'COMPLETED'
                    ? '✓'
                    : index + 1}
              </span>
              <div>
                <strong>{statusLabels[event.status]}</strong>
                <time dateTime={event.occurredAt}>{event.occurredAt}</time>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {run.status === 'FAILED' && run.error && (
        <section className="run-failure" aria-labelledby="run-failure-heading">
          <h3 id="run-failure-heading">Run failed</h3>
          <p>
            <strong>{run.error.code.replaceAll('_', ' ')}</strong>
          </p>
          <p>
            {run.error.code === 'SERVICE_EXECUTION_FAILED' &&
            !runReachedStatus(run, 'EXECUTING')
              ? 'The run failed after settlement before service execution was recorded.'
              : (failureDescriptions[run.error.code] ??
                'The agent run ended without a successful result.')}
          </p>
          {settled && run.paymentReceipt && (
            <p>
              A settlement receipt exists for this failed run. Failure does not
              imply a refund and this page will not repeat the payment.
            </p>
          )}
        </section>
      )}

      {run.status === 'COMPLETED' && run.result && (
        <section className="run-result" aria-labelledby="run-result-heading">
          <h3 id="run-result-heading">AI result</h3>
          <dl>
            <div>
              <dt>Category</dt>
              <dd>{run.result.category}</dd>
            </div>
            <div>
              <dt>Urgency</dt>
              <dd>{run.result.urgency}</dd>
            </div>
            <div>
              <dt>Summary</dt>
              <dd>{run.result.summary}</dd>
            </div>
            <div>
              <dt>Suggested action</dt>
              <dd>{run.result.suggestedAction}</dd>
            </div>
          </dl>
        </section>
      )}

      {settled && run.paymentReceipt && (
        <section className="run-receipt" aria-labelledby="receipt-heading">
          <h3 id="receipt-heading">Payment receipt</h3>
          <dl>
            <div>
              <dt>Receipt ID</dt>
              <dd>{run.paymentReceipt.id}</dd>
            </div>
            <div>
              <dt>Transaction ID</dt>
              <dd>{run.paymentReceipt.transactionId}</dd>
            </div>
            <div>
              <dt>Paid</dt>
              <dd>
                {formatHbar(
                  run.paymentReceipt.paymentRequirements.amountAtomic,
                )}{' '}
                HBAR
              </dd>
            </div>
            <div>
              <dt>Recipient</dt>
              <dd>{run.paymentReceipt.paymentRequirements.payTo}</dd>
            </div>
            <div>
              <dt>Settled at</dt>
              <dd>
                <time dateTime={run.paymentReceipt.settledAt}>
                  {run.paymentReceipt.settledAt}
                </time>
              </dd>
            </div>
          </dl>
          {receiptUrl ? (
            <a
              className="hashscan-link"
              href={receiptUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View transaction on HashScan <span aria-hidden="true">↗</span>
            </a>
          ) : (
            <p className="notice" role="alert">
              The receipt transaction link did not pass the HashScan safety
              check and is not available.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

export function AgentRunView({
  state,
  session,
}: {
  state: AgentRunState;
  session: ReturnType<typeof createAgentRunSession>;
}) {
  const terminal = state.run ? isTerminalRun(state.run) : false;
  const locked = state.creating || !!state.run || state.creationUncertain;
  return (
    <section id="agent-run" aria-labelledby="agent-run-heading">
      <p className="eyebrow">Live agent · Hedera testnet</p>
      <h2 id="agent-run-heading">Run support-ticket triage</h2>
      <p>
        Submit one request with a maximum budget. The server discovers a
        currently eligible service, handles any real HTTP 402 payment, and
        returns its recorded events, result, and settlement receipt.
      </p>
      <p className="notice">
        Starting a run can spend testnet HBAR. If creation becomes uncertain,
        this page blocks another attempt to avoid a duplicate payment.
      </p>
      <form
        aria-labelledby="agent-run-heading"
        aria-busy={state.creating}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const access = data.get('accessToken');
          void session.start(
            agentRunFormData(data),
            typeof access === 'string' ? access : '',
          );
        }}
      >
        <fieldset disabled={locked}>
          <legend>Agent request</legend>
          <label htmlFor="agent-access">Demo access code</label>
          <input
            id="agent-access"
            name="accessToken"
            type="password"
            required
            minLength={16}
            maxLength={256}
            autoComplete="off"
            aria-describedby="agent-access-help"
          />
          <p id="agent-access-help">
            Separate Web authorization supplied by the demo operator. It is kept
            only in this page session and is not a payment credential.
          </p>
          <label htmlFor="agent-ticket">Support request</label>
          <textarea
            id="agent-ticket"
            name="ticket"
            required
            maxLength={10000}
            aria-describedby="agent-ticket-help"
          />
          <p id="agent-ticket-help">
            Describe the ticket the selected AI service should classify.
          </p>
          <label htmlFor="agent-budget">Maximum budget (tinybars)</label>
          <input
            id="agent-budget"
            name="maxAmountAtomic"
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            required
            aria-describedby="agent-budget-help"
          />
          <p id="agent-budget-help">
            100000000 tinybars = 1 HBAR. The agent rejects a price above this
            limit.
          </p>
          <button type="submit">
            {state.creating ? 'Starting agent run…' : 'Start agent run'}
          </button>
        </fieldset>
      </form>
      <p role="status" aria-live="polite">
        {state.creating
          ? 'Creating one agent run. Do not resubmit.'
          : state.refreshing
            ? 'Refreshing authoritative run status.'
            : state.run && state.pollingPermanentlyStopped
              ? 'Automatic polling stopped because this local run view is no longer authorized.'
              : state.run && !terminal
                ? `Run in progress: ${statusLabels[state.run.status]}. Polling safely.`
                : state.run
                  ? `Run reached terminal status: ${statusLabels[state.run.status]}.`
                  : ''}
      </p>
      {state.error && (
        <div className="notice" role="alert">
          <p>{state.error}</p>
          {state.run && !terminal && !state.pollingPermanentlyStopped && (
            <button
              type="button"
              disabled={state.refreshing}
              onClick={() => void session.refresh()}
            >
              Retry status refresh
            </button>
          )}
        </div>
      )}
      {state.run && <RunDetails run={state.run} />}
      {state.run && terminal && (
        <button type="button" onClick={() => session.startAnother()}>
          {state.run.status === 'FAILED'
            ? 'Start a new run after reviewing failure'
            : 'Start another run'}
        </button>
      )}
    </section>
  );
}

export function scheduleAgentRunPoll(
  session: ReturnType<typeof createAgentRunSession>,
  schedule: (
    callback: () => void,
    delayMs: number,
  ) => number = window.setTimeout,
  cancel: (timer: number) => void = window.clearTimeout,
): (() => void) | undefined {
  if (!session.canPoll()) return;
  const timer = schedule(() => void session.refresh(), session.pollDelayMs());
  return () => cancel(timer);
}

export function AgentRunDemo() {
  const [session] = useState(() => createAgentRunSession());
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    return scheduleAgentRunPoll(session);
  }, [session, state.run, state.refreshing, state.pollingPermanentlyStopped]);
  return <AgentRunView state={state} session={session} />;
}
