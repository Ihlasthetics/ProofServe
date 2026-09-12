import { hashSignal } from '@worldcoin/idkit-core/hashing';
import {
  signRequest,
  type RpSignature,
  type SignRequestParams,
} from '@worldcoin/idkit-core/signing';
import type { IDKitRequestConfig, IDKitResult } from '@worldcoin/idkit-core';
import {
  WorldVerificationContextResponseSchema,
  type Identifier,
  type WorldVerificationContextResponse,
  type WorldVerificationRequest,
} from '@proofserve/shared';
import { parseJsonWithUniqueMembers } from './json.js';

const VERIFY_URL_PREFIX = 'https://developer.world.org/api/v4/verify/';
const DEFAULT_TIMEOUT_MS = 5_000;
const RP_SIGNATURE_TTL_SECONDS = 300;
const MAX_FRESHNESS_SECONDS = 31_536_000;
const MAX_TIMEOUT_MS = 30_000;
const actionPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const appIdPattern = /^app_[A-Za-z0-9_-]{1,128}$/;
const rpIdPattern = /^rp_[A-Za-z0-9_-]{1,128}$/;
const signingKeyPattern = /^(?:0x)?[0-9a-fA-F]{64}$/;
const canonicalPositiveIntegerPattern = /^[1-9][0-9]*$/;
const hexadecimalFieldElementPattern = /^0[xX][0-9a-fA-F]{1,64}$/;
const decimalFieldElementPattern = /^[0-9]{1,78}$/;
const maximumFieldElement = (1n << 256n) - 1n;
const dateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface WorldConfiguration {
  appId: string;
  rpId: string;
  signingKey: string;
  action: string;
  idkitEnvironment: WorldClientEnvironment;
  freshnessSeconds: number;
}

/** Exact environment accepted by the pinned IDKit 4.2.4 request config. */
export type WorldClientEnvironment = NonNullable<
  IDKitRequestConfig['environment']
>;

export class WorldConfigurationError extends Error {
  constructor() {
    super('Invalid World verification configuration.');
  }
}

function configured(
  environment: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv,
): string {
  const value = environment[name];
  if (typeof value !== 'string') throw new WorldConfigurationError();
  return value;
}

export function readWorldConfiguration(
  environment: NodeJS.ProcessEnv,
): WorldConfiguration {
  const appId = configured(environment, 'WORLD_APP_ID');
  const rpId = configured(environment, 'WORLD_RP_ID');
  const signingKey = configured(environment, 'WORLD_RP_SIGNING_KEY');
  const action = configured(environment, 'WORLD_ACTION');
  const idkitEnvironment = configured(environment, 'WORLD_ENVIRONMENT');
  const freshnessText = configured(
    environment,
    'WORLD_VERIFICATION_FRESHNESS_SECONDS',
  );
  if (
    !appIdPattern.test(appId) ||
    !rpIdPattern.test(rpId) ||
    !signingKeyPattern.test(signingKey) ||
    !actionPattern.test(action) ||
    (idkitEnvironment !== 'production' &&
      idkitEnvironment !== 'staging' &&
      idkitEnvironment !== 'sandbox') ||
    !canonicalPositiveIntegerPattern.test(freshnessText)
  ) {
    throw new WorldConfigurationError();
  }
  const freshnessSeconds = Number(freshnessText);
  if (
    !Number.isSafeInteger(freshnessSeconds) ||
    freshnessSeconds > MAX_FRESHNESS_SECONDS
  ) {
    throw new WorldConfigurationError();
  }
  return {
    appId,
    rpId,
    signingKey,
    action,
    idkitEnvironment,
    freshnessSeconds,
  };
}

export type WorldVerificationFailureCode =
  'WORLD_PROOF_INVALID' | 'WORLD_VERIFICATION_UNAVAILABLE';

export class WorldVerificationFailure extends Error {
  constructor(readonly code: WorldVerificationFailureCode) {
    super(
      code === 'WORLD_PROOF_INVALID'
        ? 'World verification result is invalid.'
        : 'World verification is temporarily unavailable.',
    );
  }
}

export interface WorldVerificationClient {
  readonly freshnessSeconds: number;
  createRequest(providerId: Identifier): WorldVerificationContextResponse;
  verify(
    providerId: Identifier,
    result: WorldVerificationRequest,
  ): Promise<string>;
}

