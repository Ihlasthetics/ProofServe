import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  activeServiceFixture,
  draftServiceFixture,
  unverifiedProviderFixture,
  verifiedProviderFixture,
} from '@proofserve/shared';
import { createRegistryClient } from '../src/lib/registry-client';
import { createRegistrySession } from '../src/lib/registry-session';
import { RegistryView } from '../src/components/provider-onboarding';

const providerInput = {
  displayName: unverifiedProviderFixture.displayName,
  payoutAccount: '0.0.123457',
};
const draftInput = {
  name: draftServiceFixture.name,
  description: draftServiceFixture.description,
  capability: 'SUPPORT_TICKET_TRIAGE' as const,
  price: {
    network: 'hedera:testnet' as const,
    asset: '0.0.0' as const,
    amountAtomic: '1000000',
  },
};
function setup() {
  const fetcher = vi.fn<typeof fetch>();
  const session = createRegistrySession(createRegistryClient(fetcher));
  const view = () =>
    renderToStaticMarkup(
      <RegistryView state={session.getSnapshot()} session={session} />,
    );
  return { fetcher, session, view };
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

it('creates a real provider and draft with authoritative request bodies and server IDs', async () => {
  const { fetcher, session, view } = setup();
  fetcher.mockResolvedValueOnce(json(unverifiedProviderFixture, 201));
  await session.createProvider(providerInput);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/providers',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(providerInput),
    }),
  );
  expect(view()).toContain(unverifiedProviderFixture.id);
  expect(view()).toContain('Unverified — no current liveness verification');
  fetcher.mockResolvedValueOnce(json(draftServiceFixture, 201));
  await session.createDraft(draftInput);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/services',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        providerId: unverifiedProviderFixture.id,
        ...draftInput,
      }),
    }),
  );
  expect(view()).toContain(draftServiceFixture.id);
  expect(view()).toContain('Service: Draft');
  expect(view()).not.toMatch(/Service: Active|Liveness verified/);
});

it.each([
  { displayName: '', payoutAccount: '0.0.123457' },
  {
    displayName: unverifiedProviderFixture.displayName,
    payoutAccount: 'private-key',
  },
])('validates provider inputs before sending', async (input) => {
  const { fetcher, session, view } = setup();
  await session.createProvider(input);
  expect(fetcher).not.toHaveBeenCalled();
  expect(view()).toContain('role="alert"');
  expect(session.getSnapshot().provider).toBeNull();
});

it('displays a safe validation error without exposing backend text', async () => {
  const { fetcher, session, view } = setup();
  fetcher.mockResolvedValue(
    json(
      { error: { code: 'VALIDATION_ERROR', message: 'secret stack trace' } },
      400,
    ),
  );
  await session.createProvider(providerInput);
  expect(view()).toContain('Check the submitted fields');
  expect(view()).not.toContain('secret stack trace');
});

it('handles blocked activation without changing the provider or draft', async () => {
  const { fetcher, session, view } = setup();
  fetcher
    .mockResolvedValueOnce(json(unverifiedProviderFixture, 201))
    .mockResolvedValueOnce(json(draftServiceFixture, 201))
    .mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'PROVIDER_VERIFICATION_REQUIRED',
            message: 'Current provider verification is required.',
          },
        },
        403,
      ),
    );
  await session.createProvider(providerInput);
  await session.createDraft(draftInput);
  await session.activate();
  expect(fetcher).toHaveBeenLastCalledWith(
    `/api/services/${draftServiceFixture.id}/activate`,
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );
  expect(view()).toContain(
    'Activation blocked: current provider verification is required.',
  );
  expect(view()).toContain('Service: Draft');
  expect(view()).not.toMatch(/Service: Active|Liveness verified/);
  expect(
    fetcher.mock.calls.every(
      ([path]) => !String(path).includes('/verification/'),
    ),
  ).toBe(true);
});

it('rejects unexpected provider verification, active draft, and mismatched activation', async () => {
  const { fetcher, session, view } = setup();
  fetcher.mockResolvedValueOnce(json(verifiedProviderFixture));
  await session.createProvider(providerInput);
  expect(session.getSnapshot().provider).toBeNull();
  fetcher.mockResolvedValueOnce(json(unverifiedProviderFixture));
  await session.createProvider(providerInput);
  fetcher.mockResolvedValueOnce(
    json({ ...draftServiceFixture, status: 'ACTIVE' }),
  );
  await session.createDraft(draftInput);
  expect(session.getSnapshot().draft).toBeNull();
  fetcher.mockResolvedValueOnce(json(draftServiceFixture));
  await session.createDraft(draftInput);
  fetcher.mockResolvedValueOnce(
    json({ ...draftServiceFixture, status: 'ACTIVE', id: 'wrong-service' }),
  );
  await session.activate();
  expect(view()).toContain('Unexpected activation response');
  expect(view()).not.toMatch(/Service: Active|Liveness verified/);
});

it.each(['network', 'json', 'schema', 'error-schema'] as const)(
  'fails safely on %s responses',
  async (failure) => {
    const { fetcher, session, view } = setup();
    if (failure === 'network')
      fetcher.mockRejectedValue(new Error('secret transport details'));
    else if (failure === 'json')
      fetcher.mockResolvedValue(new Response('secret <html>'));
    else
      fetcher.mockResolvedValue(
        json({ secret: 'stack trace' }, failure === 'error-schema' ? 500 : 200),
      );
    await session.createProvider(providerInput);
    expect(session.getSnapshot().provider).toBeNull();
    expect(view()).toContain('role="alert"');
    expect(view()).not.toMatch(
      /secret|stack trace|Service: Active|Liveness verified/,
    );
    expect(session.getSnapshot().pending.provider).toBe(false);
  },
);

