import type { ReactNode } from 'react';

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <a className="brand" href="#home">
          ProofServe<span aria-hidden="true">.</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#home">Home</a>
          <a href="#service-preview">Service preview</a>
          <a href="#how-it-works">How it works</a>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer>
        <p>ProofServe — planned Hedera testnet demo</p>
        <p>
          Verification describes recent liveness, not a service-quality
          guarantee.
        </p>
        <a href="#home">Return to home</a>
      </footer>
    </>
  );
}