type FetchImplementation = (
  input: string,
  init: RequestInit,
) => Promise<Response>;
type SignImplementation = (parameters: SignRequestParams) => RpSignature;

export interface WorldClientDependencies {
  fetch?: FetchImplementation;
  sign?: SignImplementation;
  timeoutMs?: number;
}

function providerSignal(providerId: Identifier): string {
  return `proofserve:provider:${providerId}`;
}

export function canonicalizeWorldFieldElement(value: string): string {
  if (
    !hexadecimalFieldElementPattern.test(value) &&
    !decimalFieldElementPattern.test(value)
  ) {
    throw new WorldVerificationFailure('WORLD_PROOF_INVALID');
  }
  const parsed = BigInt(value);
  if (parsed > maximumFieldElement)
    throw new WorldVerificationFailure('WORLD_PROOF_INVALID');
  return parsed.toString(10);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalDateTime(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      dateTimePattern.test(value) &&
      Number.isFinite(Date.parse(value)))
  );
}

/** Keep a closed list of proof failures emitted by the current V4 handler. */
const documentedNestedProofFailureCodes = new Set([
  'invalid_proof',
  'invalid_merkle_root',
  'root_too_old',
]);

/** Mirrors the failed per-proof result returned by the current V4 handler. */
interface VerifyV4FailureResult {
  identifier: 'selfie';
  success: false;
  code: string;
  detail: string;
}

/** Mirrors the current V4 all-verifications-failed response. */
interface VerifyV4ErrorResponse {
  success: false;
  code: 'all_verifications_failed';
  detail: string;
  results: [VerifyV4FailureResult];
}

function isDocumentedProofFailure(
  value: unknown,
): value is VerifyV4ErrorResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['success', 'code', 'detail', 'results']) ||
    value.success !== false ||
    typeof value.code !== 'string' ||
    typeof value.detail !== 'string'
  ) {
    return false;
  }
  if (
    value.code !== 'all_verifications_failed' ||
    !Array.isArray(value.results) ||
    value.results.length !== 1
  ) {
    return false;
  }
  const result = value.results[0];
  return (
    isRecord(result) &&
    hasOnlyKeys(result, ['identifier', 'success', 'code', 'detail']) &&
    result.identifier === 'selfie' &&
    result.success === false &&
    typeof result.code === 'string' &&
    documentedNestedProofFailureCodes.has(result.code) &&
    typeof result.detail === 'string'
  );
}

function verifiedUpstreamNullifier(
  value: unknown,
  expectedAction: string,
  expectedEnvironment: WorldClientEnvironment,
  expectedNullifier: string,
): string | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.success !== true ||
    !hasOnlyKeys(value, [
      'success',
      'protocol_version',
      'results',
      'action',
      'nullifier',
      'created_at',
      'environment',
      'message',
    ]) ||
    value.protocol_version !== '3.0' ||
    !Array.isArray(value.results) ||
    value.results.length !== 1 ||
    typeof value.action !== 'string' ||
    typeof value.nullifier !== 'string' ||
    !optionalDateTime(value.created_at) ||
    typeof value.environment !== 'string' ||
    typeof value.message !== 'string' ||
    value.action !== expectedAction ||
    value.environment !== expectedEnvironment
  ) {
    return undefined;
  }
  const result = value.results[0];
  if (
    !isRecord(result) ||
    !hasOnlyKeys(result, ['identifier', 'success', 'nullifier']) ||
    result.identifier !== 'selfie' ||
    result.success !== true ||
    typeof result.nullifier !== 'string'
  ) {
    return undefined;
  }
  let upstreamNullifier: string;
  try {
    upstreamNullifier = canonicalizeWorldFieldElement(result.nullifier);
    if (canonicalizeWorldFieldElement(value.nullifier) !== expectedNullifier) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return upstreamNullifier === expectedNullifier
    ? upstreamNullifier
    : undefined;
}

function hasJsonContentType(response: Response): boolean {
  const mediaType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  return (
    mediaType === 'application/json' ||
    (mediaType?.startsWith('application/') === true &&
      mediaType.endsWith('+json'))
  );
}

