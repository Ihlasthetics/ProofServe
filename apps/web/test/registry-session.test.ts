import { expect, it, vi } from 'vitest';
import {
  unverifiedProviderFixture,
  draftServiceFixture,
} from '@proofserve/shared';
import { createRegistryClient } from '../src/lib/registry-client';
import { createRegistrySession } from '../src/lib/registry-session';

const input = {
  displayName: unverifiedProviderFixture.displayName,
  payoutAccount: unverifiedProviderFixture.payoutAccount,
};
const draft = {
  name: draftServiceFixture.name,
  description: draftServiceFixture.description,
  capability: 'SUPPORT_TICKET_TRIAGE' as const,
  price: {
    network: 'hedera:testnet' as const,
    asset: '0.0.0' as const,
    amountAtomic: '1000000',
  },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

it('timestamps only successful listing snapshots, unaffected by other operations or failed refreshes', async () => {
  const fetcher = vi.fn<typeof fetch>();
  let time = '2026-09-10T10:00:00.000Z';
  const clock = vi.fn(() => time);
  const session = createRegistrySession(createRegistryClient(fetcher), clock);
  expect(session.getSnapshot().listingCheckedAt).toBeNull();
  fetcher.mockResolvedValueOnce(json({ services: [] }));
  await session.refresh();
  expect(session.getSnapshot().listingCheckedAt).toBe(time);
  time = '2026-09-10T11:00:00.000Z';
  fetcher.mockResolvedValueOnce(json(unverifiedProviderFixture));
  await session.createProvider(input);
  fetcher.mockRejectedValueOnce(new Error('offline'));
  await session.refresh();
  expect(session.getSnapshot().listingCheckedAt).toBe(
    '2026-09-10T10:00:00.000Z',
  );
  expect(clock).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().listing).toBeNull();
  fetcher.mockResolvedValueOnce(json({ services: [] }));
  await session.refresh();
  expect(session.getSnapshot().listingCheckedAt).toBe(time);
  expect(session.getSnapshot().errors.listing).toBeUndefined();
});

it('clears retry errors at pending time, prevents duplicate provider operations, and notifies subscribers', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('offline'));
  const session = createRegistrySession(createRegistryClient(fetcher));
  const listener = vi.fn();
  const unsubscribe = session.subscribe(listener);
  await session.createProvider(input);
  expect(session.getSnapshot().errors.provider).toBeDefined();
  let resolve!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const pending = session.createProvider(input);
  expect(session.getSnapshot().pending.provider).toBe(true);
  expect(session.getSnapshot().errors.provider).toBeUndefined();
  await session.createProvider(input);
  expect(fetcher).toHaveBeenCalledTimes(2);
  resolve(json(unverifiedProviderFixture));
  await pending;
  expect(session.getSnapshot().pending.provider).toBe(false);
  await session.createProvider(input);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalled();
  unsubscribe();
  listener.mockClear();
  fetcher.mockResolvedValueOnce(json({ services: [] }));
  await session.refresh();
  expect(listener).not.toHaveBeenCalled();
});

it('retries draft and blocked activation without any verification or activation promotion', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(unverifiedProviderFixture))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(json(draftServiceFixture));
  const session = createRegistrySession(createRegistryClient(fetcher));
  await session.createProvider(input);
  await session.createDraft(draft);
  expect(session.getSnapshot().draft).toBeNull();
  await session.createDraft(draft);
  expect(session.getSnapshot().errors.draft).toBeUndefined();
  for (let attempt = 0; attempt < 2; attempt++) {
    fetcher.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'PROVIDER_VERIFICATION_REQUIRED',
            message: 'Verification required.',
          },
        },
        403,
      ),
    );
    await session.activate();
    expect(session.getSnapshot().pending.activation).toBe(false);
    expect(session.getSnapshot().errors.activation).toContain(
      'Activation blocked',
    );
    expect(session.getSnapshot().draft?.status).toBe('DRAFT');
    expect(session.getSnapshot().provider?.verification.status).toBe(
      'UNVERIFIED',
    );
  }
});

it.each(['provider', 'draft', 'activation'] as const)(
  'keeps uncertain %s outcomes conservative without automatically retrying',
  async (operation) => {
    for (const failure of ['internal', 'network', 'malformed'] as const) {
      const fetcher = vi.fn<typeof fetch>();
      const session = createRegistrySession(createRegistryClient(fetcher));
      if (operation !== 'provider') {
        fetcher.mockResolvedValueOnce(json(unverifiedProviderFixture));
        await session.createProvider(input);
      }
      if (operation === 'activation') {
        fetcher.mockResolvedValueOnce(json(draftServiceFixture));
        await session.createDraft(draft);
      }
      const before = fetcher.mock.calls.length;
      if (failure === 'internal') {
        fetcher.mockResolvedValueOnce(
          json(
            {
              error: {
                code: 'INTERNAL_ERROR',
                message: 'secret upstream stack trace',
              },
            },
            500,
          ),
        );
      } else if (failure === 'network') {
        fetcher.mockRejectedValueOnce(
          new Error('secret upstream transport diagnostics'),
        );
      } else {
        fetcher.mockResolvedValueOnce(
          new Response('<html>secret diagnostics</html>'),
        );
      }
      if (operation === 'provider') await session.createProvider(input);
      else if (operation === 'draft') await session.createDraft(draft);
      else await session.activate();
      const state = session.getSnapshot();
      expect(state.errors[operation]).toContain(
        'The request outcome is uncertain and may have been saved.',
      );
      expect(state.errors[operation]).toContain('Check the current state');
      expect(state.errors[operation]).toContain('before retrying');
      expect(state.errors[operation]).not.toMatch(
        /Try again later|definitely failed|secret|stack trace|diagnostics|<html>/,
      );
      expect(fetcher).toHaveBeenCalledTimes(before + 1);
      expect(state.pending[operation]).toBe(false);
      expect(state.provider?.verification.status ?? null).toBe(
        operation === 'provider' ? null : 'UNVERIFIED',
      );
      expect(state.draft?.status ?? null).toBe(
        operation === 'activation' ? 'DRAFT' : null,
      );
    }
  },
);

it.each(['internal', 'network'] as const)(
  'offers safe read-only retry guidance for %s listing failures',
  async (failure) => {
    const fetcher = vi.fn<typeof fetch>();
    if (failure === 'internal')
      fetcher.mockResolvedValueOnce(
        json(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'secret upstream stack trace',
            },
          },
          500,
        ),
      );
    else fetcher.mockRejectedValueOnce(new Error('secret diagnostics'));
    const session = createRegistrySession(createRegistryClient(fetcher));
    await session.refresh();
    expect(session.getSnapshot().errors.listing).toContain('Try again later.');
    expect(session.getSnapshot().errors.listing).not.toMatch(
      /may have been saved|secret|stack trace|diagnostics/,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(session.getSnapshot().listing).toBeNull();
  },
);
