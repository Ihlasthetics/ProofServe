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
import type { ClientHederaSigner } from '@x402/hedera';
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

export interface BuyerOptions {
  /** Trusted server configuration, never copied from an AgentTask or listing. */
  registryBaseUrl: string;
  allowedServiceEndpoint: string;
  runId?: string;
  ownership?: BuyerOwnership;
  fetcher?: typeof fetch;
  now?: () => string;
  /** Test/HSM boundary. Production defaults to the official ECDSA signer. */
  signerFactory?: () => ClientHederaSigner | Promise<ClientHederaSigner>;
}

async function productionSigner(): Promise<ClientHederaSigner> {
  const { createClientHederaSigner, PrivateKey } = await import('@x402/hedera');
  const account = HederaAccountIdSchema.parse(
    process.env.HEDERA_PAYER_ACCOUNT_ID,
  );
  const key = process.env.HEDERA_PAYER_PRIVATE_KEY;
  if (!key) throw new BuyerError();
  return createClientHederaSigner(account, PrivateKey.fromStringECDSA(key), {
    network: 'hedera:testnet',
  });
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
    url.protocol !== 'https:' ||
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
    allowed = endpoint(options.allowedServiceEndpoint);
    const base = new URL(options.registryBaseUrl);
    if (base.protocol !== 'https:' || base.username || base.password)
      throw new BuyerError('VALIDATION_ERROR');
    registry = base.href;
    runId = IdentifierSchema.parse(
      options.runId === undefined ? randomUUID() : options.runId,
    );
  } catch {
    throw new BuyerError('VALIDATION_ERROR');
  }
  const fetcher = options.fetcher ?? globalThis.fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const signerFactory = options.signerFactory ?? productionSigner;
  const ownership = options.ownership ?? defaultBuyerOwnership;
  let execution: Promise<AgentRun> | undefined;

  async function run(claim: BuyerClaim): Promise<AgentRun> {
    let started: string;
    try {
      started = TimestampSchema.parse(now());
    } catch {
      throw new BuyerError('VALIDATION_ERROR');
    }
    let snapshot = AgentRunSchema.parse({
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
    let anchorUtc = Date.parse(started);
    let anchorMonotonic = performance.now();
    const time = () => {
      const value = TimestampSchema.parse(now());
      if (value < snapshot.updatedAt || Date.parse(value) < anchorUtc)
        throw new BuyerError();
      anchorUtc = Date.parse(value);
      anchorMonotonic = performance.now();
      return value;
    };
    const transition = (command: AgentTransition) => {
      snapshot = transitionAgentRun(snapshot, command);
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
    try {
      transition({ status: 'DISCOVERING', occurredAt: time() });
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
      transition({
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
      transition({
        status: 'PAYMENT_REQUIRED',
        paymentRequirements: chosen.service.paymentRequirements,
        occurredAt: time(),
      });
      // Rediscover after receiving the price challenge, immediately before signing.
      await revalidate();
      remaining -= BigInt(chosen.service.paymentRequirements.amountAtomic);
      if (remaining < 0n) throw new BuyerError('BUDGET_EXCEEDED');
      transition({ status: 'PAYING', occurredAt: time() });
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
      claim.beginSigning();
      const payload = await bounded(() => http.createPaymentPayload(offer));
      const headers = http.encodePaymentSignatureHeader(payload);
      // Last awaited operation before submission: refresh security state after signing.
      await revalidate();
      const paid = await request(headers, paidController); // Exactly one paid retry; never use an automatic fetch wrapper.
      const evidence = validatedSettlement(
        paid,
        offer.accepts[0]?.extra?.feePayer,
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
      transition({
        status: 'PAID',
        paymentReceipt: receipt,
        occurredAt: settledAt,
      });
      if (clockFailed) throw new BuyerError('SERVICE_EXECUTION_FAILED');
      transition({ status: 'EXECUTING', occurredAt: time() });
      if (paid.status !== 200) throw new BuyerError('SERVICE_EXECUTION_FAILED');
      const paidText = await bounded(
        (signal) => readBuyerBody(paid, 65_536, signal),
        paidController,
      );
      const paidBody: unknown = JSON.parse(paidText);
      const result = TriageResultSchema.safeParse(paidBody);
      if (!result.success) throw new BuyerError('SERVICE_EXECUTION_FAILED');
      const serialized = JSON.stringify(result.data);
      const signingMaterial = payload.payload.transaction;
      if (
        Object.values(headers).some((value) => serialized.includes(value)) ||
        (typeof signingMaterial === 'string' &&
          serialized.includes(signingMaterial))
      )
        throw new BuyerError('SERVICE_EXECUTION_FAILED');
      transition({
        status: 'COMPLETED',
        result: result.data,
        occurredAt: time(),
      });
    } catch (error) {
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
      transition({
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
        const claim = ownership.claim(runId);
        try {
          return await run(claim);
        } finally {
          claim.release();
        }
      });
      return execution.then((value) => AgentRunSchema.parse(value));
    },
  };
}
