'use client';

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import {
  createRegistrySession,
  type RegistryState,
} from '../lib/registry-session';
import { providerFormData, draftFormData } from '../lib/onboarding-form-data';
import { ServiceStatusBadge } from './service-status-badge';
import { ServiceCard } from './service-card';
import { ProviderWorldVerification } from './provider-world-verification';

function fields(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}

export function RegistryView({
  state,
  session,
}: {
  state: RegistryState;
  session: ReturnType<typeof createRegistrySession>;
}) {
  const checkedAt = state.listingCheckedAt;
  const eligible = state.listing?.services.filter(
    ({ service, provider }) =>
      checkedAt !== null &&
      service.status === 'ACTIVE' &&
      provider.verification.status === 'VERIFIED' &&
      provider.verification.verifiedAt <= checkedAt &&
      checkedAt < provider.verification.expiresAt,
  );
  return (
    <>
      <section id="provider-onboarding" aria-labelledby="onboarding-heading">
        <p className="eyebrow">Live registry · Hedera testnet</p>
        <h2 id="onboarding-heading">Provider onboarding</h2>
        <p className="notice">
          Registration does not verify a provider. World verification and
          activation are separate explicit actions; the registry decides every
          activation request. Draft services are not discoverable or payable.
        </p>
        <p>
          Created records are kept in this page session. Reloading loses this
          page’s references; the registry may still retain the records.
        </p>
        <div className="onboarding-grid">
          <article
            className="onboarding-card"
            aria-labelledby="provider-heading"
          >
            <h3 id="provider-heading">1. Create provider</h3>
            <form
              aria-labelledby="provider-heading"
              aria-busy={!!state.pending.provider}
              onSubmit={(event) => {
                const data = fields(event);
                void session.createProvider(providerFormData(data));
              }}
            >
              <fieldset disabled={!!state.pending.provider || !!state.provider}>
                <legend>Provider details</legend>
                <label htmlFor="display-name">Display name</label>
                <input
                  id="display-name"
                  name="displayName"
                  required
                  maxLength={120}
                />
                <label htmlFor="payout-account">Hedera payout account</label>
                <input
                  id="payout-account"
                  name="payoutAccount"
                  required
                  aria-describedby="payout-help"
                />
                <p id="payout-help">
                  Numeric account ID, for example 0.0.123456. Never enter a
                  private key.
                </p>
                <button type="submit">
                  {state.pending.provider
                    ? 'Creating provider…'
                    : 'Create provider'}
                </button>
              </fieldset>
            </form>
            <p role="status">
              {state.pending.provider
                ? 'Provider creation pending.'
                : state.provider
                  ? state.provider.verification.status === 'VERIFIED'
                    ? `Provider created: ${state.provider.displayName}. Verified — backend-confirmed current liveness verification.`
                    : `Provider created: ${state.provider.displayName}. At registration: Unverified — no current liveness verification.`
                  : ''}
            </p>
            {state.provider && (
              <div>
                <p>
                  Provider ID: <code>{state.provider.id}</code>. Verification:{' '}
                  <strong>{state.provider.verification.status}</strong>.
                </p>
                {state.provider.verification.status === 'VERIFIED' ? (
                  <p>
                    Backend-confirmed at{' '}
                    <time dateTime={state.provider.verification.verifiedAt}>
                      {state.provider.verification.verifiedAt}
                    </time>
                    ; expires at{' '}
                    <time dateTime={state.provider.verification.expiresAt}>
                      {state.provider.verification.expiresAt}
                    </time>
                    . World verification succeeded for this provider, but
                    activation still requires a separate explicit request that
                    the registry decides.
                  </p>
                ) : (
                  <ProviderWorldVerification
                    providerId={state.provider.id}
                    onVerified={session.applyWorldVerification}
                  />
                )}
              </div>
            )}
            {state.errors.provider && (
              <p role="alert" className="notice">
                {state.errors.provider}
              </p>
            )}
          </article>
          <article className="onboarding-card" aria-labelledby="draft-heading">
            <h3 id="draft-heading">2. Create draft service</h3>
            {!state.provider && (
              <p>Create a provider first to enable this form.</p>
            )}
            <form
              aria-labelledby="draft-heading"
              aria-busy={!!state.pending.draft}
              onSubmit={(event) => {
                const data = fields(event);
                void session.createDraft(draftFormData(data));
              }}
            >
              <fieldset
                disabled={
                  !state.provider || !!state.pending.draft || !!state.draft
                }
              >
                <legend>Support ticket triage</legend>
                <label htmlFor="service-name">Service name</label>
                <input id="service-name" name="name" required maxLength={120} />
                <label htmlFor="service-description">Description</label>
                <textarea
                  id="service-description"
                  name="description"
                  required
                  maxLength={1000}
                />
                <label htmlFor="service-price">
                  Price per request (tinybars)
                </label>
                <input
                  id="service-price"
                  name="amountAtomic"
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  required
                  aria-describedby="price-help"
                />
                <p id="price-help">
                  100000000 tinybars = 1 HBAR on Hedera testnet. The registry
                  selects the endpoint and payout recipient.
                </p>
                <button type="submit">
                  {state.pending.draft
                    ? 'Creating draft…'
                    : 'Create draft service'}
                </button>
              </fieldset>
            </form>
            <p role="status">
              {state.pending.draft
                ? 'Draft creation pending.'
                : state.draft
                  ? state.draft.status === 'ACTIVE'
                    ? state.provider?.verification.status === 'VERIFIED'
                      ? `Registry confirmed activation: ${state.draft.name}. World verification succeeded separately, and activation followed a separate explicit registry request. Eligibility is shown only by a successful registry listing.`
                      : `Registry confirmed activation: ${state.draft.name}. The local provider snapshot remains ${state.provider?.verification.status ?? 'unavailable'}; eligibility is shown only by a successful registry listing.`
                    : `Draft created: ${state.draft.name}. Not discoverable or payable.`
                  : ''}
            </p>
            {state.errors.draft && (
              <p role="alert" className="notice">
                {state.errors.draft}
              </p>
            )}
            {state.draft && (
              <div className="onboarding-service">
                <p>
                  Service ID: <code>{state.draft.id}</code>
                </p>
                <ServiceStatusBadge status={state.draft.status} />
                <p>
                  Activation is a separate explicit backend request. The
                  registry authoritatively checks current provider verification
                  and either activates or safely rejects it.
                </p>
                <button
                  type="button"
                  disabled={
                    !state.provider ||
                    !!state.pending.activation ||
                    state.draft.status === 'ACTIVE'
                  }
                  onClick={() => {
                    void session.activate();
                  }}
                >
                  {state.pending.activation
                    ? 'Checking activation…'
                    : state.draft.status === 'ACTIVE'
                      ? 'Registry service is active'
                      : 'Attempt activation'}
                </button>
                <p role="status">
                  {state.pending.activation
                    ? state.draft.status === 'ACTIVE'
                      ? 'Registry activation confirmed. Reconciling eligible services.'
                      : 'Activation request pending. This separate request does not change the local World verification state.'
                    : ''}
                </p>
              </div>
            )}
            {state.errors.activation && (
              <p role="alert" className="notice">
                {state.errors.activation}
              </p>
            )}
          </article>
        </div>
      </section>
      <section id="service-preview" aria-labelledby="preview-heading">
        <h2 id="preview-heading">Eligible services</h2>
        <p>
          Live registry snapshot. Discovery and payment require fresh server
          checks; this page does not make payments.
        </p>
        <button
          type="button"
          disabled={!!state.pending.listing}
          onClick={() => {
            void session.refresh();
          }}
        >
          {state.pending.listing ? 'Loading services…' : 'Refresh services'}
        </button>
        <p role="status">
          {state.pending.listing
            ? 'Loading eligible services.'
            : eligible
              ? `${eligible.length} eligible services returned.`
              : ''}
        </p>
        {state.errors.listing && (
          <p role="alert" className="notice">
            {state.errors.listing}
          </p>
        )}
        {eligible?.length === 0 && (
          <p>
            No eligible services are available. Unverified providers and draft
            services are excluded.
          </p>
        )}
        <div className="onboarding-grid">
          {eligible?.map(({ service, provider }) => (
            <ServiceCard
              key={service.id}
              service={service}
              provider={provider}
              referenceTime={state.listingCheckedAt!}
            />
          ))}
        </div>
      </section>
    </>
  );
}

export function ProviderOnboarding() {
  const [session] = useState(() => createRegistrySession());
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    void session.refresh();
  }, [session]);
  return <RegistryView state={state} session={session} />;
}
