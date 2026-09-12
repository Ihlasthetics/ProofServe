import { hashSignal } from '@worldcoin/idkit-core/hashing';
import {
  activeServiceFixture,
  ApiErrorResponseSchema,
  ProviderSchema,
  ServiceListingSchema,
  WorldVerificationContextResponseSchema,
  WorldVerificationRequestSchema,
  WorldVerificationResponseSchema,
  type ApiErrorCode,
  type Identifier,
  type Provider,
  type WorldVerificationRequest,
} from '@proofserve/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalizeWorldFieldElement,
  createApiApp,
  createWorldVerificationClient,
  InMemoryRegistryRepository,
  InMemoryWorldReplayStore,
  WorldVerificationFailure,
  type WorldConfiguration,
  type WorldVerificationClient,
} from '../src/index.js';

const initialTime = '2026-09-10T12:00:00.000Z';
const action = 'proofserve-provider-verification';
const environment = 'sandbox';
const officialIntegrityBundle = {
  version: 1 as const,
  signature_format: 'android_keystore' as const,
  timestamp: 1_789_034_400,
  signature: 'ab'.repeat(64),
  jwt: 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImZpY3Rpb25hbCJ9.eyJwYXNzIjp0cnVlfQ.ZmljdGlvbmFs',
};
const apps: ReturnType<typeof createApiApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function provider(id: Identifier, verification?: Provider['verification']) {
  return ProviderSchema.parse({
    id,
    displayName: `Fictional ${id}`,
    payoutAccount: '0.0.456789',
    verification: verification ?? {
      providerId: id,
      method: 'WORLD_SELFIE_CHECK',
      status: 'UNVERIFIED',
      verifiedAt: null,
      expiresAt: null,
    },
    createdAt: initialTime,
    updatedAt: initialTime,
  });
}

function worldResult(
  providerId: Identifier,
  nullifier = '0x0A',
): WorldVerificationRequest {
  return WorldVerificationRequestSchema.parse({
    protocol_version: '3.0',
    nonce: `0x${'11'.repeat(32)}`,
    action,
    responses: [
      {
        identifier: 'selfie',
        signal_hash: hashSignal(`proofserve:provider:${providerId}`),
        proof: `0x${'22'.repeat(256)}`,
        merkle_root: `0x${'33'.repeat(32)}`,
        nullifier,
      },
    ],
    user_presence_completed: true,
    environment,
  });
}

function fakeWorld(freshnessSeconds = 60): WorldVerificationClient {
  return {
    freshnessSeconds,
    createRequest(providerId) {
      return WorldVerificationContextResponseSchema.parse({
        app_id: 'app_sandbox_00000000000000000000000000000000',
        action,
        signal: `proofserve:provider:${providerId}`,
        environment,
        rp_context: {
          rp_id: 'rp_00000000000000000000000000000000',
          nonce: `0x${'44'.repeat(32)}`,
          created_at: 1_789_034_400,
          expires_at: 1_789_034_700,
          signature: `0x${'55'.repeat(65)}`,
        },
        allow_legacy_proofs: true,
        require_user_presence: true,
      });
    },
    async verify(_providerId, result) {
      return canonicalizeWorldFieldElement(result.responses[0].nullifier);
    },
  };
}

function setup(
  selectedWorld: WorldVerificationClient = fakeWorld(),
  repository = new InMemoryRegistryRepository(new InMemoryWorldReplayStore()),
) {
  const clock = { now: initialTime };
  const app = createApiApp({
    repository,
    now: () => clock.now,
    providerId: () => 'provider_generated',
    serviceId: () => 'service_generated',
    resolveEndpoint: () => activeServiceFixture.endpoint,
    worldVerification: selectedWorld,
  });
  apps.push(app);
  return { app, repository, clock, world: selectedWorld };
}

function expectError(
  response: { statusCode: number; json(): unknown; body: string },
  status: number,
  code: ApiErrorCode,
) {
  expect(response.statusCode).toBe(status);
  const parsed = ApiErrorResponseSchema.parse(response.json());
  expect(parsed.error.code).toBe(code);
  expect(response.body).not.toMatch(
    /private-test-marker|proof-test-marker|upstream-test-marker|WORLD_RP_SIGNING_KEY|stack|ZodError|issues/,
  );
  return parsed;
}

