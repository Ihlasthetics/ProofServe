import type { AgentRun, AgentTask } from '@proofserve/shared';
import { AgentRunRequestError, createAgentRunClient } from './agent-run-client';
import { isTerminalRun, isValidRunAdvance } from './agent-run-validation';

export interface AgentRunState {
  run: AgentRun | null;
  creating: boolean;
  refreshing: boolean;
  creationUncertain: boolean;
  pollingPermanentlyStopped: boolean;
  error: string | null;
}

export function createAgentRunSession(client = createAgentRunClient()) {
  let accessToken: string | null = null;
  let transientPollFailures = 0;
  let state: AgentRunState = {
    run: null,
    creating: false,
    refreshing: false,
    creationUncertain: false,
    pollingPermanentlyStopped: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<AgentRunState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(task: AgentTask, suppliedAccessToken: string) {
      if (state.creating || state.run || state.creationUncertain) return;
      update({ creating: true, error: null });
      try {
        const run = await client.createRun(task, suppliedAccessToken);
        accessToken = suppliedAccessToken;
        transientPollFailures = 0;
        update({ run, pollingPermanentlyStopped: false });
      } catch (error) {
        update({
          error:
            error instanceof AgentRunRequestError
              ? error.message
              : 'The run request could not be completed safely.',
          creationUncertain:
            error instanceof AgentRunRequestError && error.creationUncertain,
        });
      } finally {
        update({ creating: false });
      }
    },
    async refresh() {
      const current = state.run;
      if (
        !current ||
        !accessToken ||
        isTerminalRun(current) ||
        state.refreshing ||
        state.pollingPermanentlyStopped
      )
        return;
      update({ refreshing: true, error: null });
      try {
        const next = await client.getRun(current.id, accessToken);
        if (!isValidRunAdvance(current, next))
          throw new AgentRunRequestError(
            'Run status failed continuity checks. Retrying is safe.',
          );
        transientPollFailures = 0;
        update({ run: next });
      } catch (error) {
        const permanentlyStopped =
          error instanceof AgentRunRequestError &&
          error.pollingPermanentlyStopped;
        if (!permanentlyStopped)
          transientPollFailures = Math.min(transientPollFailures + 1, 5);
        update({
          error:
            error instanceof AgentRunRequestError
              ? error.message
              : 'Run status is temporarily unavailable. Retrying is safe.',
          pollingPermanentlyStopped: permanentlyStopped,
        });
      } finally {
        update({ refreshing: false });
      }
    },
    canPoll() {
      return (
        state.run !== null &&
        !isTerminalRun(state.run) &&
        !state.refreshing &&
        !state.pollingPermanentlyStopped
      );
    },
    pollDelayMs() {
      return Math.min(1500 * 2 ** transientPollFailures, 30_000);
    },
    startAnother() {
      if (!state.run || !isTerminalRun(state.run)) return;
      accessToken = null;
      transientPollFailures = 0;
      update({
        run: null,
        error: null,
        creationUncertain: false,
        pollingPermanentlyStopped: false,
      });
    },
  };
}
