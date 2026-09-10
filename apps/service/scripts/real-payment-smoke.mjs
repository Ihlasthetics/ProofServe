import { TriageResultSchema } from '@proofserve/shared';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import {
  HBAR_ASSET_ID,
  HEDERA_TESTNET_CAIP2,
  PrivateKey,
  createClientHederaSigner,
} from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { hashScanTestnetTransactionUrl } from '../src/hashscan.ts';

const SMOKE_STAGE = Object.freeze({
  CONFIGURATION: 'configuration',
  SIGNER_INITIALIZATION: 'signer initialization',
  UNPAID_REQUEST: 'unpaid request',
  PAYMENT_REQUIREMENT_VALIDATION: 'payment-requirement validation',
  PAYMENT_CREATION_SIGNING: 'payment creation/signing',
  PAID_REQUEST: 'paid request',
  TRIAGE_RESULT_VALIDATION: 'triage-result validation',
  SETTLEMENT_VALIDATION: 'settlement validation',
  HASHSCAN_VALIDATION: 'HashScan validation',
});
const SMOKE_STAGE_NAMES = new Set(Object.values(SMOKE_STAGE));
const PAID_RESPONSE_ERROR_CODES = new Set([
  'PAYMENT_FAILED',
  'SERVICE_EXECUTION_FAILED',
]);

function isSafeHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function setFailureStage(context, stage, httpStatus) {
  context.stage = SMOKE_STAGE_NAMES.has(stage)
    ? stage
    : SMOKE_STAGE.CONFIGURATION;
  context.httpStatus = isSafeHttpStatus(httpStatus) ? httpStatus : undefined;
}

