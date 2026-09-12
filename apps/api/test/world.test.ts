import { hashSignal } from '@worldcoin/idkit-core/hashing';
import {
  WorldVerificationContextResponseSchema,
  WorldVerificationRequestSchema,
  type WorldVerificationRequest,
} from '@proofserve/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeWorldFieldElement,
  createWorldVerificationClient,
  readWorldConfiguration,
  WorldConfigurationError,
  WorldVerificationFailure,
  type WorldConfiguration,
} from '../src/index.js';

const configuration: WorldConfiguration = {
  appId: 'app_sandbox_00000000000000000000000000000000',
  rpId: 'rp_00000000000000000000000000000000',
  signingKey: '11'.repeat(32),
  action: 'proofserve-provider-verification',
  idkitEnvironment: 'sandbox',
  freshnessSeconds: 86_400,
};
const providerId = 'provider_world_test';
const providerSignal = `proofserve:provider:${providerId}`;
const officialIntegrityBundle = {
  version: 1 as const,
  signature_format: 'android_keystore' as const,
  timestamp: 1_789_034_400,
  signature: 'ab'.repeat(64),
  jwt: 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImZpY3Rpb25hbCJ9.eyJwYXNzIjp0cnVlfQ.ZmljdGlvbmFs',
};

function worldResult(
  overrides: Partial<WorldVerificationRequest> = {},
): WorldVerificationRequest {
  return WorldVerificationRequestSchema.parse({
    protocol_version: '3.0',
    nonce: `0x${'22'.repeat(32)}`,
    action: configuration.action,
    responses: [
      {
        identifier: 'selfie',
        signal_hash: hashSignal(providerSignal),
        proof: `0x${'33'.repeat(256)}`,
        merkle_root: `0x${'44'.repeat(32)}`,
        nullifier: '0x0A',
      },
    ],
    user_presence_completed: true,
    environment: configuration.idkitEnvironment,
    ...overrides,
  });
}

