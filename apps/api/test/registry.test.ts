import { expect, it } from 'vitest';
import {
  activeServiceFixture,
  verifiedProviderFixture,
  ServiceListingSchema,
} from '@proofserve/shared';
import { InMemoryRegistryRepository } from '../src/index.js';

it('copies providers on write and read, including nested verification', () => {
  const repository = new InMemoryRegistryRepository();
  const original = structuredClone(verifiedProviderFixture);
  repository.createProvider(original);
  original.verification.providerId = 'mutated';
  const retrieved = repository.getProvider(verifiedProviderFixture.id);
  expect(retrieved).toBeDefined();
  if (!retrieved) throw new Error('Missing test provider');
  retrieved.verification.providerId = 'also_mutated';
  retrieved.payoutAccount = '0.0.999';
  expect(repository.getProvider(verifiedProviderFixture.id)).toEqual(
    verifiedProviderFixture,
  );
});

it('copies service creates, reads, lists and updates, including nested prices', () => {
  const repository = new InMemoryRegistryRepository();
  const original = structuredClone(activeServiceFixture);
  repository.createService(original);
  original.paymentRequirements.amountAtomic = '1';
  const retrieved = repository.getService(original.id);
  if (!retrieved) throw new Error('Missing test service');
  retrieved.paymentRequirements.payTo = '0.0.999';
  const listed = repository.listServices();
  const first = listed[0];
  if (!first) throw new Error('Missing listed service');
  first.paymentRequirements.amountAtomic = '2';
  listed.length = 0;
  expect(repository.listServices()).toEqual([activeServiceFixture]);
  const updated = ServiceListingSchema.parse({
    ...activeServiceFixture,
    status: 'SUSPENDED',
  });
  repository.updateService(updated);
  updated.paymentRequirements.amountAtomic = '3';
  expect(repository.getService(updated.id)).toEqual({
    ...activeServiceFixture,
    status: 'SUSPENDED',
  });
});

it('refuses duplicate creates and updates of missing services without overwriting data', () => {
  const repository = new InMemoryRegistryRepository();
  repository.createProvider(verifiedProviderFixture);
  repository.createService(activeServiceFixture);
  expect(() =>
    repository.createProvider({
      ...verifiedProviderFixture,
      payoutAccount: '0.0.999',
    }),
  ).toThrow();
  expect(() =>
    repository.createService({ ...activeServiceFixture, status: 'DRAFT' }),
  ).toThrow();
  expect(() =>
    repository.updateService({ ...activeServiceFixture, id: 'missing' }),
  ).toThrow();
  expect(repository.getProvider(verifiedProviderFixture.id)).toEqual(
    verifiedProviderFixture,
  );
  expect(repository.listServices()).toEqual([activeServiceFixture]);
});

it('keeps repositories independent and returns undefined for missing records', () => {
  const first = new InMemoryRegistryRepository();
  const second = new InMemoryRegistryRepository();
  first.createProvider(verifiedProviderFixture);
  first.createService(activeServiceFixture);
  expect(second.getProvider(verifiedProviderFixture.id)).toBeUndefined();
  expect(second.getService(activeServiceFixture.id)).toBeUndefined();
  expect(second.listServices()).toEqual([]);
});