it('renders real eligible service responses and excludes inactive or unverified records', async () => {
  const { fetcher, session, view } = setup();
  const now = Date.now();
  const provider = {
    ...verifiedProviderFixture,
    displayName: 'Live registry operator',
    verification: {
      ...verifiedProviderFixture.verification,
      verifiedAt: new Date(now - 60000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
    },
  };
  fetcher.mockResolvedValueOnce(
    json({
      services: [
        {
          service: { ...activeServiceFixture, name: 'Live registry triage' },
          provider,
        },
        { service: draftServiceFixture, provider: unverifiedProviderFixture },
        {
          service: {
            ...draftServiceFixture,
            status: 'ACTIVE',
            name: 'Unsafe service',
          },
          provider: unverifiedProviderFixture,
        },
        {
          service: { ...activeServiceFixture, name: 'Expired service' },
          provider: verifiedProviderFixture,
        },
      ],
    }),
  );
  await session.refresh();
  expect(fetcher).toHaveBeenCalledWith(
    '/api/services',
    expect.objectContaining({ method: 'GET', cache: 'no-store' }),
  );
  expect(view()).toContain('Live registry triage');
  expect(view()).toContain('Live registry operator');
  expect(view()).toContain('1 eligible services returned.');
  expect(view()).not.toMatch(/Unsafe service|Expired service/);
  fetcher.mockRejectedValueOnce(new Error('offline'));
  await session.refresh();
  expect(view()).not.toContain('Live registry triage');
  expect(view()).toContain('role="alert"');
});

it('rejects malformed listings instead of using a fixture fallback', async () => {
  const { fetcher, session, view } = setup();
  fetcher.mockResolvedValue(
    json({
      services: [
        { service: activeServiceFixture, provider: unverifiedProviderFixture },
      ],
    }),
  );
  await session.refresh();
  expect(session.getSnapshot().listing).toBeNull();
  expect(view()).toContain('invalid response');
  expect(view()).not.toContain(activeServiceFixture.name);
});

it('prevents duplicates during every pending operation and keeps controls accessible', async () => {
  const { fetcher, session, view } = setup();
  async function pending(
    action: () => Promise<void>,
    response: unknown,
    operation: string,
  ) {
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const calls = fetcher.mock.calls.length;
    const first = action();
    await action();
    expect(fetcher).toHaveBeenCalledTimes(calls + 1);
    expect(view()).toContain('disabled=""');
    expect(view()).toContain(operation);
    expect(view()).toContain('role="status"');
    resolve(json(response));
    await first;
  }
  await pending(
    () => session.createProvider(providerInput),
    unverifiedProviderFixture,
    'Provider creation pending.',
  );
  await pending(
    () => session.createDraft(draftInput),
    draftServiceFixture,
    'Draft creation pending.',
  );
  await pending(
    () => session.activate(),
    { ...draftServiceFixture, status: 'ACTIVE', id: 'wrong-service' },
    'Activation check pending.',
  );
  await pending(
    () => session.refresh(),
    { services: [] },
    'Loading eligible services.',
  );
  expect(view()).toContain('No eligible services are available');
  expect(view()).not.toMatch(/Service: Active|Liveness verified/);
});

it('validates draft prices and prevents draft creation before provider registration', async () => {
  const { fetcher, session, view } = setup();
  await session.createDraft(draftInput);
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(json(unverifiedProviderFixture));
  await session.createProvider(providerInput);
  await session.createDraft({
    ...draftInput,
    price: { ...draftInput.price, amountAtomic: '1.5' },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(view()).toContain('positive whole-number price');
});

it.each(['draft', 'activation'] as const)(
  'keeps safe state after %s network and malformed-response failures',
  async (operation) => {
    const { fetcher, session, view } = setup();
    fetcher.mockResolvedValueOnce(json(unverifiedProviderFixture));
    await session.createProvider(providerInput);
    if (operation === 'activation') {
      fetcher.mockResolvedValueOnce(json(draftServiceFixture));
      await session.createDraft(draftInput);
    }
    const action = () =>
      operation === 'draft'
        ? session.createDraft(draftInput)
        : session.activate();
    fetcher.mockRejectedValueOnce(new Error('secret'));
    await action();
    expect(view()).toContain('could not be reached');
    fetcher.mockResolvedValueOnce(json({ status: 'ACTIVE' }));
    await action();
    expect(view()).toContain('invalid response');
    expect(view()).not.toMatch(/Service: Active|Liveness verified|secret/);
    expect(session.getSnapshot().provider?.verification.status).toBe(
      'UNVERIFIED',
    );
    expect(session.getSnapshot().draft?.status ?? null).toBe(
      operation === 'draft' ? null : 'DRAFT',
    );
  },
);

it('rejects a draft belonging to a different provider', async () => {
  const { fetcher, session } = setup();
  fetcher.mockResolvedValueOnce(json(unverifiedProviderFixture));
  await session.createProvider(providerInput);
  fetcher.mockResolvedValueOnce(
    json({ ...draftServiceFixture, providerId: 'another-provider' }),
  );
  await session.createDraft(draftInput);
  expect(session.getSnapshot().draft).toBeNull();
});
