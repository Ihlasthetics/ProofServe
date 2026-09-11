import {
  HederaAccountIdSchema,
  PaymentRequirementsSchema,
  type PaymentRequirements,
} from '@proofserve/shared';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http';
import { parsePaymentRequired } from '@x402/core/schemas';
import type { PaymentRequired } from '@x402/core/types';

export class BuyerError extends Error {
  constructor(
    readonly code:
      | 'VALIDATION_ERROR'
      | 'NO_ELIGIBLE_SERVICE'
      | 'BUDGET_EXCEEDED'
      | 'PAYMENT_FAILED'
      | 'SERVICE_EXECUTION_FAILED' = 'PAYMENT_FAILED',
  ) {
    super(
      {
        VALIDATION_ERROR: 'Invalid buyer task or configuration.',
        NO_ELIGIBLE_SERVICE: 'No eligible unchanged service is available.',
        BUDGET_EXCEEDED: 'Payment exceeds the remaining budget.',
        PAYMENT_FAILED:
          'Payment could not be confirmed. Do not automatically retry.',
        SERVICE_EXECUTION_FAILED: 'Paid service execution failed.',
      }[code],
    );
    this.name = 'BuyerError';
  }
}

/** Y03 emits one v2 exact offer. Never pass arbitrary extensions to the signer. */
export function validatedOffer(
  response: Response,
  endpoint: string,
  expected: PaymentRequirements,
  remaining: bigint,
): PaymentRequired {
  const header = response.headers.get('payment-required');
  if (response.status !== 402 || !header || header.length > 16_384)
    throw new BuyerError();
  const parsed = parsePaymentRequired(decodePaymentRequiredHeader(header));
  if (!parsed.success || parsed.data.x402Version !== 2) throw new BuyerError();
  const data = parsed.data;
  const offer = data.accepts[0];
  if (
    data.accepts.length !== 1 ||
    !offer ||
    data.resource.url !== endpoint ||
    data.resource.mimeType !== 'application/json' ||
    offer.scheme !== 'exact' ||
    offer.maxTimeoutSeconds !== 300
  )
    throw new BuyerError();
  const domain = PaymentRequirementsSchema.safeParse({
    network: offer.network,
    asset: offer.asset,
    amountAtomic: offer.amount,
    payTo: offer.payTo,
  });
  const feePayer = HederaAccountIdSchema.safeParse(offer.extra?.feePayer);
  if (!domain.success || !feePayer.success) throw new BuyerError();
  if (
    domain.data.network !== expected.network ||
    domain.data.asset !== expected.asset ||
    domain.data.payTo !== expected.payTo
  )
    throw new BuyerError();
  if (BigInt(domain.data.amountAtomic) > remaining)
    throw new BuyerError('BUDGET_EXCEEDED');
  if (domain.data.amountAtomic !== expected.amountAtomic)
    throw new BuyerError();
  return {
    x402Version: 2,
    resource: {
      url: endpoint,
      mimeType: 'application/json',
      description: 'ProofServe support-ticket triage',
    },
    accepts: [
      {
        scheme: 'exact',
        network: domain.data.network,
        asset: domain.data.asset,
        amount: domain.data.amountAtomic,
        payTo: domain.data.payTo,
        maxTimeoutSeconds: 300,
        extra: { feePayer: feePayer.data },
      },
    ],
  };
}

/** Same native/path transaction formats and canonical URL as merged Y03. */
export function validatedSettlement(
  response: Response,
  feePayer: unknown,
): { transactionId: string; transactionUrl: string } {
  const header = response.headers.get('payment-response');
  if (!header || header.length > 16_384) throw new BuyerError();
  const settlement = decodePaymentResponseHeader(header);
  if (
    settlement.success !== true ||
    settlement.network !== 'hedera:testnet' ||
    typeof settlement.transaction !== 'string'
  )
    throw new BuyerError();
  const native =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)@([1-9][0-9]*)\.([0-9]{1,9})$/;
  const path =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-([1-9][0-9]*)-([0-9]{1,9})$/;
  const match =
    native.exec(settlement.transaction) ?? path.exec(settlement.transaction);
  if (!match) throw new BuyerError();
  const [, shard, realm, account, seconds, nanos] = match;
  const accountId = `${shard}.${realm}.${account}`;
  if (!nanos || accountId !== feePayer) throw new BuyerError();
  const transactionUrl = `https://hashscan.io/testnet/transaction/${accountId}-${seconds}-${nanos.padStart(9, '0')}`;
  if (
    response.headers.get('x-proofserve-hedera-transaction-id') !==
      settlement.transaction ||
    response.headers.get('x-proofserve-hedera-transaction-url') !==
      transactionUrl
  )
    throw new BuyerError();
  return { transactionId: settlement.transaction, transactionUrl };
}
