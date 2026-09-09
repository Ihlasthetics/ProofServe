const NATIVE_TRANSACTION_ID =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)@([1-9][0-9]*)\.([0-9]{1,9})$/;
const PATH_TRANSACTION_ID =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-([1-9][0-9]*)-([0-9]{1,9})$/;

export interface HederaTransactionIdParts {
  accountId: string;
  seconds: string;
  nanos: string;
}

export function parseHederaTransactionId(
  transactionId: string,
): HederaTransactionIdParts | undefined {
  const match =
    NATIVE_TRANSACTION_ID.exec(transactionId) ??
    PATH_TRANSACTION_ID.exec(transactionId);
  if (match === null) return undefined;

  const [, shard, realm, account, seconds, nanos] = match;
  if (
    shard === undefined ||
    realm === undefined ||
    account === undefined ||
    seconds === undefined ||
    nanos === undefined
  ) {
    return undefined;
  }

  return {
    accountId: `${shard}.${realm}.${account}`,
    seconds,
    nanos: nanos.padStart(9, '0'),
  };
}

export function hashScanTestnetTransactionUrl(transactionId: string): string {
  const parts = parseHederaTransactionId(transactionId);
  if (parts === undefined) {
    throw new Error('Invalid Hedera transaction ID.');
  }

  return `https://hashscan.io/testnet/transaction/${parts.accountId}-${parts.seconds}-${parts.nanos}`;
}
