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

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required smoke-test configuration: ${name}`);
  }
  return value;
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

async function run() {
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

  const signer = createClientHederaSigner(
    payerAccountId,
    PrivateKey.fromString(payerPrivateKey),
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

  const unpaid = await globalThis.fetch(url, request);
  if (unpaid.status !== 402) {
    throw new Error(
      `Expected an unpaid 402 response, received ${unpaid.status}.`,
    );
  }
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

  const paymentPayload = await httpClient.createPaymentPayload({
    ...paymentRequired,
    accepts: [accepted],
  });
  const paid = await globalThis.fetch(url, {
    ...request,
    headers: {
      ...request.headers,
      ...httpClient.encodePaymentSignatureHeader(paymentPayload),
    },
  });
  const paidBody = await paid.json();
  if (!paid.ok) {
    throw new Error(`Paid request failed with HTTP ${paid.status}.`);
  }
  if (!TriageResultSchema.safeParse(paidBody).success) {
    throw new Error(
      'Paid response did not match the shared triage-result schema.',
    );
  }

  const settlement = httpClient.getPaymentSettleResponse((name) =>
    paid.headers.get(name),
  );
  if (!settlement.success || settlement.transaction === '') {
    throw new Error(
      'The paid response did not contain a successful settlement.',
    );
  }

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
  run().catch(() => {
    fail('Real-payment smoke test failed. Check the testnet configuration.');
  });
}
