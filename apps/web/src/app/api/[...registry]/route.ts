import { registryBoundary } from '../../../server/registry-boundary';

export const dynamic = 'force-dynamic';

// Explicit HEAD/OPTIONS handlers prevent Next from synthesizing forwarded GETs.
const handle = (request: Request) => registryBoundary(request);
export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as HEAD,
  handle as OPTIONS,
};
