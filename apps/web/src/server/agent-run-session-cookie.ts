import { createHmac, timingSafeEqual } from 'node:crypto';
import { IdentifierSchema } from '@proofserve/shared';

export const AGENT_RUN_SESSION_TTL_MS = 30 * 60 * 1000;
export const AGENT_RUN_SESSION_COOKIE = 'proofserve_agent_run';
export const AGENT_RUN_SESSION_COOKIE_PATH = '/api/agent/runs/';

interface RunSessionPayload {
  version: 1;
  runId: string;
  expiresAt: number;
}

function serializePayload(payload: RunSessionPayload): string {
  return JSON.stringify({
    version: payload.version,
    runId: payload.runId,
    expiresAt: payload.expiresAt,
  });
}

function encodePayload(payload: RunSessionPayload): string {
  return Buffer.from(serializePayload(payload), 'utf8').toString('base64url');
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

export function issueAgentRunSession(
  runId: string,
  secret: string,
  now: number,
): string {
  const canonicalRunId = IdentifierSchema.parse(runId);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - AGENT_RUN_SESSION_TTL_MS
  )
    throw new Error('Invalid session time');
  const payload = encodePayload({
    version: 1,
    runId: canonicalRunId,
    expiresAt: now + AGENT_RUN_SESSION_TTL_MS,
  });
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

export function verifyAgentRunSession(
  session: string | null,
  expectedRunId: string,
  secret: string,
  now: number,
): boolean {
  if (
    !session ||
    session.length > 1024 ||
    !IdentifierSchema.safeParse(expectedRunId).success ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - AGENT_RUN_SESSION_TTL_MS
  )
    return false;
  const parts = session.split('.');
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1])
  )
    return false;

  let decodedText: string;
  try {
    const payloadBytes = Buffer.from(parts[0], 'base64url');
    if (payloadBytes.toString('base64url') !== parts[0]) return false;
    decodedText = new TextDecoder('utf-8', { fatal: true }).decode(
      payloadBytes,
    );
  } catch {
    return false;
  }

  let value: unknown;
  try {
    value = JSON.parse(decodedText) as unknown;
  } catch {
    return false;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'version,runId,expiresAt'
  )
    return false;
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.runId !== 'string' ||
    !IdentifierSchema.safeParse(payload.runId).success ||
    !Number.isSafeInteger(payload.expiresAt)
  )
    return false;
  const canonical = encodePayload({
    version: 1,
    runId: payload.runId,
    expiresAt: payload.expiresAt as number,
  });
  if (canonical !== parts[0]) return false;

  const suppliedSignature = Buffer.from(parts[1], 'base64url');
  const expectedSignature = signature(parts[0], secret);
  const comparable =
    suppliedSignature.length === expectedSignature.length
      ? suppliedSignature
      : Buffer.alloc(expectedSignature.length);
  if (
    suppliedSignature.toString('base64url') !== parts[1] ||
    !timingSafeEqual(comparable, expectedSignature) ||
    suppliedSignature.length !== expectedSignature.length
  )
    return false;

  const expiresAt = payload.expiresAt as number;
  return (
    payload.runId === expectedRunId &&
    expiresAt > now &&
    expiresAt <= now + AGENT_RUN_SESSION_TTL_MS
  );
}

export function agentRunSessionFromCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header || header.length > 8192) return null;
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${AGENT_RUN_SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(AGENT_RUN_SESSION_COOKIE.length + 1);
  return value.length > 0 ? value : null;
}
