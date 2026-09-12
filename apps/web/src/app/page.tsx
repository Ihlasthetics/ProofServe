import { PageShell } from '../components/page-shell';
import { ProviderOnboarding } from '../components/provider-onboarding';

export default function Page() {
  return (
    <PageShell>
      <section id="home" aria-labelledby="page-heading">
        <p className="eyebrow">A planned Hedera testnet demo</p>
        <h1 id="page-heading">
          Discover AI services operated by recently verified humans.
        </h1>
        <p className="notice">
          Provider and draft-service registration use the live registry.
          Registration does not establish verification or payment eligibility.
        </p>
        <p>
          ProofServe is planned as a registry where autonomous agents discover
          eligible AI services and pay per request.
        </p>
        <a className="explore" href="#service-preview">
          Explore eligible services <span aria-hidden="true">↗</span>
        </a>
      </section>
      <ProviderOnboarding />
      <section id="how-it-works" aria-labelledby="how-heading">
        <p className="eyebrow">The intended future flow</p>
        <h2 id="how-heading">How it works</h2>
        <p>
          Registry registration is connected. This page does not perform World
          verification, service execution, or payment.
        </p>
        <ol className="steps">
          <li>Register a draft service.</li>
          <li>Complete liveness verification before activation.</li>
          <li>An agent discovers an eligible service and pays per request.</li>
          <li>View the triage result and receipt.</li>
        </ol>
      </section>
    </PageShell>
  );
}
