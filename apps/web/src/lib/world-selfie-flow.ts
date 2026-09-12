import {
  IdentifierSchema,
  WorldVerificationRequestSchema,
  type WorldVerificationContextResponse,
  type WorldVerificationResponse,
} from '@proofserve/shared';
import {
  createConnectorQrCode,
  createWorldRequest,
  type WorldIdKitRequest,
} from './world-idkit';
import { createWorldVerificationApiClient } from './world-verification-client';

export type WorldSelfieFlowStatus =
  | 'idle'
  | 'invalid'
  | 'requesting'
  | 'waiting'
  | 'submitting'
  | 'cancelled'
  | 'error'
  | 'verified';

export interface WorldSelfieFlowSnapshot {
  status: WorldSelfieFlowStatus;
  busy: boolean;
  message: string;
  connectorURI?: string;
  qrDataUrl?: string;
  verification?: WorldVerificationResponse;
}

export interface WorldSelfieFlowDependencies {
  fetchContext(
    providerId: string,
    signal: AbortSignal,
  ): Promise<WorldVerificationContextResponse>;
  createWorldRequest(
    context: WorldVerificationContextResponse,
  ): Promise<WorldIdKitRequest>;
  createQrCode(connectorURI: string): Promise<string>;
  submitVerification(
    providerId: string,
    result: unknown,
    signal: AbortSignal,
  ): Promise<WorldVerificationResponse>;
}

const initialSnapshot: WorldSelfieFlowSnapshot = {
  status: 'idle',
  busy: false,
  message: 'Enter a provider ID to begin.',
};

const cancelledMessage =
  'The World check was cancelled or declined. No verification was recorded.';
const genericErrorMessage =
  'Verification could not be completed. No VERIFIED state was recorded.';
const unconfirmedMessage =
  'This page did not receive backend confirmation, so it has not marked the provider VERIFIED.';

export class WorldSelfieFlow {
  private snapshot: WorldSelfieFlowSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private active = false;

  constructor(private readonly dependencies: WorldSelfieFlowDependencies) {}

  getSnapshot = (): WorldSelfieFlowSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(snapshot: WorldSelfieFlowSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  async start(providerIdInput: string): Promise<boolean> {
    if (this.active || this.snapshot.status === 'verified') return false;
    const provider = IdentifierSchema.safeParse(providerIdInput);
    if (!provider.success) {
      this.update({
        status: 'invalid',
        busy: false,
        message:
          'Use 1–128 ASCII letters, numbers, underscores, or hyphens, beginning with a letter or number.',
      });
      return false;
    }

    this.active = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let submissionStarted = false;
    this.update({
      status: 'requesting',
      busy: true,
      message: 'Requesting provider-bound World settings from ProofServe…',
    });

    try {
      const context = await this.dependencies.fetchContext(
        provider.data,
        signal,
      );
      const request = await this.dependencies.createWorldRequest(context);
      if (signal.aborted) throw new Error('Cancelled');
      const qrDataUrl = await this.dependencies.createQrCode(
        request.connectorURI,
      );
      if (signal.aborted) throw new Error('Cancelled');
      this.update({
        status: 'waiting',
        busy: true,
        message: 'Scan the QR code or open World App to continue.',
        connectorURI: request.connectorURI,
        qrDataUrl,
      });

      const completion = await request.pollUntilCompletion({
        pollInterval: 1_000,
        timeout: 900_000,
        signal,
      });
      if (!completion.success) {
        const cancelled =
          completion.error === 'cancelled' ||
          completion.error === 'user_rejected' ||
          completion.error === 'verification_rejected';
        this.update({
          status: cancelled ? 'cancelled' : 'error',
          busy: true,
          message: cancelled ? cancelledMessage : genericErrorMessage,
        });
        return true;
      }

      const result = WorldVerificationRequestSchema.safeParse(
        completion.result,
      );
      if (!result.success) throw new Error('Invalid World result');
      submissionStarted = true;
      this.update({
        status: 'submitting',
        busy: true,
        message:
          'World completed. Waiting for ProofServe backend confirmation…',
      });
      const verification = await this.dependencies.submitVerification(
        provider.data,
        result.data,
        signal,
      );
      this.update({
        status: 'verified',
        busy: true,
        message: 'VERIFIED — confirmed by the ProofServe backend.',
        verification,
      });
      return true;
    } catch {
      this.update({
        status: signal.aborted && !submissionStarted ? 'cancelled' : 'error',
        busy: true,
        message:
          signal.aborted && !submissionStarted
            ? cancelledMessage
            : submissionStarted
              ? unconfirmedMessage
              : genericErrorMessage,
      });
      return true;
    } finally {
      this.active = false;
      this.controller = undefined;
      if (this.snapshot.busy) this.update({ ...this.snapshot, busy: false });
    }
  }

  cancel(): boolean {
    if (
      !this.active ||
      this.controller === undefined ||
      this.snapshot.status === 'submitting'
    ) {
      return false;
    }
    this.controller.abort();
    this.update({
      status: 'cancelled',
      busy: true,
      message: cancelledMessage,
    });
    return true;
  }
}

export function createDefaultWorldSelfieFlow(): WorldSelfieFlow {
  const api = createWorldVerificationApiClient();
  return new WorldSelfieFlow({
    fetchContext: (providerId, signal) => api.fetchContext(providerId, signal),
    createWorldRequest,
    createQrCode: createConnectorQrCode,
    submitVerification: (providerId, result, signal) =>
      api.submitVerification(providerId, result, signal),
  });
}
