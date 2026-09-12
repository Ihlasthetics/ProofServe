import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  draftServiceFixture,
  unverifiedProviderFixture,
  verifiedProviderFixture,
  fixtureReferenceTime,
} from '@proofserve/shared';
import { createRegistryClient } from '../src/lib/registry-client';
import { createRegistrySession } from '../src/lib/registry-session';
import { RegistryView } from '../src/components/provider-onboarding';

const activated = {
  ...draftServiceFixture,
  status: 'ACTIVE' as const,
  updatedAt: '2026-09-06T10:01:00.000Z',
};
const verified = {
  ...unverifiedProviderFixture,
  verification: {
    ...verifiedProviderFixture.verification,
    providerId: unverifiedProviderFixture.id,
  },
};
const listing = { services: [{ service: activated, provider: verified }] };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
async function setup() {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(unverifiedProviderFixture))
    .mockResolvedValueOnce(json(draftServiceFixture));
  const session = createRegistrySession(
    createRegistryClient(fetcher),
    () => fixtureReferenceTime,
  );
  await session.createProvider({
    displayName: unverifiedProviderFixture.displayName,
    payoutAccount: unverifiedProviderFixture.payoutAccount,
  });
  await session.createDraft({
    name: draftServiceFixture.name,
    description: draftServiceFixture.description,
    capability: 'SUPPORT_TICKET_TRIAGE',
    price: {
      network: 'hedera:testnet',
      asset: '0.0.0',
      amountAtomic: '1000000',
    },
  });
  return { fetcher, session };
}

it('reflects validated activation state and reconciles listing without inventing verification', async () => {
  const { fetcher, session } = await setup();
  fetcher
    .mockResolvedValueOnce(json(activated))
    .mockResolvedValueOnce(json(listing));
  await session.activate();
  expect(session.getSnapshot().draft).toEqual(activated);
  expect(session.getSnapshot().listing).toEqual(listing);
  expect(session.getSnapshot().listingCheckedAt).toBe(fixtureReferenceTime);
  expect(session.getSnapshot().provider).toEqual(unverifiedProviderFixture);
  expect(fetcher.mock.calls.slice(2).map(([url]) => url)).toEqual([
    `/api/services/${activated.id}/activate`,
    '/api/services',
  ]);
  const markup = renderToStaticMarkup(
    <RegistryView state={session.getSnapshot()} session={session} />,
  );
  expect(markup).toContain(
    `Registry confirmed activation: ${draftServiceFixture.name}`,
  );
  expect(markup).toContain('Service: Active');
  expect(markup).not.toContain('Service: Draft');
  expect(markup).toContain('local provider snapshot remains UNVERIFIED');
  expect(markup).toContain('1 eligible services returned.');
  await session.activate();
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it('retains authoritative activation if listing reconciliation fails, without asserting eligibility', async () => {
  const { fetcher, session } = await setup();
  fetcher
    .mockResolvedValueOnce(json(activated))
    .mockRejectedValueOnce(new Error('offline'));
  await session.activate();
  expect(session.getSnapshot().draft).toEqual(activated);
  expect(session.getSnapshot().provider).toEqual(unverifiedProviderFixture);
  expect(session.getSnapshot().listing).toBeNull();
  expect(session.getSnapshot().errors.listing).toBeDefined();
  expect(session.getSnapshot().errors.activation).toBeUndefined();
});
it.each([
  [activated, 201],
  [{}, 200],
  [{ ...activated, id: 'other' }, 200],
  [{ ...activated, providerId: 'other' }, 200],
  [{ ...activated, status: 'DRAFT' }, 200],
  [
    { error: { code: 'PROVIDER_VERIFICATION_REQUIRED', message: 'Blocked' } },
    403,
  ],
  [{ error: { code: 'INTERNAL_ERROR', message: 'Private' } }, 500],
])(
  'rejects unexpected/error activation %# without promoting state or refreshing discovery',
  async (data, status) => {
    const { fetcher, session } = await setup();
    fetcher.mockResolvedValueOnce(json(data, Number(status)));
    await session.activate();
    expect(session.getSnapshot().draft).toEqual(draftServiceFixture);
    expect(session.getSnapshot().provider).toEqual(unverifiedProviderFixture);
    expect(session.getSnapshot().listing).toBeNull();
    expect(session.getSnapshot().errors.activation).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);
it('discards an in-flight pre-activation listing and performs a fresh post-activation read', async () => {
  const { fetcher, session } = await setup();
  let finishOld!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishOld = resolve;
      }),
  );
  const oldRead = session.refresh();
  fetcher
    .mockResolvedValueOnce(json(activated))
    .mockResolvedValueOnce(json(listing));
  const activation = session.activate();
  // Wait for the authoritative activation update while the old GET is pending.
  await vi.waitFor(() =>
    expect(session.getSnapshot().draft?.status).toBe('ACTIVE'),
  );
  expect(session.getSnapshot().listing).toBeNull();
  const snapshots: unknown[] = [];
  const unsubscribe = session.subscribe(() => {
    snapshots.push(session.getSnapshot().listing);
  });
  finishOld(json({ services: [] }));
  await oldRead;
  await activation;
  unsubscribe();
  expect(session.getSnapshot().listing).toEqual(listing);
  expect(snapshots.filter(Boolean)).not.toContainEqual({ services: [] });
  expect(fetcher).toHaveBeenCalledTimes(5);
});
it('clears old eligibility after blocked activation without advancing listingCheckedAt', async () => {
  const { fetcher, session } = await setup();
  fetcher.mockResolvedValueOnce(json(listing));
  await session.refresh();
  const before = renderToStaticMarkup(
    <RegistryView state={session.getSnapshot()} session={session} />,
  );
  // Fixture verification is expired at wall-clock time, but valid at the labelled snapshot.
  expect(before).toContain('1 eligible services returned.');
  expect(before).toContain(`dateTime="${fixtureReferenceTime}"`);
  fetcher.mockResolvedValueOnce(
    json(
      { error: { code: 'PROVIDER_VERIFICATION_REQUIRED', message: 'Blocked' } },
      403,
    ),
  );
  await session.activate();
  const after = renderToStaticMarkup(
    <RegistryView state={session.getSnapshot()} session={session} />,
  );
  expect(after).not.toContain('1 eligible services returned.');
  expect(after).not.toContain(`dateTime="${fixtureReferenceTime}"`);
  expect(session.getSnapshot().listingCheckedAt).toBe(fixtureReferenceTime);
});