export function formatSmokeFailure(context) {
  const stage = SMOKE_STAGE_NAMES.has(context.stage)
    ? context.stage
    : SMOKE_STAGE.CONFIGURATION;
  const status = isSafeHttpStatus(context.httpStatus)
    ? ` HTTP status: ${context.httpStatus}.`
    : '';
  return `Real-payment smoke test failed. Stage: ${stage}.${status}`;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paidResponseErrorCode(paidBody) {
  if (!isRecord(paidBody) || !isRecord(paidBody.error)) return undefined;
  const code = paidBody.error.code;
  return typeof code === 'string' && PAID_RESPONSE_ERROR_CODES.has(code)
    ? code
    : undefined;
}

function paidResponseSettlementEvidence(paidResponse, httpClient) {
  try {
    const settlement = httpClient.getPaymentSettleResponse((name) =>
      paidResponse.headers.get(name),
    );
    if (
      settlement.success !== true ||
      settlement.network !== HEDERA_TESTNET_CAIP2 ||
      typeof settlement.transaction !== 'string' ||
      settlement.transaction === ''
    ) {
      return undefined;
    }

    return {
      transaction: settlement.transaction,
      transactionUrl: hashScanTestnetTransactionUrl(settlement.transaction),
    };
  } catch {
    return undefined;
  }
}

export function formatPaidFailureDiagnostics({
  paidBody,
  paidResponse,
  httpClient,
}) {
  const code = paidResponseErrorCode(paidBody) ?? 'unavailable';
  const lines = [`Paid response error code: ${code}`];
  const evidence = paidResponseSettlementEvidence(paidResponse, httpClient);
  if (evidence !== undefined) {
    lines.push(`Settlement transaction: ${evidence.transaction}`);
    lines.push(`HashScan: ${evidence.transactionUrl}`);
  }
  return lines.join('\n');
}

function fail(context) {
  process.stderr.write(`${formatSmokeFailure(context)}\n`);
  process.exitCode = 1;
}

function printPaidFailureDiagnostics(paidBody, paidResponse, httpClient) {
  process.stderr.write(
    `${formatPaidFailureDiagnostics({ paidBody, paidResponse, httpClient })}\n`,
  );
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required smoke-test configuration: ${name}`);
  }
  return value;
}

export function parseSmokePayerPrivateKey(payerPrivateKey) {
  return PrivateKey.fromStringECDSA(payerPrivateKey);
}

export function createSmokePaymentClient({
  signer,
  expectedReceiver,
  expectedAmount,
}) {
  return new x402Client()
    .register(HEDERA_TESTNET_CAIP2, new ExactHederaScheme(signer))
    .setSpendControls({
      allowedAssets: [
        {
          network: HEDERA_TESTNET_CAIP2,
          asset: HBAR_ASSET_ID,
          maxAmountPerPayment: expectedAmount,
        },
      ],
    })
    .registerPolicy((x402Version, requirements) => {
      if (x402Version !== 2) return [];
      return requirements.filter(
        (requirement) =>
          requirement.scheme === 'exact' &&
          requirement.network === HEDERA_TESTNET_CAIP2 &&
          requirement.asset === HBAR_ASSET_ID &&
          requirement.payTo === expectedReceiver &&
          requirement.amount === expectedAmount,
      );
    });
}

async function run(failureContext) {
  setFailureStage(failureContext, SMOKE_STAGE.CONFIGURATION);
  if (process.env.RUN_REAL_PAYMENT_SMOKE !== 'true') {
    throw new Error(
      'Real-payment smoke test is disabled. Set RUN_REAL_PAYMENT_SMOKE=true to invoke it explicitly.',
    );
  }

  const url = required('TRIAGE_SMOKE_URL');
  const payerAccountId = required('HEDERA_PAYER_ACCOUNT_ID');
  const payerPrivateKey = required('HEDERA_PAYER_PRIVATE_KEY');
  const expectedReceiver = required('X402_RECEIVER_ACCOUNT_ID');
  const expectedAmount = required('X402_PRICE_TINYBAR');

  setFailureStage(failureContext, SMOKE_STAGE.SIGNER_INITIALIZATION);
  const signer = createClientHederaSigner(
    payerAccountId,
    parseSmokePayerPrivateKey(payerPrivateKey),
    { network: HEDERA_TESTNET_CAIP2 },
  );
  const protocolClient = createSmokePaymentClient({
    signer,
    expectedReceiver,
    expectedAmount,
  });
  const httpClient = new x402HTTPClient(protocolClient);
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ticket: 'Unable to sign in after resetting my password.',
    }),
  };

  setFailureStage(failureContext, SMOKE_STAGE.UNPAID_REQUEST);
  const unpaid = await globalThis.fetch(url, request);
  setFailureStage(failureContext, SMOKE_STAGE.UNPAID_REQUEST, unpaid.status);
  if (unpaid.status !== 402) {
    throw new Error(
      `Expected an unpaid 402 response, received ${unpaid.status}.`,
    );
  }

  setFailureStage(
    failureContext,
    SMOKE_STAGE.PAYMENT_REQUIREMENT_VALIDATION,
    unpaid.status,
  );
  const unpaidBody = await unpaid.json();
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    unpaidBody,
  );
  const accepted = paymentRequired.accepts.find(
    (requirement) =>
      requirement.network === HEDERA_TESTNET_CAIP2 &&
      requirement.asset === HBAR_ASSET_ID &&
      requirement.payTo === expectedReceiver &&
      requirement.amount === expectedAmount,
  );
  if (accepted === undefined) {
    throw new Error(
      'The service payment requirements do not match the smoke-test configuration.',
    );
  }

  setFailureStage(failureContext, SMOKE_STAGE.PAYMENT_CREATION_SIGNING);
  const paymentPayload = await httpClient.createPaymentPayload({
    ...paymentRequired,
    accepts: [accepted],
  });
  const paymentHeaders =
    httpClient.encodePaymentSignatureHeader(paymentPayload);

  setFailureStage(failureContext, SMOKE_STAGE.PAID_REQUEST);
  const paid = await globalThis.fetch(url, {
    ...request,
    headers: {
      ...request.headers,
      ...paymentHeaders,
    },
  });
  setFailureStage(failureContext, SMOKE_STAGE.PAID_REQUEST, paid.status);
  let paidBody;
  try {
    paidBody = await paid.json();
  } catch {
    if (!paid.ok) {
      printPaidFailureDiagnostics(undefined, paid, httpClient);
    }
    throw new Error('Paid response body was not valid JSON.');
  }
  if (!paid.ok) {
    printPaidFailureDiagnostics(paidBody, paid, httpClient);
    throw new Error(`Paid request failed with HTTP ${paid.status}.`);
  }

  setFailureStage(
    failureContext,
    SMOKE_STAGE.TRIAGE_RESULT_VALIDATION,
    paid.status,
  );
  if (!TriageResultSchema.safeParse(paidBody).success) {
    throw new Error(
      'Paid response did not match the shared triage-result schema.',
    );
  }

  setFailureStage(
    failureContext,
    SMOKE_STAGE.SETTLEMENT_VALIDATION,
    paid.status,
  );
  const settlement = httpClient.getPaymentSettleResponse((name) =>
    paid.headers.get(name),
  );
  if (!settlement.success || settlement.transaction === '') {
    throw new Error(
      'The paid response did not contain a successful settlement.',
    );
  }

  setFailureStage(failureContext, SMOKE_STAGE.HASHSCAN_VALIDATION, paid.status);
  const transactionUrl = paid.headers.get(
    'x-proofserve-hedera-transaction-url',
  );
  if (transactionUrl === null) {
    throw new Error('The paid response did not contain a HashScan URL.');
  }
  const transactionMatch =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)@([1-9][0-9]*)\.([0-9]{1,9})$/.exec(
      settlement.transaction,
    );
  if (transactionMatch === null) {
    throw new Error('The settlement transaction ID is not a safe Hedera ID.');
  }
  const [, shard, realm, account, seconds, nanos] = transactionMatch;
  const expectedTransactionUrl = `https://hashscan.io/testnet/transaction/${shard}.${realm}.${account}-${seconds}-${nanos.padStart(9, '0')}`;
  if (transactionUrl !== expectedTransactionUrl) {
    throw new Error(
      'The paid response HashScan URL does not match settlement.',
    );
  }

  process.stdout.write(`Settlement transaction: ${settlement.transaction}\n`);
  process.stdout.write(`HashScan: ${transactionUrl}\n`);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  const failureContext = { stage: SMOKE_STAGE.CONFIGURATION };
  run(failureContext).catch(() => {
    fail(failureContext);
  });
}
