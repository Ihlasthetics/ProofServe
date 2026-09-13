# World integration feedback

This document records the team's confirmed experience integrating World Selfie
Check into ProofServe. It deliberately separates observed behavior from desired
improvements and does not claim a broader test matrix than the team performed.

## Integration and documentation

ProofServe uses World Selfie Check as a meaningful eligibility gate rather than a
decorative badge. Provider registration begins unverified. An unverified provider
may create a draft service, but activation is blocked until the backend accepts a
current World verification. Verification still does not activate the service:
activation is a separate explicit step, and discovery/payment eligibility is
rechecked by the backend.

The confirmed end-to-end experience used a QR-based verification flow with the
World Android app. On 2026-09-13, an attempted activation before verification was
blocked, a genuine verification succeeded, and the service became discoverable
only after explicit activation. This was a useful integration shape because the
World result influenced an observable server-side authorization decision.

The integration required aligning the application ID, relying-party ID,
server-only relying-party signing key, action, environment, signed context, and
browser result submission. A single, end-to-end guide showing where each value is
created, which values are public, which must remain server-only, and how the
Portal configuration maps to IDKit request fields would reduce integration time.
Examples that keep the action, environment, RP context, and verification endpoint
visible together would also make configuration mismatches easier to diagnose.

## Developer Portal navigation and debugging

The most difficult confirmed Portal task was locating the signing-key and action
configuration. Those settings were not easy to discover from the integration
path. More direct navigation from an application's overview to its actions and RP
signing material, together with consistent terminology between the Portal and
IDKit documentation, would help.

Debugging crosses several boundaries: Portal configuration, server-issued signed
context, the browser QR flow, the Android app, and the backend verification call.
It would be useful for documentation to provide a safe troubleshooting checklist
ordered across those boundaries. The checklist should identify common mismatch
categories without requiring developers to log proofs, signatures, signing keys,
or other sensitive request bodies. Stable, documented error categories and a
clear indication of which layer rejected a request would make diagnosis faster.

## Sandbox coverage and limitations

We do not claim a systematic World Sandbox test matrix, use of every simulator
path, or controlled reproduction of specific Sandbox errors. The confirmed
evidence is the QR-based Android World app flow and the resulting backend state
transition described above. Any broader Sandbox behavior would require separate,
recorded testing.

The distinctions among Sandbox, staging, and production configuration are
important but can be difficult to hold together while following multiple pages.
A comparison table covering destination, supported client flow, Portal resource,
credentials, and expected verification endpoint behavior would help teams avoid
mixing environments. A minimal negative-test guide would also be valuable, but
this project does not claim to have executed such a guide.

## Confusing or difficult cases

- Finding the Portal locations for the RP signing key and action configuration
  took more effort than expected.
- Documentation should state in one place which configuration values belong in
  the browser, which belong only on the server, and which must match a Portal
  resource.
- The mobile QR handoff adds a real second-device boundary. Guidance that follows
  one request from desktop browser to Android app and back to backend verification
  would make the flow easier to reason about.
- Failure diagnosis benefits from knowing whether the Portal, signed-context
  creation, mobile interaction, or verification endpoint rejected the request.
  Documentation should help isolate that layer without encouraging sensitive
  payload logging.

## Assurance boundary

In ProofServe, Selfie Check is treated only as a low-assurance, time-limited
liveness signal for service eligibility. We do not interpret it as guaranteed
unique identity, legal identity, AI-service quality, reputation, or
production-grade authorization. ProofServe adds separate server-side freshness,
activation, discovery, budget, and payment checks, but those controls do not
increase the identity assurance of the underlying Selfie Check.
