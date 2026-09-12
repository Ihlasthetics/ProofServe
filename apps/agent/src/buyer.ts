import {
  AgentRunSchema,
  AgentTaskSchema,
  EndpointUrlSchema,
  HederaAccountIdSchema,
  IdentifierSchema,
  PaymentReceiptSchema,
  TimestampSchema,
  TriageResultSchema,
  type AgentRun,
  type AgentTask,
  type DiscoveryService,
} from '@proofserve/shared';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequirements as X402PaymentRequirements } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readBuyerBody } from './buyer-body.js';
import {
  defaultBuyerOwnership,
  type BuyerClaim,
  type BuyerOwnership,
} from './buyer-ownership.js';
import {
  BuyerError,
  validatedOffer,
  validatedSettlement,
} from './buyer-payment.js';
import { discoverServices } from './registry-client.js';
import { selectService } from './service-selection.js';
import { transitionAgentRun, type AgentTransition } from './state-machine.js';
import {
  inspectSignedPaymentTransaction,
  paymentExpectation,
} from './hedera-payment-transaction.js';
import type { BuyerPaymentAttempt } from './buyer-ownership.js';

const runStatuses = [
  'CREATED',
  'DISCOVERING',
  'SELECTED',
  'PAYMENT_REQUIRED',
  'PAYING',
  'PAID',
  'EXECUTING',
  'COMPLETED',
] as const;

export interface BuyerOptions {
  /** Trusted server configuration, never copied from an AgentTask or listing. */
  registryBaseUrl: string;
  allowedServiceEndpoint: string;
  runId?: string;
  ownership?: BuyerOwnership;
  fetcher?: typeof fetch;
  now?: () => string;
  /** Test/HSM boundary. Production defaults to the official ECDSA signer. */
  signerFactory?: () => BuyerSigner | Promise<BuyerSigner>;
  /** Test boundary. Production inspects the official signed Hedera payload. */
  paymentTransaction?: (
    signedTransaction: string,
    expected: Omit<
      BuyerPaymentAttempt,
      'transactionId' | 'transactionValidUntil'
    >,
  ) => BuyerPaymentAttempt | Promise<BuyerPaymentAttempt>;
}

export interface BuyerSigner {
  readonly accountId: string;
  createPartiallySignedTransferTransaction(
    requirements: X402PaymentRequirements,
  ): Promise<string>;
}

async function productionSigner(): Promise<BuyerSigner> {
  try {
    const factory = await createProductionBuyerSignerFactory({
      accountId: process.env.HEDERA_PAYER_ACCOUNT_ID,
      privateKey: process.env.HEDERA_PAYER_PRIVATE_KEY,
    });
    return factory();
  } catch {
    throw new BuyerError();
  }
}

/** Eagerly validates and constructs the production signer without signing. */
export async function createProductionBuyerSignerFactory(configuration: {
  accountId: unknown;
  privateKey: unknown;
}): Promise<() => BuyerSigner> {
  try {
    const account = HederaAccountIdSchema.parse(configuration.accountId);
    if (
      typeof configuration.privateKey !== 'string' ||
      configuration.privateKey.length === 0
    )
      throw new BuyerError();
    const { createClientHederaSigner, PrivateKey } =
      await import('@x402/hedera');
    const signer = createClientHederaSigner(
      account,
      PrivateKey.fromStringECDSA(configuration.privateKey),
      { network: 'hedera:testnet' },
    );
    return () => signer;
  } catch {
    throw new BuyerError('VALIDATION_ERROR');
  }
}

/** Bounds fetch, body reads and signing separately. A late signer never triggers a retry. */
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  controller = new AbortController(),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new BuyerError());
        }, 30_000);
      }),
      operation(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function endpoint(value: string): string {
  const url = new URL(EndpointUrlSchema.parse(value));
  if (
    !isTrustedProtocol(url) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/triage' ||
    url.href !== value
  )
    throw new BuyerError('VALIDATION_ERROR');
  return url.href;
}

function isTrustedProtocol(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  );
}

