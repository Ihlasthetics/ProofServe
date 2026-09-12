import { expect, it, vi } from 'vitest';
import {
  unverifiedProviderFixture,
  verifiedProviderFixture,
  WorldVerificationResponseSchema,
  type WorldVerificationResponse,
} from '@proofserve/shared';
import { createRegistryClient } from '../src/lib/registry-client';
import { createRegistrySession } from '../src/lib/registry-session';
import { runProviderWorldVerification } from '../src/lib/provider-world-verification';
import {
  WorldSelfieFlow,
  type WorldSelfieFlowDependencies,
} from '../src/lib/world-selfie-flow';
import {
  fictionalConnectorUri,
  fictionalWorldContext,
  fictionalWorldResult,
} from './world-fixtures';

const providerInput = {
  displayName: unverifiedProviderFixture.displayName,
  payoutAccount: unverifiedProviderFixture.payoutAccount,
};
const contextForCreatedProvider = {
  ...fictionalWorldContext,
  signal: `proofserve:provider:${unverifiedProviderFixture.id}`,
};
const verifiedRecordForCreatedProvider: WorldVerificationResponse =
  WorldVerificationResponseSchema.parse({
    ...verifiedProviderFixture.verification,
    providerId: unverifiedProviderFixture.id,
  });
const mismatchedVerifiedRecord = WorldVerificationResponseSchema.parse(
  verifiedProviderFixture.verification,
);

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assertion();
}

function flowDependencies(
  overrides: Partial<WorldSelfieFlowDependencies> = {},
): WorldSelfieFlowDependencies {
  return {
    fetchContext: async () => contextForCreatedProvider,
    createWorldRequest: async () => ({
      connectorURI: fictionalConnectorUri,
      pollUntilCompletion: async () => ({
        success: true,
        result: fictionalWorldResult,
      }),
    }),
    createQrCode: async () => 'data:image/png;base64,ZmljdGlvbmFsLXFy',
    submitVerification: async () => verifiedRecordForCreatedProvider,
    ...overrides,
  };
}

async function createdSession() {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(unverifiedProviderFixture, 201));
  const session = createRegistrySession(createRegistryClient(fetcher));
  await session.createProvider(providerInput);
  return { fetcher, session };
}

it.each([
  ['cancellation', { success: false as const, error: 'cancelled' }],
  ['rejection', { success: false as const, error: 'user_rejected' }],
  [
    'verification rejection',
    {
      success: false as const,
      error: 'verification_rejected',
    },
  ],
  ['timeout', { success: false as const, error: 'timeout' }],
  ['malformed result', { success: true as const, result: {} }],
])('keeps the provider UNVERIFIED after %s', async (_label, completion) => {
  const { fetcher, session } = await createdSession();
  const submitVerification = vi.fn(
    async () => verifiedRecordForCreatedProvider,
  );
  const flow = new WorldSelfieFlow(
    flowDependencies({
      createWorldRequest: async () => ({
        connectorURI: fictionalConnectorUri,
        pollUntilCompletion: async () => completion,
      }),
      submitVerification,
    }),
  );

  await expect(
    runProviderWorldVerification(
      flow,
      unverifiedProviderFixture.id,
      session.applyWorldVerification,
    ),
  ).resolves.toBe('incomplete');
  expect(session.getSnapshot().provider).toEqual(unverifiedProviderFixture);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(submitVerification).not.toHaveBeenCalled();
});

it('fails closed for a mismatched backend verification response', async () => {
  const { fetcher, session } = await createdSession();
  const flow = new WorldSelfieFlow(
    flowDependencies({
      submitVerification: async () => mismatchedVerifiedRecord,
    }),
  );

  await expect(
    runProviderWorldVerification(
      flow,
      unverifiedProviderFixture.id,
      session.applyWorldVerification,
    ),
  ).resolves.toBe('incomplete');
  expect(flow.getSnapshot().status).toBe('error');
  expect(session.getSnapshot().provider).toEqual(unverifiedProviderFixture);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('coalesces duplicate starts and applies one provider-bound confirmation', async () => {
  const { fetcher, session } = await createdSession();
  const confirmation = deferred<WorldVerificationResponse>();
  const fetchContext = vi.fn(async () => contextForCreatedProvider);
  const createWorldRequest = vi.fn(async () => ({
    connectorURI: fictionalConnectorUri,
    pollUntilCompletion: async () => ({
      success: true as const,
      result: fictionalWorldResult,
    }),
  }));
  const submitVerification = vi.fn(async () => await confirmation.promise);
  const accept = vi.fn(session.applyWorldVerification);
  const flow = new WorldSelfieFlow(
    flowDependencies({
      fetchContext,
      createWorldRequest,
      submitVerification,
    }),
  );

  const first = runProviderWorldVerification(
    flow,
    unverifiedProviderFixture.id,
    accept,
  );
  await eventually(() => {
    expect(submitVerification).toHaveBeenCalledTimes(1);
  });
  await expect(
    runProviderWorldVerification(flow, unverifiedProviderFixture.id, accept),
  ).resolves.toBe('not-started');
  confirmation.resolve(verifiedRecordForCreatedProvider);
  await expect(first).resolves.toBe('accepted');

  expect(fetchContext).toHaveBeenCalledExactlyOnceWith(
    unverifiedProviderFixture.id,
    expect.any(AbortSignal),
  );
  expect(createWorldRequest).toHaveBeenCalledExactlyOnceWith(
    contextForCreatedProvider,
  );
  expect(submitVerification).toHaveBeenCalledExactlyOnceWith(
    unverifiedProviderFixture.id,
    fictionalWorldResult,
    expect.any(AbortSignal),
  );
  expect(accept).toHaveBeenCalledExactlyOnceWith(
    verifiedRecordForCreatedProvider,
  );
  expect(session.getSnapshot().provider?.verification).toEqual(
    verifiedRecordForCreatedProvider,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('never retries an ambiguous proof submission', async () => {
  const { fetcher, session } = await createdSession();
  const submitVerification = vi.fn(async () => {
    throw new Error(`private-proof:${fictionalWorldResult.responses[0].proof}`);
  });
  const flow = new WorldSelfieFlow(flowDependencies({ submitVerification }));

  await expect(
    runProviderWorldVerification(
      flow,
      unverifiedProviderFixture.id,
      session.applyWorldVerification,
    ),
  ).resolves.toBe('incomplete');
  expect(submitVerification).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().provider).toEqual(unverifiedProviderFixture);
  expect(JSON.stringify(flow.getSnapshot())).not.toMatch(
    /private-proof|0x55555555/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
