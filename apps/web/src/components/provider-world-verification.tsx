'use client';

import { useState, useSyncExternalStore } from 'react';
import type { WorldVerificationResponse } from '@proofserve/shared';
import {
  createDefaultWorldSelfieFlow,
  type WorldSelfieFlow,
} from '../lib/world-selfie-flow';
import { runProviderWorldVerification } from '../lib/provider-world-verification';
import styles from '../app/world-selfie-test/world-selfie-test.module.css';

export function ProviderWorldVerification({
  providerId,
  onVerified,
  flow: suppliedFlow,
}: {
  providerId: string;
  onVerified(verification: WorldVerificationResponse): boolean;
  flow?: WorldSelfieFlow;
}) {
  const [flow] = useState(() => suppliedFlow ?? createDefaultWorldSelfieFlow());
  const [bindingRejected, setBindingRejected] = useState(false);
  const snapshot = useSyncExternalStore(
    flow.subscribe,
    flow.getSnapshot,
    flow.getSnapshot,
  );
  const canCancel =
    snapshot.busy &&
    (snapshot.status === 'requesting' || snapshot.status === 'waiting');
  const verified = snapshot.status === 'verified' && !bindingRejected;

  const start = async () => {
    setBindingRejected(false);
    const outcome = await runProviderWorldVerification(
      flow,
      providerId,
      onVerified,
    );
    if (outcome === 'rejected') setBindingRejected(true);
  };

  return (
    <section
      className={styles.embedded}
      aria-labelledby="provider-world-heading"
    >
      <h4 id="provider-world-heading">Verify with World</h4>
      <p>
        Open this verification request in the World App. The ProofServe backend
        selects the World environment; this page does not. This is an
        external-browser flow, and embedded World App execution is not
        supported.
      </p>
      <p>
        ProofServe requests settings bound to provider <code>{providerId}</code>{' '}
        only after you start the check.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={snapshot.busy || verified || bindingRejected}
          onClick={() => {
            void start();
          }}
        >
          {snapshot.status === 'error' || snapshot.status === 'cancelled'
            ? 'Try Verify with World again'
            : verified
              ? 'World verification confirmed'
              : 'Verify with World'}
        </button>
        {canCancel && (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => flow.cancel()}
          >
            Cancel
          </button>
        )}
      </div>
      <div
        className={styles.status}
        role={
          bindingRejected ||
          snapshot.status === 'invalid' ||
          snapshot.status === 'error'
            ? 'alert'
            : 'status'
        }
        aria-live="polite"
        aria-busy={snapshot.busy}
      >
        <p className={verified ? styles.verified : undefined}>
          {bindingRejected
            ? 'The verification response did not match this provider. The provider remains UNVERIFIED.'
            : snapshot.message}
        </p>
        {!bindingRejected &&
          snapshot.status === 'waiting' &&
          snapshot.connectorURI !== undefined &&
          snapshot.qrDataUrl !== undefined && (
            <div className={styles.connector}>
              <img
                src={snapshot.qrDataUrl}
                alt="QR code to continue verification in the external World App flow"
                width={320}
                height={320}
              />
              <a
                className={styles.deepLink}
                href={snapshot.connectorURI}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open external World App flow
              </a>
            </div>
          )}
      </div>
      <p className={styles.privacy}>
        Proof material and World responses are never displayed or stored by this
        page. Cancellation or failure leaves this provider UNVERIFIED and does
        not attempt activation.
      </p>
    </section>
  );
}
