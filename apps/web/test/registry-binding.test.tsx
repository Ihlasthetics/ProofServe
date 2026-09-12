import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  CreateProviderRequestSchema,
  CreateServiceRequestSchema,
  ProviderSchema,
  ServiceListingSchema,
  draftServiceFixture,
  unverifiedProviderFixture,
  verifiedProviderFixture,
  fixtureReferenceTime,
  type ServiceListing,
} from '@proofserve/shared';
import {
  createRegistryClient,
  RegistryRequestError,
} from '../src/lib/registry-client';
import { createRegistrySession } from '../src/lib/registry-session';
import { registryBoundary } from '../src/server/registry-boundary';
import { RegistryView } from '../src/components/provider-onboarding';
import {
  providerFormData,
  draftFormData,
} from '../src/lib/onboarding-form-data';

const provider = unverifiedProviderFixture;
const draft = ServiceListingSchema.parse({
  ...draftServiceFixture,
  paymentRequirements: {
    ...draftServiceFixture.paymentRequirements,
    amountAtomic: '9007199254740993',
  },
});
const providerInput = CreateProviderRequestSchema.parse({
  displayName: provider.displayName,
  payoutAccount: provider.payoutAccount,
});
const draftInput = CreateServiceRequestSchema.parse({
  providerId: provider.id,
  name: draft.name,
  description: draft.description,
  capability: draft.capability,
  price: {
    network: draft.paymentRequirements.network,
    asset: draft.paymentRequirements.asset,
    amountAtomic: draft.paymentRequirements.amountAtomic,
  },
});
const draftForm = draftInput;
const active = {
  ...draft,
  status: 'ACTIVE' as const,
  updatedAt: '2026-09-06T10:01:00.000Z',
};
const listing = {
  services: [
    {
      service: active,
      provider: {
        ...provider,
        verification: {
          ...verifiedProviderFixture.verification,
          providerId: provider.id,
        },
      },
    },
  ],
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Debug': 'private-diagnostic',
      'Set-Cookie': 'private-cookie',
      Location: 'https://private.example.test',
      'Cache-Control': 'public',
    },
  });
