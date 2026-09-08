import type { Identifier, Provider, ServiceListing } from '@proofserve/shared';

/** Synchronous storage for Y02; each application owns its repository instance. */
export interface RegistryRepository {
  createProvider(provider: Provider): void;
  getProvider(id: Identifier): Provider | undefined;
  createService(service: ServiceListing): void;
  getService(id: Identifier): ServiceListing | undefined;
  updateService(service: ServiceListing): void;
  listServices(): ServiceListing[];
}

export class InMemoryRegistryRepository implements RegistryRepository {
  private readonly providers = new Map<Identifier, Provider>();
  private readonly services = new Map<Identifier, ServiceListing>();

  createProvider(provider: Provider): void {
    if (this.providers.has(provider.id))
      throw new Error('Duplicate provider ID');
    this.providers.set(provider.id, structuredClone(provider));
  }

  getProvider(id: Identifier): Provider | undefined {
    return structuredClone(this.providers.get(id));
  }

  createService(service: ServiceListing): void {
    if (this.services.has(service.id)) throw new Error('Duplicate service ID');
    this.services.set(service.id, structuredClone(service));
  }

  getService(id: Identifier): ServiceListing | undefined {
    return structuredClone(this.services.get(id));
  }

  updateService(service: ServiceListing): void {
    if (!this.services.has(service.id)) throw new Error('Missing service');
    this.services.set(service.id, structuredClone(service));
  }

  listServices(): ServiceListing[] {
    return structuredClone([...this.services.values()]);
  }
}
