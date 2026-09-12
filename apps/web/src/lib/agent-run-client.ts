import {
  ApiErrorResponseSchema,
  CreateAgentRunRequestSchema,
  CreateAgentRunResponseSchema,
  GetAgentRunResponseSchema,
  AgentRunParamsSchema,
  type AgentTask,
} from '@proofserve/shared';
import { isSemanticallyValidRun, taskMatches } from './agent-run-validation';

const safeErrors = {
  VALIDATION_ERROR: 'Check the task and maximum budget, then try again.',
  RUN_NOT_FOUND: 'This agent run could not be found.',
  UNAUTHORIZED: 'Agent-run authorization is unavailable.',
  FORBIDDEN: 'This agent-run request is forbidden.',
} as const;

const uncertainCreation =
  'The run-creation outcome is uncertain. A run may already be processing or paid, so do not resubmit. Ask the demo operator to reconcile backend run and payment records.';
const pollingAuthorizationLost =
  'This local run view is no longer authorized and automatic polling has stopped. Ask the demo operator to reconcile this existing run; do not start another paid run.';
const certainCreationRejections = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
} as const;

export class AgentRunRequestError extends Error {
  constructor(
    message: string,
    readonly creationUncertain = false,
    readonly pollingPermanentlyStopped = false,
  ) {
    super(message);
    this.name = 'AgentRunRequestError';
  }
}

export function createAgentRunClient(fetcher: typeof fetch = fetch) {
  function accessHeader(value: string) {
    if (value.length < 16 || value.length > 256 || /[\r\n]/.test(value))
      throw new AgentRunRequestError('Enter the configured demo access code.');
    return value;
  }
  async function responseJson(response: Response): Promise<unknown> {
    try {
      if (
        response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      )
        throw new Error('Unexpected content type');
      return await response.json();
    } catch {
      throw new AgentRunRequestError(
        'The server returned an unreadable response.',
      );
    }
  }

  return {
    async createRun(input: AgentTask, accessToken: string) {
      const task = CreateAgentRunRequestSchema.safeParse(input);
      if (!task.success)
        throw new AgentRunRequestError(
          'Enter a task and a positive whole-number maximum budget in tinybars.',
        );
      const demoAccess = accessHeader(accessToken);
      let response: Response;
      try {
        response = await fetcher('/api/agent/runs', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-ProofServe-Demo-Access': demoAccess,
          },
          body: JSON.stringify(task.data),
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new AgentRunRequestError(uncertainCreation, true);
      }
      let data: unknown;
      try {
        data = await responseJson(response);
      } catch {
        throw new AgentRunRequestError(uncertainCreation, true);
      }
      if (!response.ok) {
        const parsed = ApiErrorResponseSchema.safeParse(data);
        const code = parsed.success ? parsed.data.error.code : undefined;
        const certain =
          code !== undefined &&
          code in certainCreationRejections &&
          certainCreationRejections[
            code as keyof typeof certainCreationRejections
          ] === response.status;
        throw new AgentRunRequestError(
          certain
            ? (safeErrors[code as keyof typeof safeErrors] ??
                'The run request was rejected safely.')
            : uncertainCreation,
          !certain,
        );
      }
      const run = CreateAgentRunResponseSchema.safeParse(data);
      if (
        response.status !== 202 ||
        !run.success ||
        run.data.status !== 'CREATED' ||
        run.data.events.length !== 1 ||
        !taskMatches(task.data, run.data.task) ||
        !isSemanticallyValidRun(run.data)
      )
        throw new AgentRunRequestError(uncertainCreation, true);
      return run.data;
    },

    async getRun(runIdInput: string, accessToken: string) {
      const params = AgentRunParamsSchema.safeParse({ runId: runIdInput });
      if (!params.success)
        throw new AgentRunRequestError('The agent run identifier is invalid.');
      const demoAccess = accessHeader(accessToken);
      let response: Response;
      try {
        response = await fetcher(
          `/api/agent/runs/${encodeURIComponent(params.data.runId)}`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'X-ProofServe-Demo-Access': demoAccess,
            },
            cache: 'no-store',
            credentials: 'same-origin',
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch {
        throw new AgentRunRequestError(
          'Run status is temporarily unavailable. Retrying is safe.',
        );
      }
      let data: unknown;
      try {
        data = await responseJson(response);
      } catch {
        if (response.status === 401 || response.status === 403)
          throw new AgentRunRequestError(pollingAuthorizationLost, false, true);
        throw new AgentRunRequestError(
          'Run status was unreadable. Retrying is safe.',
        );
      }
      if (!response.ok) {
        const parsed = ApiErrorResponseSchema.safeParse(data);
        const code = parsed.success ? parsed.data.error.code : undefined;
        if (
          response.status === 401 ||
          response.status === 403 ||
          (parsed.success &&
            parsed.data.error.code === 'UNAUTHORIZED' &&
            parsed.data.error.message ===
              'Agent-run authorization is unavailable.')
        )
          throw new AgentRunRequestError(pollingAuthorizationLost, false, true);
        throw new AgentRunRequestError(
          safeErrors[code as keyof typeof safeErrors] ??
            'Run status is temporarily unavailable. Retrying is safe.',
        );
      }
      const run = GetAgentRunResponseSchema.safeParse(data);
      if (
        response.status !== 200 ||
        !run.success ||
        run.data.id !== params.data.runId ||
        !isSemanticallyValidRun(run.data)
      )
        throw new AgentRunRequestError(
          'Run status failed validation. Retrying is safe.',
        );
      return run.data;
    },
  };
}