export function validateBuyerConfiguration(configuration: {
  registryBaseUrl: string;
  allowedServiceEndpoint: string;
}): { registryBaseUrl: string; allowedServiceEndpoint: string } {
  try {
    const allowedServiceEndpoint = endpoint(
      configuration.allowedServiceEndpoint,
    );
    const registry = new URL(configuration.registryBaseUrl);
    if (
      !isTrustedProtocol(registry) ||
      registry.username ||
      registry.password ||
      registry.search ||
      registry.hash ||
      registry.pathname !== '/'
    )
      throw new BuyerError('VALIDATION_ERROR');
    return { registryBaseUrl: registry.href, allowedServiceEndpoint };
  } catch {
    throw new BuyerError('VALIDATION_ERROR');
  }
}

function securitySnapshot({ service, provider }: DiscoveryService): string {
  return JSON.stringify({
    id: service.id,
    providerId: service.providerId,
    capability: service.capability,
    endpoint: service.endpoint,
    status: service.status,
    createdAt: service.createdAt,
    paymentRequirements: service.paymentRequirements,
    provider: {
      id: provider.id,
      payoutAccount: provider.payoutAccount,
      createdAt: provider.createdAt,
      verification: provider.verification,
    },
  });
}

/**
 * Prepare one server-side run without I/O. Only execute() may discover or sign.
 * Same-handle calls share one attempt; other handles cannot execute a claimed ID.
 * Only signing consumes permanent capacity; durable ownership belongs to Y05.
 */
