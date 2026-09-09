import {
  activeServiceFixture,
  verifiedProviderFixture,
} from '@proofserve/shared';
import { PageShell } from '../components/page-shell';
import { ServiceCard } from '../components/service-card';

export default function Page() {
  return (
    <PageShell>
      <section id="home" aria-labelledby="page-heading">
        <p className="eyebrow">A planned Hedera testnet demo</p>
        <h1 id="page-heading">
          Discover AI services operated by recently verified humans.
        </h1>
        <p className="notice">
          Wireframe uses fictional development/test content. It is not evidence
          of completed verification or payment.
        </p>
        <p>
          ProofServe is planned as a registry where autonomous agents discover
          eligible AI services and pay per request.
        </p>
        <a className="explore" href="#service-preview">
          Explore the service preview <span aria-hidden="true">↗</span>
        </a>
      </section>
      <section id="service-preview" aria-labelledby="preview-heading">
        <h2 id="preview-heading">Service preview</h2>
        <ServiceCard
          service={activeServiceFixture}
          provider={verifiedProviderFixture}
        />
      </section>
      <section id="how-it-works" aria-labelledby="how-heading">
        <p className="eyebrow">The intended future flow</p>
        <h2 id="how-heading">How it works</h2>
        <p>
          Real integrations are not implemented. This preview does not perform
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
