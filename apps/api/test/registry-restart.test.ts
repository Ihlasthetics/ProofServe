import { describe, expect, it } from 'vitest';
import {
  activeServiceFixture,
  verifiedProviderFixture,
  fixtureReferenceTime,
} from '@proofserve/shared';
import { InMemoryRegistryRepository } from '../src/repository.js';
import { createRegistry } from '../src/registry.js';

describe('T05 registry restart diagnosis', () => {
  it('reproduces loss of an active, verified one-tinybar listing when the default registry is recreated', async () => {
    const repository = new InMemoryRegistryRepository();
    const service = structuredClone(activeServiceFixture);
    service.paymentRequirements.amountAtomic = '1';
    repository.createProvider(verifiedProviderFixture);
    repository.createService(service);
    const configuration = {
      now: () => fixtureReferenceTime,
      resolveEndpoint: () => service.endpoint,
    };
    const query = {
      capability: 'SUPPORT_TICKET_TRIAGE',
      network: 'hedera:testnet',
      asset: '0.0.0',
      maxAmountAtomic: '1',
    } as const;
    expect(
      (
        await createRegistry({ ...configuration, repository }).listServices(
          query,
        )
      ).services,
    ).toHaveLength(1);
    expect(
      (await createRegistry(configuration).listServices(query)).services,
    ).toEqual([]);
  });
});
