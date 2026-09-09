import {
  fixtureReferenceTime,
  type Provider,
  type ServiceListing,
} from '@proofserve/shared';
import { formatHbar } from '../lib/format-hbar';
import { ServiceStatusBadge } from './service-status-badge';
import { ProviderVerificationBadge } from './provider-verification-badge';

export function ServiceCard({
  service,
  provider,
}: {
  service: ServiceListing;
  provider: Provider;
}) {
  if (service.providerId !== provider.id)
    throw new Error('Service and provider must match.');
  return (
    <article className="service-card" aria-labelledby={service.id}>
      <p className="eyebrow">Fictional development/test service preview</p>
      <h3 id={service.id}>{service.name}</h3>
      <p>{service.description}</p>
      <dl>
        <div>
          <dt>Capability</dt>
          <dd>{service.capability.replaceAll('_', ' ').toLowerCase()}</dd>
        </div>
        <div>
          <dt>Price per request</dt>
          <dd>
            {formatHbar(service.paymentRequirements.amountAtomic)} HBAR —
            fictional example
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{service.paymentRequirements.network}</dd>
        </div>
      </dl>
      <ServiceStatusBadge status={service.status} />
      <div className="provider">
        <p className="eyebrow">Provider</p>
        <p className="provider-name">{provider.displayName}</p>
        <ProviderVerificationBadge
          verification={provider.verification}
          referenceTime={fixtureReferenceTime}
        />
        <p className="reference">
          Fictional status at{' '}
          <time dateTime={fixtureReferenceTime}>{fixtureReferenceTime}</time>;
          not a live verification result.
        </p>
      </div>
    </article>
  );
}
