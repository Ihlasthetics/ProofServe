import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AGENT_RUN_SESSION_TTL_MS,
  issueAgentRunSession,
  verifyAgentRunSession,
} from '../src/server/agent-run-session-cookie';

const runId = 'run_live_123';
const secret = 'test-capability-secret-00000000000000000000';
const now = 1_788_940_800_000;
const expiresAt = now + AGENT_RUN_SESSION_TTL_MS;
const canonicalJson = `{"version":1,"runId":"${runId}","expiresAt":${expiresAt}}`;

function encode(bytes: string | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64url');
}

function signedText(payloadText: string): string {
  const payload = encode(payloadText);
  return `${payload}.${sign(payload)}`;
}

function alternateBase64url(encoded: string): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = Buffer.from(encoded, 'base64url');
  for (const candidate of alphabet) {
    const changed = `${encoded.slice(0, -1)}${candidate}`;
    if (changed !== encoded && Buffer.from(changed, 'base64url').equals(bytes))
      return changed;
  }
  throw new Error('Expected a noncanonical base64url alias');
}

it('issues exactly the canonical payload and accepts it', () => {
  const session = issueAgentRunSession(runId, secret, now);
  const [payload, signature] = session.split('.');
  expect(Buffer.from(payload!, 'base64url').toString('utf8')).toBe(
    canonicalJson,
  );
  expect(payload).toBe(encode(canonicalJson));
  expect(signature).toBe(sign(payload!));
  expect(verifyAgentRunSession(session, runId, secret, now)).toBe(true);
});

it.each([
  [
    'reordered keys',
    signedText(`{"runId":"${runId}","version":1,"expiresAt":${expiresAt}}`),
  ],
  [
    'duplicate keys',
    signedText(
      `{"version":1,"version":1,"runId":"${runId}","expiresAt":${expiresAt}}`,
    ),
  ],
  [
    'extra keys',
    signedText(
      `{"version":1,"runId":"${runId}","expiresAt":${expiresAt},"extra":true}`,
    ),
  ],
  ['missing keys', signedText(`{"version":1,"runId":"${runId}"}`)],
  ['whitespace changes', signedText(` ${canonicalJson}`)],
])(
  'rejects valid signatures over noncanonical payloads: %s',
  (_case, value) => {
    expect(verifyAgentRunSession(value, runId, secret, now)).toBe(false);
  },
);

it('rejects padded and alternate base64url encodings', () => {
  const canonical = issueAgentRunSession(runId, secret, now);
  const [payload, signature] = canonical.split('.');
  const paddedPayload = `${payload}=`;
  const alternatePayload = alternateBase64url(payload!);
  const standardBase64Signature = Buffer.from(signature!, 'base64url').toString(
    'base64',
  );
  expect(
    verifyAgentRunSession(
      `${paddedPayload}.${sign(paddedPayload)}`,
      runId,
      secret,
      now,
    ),
  ).toBe(false);
  expect(
    verifyAgentRunSession(
      `${alternatePayload}.${sign(alternatePayload)}`,
      runId,
      secret,
      now,
    ),
  ).toBe(false);
  expect(
    verifyAgentRunSession(
      `${payload}.${alternateBase64url(signature!)}`,
      runId,
      secret,
      now,
    ),
  ).toBe(false);
  expect(standardBase64Signature).not.toBe(signature);
  expect(
    verifyAgentRunSession(
      `${payload}.${standardBase64Signature}`,
      runId,
      secret,
      now,
    ),
  ).toBe(false);
});

it('rejects invalid UTF-8 before considering its valid signature', () => {
  const payload = encode(Uint8Array.from([0xc3, 0x28]));
  expect(
    verifyAgentRunSession(`${payload}.${sign(payload)}`, runId, secret, now),
  ).toBe(false);
});

it('rejects an altered signature', () => {
  const canonical = issueAgentRunSession(runId, secret, now);
  const [payload, signature] = canonical.split('.');
  const altered = `${signature!.slice(0, -1)}${signature!.endsWith('a') ? 'b' : 'a'}`;
  expect(
    verifyAgentRunSession(`${payload}.${altered}`, runId, secret, now),
  ).toBe(false);
});
