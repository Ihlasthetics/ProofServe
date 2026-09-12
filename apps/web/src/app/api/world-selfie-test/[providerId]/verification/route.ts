import {
  handleWorldProxyPost,
  worldProxyMethodNotAllowed,
} from '../../../../../server/world-verification-proxy';

interface RouteContext {
  params: Promise<{ providerId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { providerId } = await context.params;
  return handleWorldProxyPost(request, providerId, 'verification');
}

export const GET = worldProxyMethodNotAllowed;
export const HEAD = worldProxyMethodNotAllowed;
export const PUT = worldProxyMethodNotAllowed;
export const PATCH = worldProxyMethodNotAllowed;
export const DELETE = worldProxyMethodNotAllowed;
export const OPTIONS = worldProxyMethodNotAllowed;