export function createBuyerRun(
  task: Readonly<AgentTask>,
  options: Readonly<BuyerOptions>,
): { execute(): Promise<AgentRun> } {
  let input: AgentTask;
  let allowed: string;
  let registry: string;
  let runId: string;
  try {
    input = AgentTaskSchema.parse(task);
    const configuration = validateBuyerConfiguration(options);
    allowed = configuration.allowedServiceEndpoint;
    registry = configuration.registryBaseUrl;
    runId = IdentifierSchema.parse(
      options.runId === undefined ? randomUUID() : options.runId,
    );
  } catch {
    throw new BuyerError('VALIDATION_ERROR');
  }
  const fetcher = options.fetcher ?? globalThis.fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const signerFactory = options.signerFactory ?? productionSigner;
  const inspectPayment =
    options.paymentTransaction ?? inspectSignedPaymentTransaction;
  const ownership = options.ownership ?? defaultBuyerOwnership;
  let execution: Promise<AgentRun> | undefined;

  async function run(claim: BuyerClaim): Promise<AgentRun> {
    let snapshot: AgentRun;
    try {
      if (claim.initialRun) {
        snapshot = AgentRunSchema.parse(claim.initialRun);
        if (
          snapshot.id !== runId ||
          JSON.stringify(snapshot.task) !== JSON.stringify(input) ||
          snapshot.status === 'COMPLETED' ||
          snapshot.status === 'FAILED' ||
          snapshot.paymentReceipt !== null
        )
          throw new BuyerError('VALIDATION_ERROR');
      } else {
        const started = TimestampSchema.parse(now());
        snapshot = AgentRunSchema.parse({
          id: runId,
          task: input,
          status: 'CREATED',
          selectedServiceId: null,
          paymentRequirements: null,
          paymentReceipt: null,
          result: null,
          error: null,
          events: [{ status: 'CREATED', occurredAt: started }],
          createdAt: started,
          updatedAt: started,
        });
      }
    } catch {
      throw new BuyerError('VALIDATION_ERROR');
    }
    let anchorUtc = Date.parse(snapshot.updatedAt);
    let anchorMonotonic = performance.now();
    const time = () => {
      const value = TimestampSchema.parse(now());
      if (value < snapshot.updatedAt || Date.parse(value) < anchorUtc)
        throw new BuyerError();
      anchorUtc = Date.parse(value);
      anchorMonotonic = performance.now();
      return value;
    };
    const transition = async (command: AgentTransition) => {
      const currentIndex = runStatuses.indexOf(
        snapshot.status as (typeof runStatuses)[number],
      );
      const targetIndex = runStatuses.indexOf(
        command.status as (typeof runStatuses)[number],
      );
      if (command.status !== 'FAILED' && currentIndex >= targetIndex) {
        const matchesPersistedData =
          (command.status !== 'SELECTED' ||
            snapshot.selectedServiceId === command.selectedServiceId) &&
          (command.status !== 'PAYMENT_REQUIRED' ||
            JSON.stringify(snapshot.paymentRequirements) ===
              JSON.stringify(command.paymentRequirements));
        if (!matchesPersistedData) throw new BuyerError('VALIDATION_ERROR');
        return;
      }
      const next = transitionAgentRun(snapshot, command);
      // Retain authoritative evidence locally if a persistence acknowledgement
      // fails, so a following FAILED snapshot can still preserve the receipt.
      snapshot = next;
      await claim.persist?.(next);
    };
    const discover = () =>
      bounded((signal) =>
        discoverServices(
          registry,
          { capability: input.capability, ...input.budget },
          async (url, init) => {
            const response = await fetcher(url, {
              ...init,
              signal,
              headers: { ...init?.headers, 'cache-control': 'no-store' },
              credentials: 'omit',
            });
            const text = await readBuyerBody(response, 1_048_576, signal);
            return new Response(text, {
              status: response.status,
              headers: response.headers,
            });
          },
        ),
      );
    const select = (candidates: DiscoveryService[]) => {
      try {
        return selectService(input, candidates, time());
      } catch {
        throw new BuyerError('NO_ELIGIBLE_SERVICE');
      }
    };
    // One payment per task; no number conversion and no retry budget reset.
    let remaining = BigInt(input.budget.maxAmountAtomic);
    const unpaidController = new AbortController();
    const paidController = new AbortController();
    let paymentTombstoned = false;
    try {
      await transition({ status: 'DISCOVERING', occurredAt: time() });
      const chosen = select(await discover());
      if (
        chosen.service.endpoint !== allowed ||
        chosen.provider.payoutAccount !==
          chosen.service.paymentRequirements.payTo
      )
        throw new BuyerError('NO_ELIGIBLE_SERVICE');
      const revalidate = async () => {
        const fresh = select(
          (await discover()).filter(
            (entry) => entry.service.id === chosen.service.id,
          ),
        );
        if (securitySnapshot(fresh) !== securitySnapshot(chosen))
          throw new BuyerError('NO_ELIGIBLE_SERVICE');
      };
      await transition({
        status: 'SELECTED',
        selectedServiceId: chosen.service.id,
        occurredAt: time(),
      });
      const body = JSON.stringify(input.input);
      const request = (
        headers: Record<string, string>,
        controller: AbortController,
      ) =>
        bounded(
          (signal) =>
            fetcher(chosen.service.endpoint, {
              method: 'POST',
              body,
              headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                'cache-control': 'no-store',
                ...headers,
              },
              redirect: 'error',
              credentials: 'omit',
              signal,
            }),
          controller,
        );
      const unpaid = await request({}, unpaidController);
      await bounded(
        (signal) => readBuyerBody(unpaid, 16_384, signal),
        unpaidController,
      );
      unpaidController.abort(); // Only Y03's header is needed; discard its error body.
      const offer = validatedOffer(
        unpaid,
        allowed,
        chosen.service.paymentRequirements,
        remaining,
      );
      await transition({
        status: 'PAYMENT_REQUIRED',
        paymentRequirements: chosen.service.paymentRequirements,
        occurredAt: time(),
      });
      // Rediscover after receiving the price challenge, immediately before signing.
      await revalidate();
      remaining -= BigInt(chosen.service.paymentRequirements.amountAtomic);
      if (remaining < 0n) throw new BuyerError('BUDGET_EXCEEDED');
      await transition({ status: 'PAYING', occurredAt: time() });
      const signer = await bounded(async () => signerFactory());
      await revalidate();
      const client = new x402Client()
        .register('hedera:testnet', new ExactHederaScheme(signer))
        .setSpendControls({
          allowedAssets: [
            {
              network: 'hedera:testnet',
              asset: '0.0.0',
              maxAmountPerPayment:
                chosen.service.paymentRequirements.amountAtomic,
            },
          ],
        })
        .registerPolicy((version, requirements) =>
          version === 2
            ? requirements.filter(
                (requirement) =>
                  requirement.scheme === 'exact' &&
                  requirement.network === 'hedera:testnet' &&
                  requirement.asset === '0.0.0' &&
                  requirement.payTo ===
                    chosen.service.paymentRequirements.payTo &&
                  requirement.amount ===
                    chosen.service.paymentRequirements.amountAtomic,
              )
            : [],
        );
      const http = new x402HTTPClient(client);
      const expectedPayment = paymentExpectation(
        signer.accountId,
        chosen.service.paymentRequirements,
      );
      await claim.beginSigning(expectedPayment);
      paymentTombstoned = true;
      const payload = await bounded(() => http.createPaymentPayload(offer));
      const signingMaterial = payload.payload.transaction;
      if (typeof signingMaterial !== 'string') throw new BuyerError();
      const paymentAttempt = await inspectPayment(
        signingMaterial,
        expectedPayment,
      );
      await claim.recordPaymentAttempt?.(paymentAttempt);
      const headers = http.encodePaymentSignatureHeader(payload);
      // Last awaited operation before submission: refresh security state after signing.
      await revalidate();
      await claim.authorizeSubmission?.(paymentAttempt.transactionId);
      const paid = await request(headers, paidController); // Exactly one paid retry; never use an automatic fetch wrapper.
      const evidence = validatedSettlement(
        paid,
        paymentAttempt,
        offer.accepts[0]?.extra?.feePayer,
        chosen.service.paymentRequirements,
      );
      let settledAt: string;
      let clockFailed = false;
      try {
        settledAt = time();
      } catch {
        // Observation time, not consensus time: continue the last valid UTC sample
        // using elapsed monotonic time. Preserve evidence, then fail the run.
        settledAt = new Date(
          Math.min(
            Date.parse('9999-12-31T23:59:59.999Z'),
            anchorUtc + Math.max(0, performance.now() - anchorMonotonic),
          ),
        ).toISOString();
        clockFailed = true;
      }
      const receipt = PaymentReceiptSchema.parse({
        id: randomUUID(),
        runId,
        serviceId: chosen.service.id,
        paymentRequirements: chosen.service.paymentRequirements,
        ...evidence,
        settledAt,
      });
      await transition({
        status: 'PAID',
        paymentReceipt: receipt,
        occurredAt: settledAt,
      });
      if (clockFailed) throw new BuyerError('SERVICE_EXECUTION_FAILED');
      await transition({ status: 'EXECUTING', occurredAt: time() });
      if (paid.status !== 200) throw new BuyerError('SERVICE_EXECUTION_FAILED');
      const paidText = await bounded(
        (signal) => readBuyerBody(paid, 65_536, signal),
        paidController,
      );
      const paidBody: unknown = JSON.parse(paidText);
      const result = TriageResultSchema.safeParse(paidBody);
      if (!result.success) throw new BuyerError('SERVICE_EXECUTION_FAILED');
      const serialized = JSON.stringify(result.data);
      if (
        Object.values(headers).some((value) => serialized.includes(value)) ||
        (typeof signingMaterial === 'string' &&
          serialized.includes(signingMaterial))
      )
        throw new BuyerError('SERVICE_EXECUTION_FAILED');
      await transition({
        status: 'COMPLETED',
        result: result.data,
        occurredAt: time(),
      });
    } catch (error) {
      if (paymentTombstoned && snapshot.paymentReceipt === null) {
        // Once signing/payment may have begun, only authoritative settlement
        // reconciliation may create a receipt or terminalize the run.
        return snapshot;
      }
      const safe = new BuyerError(
        snapshot.paymentReceipt
          ? 'SERVICE_EXECUTION_FAILED'
          : error instanceof BuyerError
            ? error.code
            : 'PAYMENT_FAILED',
      );
      // No raw cause, body, header, signer or server diagnostic reaches the run.
      let failedAt = snapshot.updatedAt;
      try {
        failedAt = time();
      } catch {
        /* Retain a valid timeline if the injected clock fails. */
      }
      await transition({
        status: 'FAILED',
        error: { code: safe.code, message: safe.message },
        occurredAt: failedAt,
      });
    } finally {
      unpaidController.abort();
      paidController.abort();
    }
    return snapshot;
  }
  return {
    execute: () => {
      execution ??= Promise.resolve().then(async () => {
        const claim = await ownership.claim(runId);
        try {
          return await run(claim);
        } finally {
          await claim.release();
        }
      });
      return execution.then((value) => AgentRunSchema.parse(value));
    },
  };
}