const request = (path: string, body: unknown) =>
  new Request(`http://web.example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
async function controlled(response: Response) {
  expect(response.status).toBe(500);
  expect([...response.headers.keys()].sort()).toEqual([
    'cache-control',
    'content-type',
  ]);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The registry request could not be completed.',
    },
  });
}
async function setup() {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(provider, 201))
    .mockResolvedValueOnce(json(draft, 201));
  const client = createRegistryClient(fetcher);
  const session = createRegistrySession(client, () => fixtureReferenceTime);
  await session.createProvider(providerInput);
  await session.createDraft(draftForm);
  expect(session.getSnapshot().draft).toEqual(draft);
  return { fetcher, client, session };
}
function unchanged(session: ReturnType<typeof createRegistrySession>) {
  const state = session.getSnapshot();
  expect(state.provider).toEqual(provider);
  expect(state.draft).toEqual(draft);
  expect(state.listing).toBeNull();
  expect(state.errors.activation).toContain('No local success was applied.');
  expect(state.errors.activation).toContain('outcome is uncertain');
  const markup = renderToStaticMarkup(
    <RegistryView state={state} session={session} />,
  );
  expect(markup).toContain('Service: Draft');
  expect(markup).not.toMatch(
    /Service: Active|Liveness verified|private-diagnostic|eligible services returned/,
  );
}

function verifiedCreationResponse() {
  // VERIFIED requires dated metadata. Keep the same provider and verification
  // identity; change only status and the dates required by that schema branch.
  const returned = ProviderSchema.parse({
    ...provider,
    verification: {
      ...provider.verification,
      status: 'VERIFIED',
      verifiedAt: fixtureReferenceTime,
      expiresAt: '2026-09-07T10:00:00.000Z',
    },
  });
  expect({ ...returned, verification: provider.verification }).toEqual(
    provider,
  );
  expect(returned.displayName).toBe(providerInput.displayName);
  expect(returned.payoutAccount).toBe(providerInput.payoutAccount);
  expect(returned.verification.providerId).toBe(provider.id);
  expect(returned.verification.method).toBe(provider.verification.method);
  expect(returned.verification.status).toBe('VERIFIED');
  return returned;
}

it('rejects an otherwise matching VERIFIED provider creation at the server boundary', async () => {
  const returned = verifiedCreationResponse();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(returned, 201));
  await controlled(
    await registryBoundary(request('/api/providers', providerInput), fetcher),
  );
  expect(fetcher).toHaveBeenCalledOnce();
});

it('rejects an otherwise matching VERIFIED provider creation in the browser client', async () => {
  const returned = verifiedCreationResponse();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(returned, 201));
  await expect(
    createRegistryClient(fetcher).createProvider(providerInput),
  ).rejects.toThrow(
    /^Unexpected provider response\. No local success was applied\./,
  );
  expect(fetcher).toHaveBeenCalledOnce();
});

it('does not retain an otherwise matching VERIFIED creation or enable downstream onboarding', async () => {
  const returned = verifiedCreationResponse();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(returned, 201));
  const session = createRegistrySession(createRegistryClient(fetcher));
  await session.createProvider(providerInput);
  await session.createDraft(draftForm);
  await session.activate();
  const state = session.getSnapshot();
  expect(state.provider).toBeNull();
  expect(state.draft).toBeNull();
  expect(state.listing).toBeNull();
  expect(state.listingCheckedAt).toBeNull();
  expect(state.pending.provider).toBe(false);
  expect(state.errors.provider).toMatch(/^Unexpected provider response\./);
  expect(fetcher).toHaveBeenCalledOnce();
  const markup = renderToStaticMarkup(
    <RegistryView state={state} session={session} />,
  );
  const draftFormMarkup = markup.match(
    /<form\b[^>]*aria-labelledby="draft-heading"[^>]*>[\s\S]*?<\/form>/,
  )?.[0];
  expect(draftFormMarkup).toBeDefined();
  expect(draftFormMarkup).toContain('<fieldset disabled="">');
  expect(markup).toContain('Create a provider first to enable this form.');
  expect(markup).toContain('Unexpected provider response.');
  expect(markup).not.toMatch(
    /Provider created:|Service: Draft|Service: Active|Liveness verified/,
  );
});

it.each(['displayName', 'payoutAccount'] as const)(
  'rejects schema-valid provider %s mismatch at boundary, client and session',
  async (field) => {
    const returned = {
      ...provider,
      [field]: field === 'displayName' ? 'private-diagnostic' : '0.0.999',
    };
    expect(ProviderSchema.safeParse(returned).success).toBe(true);
    await controlled(
      await registryBoundary(
        request('/api/providers', providerInput),
        vi.fn<typeof fetch>().mockResolvedValue(json(returned, 201)),
      ),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(returned, 201));
    const client = createRegistryClient(fetcher);
    await expect(client.createProvider(providerInput)).rejects.toBeInstanceOf(
      RegistryRequestError,
    );
    const session = createRegistrySession(client);
    await session.createProvider(providerInput);
    expect(session.getSnapshot().provider).toBeNull();
    expect(session.getSnapshot().draft).toBeNull();
    expect(session.getSnapshot().listing).toBeNull();
    expect(session.getSnapshot().errors.provider).toContain(
      'outcome is uncertain',
    );
    expect(session.getSnapshot().errors.provider).not.toContain(
      'private-diagnostic',
    );
  },
);

type Mutation = {
  field: string;
  schemaValid: boolean;
  mutate: (value: ServiceListing) => unknown;
};
const draftMutations: Mutation[] = [
  {
    field: 'providerId',
    schemaValid: true,
    mutate: (s) => ({ ...s, providerId: 'other-provider' }),
  },
  {
    field: 'name',
    schemaValid: true,
    mutate: (s) => ({ ...s, name: 'private-diagnostic' }),
  },
  {
    field: 'description',
    schemaValid: true,
    mutate: (s) => ({ ...s, description: 'private-diagnostic' }),
  },
  // These fields have only one permitted value in the current shared contract.
  {
    field: 'capability',
    schemaValid: false,
    mutate: (s) => ({ ...s, capability: 'OTHER' }),
  },
  {
    field: 'network',
    schemaValid: false,
    mutate: (s) => ({
      ...s,
      paymentRequirements: {
        ...s.paymentRequirements,
        network: 'hedera:mainnet',
      },
    }),
  },
  {
    field: 'asset',
    schemaValid: false,
    mutate: (s) => ({
      ...s,
      paymentRequirements: { ...s.paymentRequirements, asset: '0.0.1' },
    }),
  },
  {
    field: 'amount',
    schemaValid: true,
    mutate: (s) => ({
      ...s,
      paymentRequirements: {
        ...s.paymentRequirements,
        amountAtomic: '9007199254740992',
      },
    }),
  },
];
const payTo: Mutation = {
  field: 'payTo',
  schemaValid: true,
  mutate: (s) => ({
    ...s,
    paymentRequirements: { ...s.paymentRequirements, payTo: '0.0.999' },
  }),
};
const activationMutations: Mutation[] = [
  ...draftMutations,
  payTo,
  {
    field: 'id',
    schemaValid: true,
    mutate: (s) => ({ ...s, id: 'other-service' }),
  },
  {
    field: 'endpoint',
    schemaValid: true,
    mutate: (s) => ({ ...s, endpoint: 'https://other.example.test/v1/triage' }),
  },
  {
    field: 'createdAt',
    schemaValid: true,
    mutate: (s) => ({ ...s, createdAt: '2026-09-06T09:00:00.000Z' }),
  },
];
it.each(draftMutations)(
  'rejects draft $field mismatch at the real server boundary',
  async ({ mutate, schemaValid }) => {
    const returned = mutate(draft);
    expect(ServiceListingSchema.safeParse(returned).success).toBe(schemaValid);
    await controlled(
      await registryBoundary(
        request('/api/services', draftInput),
        vi.fn<typeof fetch>().mockResolvedValue(json(returned, 201)),
      ),
    );
  },
);
it.each([...draftMutations, payTo])(
  'rejects draft $field mismatch at client and session without retaining it',
  async ({ mutate, schemaValid }) => {
    const returned = mutate(draft);
    expect(ServiceListingSchema.safeParse(returned).success).toBe(schemaValid);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(returned, 201));
    const client = createRegistryClient(fetcher);
    await expect(
      client.createService(draftInput, provider),
    ).rejects.toBeInstanceOf(RegistryRequestError);
    const session = createRegistrySession(client);
    fetcher.mockResolvedValueOnce(json(provider, 201));
    await session.createProvider(providerInput);
    await session.createDraft(draftForm);
    expect(session.getSnapshot().provider).toEqual(provider);
    expect(session.getSnapshot().draft).toBeNull();
    expect(session.getSnapshot().listing).toBeNull();
    expect(session.getSnapshot().errors.draft).toContain(
      'outcome is uncertain',
    );
    expect(session.getSnapshot().errors.draft).not.toContain(
      'private-diagnostic',
    );
  },
);
it.each(activationMutations)(
  'rejects activation $field mismatch and invalidates old eligibility',
  async ({ mutate, schemaValid }) => {
    const returned = mutate(active);
    expect(ServiceListingSchema.safeParse(returned).success).toBe(schemaValid);
    const { fetcher, client, session } = await setup();
    fetcher.mockResolvedValueOnce(json(returned));
    await expect(client.activateService(draft)).rejects.toBeInstanceOf(
      RegistryRequestError,
    );
    fetcher.mockResolvedValueOnce(json(listing));
    await session.refresh();
    expect(session.getSnapshot().listing).toEqual(listing);
    fetcher.mockResolvedValueOnce(json(returned));
    await session.activate();
    unchanged(session);
    expect(session.getSnapshot().listingCheckedAt).toBe(fixtureReferenceTime);
    expect(fetcher).toHaveBeenCalledTimes(5); // No automatic listing on failure.
  },
);

it('discards an in-flight listing after a mismatched activation and allows explicit recovery', async () => {
  const { fetcher, session } = await setup();
  let finish!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = session.refresh();
  fetcher.mockResolvedValueOnce(
    json({ ...active, endpoint: 'https://other.example.test/v1/triage' }),
  );
  await session.activate();
  finish(json(listing));
  await pending;
  unchanged(session);
  expect(session.getSnapshot().listingCheckedAt).toBeNull();
  fetcher.mockResolvedValueOnce(json({ services: [] }));
  await session.refresh();
  expect(session.getSnapshot().listing).toEqual({ services: [] });
  expect(session.getSnapshot().listingCheckedAt).toBe(fixtureReferenceTime);
});
it('suppresses manual refresh while activation response binding is pending', async () => {
  const { fetcher, session } = await setup();
  let finish!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = session.activate();
  await session.refresh();
  expect(fetcher).toHaveBeenCalledTimes(3);
  finish(json({ ...active, name: 'private-diagnostic' }));
  await pending;
  unchanged(session);
});
it('binds against parsed snapshots even if caller inputs are mutated while requests are pending', async () => {
  const { client, fetcher } = await setup();
  const owner = structuredClone(provider);
  const input = structuredClone(draftInput);
  let finish!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = client.createService(input, owner);
  input.name = 'mutated';
  owner.payoutAccount = '0.0.999';
  finish(json(draft, 201));
  expect(await pending).toEqual(draft);
  const expected = structuredClone(draft);
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const activation = client.activateService(expected);
  expected.endpoint = 'https://other.example.test/v1/triage';
  finish(json(active));
  expect(await activation).toEqual(active);
});
it('accepts exactly bound responses through boundary, client, session and form normalization', async () => {
  const upstream = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(provider, 201))
    .mockResolvedValueOnce(json(draft, 201))
    .mockResolvedValueOnce(json(active))
    .mockResolvedValueOnce(json(listing));
  const fetcher = vi.fn<typeof fetch>(async (url, init) =>
    registryBoundary(
      new Request(`http://web.example.test${url}`, init),
      upstream,
    ),
  );
  const session = createRegistrySession(
    createRegistryClient(fetcher),
    () => fixtureReferenceTime,
  );
  const providerData = new FormData();
  providerData.set('displayName', `  ${provider.displayName}  `);
  providerData.set('payoutAccount', ` ${provider.payoutAccount} `);
  await session.createProvider(providerFormData(providerData));
  const serviceData = new FormData();
  serviceData.set('name', ` ${draft.name} `);
  serviceData.set('description', ` ${draft.description} `);
  serviceData.set(
    'amountAtomic',
    ` ${draft.paymentRequirements.amountAtomic} `,
  );
  await session.createDraft(draftFormData(serviceData));
  await session.activate();
  expect(session.getSnapshot().provider).toEqual(provider);
  expect(session.getSnapshot().draft).toEqual(active);
  expect(session.getSnapshot().listing).toEqual(listing);
  expect(session.getSnapshot().listingCheckedAt).toBe(fixtureReferenceTime);
});
