import { describe, expect, it } from 'vitest';
import {
  AgentTaskSchema,
  DiscoveryServiceSchema,
  activeServiceFixture,
  agentTaskFixture,
  fixtureReferenceTime,
  unverifiedProviderFixture,
  verifiedProviderFixture,
  type DiscoveryService,
  type VerificationRecord,
} from '@proofserve/shared';
import { ServiceSelectionError, selectService } from '../src/index.js';

const time = (milliseconds: number) =>
  new Date(Date.parse(fixtureReferenceTime) + milliseconds).toISOString();
const candidate = (id = 'service_valid', amountAtomic = '1000000') =>
  DiscoveryServiceSchema.parse({
    service: {
      ...activeServiceFixture,
      id,
      paymentRequirements: {
        ...activeServiceFixture.paymentRequirements,
        amountAtomic,
      },
    },
    provider: verifiedProviderFixture,
  });
const withVerification = (verification: VerificationRecord) =>
  DiscoveryServiceSchema.parse({
    service: activeServiceFixture,
    provider: { ...verifiedProviderFixture, verification },
  });
const select = (entries: readonly DiscoveryService[]) =>
  selectService(agentTaskFixture, entries, fixtureReferenceTime);

// Exercise malformed JavaScript callers without asserting shared types.
const rejectBoundary = (
  task: unknown,
  entries: unknown,
  asOf: unknown = fixtureReferenceTime,
) => {
  expect(() =>
    Reflect.apply(selectService, undefined, [task, entries, asOf]),
  ).toThrow(ServiceSelectionError);
};

