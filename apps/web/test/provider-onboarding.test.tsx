import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  activeServiceFixture,
  draftServiceFixture,
  unverifiedProviderFixture,
  verifiedProviderFixture,
  WorldVerificationResponseSchema,
} from '@proofserve/shared';
import { createRegistryClient } from '../src/lib/registry-client';
import { createRegistrySession } from '../src/lib/registry-session';
import { RegistryView } from '../src/components/provider-onboarding';
import { registryBoundary } from '../src/server/registry-boundary';

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
const verifiedRecordForCreatedProvider = WorldVerificationResponseSchema.parse({
  ...verifiedProviderFixture.verification,
  providerId: unverifiedProviderFixture.id,
});
const mismatchedVerifiedRecord = WorldVerificationResponseSchema.parse(
  verifiedProviderFixture.verification,
);
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
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface ButtonProps {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node))
    return textContent(node.props.children);
  return '';
}

function findButton(node: ReactNode, label: string): ReactElement<ButtonProps> {
  let found: ReactElement<ButtonProps> | undefined;
  function visit(current: ReactNode) {
    if (found !== undefined) return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isValidElement<{ children?: ReactNode }>(current)) return;
    if (
      current.type === 'button' &&
      textContent(current.props.children) === label
    ) {
      found = current as ReactElement<ButtonProps>;
      return;
    }
    visit(current.props.children);
  }
  visit(node);
  if (found === undefined) throw new Error(`Button not found: ${label}`);
  return found;
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

function boundarySetup() {
  const upstream = vi.fn<typeof fetch>();
  const browserFetch = vi.fn<typeof fetch>(async (input, init) => {
    if (typeof input !== 'string') throw new Error('Unexpected request input');
    return registryBoundary(
      new Request(`http://web.example.test${input}`, init),
      upstream,
    );
  });
  const session = createRegistrySession(createRegistryClient(browserFetch));
  return { browserFetch, session, upstream };
}

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
  const worldAction = view().match(
    /<section[^>]+aria-labelledby="provider-world-heading"[\s\S]*?<\/section>/,
  )?.[0];
  expect(worldAction).toBeDefined();
  expect(worldAction).toContain('Verify with World');
  expect(worldAction).toContain(unverifiedProviderFixture.id);
  expect(worldAction).not.toContain('<input');
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
  const activation = findButton(
    RegistryView({ state: session.getSnapshot(), session }),
    'Attempt activation',
  );
  expect(activation.props.disabled).not.toBe(true);
  expect(view()).not.toMatch(/Service: Active|Liveness verified/);
});

it('accepts only the created provider verification and never auto-activates', async () => {
  const { fetcher, session, view } = setup();
  fetcher
    .mockResolvedValueOnce(json(unverifiedProviderFixture, 201))
    .mockResolvedValueOnce(json(draftServiceFixture, 201));
  await session.createProvider(providerInput);
  await session.createDraft(draftInput);

  expect(session.applyWorldVerification(verifiedRecordForCreatedProvider)).toBe(
    true,
  );
  expect(session.getSnapshot().provider).toEqual({
    ...unverifiedProviderFixture,
    verification: verifiedRecordForCreatedProvider,
  });
  expect(session.getSnapshot().draft).toEqual(draftServiceFixture);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(view()).toContain('Verified — backend-confirmed');
  expect(view()).toContain('Attempt activation');
  expect(view()).toContain('activation still requires a separate explicit');
  expect(view()).not.toContain('World verification confirmed');

  const activated = {
    ...draftServiceFixture,
    status: 'ACTIVE' as const,
    updatedAt: '2026-09-06T10:01:00.000Z',
  };
  fetcher
    .mockResolvedValueOnce(json(activated))
    .mockResolvedValueOnce(json({ services: [] }));
  const activation = findButton(
    RegistryView({ state: session.getSnapshot(), session }),
    'Attempt activation',
  );
  expect(activation.props.disabled).not.toBe(true);
  activation.props.onClick?.();
  await eventually(() => {
    expect(session.getSnapshot().draft).toEqual(activated);
  });
  expect(fetcher).toHaveBeenNthCalledWith(
    3,
    `/api/services/${draftServiceFixture.id}/activate`,
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );
  expect(fetcher).toHaveBeenNthCalledWith(
    4,
    '/api/services',
    expect.objectContaining({ method: 'GET' }),
  );
  expect(session.getSnapshot().draft).toEqual(activated);
});

it('fails closed for mismatched or malformed verification records', async () => {
  const { fetcher, session, view } = setup();
  fetcher
    .mockResolvedValueOnce(json(unverifiedProviderFixture, 201))
    .mockResolvedValueOnce(json(draftServiceFixture, 201));
  await session.createProvider(providerInput);
  await session.createDraft(draftInput);
  const original = session.getSnapshot().provider;

  expect(session.applyWorldVerification(mismatchedVerifiedRecord)).toBe(false);
  expect(
    (session.applyWorldVerification as (value: unknown) => boolean)({
      status: 'VERIFIED',
      providerId: unverifiedProviderFixture.id,
    }),
  ).toBe(false);
  expect(session.getSnapshot().provider).toEqual(original);
  expect(session.getSnapshot().draft).toEqual(draftServiceFixture);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(view()).toContain('UNVERIFIED');
  expect(view()).toContain('Attempt activation');
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

it('lets an unverified provider click Activate through the production boundary and handles backend rejection', async () => {
  const { browserFetch, session, upstream } = boundarySetup();
  upstream
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
  expect(session.getSnapshot().provider?.verification.status).toBe(
    'UNVERIFIED',
  );
  expect(session.getSnapshot().draft?.providerId).toBe(
    unverifiedProviderFixture.id,
  );

  const rendered = RegistryView({ state: session.getSnapshot(), session });
  const markup = renderToStaticMarkup(rendered);
  expect(markup).toContain('Attempt activation');
  const activation = findButton(rendered, 'Attempt activation');
  expect(activation.props.disabled).not.toBe(true);
  activation.props.onClick?.();

  await eventually(() => {
    expect(session.getSnapshot().errors.activation).toContain(
      'Activation blocked: current provider verification is required.',
    );
  });
  expect(browserFetch).toHaveBeenLastCalledWith(
    `/api/services/${draftServiceFixture.id}/activate`,
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );
  expect(upstream).toHaveBeenNthCalledWith(
    3,
    `http://127.0.0.1:3001/api/services/${draftServiceFixture.id}/activate`,
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );
  expect(JSON.parse(String(upstream.mock.calls[1]?.[1]?.body))).toMatchObject({
    providerId: unverifiedProviderFixture.id,
  });

  const rejectedMarkup = renderToStaticMarkup(
    RegistryView({ state: session.getSnapshot(), session }),
  );
  expect(rejectedMarkup).toContain(
    'Activation blocked: current provider verification is required.',
  );
  expect(rejectedMarkup).toContain('Service: Draft');
  expect(rejectedMarkup).not.toMatch(/Service: Active|Liveness verified/);
  expect(session.getSnapshot().provider?.verification.status).toBe(
    'UNVERIFIED',
  );
  expect(session.getSnapshot().draft?.status).toBe('DRAFT');
  expect(
    browserFetch.mock.calls.every(
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
    'Activation request pending.',
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