function successBody(result: WorldVerificationRequest) {
  return {
    success: true,
    protocol_version: '3.0',
    results: [
      {
        identifier: 'selfie',
        success: true,
        nullifier: result.responses[0].nullifier,
      },
    ],
    action: result.action,
    nullifier: result.responses[0].nullifier,
    created_at: '2026-09-10T12:00:00Z',
    environment: result.environment,
    message: 'Verified',
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('World configuration and RP context', () => {
  it('accepts only the complete server configuration without exposing values in errors', () => {
    const environment: NodeJS.ProcessEnv = {
      WORLD_APP_ID: configuration.appId,
      WORLD_RP_ID: configuration.rpId,
      WORLD_RP_SIGNING_KEY: configuration.signingKey,
      WORLD_ACTION: configuration.action,
      WORLD_ENVIRONMENT: configuration.idkitEnvironment,
      WORLD_VERIFICATION_FRESHNESS_SECONDS: '86400',
    };
    expect(readWorldConfiguration(environment)).toEqual(configuration);

    for (const [name, value] of [
      ['WORLD_APP_ID', 'not-an-app'],
      ['WORLD_RP_ID', 'not-an-rp'],
      ['WORLD_RP_SIGNING_KEY', 'private-test-marker'],
      ['WORLD_ACTION', 'bad action'],
      ['WORLD_ENVIRONMENT', 'development'],
      ['WORLD_VERIFICATION_FRESHNESS_SECONDS', '01'],
      ['WORLD_VERIFICATION_FRESHNESS_SECONDS', '31536001'],
    ] as const) {
      const invalid = { ...environment, [name]: value };
      expect(() => readWorldConfiguration(invalid)).toThrow(
        WorldConfigurationError,
      );
      try {
        readWorldConfiguration(invalid);
      } catch (error) {
        expect(error).toBeInstanceOf(WorldConfigurationError);
        expect((error as Error).message).toBe(
          'Invalid World verification configuration.',
        );
        expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it('signs only the configured action and returns the public widget inputs', () => {
    const sign = vi.fn(() => ({
      sig: `0x${'55'.repeat(65)}`,
      nonce: `0x${'66'.repeat(32)}`,
      createdAt: 1_789_034_400,
      expiresAt: 1_789_034_700,
    }));
    const client = createWorldVerificationClient(configuration, { sign });
    const context = WorldVerificationContextResponseSchema.parse(
      client.createRequest(providerId),
    );
    expect(sign).toHaveBeenCalledExactlyOnceWith({
      signingKeyHex: configuration.signingKey,
      action: configuration.action,
      ttl: 300,
    });
    expect(context).toEqual({
      app_id: configuration.appId,
      action: configuration.action,
      signal: providerSignal,
      environment: configuration.idkitEnvironment,
      rp_context: {
        rp_id: configuration.rpId,
        nonce: `0x${'66'.repeat(32)}`,
        created_at: 1_789_034_400,
        expires_at: 1_789_034_700,
        signature: `0x${'55'.repeat(65)}`,
      },
      allow_legacy_proofs: true,
      require_user_presence: true,
    });
    expect(JSON.stringify(context)).not.toContain(configuration.signingKey);
  });

  it('also supports production as an exact IDKit destination', async () => {
    const production: WorldConfiguration = {
      ...configuration,
      appId: 'app_production_00000000000000000000000000000000',
      idkitEnvironment: 'production',
    };
    const result = worldResult({ environment: 'production' });
    const fetch = vi.fn(async () => jsonResponse(successBody(result)));
    const client = createWorldVerificationClient(production, { fetch });
    await expect(client.verify(providerId, result)).resolves.toBe('10');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when signing fails or produces a malformed public context', () => {
    for (const sign of [
      () => {
        throw new Error('private-test-marker');
      },
      () => ({ sig: 'bad', nonce: 'bad', createdAt: 2, expiresAt: 1 }),
    ]) {
      const client = createWorldVerificationClient(configuration, { sign });
      expect(() => client.createRequest(providerId)).toThrowError(
        expect.objectContaining({ code: 'WORLD_VERIFICATION_UNAVAILABLE' }),
      );
    }
  });
});

describe('World verification transport and response validation', () => {
  it('canonicalizes decimal and hex field-element representations', () => {
    for (const value of ['10', '00010', '0x0a', '0X000A']) {
      expect(canonicalizeWorldFieldElement(value)).toBe('10');
    }
    expect(() =>
      canonicalizeWorldFieldElement((1n << 256n).toString(10)),
    ).toThrow(WorldVerificationFailure);
  });

  it('forwards the complete validated IDKit result unchanged to the fixed RP URL', async () => {
    const result = worldResult({
      action_description: 'Fictional provider verification',
      integrity_bundle: officialIntegrityBundle,
    });
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
      void input;
      void init;
      return jsonResponse(successBody(result));
    });
    const client = createWorldVerificationClient(configuration, { fetch });
    await expect(client.verify(providerId, result)).resolves.toBe('10');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://developer.world.org/api/v4/verify/rp_00000000000000000000000000000000',
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
      redirect: 'error',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual(result);
    expect(
      (JSON.parse(String(init?.body)) as WorldVerificationRequest)
        .integrity_bundle,
    ).toEqual(officialIntegrityBundle);
  });

  it('accepts every field in the current official uniqueness success shape', async () => {
    const result = worldResult();
    const currentOfficialSuccess = successBody(result);
    const client = createWorldVerificationClient(configuration, {
      fetch: async () => jsonResponse(currentOfficialSuccess),
    });
    await expect(client.verify(providerId, result)).resolves.toBe('10');
    expect(currentOfficialSuccess).toEqual({
      success: true,
      protocol_version: '3.0',
      results: [
        {
          identifier: 'selfie',
          success: true,
          nullifier: '0x0A',
        },
      ],
      action: configuration.action,
      nullifier: '0x0A',
      created_at: '2026-09-10T12:00:00Z',
      environment: 'sandbox',
      message: 'Verified',
    });
  });

  it('canonicalizes an authoritative decimal nullifier matching submitted hex', async () => {
    const result = worldResult();
    const body = successBody(result);
    body.results[0] = {
      identifier: 'selfie',
      success: true,
      nullifier: '00010',
    };
    body.nullifier = '10';
    const client = createWorldVerificationClient(configuration, {
      fetch: async () => jsonResponse(body),
    });
    await expect(client.verify(providerId, result)).resolves.toBe('10');
  });

  const invalidBindings: Array<[string, Partial<WorldVerificationRequest>]> = [
    ['wrong action', { action: 'different-action' }],
    ['wrong production environment', { environment: 'production' }],
    ['wrong staging environment', { environment: 'staging' }],
    [
      'wrong provider signal',
      {
        responses: [
          {
            ...worldResult().responses[0],
            signal_hash: hashSignal('proofserve:provider:different-provider'),
          },
        ],
      },
    ],
  ];

  it.each(invalidBindings)(
    'rejects %s before contacting World',
    async (_label, overrides) => {
      const fetch = vi.fn(async () => jsonResponse({}));
      const client = createWorldVerificationClient(configuration, { fetch });
      const result = worldResult(overrides);
      await expect(client.verify(providerId, result)).rejects.toMatchObject({
        code: 'WORLD_PROOF_INVALID',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['invalid proof', 'invalid_proof'],
    ['invalid Merkle root', 'invalid_merkle_root'],
    ['expired Merkle root', 'root_too_old'],
  ])(
    'maps a direct V2-style HTTP 400 %s envelope to unavailable',
    async (_label, code) => {
      const client = createWorldVerificationClient(configuration, {
        fetch: async () =>
          jsonResponse(
            { success: false, code, detail: 'Fictional proof failure.' },
            400,
          ),
      });
      await expect(
        client.verify(providerId, worldResult()),
      ).rejects.toMatchObject({ code: 'WORLD_VERIFICATION_UNAVAILABLE' });
    },
  );

  it.each([
    ['invalid proof', 'invalid_proof'],
    ['invalid Merkle root', 'invalid_merkle_root'],
    ['expired Merkle root', 'root_too_old'],
  ])(
    'maps the current all-verifications-failed %s result to invalid',
    async (_label, code) => {
      const client = createWorldVerificationClient(configuration, {
        fetch: async () =>
          jsonResponse(
            {
              success: false,
              code: 'all_verifications_failed',
              detail: 'All fictional proof verifications failed.',
              results: [
                {
                  identifier: 'selfie',
                  success: false,
                  code,
                  detail: 'Fictional invalid proof material.',
                },
              ],
            },
            400,
          ),
      });
      await expect(
        client.verify(providerId, worldResult()),
      ).rejects.toMatchObject({ code: 'WORLD_PROOF_INVALID' });
    },
  );

  it('maps the current operational verification exception shape to unavailable without leaking it', async () => {
    const result = worldResult();
    const client = createWorldVerificationClient(configuration, {
      fetch: async () =>
        jsonResponse(
          {
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
          },
          400,
        ),
    });
    let thrown: unknown;
    try {
      await client.verify(providerId, result);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(
      new WorldVerificationFailure('WORLD_VERIFICATION_UNAVAILABLE'),
    );
    expect(String(thrown)).not.toMatch(
      /upstream-test-marker|proof-test-marker|verification_error/,
    );
  });

  it.each([
    [
      'an unknown nested code',
      {
        identifier: 'selfie',
        success: false,
        code: 'future_proof_error',
        detail: 'upstream-test-marker',
      },
    ],
    [
      'a missing nested detail',
      {
        identifier: 'selfie',
        success: false,
        code: 'invalid_proof',
      },
    ],
    [
      'an unknown nested field',
      {
        identifier: 'selfie',
        success: false,
        code: 'invalid_proof',
        detail: 'upstream-test-marker',
        secret: 'upstream-test-marker',
      },
    ],
  ])(
    'maps all-verifications-failed with %s to unavailable',
    async (_label, result) => {
      const client = createWorldVerificationClient(configuration, {
        fetch: async () =>
          jsonResponse(
            {
              success: false,
              code: 'all_verifications_failed',
              detail: 'upstream-test-marker',
              results: [result],
            },
            400,
          ),
      });
      await expect(
        client.verify(providerId, worldResult()),
      ).rejects.toMatchObject({ code: 'WORLD_VERIFICATION_UNAVAILABLE' });
    },
  );

  it.each([401, 403, 404, 408, 422, 429, 500, 503])(
    'maps HTTP %i to unavailable regardless of its body',
    async (status) => {
      const client = createWorldVerificationClient(configuration, {
        fetch: async () =>
          jsonResponse(
            {
              success: false,
              code: 'invalid_proof',
              detail: 'upstream-test-marker',
            },
            status,
          ),
      });
      await expect(
        client.verify(providerId, worldResult()),
      ).rejects.toMatchObject({ code: 'WORLD_VERIFICATION_UNAVAILABLE' });
    },
  );

  it.each([
    [
      'an RP configuration failure',
      {
        success: false,
        code: 'app_not_migrated',
        detail: 'upstream-test-marker',
      },
    ],
    [
      'an unknown future code',
      {
        success: false,
        code: 'future_proof_error',
        detail: 'upstream-test-marker',
      },
    ],
    [
      'an undocumented verification-failed code',
      {
        success: false,
        code: 'verification_failed',
        detail: 'upstream-test-marker',
      },
    ],
    ['a malformed error', { success: false, code: 'invalid_proof' }],
    [
      'an error with unexpected members',
      {
        success: false,
        code: 'invalid_proof',
        detail: 'upstream-test-marker',
        secret: 'upstream-test-marker',
      },
    ],
  ])('maps HTTP 400 %s to unavailable', async (_label, body) => {
    const client = createWorldVerificationClient(configuration, {
      fetch: async () => jsonResponse(body, 400),
    });
    await expect(
      client.verify(providerId, worldResult()),
    ).rejects.toMatchObject({ code: 'WORLD_VERIFICATION_UNAVAILABLE' });
  });

  it.each([
    [
      'a recognized failure sent with HTTP 200',
      jsonResponse({
        success: false,
        code: 'invalid_proof',
        detail: 'upstream-test-marker',
      }),
    ],
    [
      'malformed JSON',
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
    [
      'a non-JSON response',
      new Response('upstream-test-marker', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ],
    [
      'a malformed success response',
      jsonResponse({ success: true, results: [], unexpected: true }),
    ],
    [
      'a redirect response',
      new Response(null, {
        status: 302,
        headers: { location: 'https://upstream.example.test' },
      }),
    ],
  ])('maps %s to unavailable', async (_label, response) => {
    const client = createWorldVerificationClient(configuration, {
      fetch: async () => response,
    });
    await expect(
      client.verify(providerId, worldResult()),
    ).rejects.toMatchObject({ code: 'WORLD_VERIFICATION_UNAVAILABLE' });
  });

  it('rejects a duplicate successful protocol version as unavailable', async () => {
    const result = worldResult();
    const encoded = JSON.stringify(successBody(result));
    const duplicateProtocol = encoded.replace(
      '"protocol_version":"3.0"',
      '"protocol_version":"3.0","protocol_version":"3.0"',
    );
    const client = createWorldVerificationClient(configuration, {
      fetch: async () =>
        new Response(duplicateProtocol, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(client.verify(providerId, result)).rejects.toMatchObject({
      code: 'WORLD_VERIFICATION_UNAVAILABLE',
    });
  });

  it.each([
    (({ protocol_version: removed, ...body }) => {
      void removed;
      return body;
    })(successBody(worldResult())),
    {
      ...successBody(worldResult()),
      protocol_version: '4.0',
    },
    {
      ...successBody(worldResult()),
      protocol_version: '5.0',
    },
    {
      ...successBody(worldResult()),
      protocol_version: 3,
    },
    {
      ...successBody(worldResult()),
      action: 'different-action',
    },
    {
      ...successBody(worldResult()),
      environment: 'production',
    },
    {
      ...successBody(worldResult()),
      results: [
        {
          identifier: 'selfie',
          success: true,
          nullifier: '0x0B',
        },
      ],
    },
    {
      ...successBody(worldResult()),
      results: [
        {
          identifier: 'orb',
          success: true,
          nullifier: '0x0A',
        },
      ],
    },
    {
      ...successBody(worldResult()),
      created_at: 'not-a-date',
    },
    {
      ...successBody(worldResult()),
      session_id: 'session_malformed',
    },
  ])('rejects a mismatched successful response %j', async (body) => {
    const client = createWorldVerificationClient(configuration, {
      fetch: async () => jsonResponse(body),
    });
    await expect(
      client.verify(providerId, worldResult()),
    ).rejects.toMatchObject({ code: 'WORLD_VERIFICATION_UNAVAILABLE' });
  });

  it('maps transport exceptions and its bounded timeout to unavailable', async () => {
    const transport = createWorldVerificationClient(configuration, {
      fetch: async () => {
        throw new Error('network-test-marker');
      },
    });
    await expect(
      transport.verify(providerId, worldResult()),
    ).rejects.toMatchObject({ code: 'WORLD_VERIFICATION_UNAVAILABLE' });

    const timeout = createWorldVerificationClient(configuration, {
      timeoutMs: 5,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('timeout-test-marker')),
          );
        }),
    });
    await expect(timeout.verify(providerId, worldResult())).rejects.toEqual(
      new WorldVerificationFailure('WORLD_VERIFICATION_UNAVAILABLE'),
    );
  });

  it('rejects invalid timeout configuration without echoing it', () => {
    expect(() =>
      createWorldVerificationClient(configuration, { timeoutMs: 0 }),
    ).toThrow(WorldConfigurationError);
  });
});