describe('T02 budgeted service selection', () => {
  it('selects an active, currently verified, matching service within budget', () => {
    const entry = candidate();
    expect(select([entry])).toEqual(entry);
    // verifiedAt equals asOf: the lower freshness boundary is inclusive.
    expect(selectService(agentTaskFixture, [entry], time(1))).toEqual(entry);
  });

  it('rejects an UNVERIFIED provider', () => {
    const entry = DiscoveryServiceSchema.parse({
      service: {
        ...activeServiceFixture,
        providerId: unverifiedProviderFixture.id,
      },
      provider: unverifiedProviderFixture,
    });
    expect(() => select([entry])).toThrow(ServiceSelectionError);
  });

  it.each([
    {
      label: 'EXPIRED status even with current dates',
      status: 'EXPIRED',
      start: -2,
      end: 2,
    },
    {
      label: 'VERIFIED with past expiry',
      status: 'VERIFIED',
      start: -2,
      end: -1,
    },
    {
      label: 'VERIFIED with expiry equal to asOf',
      status: 'VERIFIED',
      start: -1,
      end: 0,
    },
    {
      label: 'VERIFIED with future verifiedAt',
      status: 'VERIFIED',
      start: 1,
      end: 2,
    },
  ])(
    'rejects $label while the service remains ACTIVE',
    ({ status, start, end }) => {
      const entry = DiscoveryServiceSchema.parse({
        ...candidate(),
        provider: {
          ...verifiedProviderFixture,
          verification: {
            ...verifiedProviderFixture.verification,
            status,
            verifiedAt: time(start),
            expiresAt: time(end),
          },
        },
      });
      expect(() => select([entry])).toThrow(ServiceSelectionError);
    },
  );

  it('accepts verification one millisecond before expiry', () => {
    const entry = withVerification({
      ...verifiedProviderFixture.verification,
      status: 'VERIFIED',
      verifiedAt: time(-1),
      expiresAt: time(1),
    });
    expect(select([entry])).toEqual(entry);
  });

  it.each(['DRAFT', 'SUSPENDED'])('rejects a %s service', (status) => {
    const entry = candidate();
    const inactive = DiscoveryServiceSchema.parse({
      ...entry,
      service: { ...entry.service, status },
    });
    expect(() => select([inactive])).toThrow(ServiceSelectionError);
  });

  it('rejects a price above budget and accepts exact budget equality', () => {
    expect(() => select([candidate('over', '2000001')])).toThrow(
      ServiceSelectionError,
    );
    const exact = candidate('exact', agentTaskFixture.budget.maxAmountAtomic);
    expect(select([exact])).toEqual(exact);
  });

  // Shared schemas support only one capability, network and asset. These are
  // invalid boundary tests, not comparisons between supported alternatives.
  it.each(['capability', 'network', 'asset'])(
    'rejects unsupported %s boundary data in both candidate and task',
    (field) => {
      const entry = candidate();
      const malformedService =
        field === 'capability'
          ? { ...entry.service, capability: 'UNSUPPORTED' }
          : {
              ...entry.service,
              paymentRequirements: {
                ...entry.service.paymentRequirements,
                [field]: 'UNSUPPORTED',
              },
            };
      rejectBoundary(agentTaskFixture, [
        { ...entry, service: malformedService },
      ]);
      const malformedTask =
        field === 'capability'
          ? { ...agentTaskFixture, capability: 'UNSUPPORTED' }
          : {
              ...agentTaskFixture,
              budget: { ...agentTaskFixture.budget, [field]: 'UNSUPPORTED' },
            };
      rejectBoundary(malformedTask, [entry]);
    },
  );

  it('rejects malformed timestamps, collections, amounts and provider pairing', () => {
    const entry = candidate();
    rejectBoundary(agentTaskFixture, [entry], 'invalid');
    rejectBoundary(agentTaskFixture, null);
    rejectBoundary(null, [entry]);
    rejectBoundary(agentTaskFixture, [
      { ...entry, provider: unverifiedProviderFixture },
    ]);
    for (const amountAtomic of ['0', '-1', '01', '1.5', '1e6', 1000000]) {
      rejectBoundary(agentTaskFixture, [
        {
          ...entry,
          service: {
            ...entry.service,
            paymentRequirements: {
              ...entry.service.paymentRequirements,
              amountAtomic,
            },
          },
        },
      ]);
      rejectBoundary(
        {
          ...agentTaskFixture,
          budget: { ...agentTaskFixture.budget, maxAmountAtomic: amountAtomic },
        },
        [entry],
      );
    }
  });

  it('compares adjacent atomic amounts beyond safe integer precision', () => {
    const task = AgentTaskSchema.parse({
      ...agentTaskFixture,
      budget: {
        ...agentTaskFixture.budget,
        maxAmountAtomic: '9007199254740992',
      },
    });
    const exact = candidate('z_exact', '9007199254740992');
    const over = candidate('a_over', '9007199254740993');
    expect(() => selectService(task, [over], fixtureReferenceTime)).toThrow(
      ServiceSelectionError,
    );
    expect(selectService(task, [over, exact], fixtureReferenceTime)).toEqual(
      exact,
    );
    const largerBudget = AgentTaskSchema.parse({
      ...task,
      budget: {
        ...task.budget,
        maxAmountAtomic: '999999999999999999999999999999',
      },
    });
    for (const entries of [
      [over, exact],
      [exact, over],
    ]) {
      expect(
        selectService(largerBudget, entries, fixtureReferenceTime),
      ).toEqual(exact);
    }
  });

  it('selects the cheapest eligible service in every candidate permutation', () => {
    const cheap = candidate('z_cheap', '9');
    const expensive = candidate('a_expensive', '10');
    const inactive = DiscoveryServiceSchema.parse({
      ...candidate('inactive', '1'),
      service: { ...candidate('inactive', '1').service, status: 'DRAFT' },
    });
    for (const entries of [
      [cheap, expensive, inactive],
      [cheap, inactive, expensive],
      [expensive, cheap, inactive],
      [expensive, inactive, cheap],
      [inactive, cheap, expensive],
      [inactive, expensive, cheap],
    ])
      expect(select(entries)).toEqual(cheap);
  });

  it('breaks equal-price ties by ordinal service ID regardless of order', () => {
    const upper = candidate('Z_service');
    const lower = candidate('a_service');
    expect(select([lower, upper])).toEqual(upper);
    expect(select([upper, lower])).toEqual(upper);
  });

  it('throws a safe local typed error when no candidate qualifies', () => {
    expect(() => select([])).toThrow(ServiceSelectionError);
    expect(() => select([])).toThrow('No eligible service');
  });

  it.each(['identical', 'different', 'ineligible'])(
    'rejects %s duplicate IDs in either order without changing nested inputs',
    (kind) => {
      const first = candidate();
      const second = candidate(
        first.service.id,
        kind === 'different' ? '1' : '1000000',
      );
      if (kind === 'ineligible') {
        first.service.status = 'DRAFT';
        second.service.status = 'SUSPENDED';
      }
      for (const entries of [
        [first, second],
        [second, first],
      ]) {
        const before = structuredClone(entries);
        const originalOrder = [...entries];
        expect(() => select(entries)).toThrow(ServiceSelectionError);
        expect(() => select(entries)).toThrow('Duplicate service ID');
        expect(entries).toEqual(before);
        expect(entries[0]).toBe(originalOrder[0]);
        expect(entries[1]).toBe(originalOrder[1]);
      }
    },
  );

  it('preserves all nested inputs and returns a detached shared-validated snapshot', () => {
    const task = structuredClone(agentTaskFixture);
    const entries = [candidate('expensive', '10'), candidate('cheap', '9')];
    const before = structuredClone({ task, entries });
    const originalOrder = [...entries];
    const output = selectService(task, entries, fixtureReferenceTime);
    expect(DiscoveryServiceSchema.parse(output)).toEqual(output);
    expect(output).toEqual(entries[1]);
    expect(output).not.toBe(entries[1]);
    output.service.paymentRequirements.amountAtomic = '123';
    output.provider.verification = unverifiedProviderFixture.verification;
    expect({ task, entries }).toEqual(before);
    expect(entries[0]).toBe(originalOrder[0]);
    expect(entries[1]).toBe(originalOrder[1]);
    expect(() => selectService(task, entries, time(-1))).toThrow(
      ServiceSelectionError,
    );
    expect({ task, entries }).toEqual(before);
  });
});