function draftService(providerId: Identifier) {
  return ServiceListingSchema.parse({
    ...activeServiceFixture,
    id: `service_${providerId}`,
    providerId,
    status: 'DRAFT',
    paymentRequirements: {
      ...activeServiceFixture.paymentRequirements,
      payTo: '0.0.456789',
    },
  });
}

describe('World RP context and verification routes', () => {
  it('returns valid provider-bound RP context from an exact empty request', async () => {
    const world = fakeWorld();
    const createRequest = vi.spyOn(world, 'createRequest');
    const { app, repository } = setup(world);
    repository.createProvider(provider('provider_context'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers/provider_context/verification/world/request',
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const context = WorldVerificationContextResponseSchema.parse(
      response.json(),
    );
    expect(context.signal).toBe('proofserve:provider:provider_context');
    expect(context.allow_legacy_proofs).toBe(true);
    expect(context.require_user_presence).toBe(true);
    expect(createRequest).toHaveBeenCalledExactlyOnceWith('provider_context');
    expect(response.body).not.toMatch(/signingKey|WORLD_RP_SIGNING_KEY/);
  });

  it('stores only a strict verified record and updates the provider after success', async () => {
    const world = fakeWorld();
    const verify = vi.spyOn(world, 'verify');
    const { app, repository } = setup(world);
    const original = provider('provider_success');
    repository.createProvider(original);
    const result = worldResult(original.id);
    const response = await app.inject({
      method: 'POST',
      url: `/api/providers/${original.id}/verification/world`,
      payload: result,
    });
    expect(response.statusCode).toBe(200);
    const verification = WorldVerificationResponseSchema.parse(response.json());
    expect(verification).toEqual({
      providerId: original.id,
      method: 'WORLD_SELFIE_CHECK',
      status: 'VERIFIED',
      verifiedAt: initialTime,
      expiresAt: '2026-09-10T12:01:00.000Z',
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(original.id, result);
    expect(repository.getProvider(original.id)).toEqual({
      ...original,
      verification,
      updatedAt: initialTime,
    });
    expect(response.body).not.toContain(result.responses[0].proof);
    expect(response.body).not.toContain(result.responses[0].nullifier);
    expect(response.body).not.toContain(result.nonce);
  });

  it('does not sign or verify for unknown providers or malformed input', async () => {
    const world = fakeWorld();
    const createRequest = vi.spyOn(world, 'createRequest');
    const verify = vi.spyOn(world, 'verify');
    const { app, repository } = setup(world);
    repository.createProvider(provider('provider_known'));

    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/providers/provider_unknown/verification/world/request',
        payload: {},
      }),
      404,
      'PROVIDER_NOT_FOUND',
    );
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/providers/provider_unknown/verification/world',
        payload: worldResult('provider_unknown'),
      }),
      404,
      'PROVIDER_NOT_FOUND',
    );
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/providers/provider_known/verification/world/request',
        payload: { action: 'client-controlled' },
      }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/providers/provider_known/verification/world',
        payload: { proof: 'proof-test-marker' },
      }),
      400,
      'VALIDATION_ERROR',
    );
    expect(createRequest).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects duplicate JSON members before signing, verification, or mutation', async () => {
    const world = fakeWorld();
    const createRequest = vi.spyOn(world, 'createRequest');
    const verify = vi.spyOn(world, 'verify');
    const { app, repository } = setup(world);
    const original = provider('provider_duplicate_members');
    repository.createProvider(original);
    const result = WorldVerificationRequestSchema.parse({
      ...worldResult(original.id),
      integrity_bundle: officialIntegrityBundle,
    });
    const raw = JSON.stringify(result);
    const proof = JSON.stringify(result.responses[0].proof);
    const cases = [
      [
        'root action',
        raw.replace(
          `"action":"${action}"`,
          `"action":"${action}","action":"different-action"`,
        ),
      ],
      [
        'escaped equivalent root action',
        raw.replace(
          `"action":"${action}"`,
          `"action":"${action}","\\u0061ction":"different-action"`,
        ),
      ],
      [
        'root environment',
        raw.replace(
          `"environment":"${environment}"`,
          `"environment":"${environment}","environment":"production"`,
        ),
      ],
      [
        'root responses',
        raw.replace('"responses":[', '"responses":[],"responses":['),
      ],
      [
        'response proof',
        raw.replace(`"proof":${proof}`, `"proof":${proof},"proof":${proof}`),
      ],
      [
        'integrity bundle version',
        raw.replace('"version":1', '"version":1,"version":2'),
      ],
    ] as const;

    for (const [label, payload] of cases) {
      expect(payload, label).not.toBe(raw);
      expectError(
        await app.inject({
          method: 'POST',
          url: `/api/providers/${original.id}/verification/world`,
          payload,
          headers: { 'content-type': 'application/json' },
        }),
        400,
        'VALIDATION_ERROR',
      );
      expect(repository.getProvider(original.id), label).toEqual(original);
    }
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/providers/${original.id}/verification/world/request`,
        payload: '{"action":"one","\\u0061ction":"two"}',
        headers: { 'content-type': 'application/json' },
      }),
      400,
      'VALIDATION_ERROR',
    );
    expect(createRequest).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('retains Fastify body-size rejection before verification or mutation', async () => {
    const world = fakeWorld();
    const verify = vi.spyOn(world, 'verify');
    const { app, repository } = setup(world);
    const original = provider('provider_oversized_body');
    repository.createProvider(original);
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/providers/${original.id}/verification/world`,
        payload: `{"padding":"${'x'.repeat(1_048_576)}"}`,
        headers: { 'content-type': 'application/json' },
      }),
      400,
      'VALIDATION_ERROR',
    );
    expect(verify).not.toHaveBeenCalled();
    expect(repository.getProvider(original.id)).toEqual(original);
  });

  it.each([
    [
      'missing user presence',
      ({ user_presence_completed: removed, ...rest }) => {
        void removed;
        return rest;
      },
    ],
    [
      'false user presence',
      (result) => ({ ...result, user_presence_completed: false }),
    ],
    ['wrong protocol', (result) => ({ ...result, protocol_version: '4.0' })],
    [
      'malformed proof',
      (result) => ({
        ...result,
        responses: [{ ...result.responses[0], proof: 'proof-test-marker' }],
      }),
    ],
    [
      'unknown field',
      (result) => ({ ...result, signing_key: 'private-test-marker' }),
    ],
    [
      'extra response',
      (result) => ({
        ...result,
        responses: [...result.responses, result.responses[0]],
      }),
    ],
    [
      'unsupported integrity bundle version',
      (result) => ({
        ...result,
        integrity_bundle: {
          ...officialIntegrityBundle,
          version: 3,
        },
      }),
    ],
    [
      '0x-prefixed integrity bundle signature',
      (result) => ({
        ...result,
        integrity_bundle: {
          ...officialIntegrityBundle,
          signature: `0x${officialIntegrityBundle.signature}`,
        },
      }),
    ],
    [
      'odd-length integrity bundle signature',
      (result) => ({
        ...result,
        integrity_bundle: {
          ...officialIntegrityBundle,
          signature: 'abc',
        },
      }),
    ],
    [
      'non-hex integrity bundle signature',
      (result) => ({
        ...result,
        integrity_bundle: {
          ...officialIntegrityBundle,
          signature: 'not-hex',
        },
      }),
    ],
    [
      'over-limit integrity bundle signature',
      (result) => ({
        ...result,
        integrity_bundle: {
          ...officialIntegrityBundle,
          signature: 'ab'.repeat(4097),
        },
      }),
    ],
    [
      'missing integrity bundle field',
      (result) => {
        const { jwt: removed, ...missingJwt } = officialIntegrityBundle;
        void removed;
        return {
          ...result,
          integrity_bundle: missingJwt,
        };
      },
    ],
    [
      'unknown integrity bundle field',
      (result) => ({
        ...result,
        integrity_bundle: {
          ...officialIntegrityBundle,
          private_key: 'private-test-marker',
        },
      }),
    ],
  ] satisfies ReadonlyArray<
    readonly [string, (result: WorldVerificationRequest) => unknown]
  >)('rejects %s before verification', async (_label, mutate) => {
    const world = fakeWorld();
    const verify = vi.spyOn(world, 'verify');
    const { app, repository } = setup(world);
    const original = provider('provider_malformed');
    repository.createProvider(original);
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/providers/${original.id}/verification/world`,
        payload: mutate(worldResult(original.id)),
      }),
      400,
      'VALIDATION_ERROR',
    );
    expect(verify).not.toHaveBeenCalled();
    expect(repository.getProvider(original.id)).toEqual(original);
  });

  it('rejects current duplicate verification without calling World', async () => {
    const current = provider('provider_current', {
      providerId: 'provider_current',
      method: 'WORLD_SELFIE_CHECK',
      status: 'VERIFIED',
      verifiedAt: '2026-09-10T11:59:00.000Z',
      expiresAt: '2026-09-10T12:01:00.000Z',
    });
    const world = fakeWorld();
    const verify = vi.spyOn(world, 'verify');
    const { app, repository } = setup(world);
    repository.createProvider(current);
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/providers/${current.id}/verification/world`,
        payload: worldResult(current.id),
      }),
      409,
      'PROVIDER_ALREADY_VERIFIED',
    );
    expect(verify).not.toHaveBeenCalled();
    expect(repository.getProvider(current.id)).toEqual(current);
  });

  it('allows an expired provider to renew with server timestamps', async () => {
    const expired = provider('provider_expired', {
      providerId: 'provider_expired',
      method: 'WORLD_SELFIE_CHECK',
      status: 'VERIFIED',
      verifiedAt: '2026-09-09T11:00:00.000Z',
      expiresAt: '2026-09-10T12:00:00.000Z',
    });
    const { app, repository } = setup();
    repository.createProvider(expired);
    const response = await app.inject({
      method: 'POST',
      url: `/api/providers/${expired.id}/verification/world`,
      payload: worldResult(expired.id, '0x0B'),
    });
    expect(response.statusCode).toBe(200);
    expect(
      WorldVerificationResponseSchema.parse(response.json()).verifiedAt,
    ).toBe(initialTime);
  });
});

