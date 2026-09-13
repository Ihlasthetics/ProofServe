import { agentRunBoundary } from '../../../../../server/agent-run-boundary';

export const dynamic = 'force-dynamic';

const handle = (request: Request) => agentRunBoundary(request);
export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as HEAD,
  handle as OPTIONS,
};