type OfficialLegacyResult = Extract<IDKitResult, { protocol_version: '3.0' }>;

function officialResult(
  result: WorldVerificationRequest,
): WorldVerificationRequest {
  const tiedToOfficialType: OfficialLegacyResult = {
    protocol_version: result.protocol_version,
    nonce: result.nonce,
    action: result.action,
    responses: result.responses,
    user_presence_completed: result.user_presence_completed,
    environment: result.environment,
    ...(result.action_description === undefined
      ? {}
      : { action_description: result.action_description }),
    ...(result.integrity_bundle === undefined
      ? {}
      : { integrity_bundle: result.integrity_bundle }),
  };
  void tiedToOfficialType;
  return result;
}

export function createWorldVerificationClient(
  configuration: WorldConfiguration,
  dependencies: WorldClientDependencies = {},
): WorldVerificationClient {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const signImplementation = dependencies.sign ?? signRequest;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new WorldConfigurationError();
  }

  return {
    freshnessSeconds: configuration.freshnessSeconds,
    createRequest(providerId) {
      try {
        const signature = signImplementation({
          signingKeyHex: configuration.signingKey,
          action: configuration.action,
          ttl: RP_SIGNATURE_TTL_SECONDS,
        });
        return WorldVerificationContextResponseSchema.parse({
          app_id: configuration.appId,
          action: configuration.action,
          signal: providerSignal(providerId),
          environment: configuration.idkitEnvironment,
          rp_context: {
            rp_id: configuration.rpId,
            nonce: signature.nonce,
            created_at: signature.createdAt,
            expires_at: signature.expiresAt,
            signature: signature.sig,
          },
          allow_legacy_proofs: true,
          require_user_presence: true,
        });
      } catch {
        throw new WorldVerificationFailure('WORLD_VERIFICATION_UNAVAILABLE');
      }
    },
    async verify(providerId, result) {
      const validatedResult = officialResult(result);
      let expectedSignalHash: string;
      let submittedSignalHash: string;
      let submittedNullifier: string;
      try {
        expectedSignalHash = canonicalizeWorldFieldElement(
          hashSignal(providerSignal(providerId)),
        );
        submittedSignalHash = canonicalizeWorldFieldElement(
          validatedResult.responses[0].signal_hash,
        );
        submittedNullifier = canonicalizeWorldFieldElement(
          validatedResult.responses[0].nullifier,
        );
      } catch {
        throw new WorldVerificationFailure('WORLD_PROOF_INVALID');
      }
      if (
        validatedResult.action !== configuration.action ||
        validatedResult.environment !== configuration.idkitEnvironment ||
        validatedResult.user_presence_completed !== true ||
        submittedSignalHash !== expectedSignalHash
      ) {
        throw new WorldVerificationFailure('WORLD_PROOF_INVALID');
      }

      let response: Response;
      try {
        response = await fetchImplementation(
          `${VERIFY_URL_PREFIX}${configuration.rpId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validatedResult),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'error',
          },
        );
      } catch {
        throw new WorldVerificationFailure('WORLD_VERIFICATION_UNAVAILABLE');
      }
      if (response.status !== 200 && response.status !== 400) {
        throw new WorldVerificationFailure('WORLD_VERIFICATION_UNAVAILABLE');
      }
      if (!hasJsonContentType(response))
        throw new WorldVerificationFailure('WORLD_VERIFICATION_UNAVAILABLE');
      let responseBody: unknown;
      try {
        responseBody = parseJsonWithUniqueMembers(await response.text());
      } catch {
        throw new WorldVerificationFailure('WORLD_VERIFICATION_UNAVAILABLE');
      }
      if (response.status === 400) {
        throw new WorldVerificationFailure(
          isDocumentedProofFailure(responseBody)
            ? 'WORLD_PROOF_INVALID'
            : 'WORLD_VERIFICATION_UNAVAILABLE',
        );
      }
      const verifiedNullifier = verifiedUpstreamNullifier(
        responseBody,
        configuration.action,
        configuration.idkitEnvironment,
        submittedNullifier,
      );
      if (verifiedNullifier === undefined) {
        throw new WorldVerificationFailure('WORLD_VERIFICATION_UNAVAILABLE');
      }
      return verifiedNullifier;
    },
  };
}