describe('atomic replay protection', () => {
  it('rejects the same nullifier for the same provider after expiration', async () => {
    const { app, repository, clock } = setup(fakeWorld(60));
    const original = provider('provider_same_replay');
    repository.createProvider(original);
    const first = await app.inject({
      method: 'POST',
      url: `/api/providers/${original.id}/verification/world`,
      payload: worldResult(original.id, '0x0A'),
    });
    expect(first.statusCode).toBe(200);
    const stored = repository.getProvider(original.id);
    clock.now = '2026-09-10T12:01:00.000Z';
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/providers/${original.id}/verification/world`,
        payload: worldResult(original.id, '0x000a'),
      }),
      409,
      'WORLD_PROOF_REPLAYED',
    );
    expect(repository.getProvider(original.id)).toEqual(stored);
  });

  it('canonicalizes equivalent nullifiers and blocks replay across providers', async () => {
    const { app, repository } = setup();
    const firstProvider = provider('provider_replay_one');
    const secondProvider = provider('provider_replay_two');
    repository.createProvider(firstProvider);
    repository.createProvider(secondProvider);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/providers/${firstProvider.id}/verification/world`,
          payload: worldResult(firstProvider.id, '0x000A'),
        })
      ).statusCode,
    ).toBe(200);
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/providers/${secondProvider.id}/verification/world`,
        payload: worldResult(secondProvider.id, '0x0a'),
      }),
      409,
      'WORLD_PROOF_REPLAYED',
    );
    expect(repository.getProvider(secondProvider.id)).toEqual(secondProvider);
  });

  it('allows only one of two concurrent submissions to commit', async () => {
    const world = fakeWorld();
    let releaseVerification: () => void = () => undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    world.verify = vi.fn(async (_providerId, result) => {
      await verificationGate;
      return canonicalizeWorldFieldElement(result.responses[0].nullifier);
    });
    const { app, repository } = setup(world);
    const original = provider('provider_concurrent');
    repository.createProvider(original);
    const request = {
      method: 'POST' as const,
      url: `/api/providers/${original.id}/verification/world`,
      payload: worldResult(original.id),
    };
    const pendingResponses = [app.inject(request), app.inject(request)];
    await vi.waitFor(() => expect(world.verify).toHaveBeenCalledTimes(2));
    releaseVerification();
    const responses = await Promise.all(pendingResponses);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const failure = responses.find((response) => response.statusCode === 409);
    if (!failure) throw new Error('Missing replay response');
    expectError(failure, 409, 'WORLD_PROOF_REPLAYED');
    expect(world.verify).toHaveBeenCalledTimes(2);
    expect(repository.getProvider(original.id)?.verification.status).toBe(
      'VERIFIED',
    );
  });

  it('shares replay claims across default repository and app instances', async () => {
    const firstRepository = new InMemoryRegistryRepository();
    const secondRepository = new InMemoryRegistryRepository();
    const first = setup(fakeWorld(), firstRepository);
    const second = setup(fakeWorld(), secondRepository);
    const firstProvider = provider('provider_process_replay_one');
    const secondProvider = provider('provider_process_replay_two');
    firstRepository.createProvider(firstProvider);
    secondRepository.createProvider(secondProvider);

    expect(
      (
        await first.app.inject({
          method: 'POST',
          url: `/api/providers/${firstProvider.id}/verification/world`,
          payload: worldResult(firstProvider.id, '0x0101'),
        })
      ).statusCode,
    ).toBe(200);
    expectError(
      await second.app.inject({
        method: 'POST',
        url: `/api/providers/${secondProvider.id}/verification/world`,
        payload: worldResult(secondProvider.id, '0x0101'),
      }),
      409,
      'WORLD_PROOF_REPLAYED',
    );
    expect(secondRepository.getProvider(secondProvider.id)).toEqual(
      secondProvider,
    );
  });

  it('canonicalizes equivalent values across default repository instances', async () => {
    const firstRepository = new InMemoryRegistryRepository();
    const secondRepository = new InMemoryRegistryRepository();
    const first = setup(fakeWorld(), firstRepository);
    const second = setup(fakeWorld(), secondRepository);
    const firstProvider = provider('provider_process_canonical_one');
    const secondProvider = provider('provider_process_canonical_two');
    firstRepository.createProvider(firstProvider);
    secondRepository.createProvider(secondProvider);

    expect(
      (
        await first.app.inject({
          method: 'POST',
          url: `/api/providers/${firstProvider.id}/verification/world`,
          payload: worldResult(firstProvider.id, '0x000A02'),
        })
      ).statusCode,
    ).toBe(200);
    expectError(
      await second.app.inject({
        method: 'POST',
        url: `/api/providers/${secondProvider.id}/verification/world`,
        payload: worldResult(secondProvider.id, '0x0a02'),
      }),
      409,
      'WORLD_PROOF_REPLAYED',
    );
  });

  it('allows only one concurrent commit across separate default apps', async () => {
    const world = fakeWorld();
    let releaseVerification: () => void = () => undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    world.verify = vi.fn(async (_providerId, result) => {
      await verificationGate;
      return canonicalizeWorldFieldElement(result.responses[0].nullifier);
    });
    const firstRepository = new InMemoryRegistryRepository();
    const secondRepository = new InMemoryRegistryRepository();
    const first = setup(world, firstRepository);
    const second = setup(world, secondRepository);
    const firstProvider = provider('provider_process_concurrent_one');
    const secondProvider = provider('provider_process_concurrent_two');
    firstRepository.createProvider(firstProvider);
    secondRepository.createProvider(secondProvider);

    const pending = [
      first.app.inject({
        method: 'POST',
        url: `/api/providers/${firstProvider.id}/verification/world`,
        payload: worldResult(firstProvider.id, '0x0A03'),
      }),
      second.app.inject({
        method: 'POST',
        url: `/api/providers/${secondProvider.id}/verification/world`,
        payload: worldResult(secondProvider.id, '0x0A03'),
      }),
    ];
    await vi.waitFor(() => expect(world.verify).toHaveBeenCalledTimes(2));
    releaseVerification();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const providerStatuses = [
      firstRepository.getProvider(firstProvider.id)?.verification.status,
      secondRepository.getProvider(secondProvider.id)?.verification.status,
    ].sort();
    expect(providerStatuses).toEqual(['UNVERIFIED', 'VERIFIED']);
  });

  it('rolls back both provider state and replay claim after a repository failure', async () => {
    class FailingRepository extends InMemoryRegistryRepository {
      protected override storeWorldVerifiedProvider(
        providerId: Identifier,
        updated: Provider,
      ): void {
        super.storeWorldVerifiedProvider(providerId, updated);
        throw new Error('private-test-marker');
      }
    }

    const replayStore = new InMemoryWorldReplayStore();
    const failingRepository = new FailingRepository(replayStore);
    const recoveryRepository = new InMemoryRegistryRepository(replayStore);
    const failing = setup(fakeWorld(), failingRepository);
    const recovery = setup(fakeWorld(), recoveryRepository);
    const original = provider('provider_commit_failure');
    const retry = provider('provider_commit_retry');
    failingRepository.createProvider(original);
    recoveryRepository.createProvider(retry);

    expectError(
      await failing.app.inject({
        method: 'POST',
        url: `/api/providers/${original.id}/verification/world`,
        payload: worldResult(original.id, '0x0A04'),
      }),
      500,
      'INTERNAL_ERROR',
    );
    expect(failingRepository.getProvider(original.id)).toEqual(original);
    expect(
      (
        await recovery.app.inject({
          method: 'POST',
          url: `/api/providers/${retry.id}/verification/world`,
          payload: worldResult(retry.id, '0x0A04'),
        })
      ).statusCode,
    ).toBe(200);
    expect(recoveryRepository.getProvider(retry.id)?.verification.status).toBe(
      'VERIFIED',
    );
  });
});

describe('failure isolation and activation integration', () => {
  it('keeps provider and replay state unchanged after the current operational verification exception', async () => {
    const originalProvider = provider('provider_operational_exception');
    const result = worldResult(originalProvider.id, '0x0A05');
    let returnOperationalError = true;
    const fetch = vi.fn(async () => {
      const body = returnOperationalError
        ? {
            success: false,
            code: 'all_verifications_failed',
            detail: 'upstream-test-marker',
            results: [
              {
                identifier: 'selfie',
                success: false,
                code: 'verification_error',
                detail: 'proof-test-marker',
              },
            ],
          }
        : {
            success: true,
            protocol_version: '3.0',
            results: [
              {
                identifier: 'selfie',
                success: true,
                nullifier: result.responses[0].nullifier,
              },
            ],
            action,
            nullifier: result.responses[0].nullifier,
            created_at: initialTime,
            environment,
            message: 'Verified',
          };
      return new Response(JSON.stringify(body), {
        status: returnOperationalError ? 400 : 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const worldConfiguration: WorldConfiguration = {
      appId: 'app_sandbox_00000000000000000000000000000000',
      rpId: 'rp_00000000000000000000000000000000',
      signingKey: '66'.repeat(32),
      action,
      idkitEnvironment: environment,
      freshnessSeconds: 60,
    };
    const repository = new InMemoryRegistryRepository(
      new InMemoryWorldReplayStore(),
    );
    const { app } = setup(
      createWorldVerificationClient(worldConfiguration, { fetch }),
      repository,
    );
    repository.createProvider(originalProvider);

    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/providers/${originalProvider.id}/verification/world`,
        payload: result,
      }),
      503,
      'WORLD_VERIFICATION_UNAVAILABLE',
    );
    expect(repository.getProvider(originalProvider.id)).toEqual(
      originalProvider,
    );

    returnOperationalError = false;
    const retry = await app.inject({
      method: 'POST',
      url: `/api/providers/${originalProvider.id}/verification/world`,
      payload: result,
    });
    expect(retry.statusCode).toBe(200);
    expect(
      repository.getProvider(originalProvider.id)?.verification.status,
    ).toBe('VERIFIED');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['invalid_proof', '0x0A06'],
    ['invalid_merkle_root', '0x0A07'],
    ['root_too_old', '0x0A08'],
  ] as const)(
    'keeps state and replay available after a direct %s envelope',
    async (code, nullifier) => {
      const originalProvider = provider(`provider_direct_${code}`);
      const result = worldResult(originalProvider.id, nullifier);
      let returnDirectEnvelope = true;
      const fetch = vi.fn(async () => {
        const body = returnDirectEnvelope
          ? {
              success: false,
              code,
              detail: 'upstream-test-marker',
            }
          : {
              success: true,
              protocol_version: '3.0',
              results: [
                {
                  identifier: 'selfie',
                  success: true,
                  nullifier: result.responses[0].nullifier,
                },
              ],
              action,
              nullifier: result.responses[0].nullifier,
              created_at: initialTime,
              environment,
              message: 'Verified',
            };
        return new Response(JSON.stringify(body), {
          status: returnDirectEnvelope ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const worldConfiguration: WorldConfiguration = {
        appId: 'app_sandbox_00000000000000000000000000000000',
        rpId: 'rp_00000000000000000000000000000000',
        signingKey: '77'.repeat(32),
        action,
        idkitEnvironment: environment,
        freshnessSeconds: 60,
      };
      const repository = new InMemoryRegistryRepository(
        new InMemoryWorldReplayStore(),
      );
      const { app } = setup(
        createWorldVerificationClient(worldConfiguration, { fetch }),
        repository,
      );
      repository.createProvider(originalProvider);

      const failure = await app.inject({
        method: 'POST',
        url: `/api/providers/${originalProvider.id}/verification/world`,
        payload: result,
      });
      expectError(failure, 503, 'WORLD_VERIFICATION_UNAVAILABLE');
      expect(failure.body).not.toContain(code);
      expect(repository.getProvider(originalProvider.id)).toEqual(
        originalProvider,
      );

      returnDirectEnvelope = false;
      const retry = await app.inject({
        method: 'POST',
        url: `/api/providers/${originalProvider.id}/verification/world`,
        payload: result,
      });
      expect(retry.statusCode).toBe(200);
      expect(
        repository.getProvider(originalProvider.id)?.verification.status,
      ).toBe('VERIFIED');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['WORLD_PROOF_INVALID', 400],
    ['WORLD_VERIFICATION_UNAVAILABLE', 503],
  ] as const)('does not mutate state on %s', async (code, status) => {
    const world = fakeWorld();
    world.verify = vi.fn(async () => {
      throw new WorldVerificationFailure(code);
    });
    const { app, repository } = setup(world);
    const originalProvider = provider(`provider_${code.toLowerCase()}`);
    const originalService = draftService(originalProvider.id);
    repository.createProvider(originalProvider);
    repository.createService(originalService);
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/providers/${originalProvider.id}/verification/world`,
        payload: worldResult(originalProvider.id),
      }),
      status,
      code,
    );
    expect(repository.getProvider(originalProvider.id)).toEqual(
      originalProvider,
    );
    expect(repository.getService(originalService.id)).toEqual(originalService);
  });

  it('blocks activation before verification and permits it after verification', async () => {
    const { app, repository } = setup();
    const originalProvider = provider('provider_activation');
    const service = draftService(originalProvider.id);
    repository.createProvider(originalProvider);
    repository.createService(service);
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/services/${service.id}/activate`,
        payload: {},
      }),
      403,
      'PROVIDER_VERIFICATION_REQUIRED',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/providers/${originalProvider.id}/verification/world`,
          payload: worldResult(originalProvider.id),
        })
      ).statusCode,
    ).toBe(200);
    const activated = await app.inject({
      method: 'POST',
      url: `/api/services/${service.id}/activate`,
      payload: {},
    });
    expect(activated.statusCode).toBe(200);
    expect(ServiceListingSchema.parse(activated.json()).status).toBe('ACTIVE');
  });

  it('treats the exact verification expiration as blocked', async () => {
    const { app, repository, clock } = setup(fakeWorld(60));
    const originalProvider = provider('provider_expiration');
    const service = draftService(originalProvider.id);
    repository.createProvider(originalProvider);
    repository.createService(service);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/providers/${originalProvider.id}/verification/world`,
          payload: worldResult(originalProvider.id),
        })
      ).statusCode,
    ).toBe(200);
    clock.now = '2026-09-10T12:01:00.000Z';
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/services/${service.id}/activate`,
        payload: {},
      }),
      403,
      'PROVIDER_VERIFICATION_REQUIRED',
    );
    expect(repository.getService(service.id)).toEqual(service);
  });

  it.each([
    {
      url: '/api/providers/provider_boundary/verification/world/request?rp_id=client',
      payload: {},
    },
    {
      url: '/api/providers/provider_boundary/verification/world?environment=production',
      payload: worldResult('provider_boundary'),
    },
    {
      url: '/api/providers/bad%20id/verification/world/request',
      payload: {},
    },
    {
      url: '/api/providers/bad%20id/verification/world',
      payload: worldResult('provider_boundary'),
    },
  ])('rejects path/query boundary $url before World work', async (request) => {
    const world = fakeWorld();
    const createRequest = vi.spyOn(world, 'createRequest');
    const verify = vi.spyOn(world, 'verify');
    const { app, repository } = setup(world);
    repository.createProvider(provider('provider_boundary'));
    expectError(
      await app.inject({ method: 'POST', ...request }),
      400,
      'VALIDATION_ERROR',
    );
    expect(createRequest).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects missing bodies on both World routes', async () => {
    const { app, repository } = setup();
    repository.createProvider(provider('provider_body'));
    for (const suffix of ['request', '']) {
      const separator = suffix === '' ? '' : `/${suffix}`;
      expectError(
        await app.inject({
          method: 'POST',
          url: `/api/providers/provider_body/verification/world${separator}`,
        }),
        400,
        'VALIDATION_ERROR',
      );
    }
  });
});
