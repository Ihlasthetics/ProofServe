import { type Provider, type ServiceListing } from '@proofserve/shared';
import { formatHbar } from '../lib/format-hbar';
import { ServiceStatusBadge } from './service-status-badge';
import { ProviderVerificationBadge } from './provider-verification-badge';

export function ServiceCard({
  service,
  provider,
  referenceTime,
}: {
  service: ServiceListing;
  provider: Provider;
  referenceTime: string;
}) {
  if (service.providerId !== provider.id)
    throw new Error('Service and provider must match.');
  return (
    <article
      className="service-card"
      aria-labelledby={`registry-service-${service.id}`}
    >
      <p className="eyebrow">Registry service snapshot</p>
      <h3 id={`registry-service-${service.id}`}>{service.name}</h3>
      <p>{service.description}</p>
      <dl>
        <div>
          <dt>Capability</dt>
          <dd>{service.capability.replaceAll('_', ' ').toLowerCase()}</dd>
        </div>
        <div>
          <dt>Price per request</dt>
          <dd>{formatHbar(service.paymentRequirements.amountAtomic)} HBAR</dd>
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
          referenceTime={referenceTime}
        />
        <p className="reference">
          Status checked at{' '}
          <time dateTime={referenceTime}>{referenceTime}</time>; eligibility
          must be rechecked before payment.
        </p>
      </div>
    </article>
  );
}
