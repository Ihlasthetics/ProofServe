import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorldSelfieTest } from '../src/components/world-selfie-test';
import {
  WorldSelfieFlow,
  type WorldSelfieFlowDependencies,
} from '../src/lib/world-selfie-flow';
import type { WorldIdKitRequest } from '../src/lib/world-idkit';
import {
  fictionalConnectorUri,
  fictionalProviderId,
  fictionalVerifiedRecord,
  fictionalWorldContext,
  fictionalWorldResult,
} from './world-fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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

function dependencies(
  overrides: Partial<WorldSelfieFlowDependencies> = {},
): WorldSelfieFlowDependencies {
  return {
    fetchContext: async () => fictionalWorldContext,
    createWorldRequest: async () => ({
      connectorURI: fictionalConnectorUri,
      pollUntilCompletion: async () => ({
        success: true,
        result: fictionalWorldResult,
      }),
    }),
    createQrCode: async () => 'data:image/png;base64,ZmljdGlvbmFsLXFy',
    submitVerification: async () => fictionalVerifiedRecord,
    ...overrides,
  };
}

describe('World selfie flow', () => {
  it('runs context → connector URI → proof submission and waits for backend confirmation', async () => {
    const completion =
      deferred<Awaited<ReturnType<WorldIdKitRequest['pollUntilCompletion']>>>();
    const confirmation = deferred<typeof fictionalVerifiedRecord>();
    const submitVerification = vi.fn(async () => await confirmation.promise);
    const flow = new WorldSelfieFlow(
      dependencies({
        createWorldRequest: async () => ({
          connectorURI: fictionalConnectorUri,
          pollUntilCompletion: async () => await completion.promise,
        }),
        submitVerification,
      }),
    );

    const run = flow.start(fictionalProviderId);
    await eventually(() => {
      expect(flow.getSnapshot()).toMatchObject({
        status: 'waiting',
        connectorURI: fictionalConnectorUri,
      });
    });
    completion.resolve({ success: true, result: fictionalWorldResult });
    await eventually(() => {
      expect(flow.getSnapshot().status).toBe('submitting');
    });
    expect(flow.getSnapshot().status).not.toBe('verified');
    expect(submitVerification).toHaveBeenCalledExactlyOnceWith(
      fictionalProviderId,
      fictionalWorldResult,
      expect.any(AbortSignal),
    );

    confirmation.resolve(fictionalVerifiedRecord);
    await run;
    expect(flow.getSnapshot()).toEqual({
      status: 'verified',
      busy: false,
      message: 'VERIFIED — confirmed by the ProofServe backend.',
      verification: fictionalVerifiedRecord,
    });
  });

  it.each(['', '_provider', 'provider with spaces', 'é', 'a'.repeat(129)])(
    'rejects invalid provider ID %j before making requests',
    async (providerId) => {
      const fetchContext = vi.fn(async () => fictionalWorldContext);
      const flow = new WorldSelfieFlow(dependencies({ fetchContext }));
      await expect(flow.start(providerId)).resolves.toBe(false);
      expect(flow.getSnapshot().status).toBe('invalid');
      expect(fetchContext).not.toHaveBeenCalled();
    },
  );

  it('coalesces duplicate starts and prevents concurrent proof submissions', async () => {
    const confirmation = deferred<typeof fictionalVerifiedRecord>();
    const fetchContext = vi.fn(async () => fictionalWorldContext);
    const submitVerification = vi.fn(async () => await confirmation.promise);
    const flow = new WorldSelfieFlow(
      dependencies({ fetchContext, submitVerification }),
    );

    const run = flow.start(fictionalProviderId);
    await expect(flow.start(fictionalProviderId)).resolves.toBe(false);
    await eventually(() => {
      expect(flow.getSnapshot().status).toBe('submitting');
    });
    await expect(flow.start(fictionalProviderId)).resolves.toBe(false);
    expect(fetchContext).toHaveBeenCalledTimes(1);
    expect(submitVerification).toHaveBeenCalledTimes(1);
    confirmation.resolve(fictionalVerifiedRecord);
    await run;
  });

  it('cancels polling without submitting proof material', async () => {
    const submitVerification = vi.fn(async () => fictionalVerifiedRecord);
    const flow = new WorldSelfieFlow(
      dependencies({
        createWorldRequest: async () => ({
          connectorURI: fictionalConnectorUri,
          pollUntilCompletion: async ({ signal } = {}) =>
            await new Promise((resolve) => {
              signal?.addEventListener(
                'abort',
                () => resolve({ success: false, error: 'cancelled' }),
                { once: true },
              );
            }),
        }),
        submitVerification,
      }),
    );
    const run = flow.start(fictionalProviderId);
    await eventually(() => {
      expect(flow.getSnapshot().status).toBe('waiting');
    });
    expect(flow.cancel()).toBe(true);
    await run;
    expect(flow.getSnapshot()).toMatchObject({
      status: 'cancelled',
      busy: false,
    });
    expect(flow.getSnapshot()).not.toHaveProperty('connectorURI');
    expect(submitVerification).not.toHaveBeenCalled();
  });

  it.each(['user_rejected', 'verification_rejected'] as const)(
    'handles %s as a safe cancellation without submission',
    async (error) => {
      const submitVerification = vi.fn(async () => fictionalVerifiedRecord);
      const flow = new WorldSelfieFlow(
        dependencies({
          createWorldRequest: async () => ({
            connectorURI: fictionalConnectorUri,
            pollUntilCompletion: async () => ({ success: false, error }),
          }),
          submitVerification,
        }),
      );
      await flow.start(fictionalProviderId);
      expect(flow.getSnapshot().status).toBe('cancelled');
      expect(JSON.stringify(flow.getSnapshot())).not.toContain(error);
      expect(submitVerification).not.toHaveBeenCalled();
    },
  );

  it('sanitizes transport and proof failures and never retries submission', async () => {
    const submitVerification = vi.fn(async () => {
      throw new Error(
        `proof-test-marker:${fictionalWorldResult.responses[0].proof}`,
      );
    });
    const flow = new WorldSelfieFlow(dependencies({ submitVerification }));
    await flow.start(fictionalProviderId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const publicState = JSON.stringify(flow.getSnapshot());
    expect(flow.getSnapshot().status).toBe('error');
    expect(publicState).not.toMatch(/proof-test-marker|0x55555555/);
    expect(submitVerification).toHaveBeenCalledTimes(1);
  });

  it('renders an idle standalone form without a fabricated verified state', () => {
    const markup = renderToStaticMarkup(<WorldSelfieTest />);
    expect(markup).toContain('Provider ID');
    expect(markup).toContain('Start selfie check');
    expect(markup).not.toContain('VERIFIED —');
    expect(markup).not.toContain(fictionalWorldResult.responses[0].proof);
    expect(markup).not.toContain(fictionalWorldResult.responses[0].nullifier);
    expect(markup).not.toContain(fictionalWorldContext.rp_context.signature);
  });
});
