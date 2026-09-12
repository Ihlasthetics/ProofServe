'use client';

import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { createDefaultWorldSelfieFlow } from '../lib/world-selfie-flow';
import styles from '../app/world-selfie-test/world-selfie-test.module.css';

export function WorldSelfieTest() {
  const [providerId, setProviderId] = useState('');
  const [flow] = useState(createDefaultWorldSelfieFlow);
  const snapshot = useSyncExternalStore(
    flow.subscribe,
    flow.getSnapshot,
    flow.getSnapshot,
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void flow.start(providerId);
  };

  const canCancel =
    snapshot.busy &&
    (snapshot.status === 'requesting' || snapshot.status === 'waiting');
  const verified = snapshot.status === 'verified';

  return (
    <section className={styles.card} aria-labelledby="world-selfie-heading">
      <p className={styles.eyebrow}>Standalone I04 integration test</p>
      <h1 id="world-selfie-heading">World Selfie Check Legacy</h1>
      <p className={styles.intro}>
        Start a provider-bound liveness check. ProofServe decides every World
        setting and confirms the final result on its backend.
      </p>

      <form className={styles.form} onSubmit={submit} noValidate>
        <label htmlFor="world-provider-id">Provider ID</label>
        <input
          id="world-provider-id"
          name="providerId"
          value={providerId}
          onChange={(event) => setProviderId(event.currentTarget.value)}
          disabled={snapshot.busy || verified}
          autoComplete="off"
          maxLength={128}
          required
          spellCheck={false}
        />
        <div className={styles.actions}>
          <button type="submit" disabled={snapshot.busy || verified}>
            {snapshot.status === 'error' || snapshot.status === 'cancelled'
              ? 'Try again'
              : 'Start selfie check'}
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
      </form>

      <div
        className={styles.status}
        role={
          snapshot.status === 'invalid' || snapshot.status === 'error'
            ? 'alert'
            : 'status'
        }
        aria-live="polite"
        aria-busy={snapshot.busy}
      >
        <p className={verified ? styles.verified : undefined}>
          {snapshot.message}
        </p>
        {snapshot.status === 'waiting' &&
          snapshot.connectorURI !== undefined &&
          snapshot.qrDataUrl !== undefined && (
            <div className={styles.connector}>
              <img
                src={snapshot.qrDataUrl}
                alt="QR code to continue the verification in World App"
                width={320}
                height={320}
              />
              <a
                className={styles.deepLink}
                href={snapshot.connectorURI}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in World App
              </a>
            </div>
          )}
        {verified && snapshot.verification !== undefined && (
          <dl className={styles.confirmation}>
            <div>
              <dt>Status</dt>
              <dd>{snapshot.verification.status}</dd>
            </div>
            <div>
              <dt>Verified at</dt>
              <dd>
                <time dateTime={snapshot.verification.verifiedAt}>
                  {snapshot.verification.verifiedAt}
                </time>
              </dd>
            </div>
            <div>
              <dt>Expires at</dt>
              <dd>
                <time dateTime={snapshot.verification.expiresAt}>
                  {snapshot.verification.expiresAt}
                </time>
              </dd>
            </div>
          </dl>
        )}
      </div>

      <p className={styles.privacy}>
        Proof material and World responses are never displayed or stored by this
        page. Closing or cancelling does not mark a provider verified.
      </p>
    </section>
  );
}
