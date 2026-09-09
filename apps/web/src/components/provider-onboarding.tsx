import {
  activeServiceFixture,
  apiErrorFixture,
  draftServiceFixture,
  fixtureNotice,
  fixtureReferenceTime,
  unverifiedProviderFixture,
  verifiedProviderFixture,
  type Provider,
  type ServiceListing,
} from '@proofserve/shared';
import type { ReactNode } from 'react';
import { ProviderVerificationBadge } from './provider-verification-badge';
import { ServiceStatusBadge } from './service-status-badge';

function OnboardingSnapshot({
  id,
  title,
  provider,
  service,
  children,
}: {
  id: string;
  title: string;
  provider: Provider;
  service?: ServiceListing;
  children: ReactNode;
}) {
  if (service && service.providerId !== provider.id)
    throw new Error('Service and provider must match.');

  return (
    <article className="onboarding-card" aria-labelledby={id}>
      <p className="eyebrow">Fictional onboarding snapshot</p>
      <h3 id={id}>{title}</h3>
      <p className="provider-name">{provider.displayName}</p>
      <ProviderVerificationBadge
        verification={provider.verification}
        referenceTime={fixtureReferenceTime}
      />
      {service && (
        <div className="onboarding-service">
          <p>{service.name}</p>
          <ServiceStatusBadge status={service.status} />
        </div>
      )}
      <div className="onboarding-explanation">{children}</div>
    </article>
  );
}

export function ProviderOnboarding() {
  return (
    <section id="provider-onboarding" aria-labelledby="onboarding-heading">
      <p className="eyebrow">Fixture/demo preview</p>
      <h2 id="onboarding-heading">Provider onboarding demo</h2>
      <p className="notice">{fixtureNotice}</p>
      <p>
        These are separate fictional snapshots, not a live onboarding session or
        a real World verification result. No verification request is sent, no
        service is activated, and no payment or authentication occurs.
      </p>
      <p className="reference">
        All verification badges use the fixed fixture reference time:{' '}
        <time dateTime={fixtureReferenceTime}>{fixtureReferenceTime}</time>.
        Actual verification freshness is enforced by the server.
      </p>
      <div className="onboarding-grid">
        <OnboardingSnapshot
          id="onboarding-draft"
          title="Draft service"
          provider={unverifiedProviderFixture}
          service={draftServiceFixture}
        >
          <p>
            The demo service is a draft. An unverified provider may create a
            draft, but it is not discoverable or payable.
          </p>
        </OnboardingSnapshot>
        <OnboardingSnapshot
          id="onboarding-unverified"
          title="Unverified provider"
          provider={unverifiedProviderFixture}
        >
          <p>
            No successful verification is recorded in this fixture. Current
            provider verification is required before service activation.
          </p>
        </OnboardingSnapshot>
        <OnboardingSnapshot
          id="onboarding-blocked"
          title="Activation blocked"
          provider={unverifiedProviderFixture}
          service={draftServiceFixture}
        >
          <p className="notice">
            Demo activation blocked: {apiErrorFixture.error.message}
          </p>
          <p>
            Fixture error: <code>{apiErrorFixture.error.code}</code>. The
            service remains draft; the provider remains unverified.
          </p>
        </OnboardingSnapshot>
        <OnboardingSnapshot
          id="onboarding-pending"
          title="Verification pending"
          provider={unverifiedProviderFixture}
          service={draftServiceFixture}
        >
          <p>
            Demo pending presentation only: this illustrates waiting for a
            server response. No request is running and this view will not
            advance automatically.
          </p>
          <p>Activation stays blocked. Pending does not mean verified.</p>
        </OnboardingSnapshot>
        <OnboardingSnapshot
          id="onboarding-verified"
          title="Verified provider"
          provider={verifiedProviderFixture}
        >
          <p>
            This shared fixture represents a recently verified human operator at
            the reference time. It is not evidence of a real World check or a
            guarantee of service quality.
          </p>
          <p>Provider verification alone does not activate a service.</p>
        </OnboardingSnapshot>
        <OnboardingSnapshot
          id="onboarding-active"
          title="Active service"
          provider={verifiedProviderFixture}
          service={activeServiceFixture}
        >
          <p>
            This separate fixture shows an active service with current
            verification at the reference time. No activation was performed
            here. Actual discovery and payment require current server checks.
          </p>
        </OnboardingSnapshot>
        <OnboardingSnapshot
          id="onboarding-error"
          title="Verification error"
          provider={unverifiedProviderFixture}
          service={draftServiceFixture}
        >
          <p className="notice">
            Demo error presentation only: verification could not be completed.
            No real World attempt failed.
          </p>
          <p>
            The provider remains unverified and activation stays blocked. In the
            future live flow, retry verification; a failed attempt must never
            activate the service.
          </p>
        </OnboardingSnapshot>
      </div>
    </section>
  );
}
