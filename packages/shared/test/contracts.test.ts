import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as c from '../src/index.js';

const boundaries: [string, z.ZodType, Record<string, unknown>][] = [
  ['Provider', c.ProviderSchema, c.verifiedProviderFixture],
  [
    'VerificationRecord',
    c.VerificationRecordSchema,
    c.verifiedVerificationFixture,
  ],
  ['ServiceListing', c.ServiceListingSchema, c.activeServiceFixture],
  ['AgentTask', c.AgentTaskSchema, c.agentTaskFixture],
  ['AgentRun', c.AgentRunSchema, c.completedAgentRunFixture],
  ['PaymentReceipt', c.PaymentReceiptSchema, c.fictionalPaymentReceiptFixture],
  ['ApiErrorResponse', c.ApiErrorResponseSchema, c.apiErrorFixture],
  ['ApiError', c.ApiErrorSchema, c.apiErrorFixture.error],
  [
    'PaymentRequirements',
    c.PaymentRequirementsSchema,
    c.activeServiceFixture.paymentRequirements,
  ],
  [
    'PaymentPrice',
    c.PaymentPriceSchema,
    { network: 'hedera:testnet', asset: '0.0.0', amountAtomic: '1' },
  ],
  ['PaymentBudget', c.PaymentBudgetSchema, c.agentTaskFixture.budget],
  ['TriageInput', c.TriageInputSchema, c.agentTaskFixture.input],
  [
    'TriageResult',
    c.TriageResultSchema,
    {
      category: 'billing',
      urgency: 'high',
      summary: 'Duplicate charge',
      suggestedAction: 'Review charges',
    },
  ],
  [
    'AgentRunEvent',
    c.AgentRunEventSchema,
    { status: 'CREATED', occurredAt: c.createdAgentRunFixture.createdAt },
  ],
  [
    'CreateProviderRequest',
    c.CreateProviderRequestSchema,
    { displayName: 'Example', payoutAccount: '0.0.123456' },
  ],
  [
    'CreateServiceRequest',
    c.CreateServiceRequestSchema,
    {
      providerId: 'provider_example',
      name: 'Example',
      description: 'Test',
      capability: 'SUPPORT_TICKET_TRIAGE',
      price: { network: 'hedera:testnet', asset: '0.0.0', amountAtomic: '1' },
    },
  ],
  ['ActivateServiceRequest', c.ActivateServiceRequestSchema, {}],
  [
    'ListServicesQuery',
    c.ListServicesQuerySchema,
    { capability: 'SUPPORT_TICKET_TRIAGE' },
  ],
  [
    'DiscoveryService',
    c.DiscoveryServiceSchema,
    { service: c.activeServiceFixture, provider: c.verifiedProviderFixture },
  ],
  ['ListServicesResponse', c.ListServicesResponseSchema, { services: [] }],
  ['ProviderParams', c.ProviderParamsSchema, { id: 'provider_example' }],
  ['ServiceParams', c.ServiceParamsSchema, { id: 'service_example' }],
  ['AgentRunParams', c.AgentRunParamsSchema, { runId: 'run_example' }],
];

describe('public boundary strictness', () => {
  it.each(boundaries)(
    '%s accepts valid data and rejects unexpected fields',
    (_name, schema, value) => {
      expect(schema.safeParse(value).success).toBe(true);
      expect(
        schema.safeParse({ ...value, unexpected: 'not allowed' }).success,
      ).toBe(false);
    },
  );
  it.each(
    boundaries.filter(
      ([name]) =>
        !['ActivateServiceRequest', 'ListServicesQuery'].includes(name),
    ),
  )('%s rejects every missing required field', (_name, schema, value) => {
    for (const key of Object.keys(value)) {
      const incomplete = { ...value };
      delete incomplete[key];
      expect(schema.safeParse(incomplete).success, key).toBe(false);
    }
  });
  it('allows omitted filters but rejects repeated query values', () => {
    expect(c.ListServicesQuerySchema.safeParse({}).success).toBe(true);
    expect(
      c.ListServicesQuerySchema.safeParse({ asset: ['0.0.0', '0.0.0'] })
        .success,
    ).toBe(false);
  });
  it('rejects unexpected nested fields', () => {
    expect(
      c.AgentTaskSchema.safeParse({
        ...c.agentTaskFixture,
        budget: { ...c.agentTaskFixture.budget, privateKey: 'forbidden' },
      }).success,
    ).toBe(false);
    expect(
      c.ServiceListingSchema.safeParse({
        ...c.activeServiceFixture,
        paymentRequirements: {
          ...c.activeServiceFixture.paymentRequirements,
          extra: true,
        },
      }).success,
    ).toBe(false);
    expect(
      c.ApiErrorResponseSchema.safeParse({
        error: { ...c.apiErrorFixture.error, proof: 'forbidden' },
      }).success,
    ).toBe(false);
  });
});

it('validates every exported data fixture', () => {
  const fixtures: Record<string, z.ZodType> = {
    verifiedVerificationFixture: c.VerificationRecordSchema,
    unverifiedVerificationFixture: c.VerificationRecordSchema,
    verifiedProviderFixture: c.ProviderSchema,
    unverifiedProviderFixture: c.ProviderSchema,
    activeServiceFixture: c.ServiceListingSchema,
    draftServiceFixture: c.ServiceListingSchema,
    agentTaskFixture: c.AgentTaskSchema,
    fictionalPaymentReceiptFixture: c.PaymentReceiptSchema,
    createdAgentRunFixture: c.AgentRunSchema,
    completedAgentRunFixture: c.AgentRunSchema,
    apiErrorFixture: c.ApiErrorResponseSchema,
  };
  const exportedFixtures = Object.entries(c).filter(([name]) =>
    name.endsWith('Fixture'),
  );
  expect(exportedFixtures.length).toBe(Object.keys(fixtures).length);
  for (const [name, value] of exportedFixtures) {
    const schema = fixtures[name];
    expect(schema, name).toBeDefined();
    expect(schema?.safeParse(value).success, name).toBe(true);
  }
  expect(c.fixtureNotice).toContain('FICTIONAL');
  expect(c.fictionalPaymentReceiptFixture.transactionId).toContain('FICTIONAL');
});

it.each([
  c.VerificationStatusSchema,
  c.ServiceStatusSchema,
  c.AgentRunStatusSchema,
  c.ServiceCapabilitySchema,
  c.HederaNetworkSchema,
  c.ApiErrorCodeSchema,
])('rejects unknown enum values', (schema) => {
  for (const value of ['unknown', '', 'verified', 1])
    expect(schema.safeParse(value).success).toBe(false);
  for (const value of schema.options)
    expect(schema.safeParse(value).success).toBe(true);
});

it.each([
  1,
  0.05,
  '0.05',
  '-1',
  '1e8',
  '0',
  '00',
  '01',
  '',
  ' 1',
  '1 ',
  '+1',
  '1\n',
  '١',
])(
  'rejects invalid atomic amount %j throughout public payment objects',
  (value) => {
    expect(c.AtomicAmountSchema.safeParse(value).success).toBe(false);
    expect(
      c.PaymentRequirementsSchema.safeParse({
        ...c.activeServiceFixture.paymentRequirements,
        amountAtomic: value,
      }).success,
    ).toBe(false);
    expect(
      c.PaymentBudgetSchema.safeParse({
        ...c.agentTaskFixture.budget,
        maxAmountAtomic: value,
      }).success,
    ).toBe(false);
    expect(
      c.ListServicesQuerySchema.safeParse({ maxAmountAtomic: value }).success,
    ).toBe(false);
  },
);
it.each(['1', '100000000', '900719925474099312345678901234567890'])(
  'preserves positive atomic string %s exactly',
  (value) => {
    expect(c.AtomicAmountSchema.parse(value)).toBe(value);
    expect(
      c.PaymentRequirementsSchema.parse({
        ...c.activeServiceFixture.paymentRequirements,
        amountAtomic: value,
      }).amountAtomic,
    ).toBe(value);
    expect(
      c.PaymentBudgetSchema.parse({
        ...c.agentTaskFixture.budget,
        maxAmountAtomic: value,
      }).maxAmountAtomic,
    ).toBe(value);
  },
);
it.each([
  'not-a-url',
  '/v1/triage',
  'https://',
  'file:///etc/passwd',
  'javascript:alert(1)',
])('rejects invalid service URL %s', (endpoint) => {
  expect(
    c.ServiceListingSchema.safeParse({ ...c.activeServiceFixture, endpoint })
      .success,
  ).toBe(false);
});
it('validates syntax without pretending to enforce an endpoint allowlist', () => {
  expect(
    c.EndpointUrlSchema.safeParse('https://triage.example.test/v1/triage')
      .success,
  ).toBe(true);
  expect(c.EndpointUrlSchema.safeParse('http://127.0.0.1/').success).toBe(true);
});
it.each([
  'yesterday',
  '2026-02-30T10:00:00.000Z',
  '2026-09-06',
  '2026-09-06T10:00:00',
  '2026-09-06T10:00:00.000+02:00',
  '2026-09-06T10:00:00Z',
  '2026-09-06T25:00:00.000Z',
])('rejects invalid/noncanonical timestamp %s', (timestamp) => {
  expect(c.TimestampSchema.safeParse(timestamp).success).toBe(false);
  expect(
    c.VerificationRecordSchema.safeParse({
      ...c.verifiedVerificationFixture,
      verifiedAt: timestamp,
    }).success,
  ).toBe(false);
});
it.each([
  'rawProof',
  'proof',
  'idkitResult',
  'selfie',
  'selfieImage',
  'biometricData',
  'biometrics',
  'privateKey',
  'private_key',
  'secret',
  'nullifier',
])('rejects private verification field %s', (field) => {
  for (const fixture of [
    c.verifiedVerificationFixture,
    c.unverifiedVerificationFixture,
  ]) {
    const verification = { ...fixture, [field]: 'forbidden-test-marker' };
    expect(c.VerificationRecordSchema.safeParse(verification).success).toBe(
      false,
    );
  }
});
it('enforces verification metadata consistency without a hardcoded freshness clock', () => {
  expect(
    c.VerificationRecordSchema.safeParse({
      ...c.verifiedVerificationFixture,
      status: 'EXPIRED',
    }).success,
  ).toBe(true);
  expect(
    c.VerificationRecordSchema.safeParse({
      ...c.verifiedVerificationFixture,
      verifiedAt: null,
    }).success,
  ).toBe(false);
  expect(
    c.VerificationRecordSchema.safeParse({
      ...c.verifiedVerificationFixture,
      expiresAt: c.verifiedVerificationFixture.verifiedAt,
    }).success,
  ).toBe(false);
  expect(
    c.VerificationRecordSchema.safeParse({
      ...c.unverifiedVerificationFixture,
      verifiedAt: '2026-09-06T10:00:00.000Z',
    }).success,
  ).toBe(false);
  expect(
    c.ProviderSchema.safeParse({
      ...c.verifiedProviderFixture,
      id: 'different_provider',
    }).success,
  ).toBe(false);
  expect(
    c.WorldVerificationResponseSchema.safeParse(c.unverifiedVerificationFixture)
      .success,
  ).toBe(false);
});
it('rejects client-controlled service endpoints and verification status', () => {
  expect(
    c.CreateProviderRequestSchema.safeParse({
      displayName: 'Example',
      payoutAccount: '0.0.123456',
      verification: c.verifiedVerificationFixture,
    }).success,
  ).toBe(false);
  expect(
    c.CreateServiceRequestSchema.safeParse({
      providerId: 'provider_example',
      name: 'Example',
      description: 'Test',
      capability: 'SUPPORT_TICKET_TRIAGE',
      price: { network: 'hedera:testnet', asset: '0.0.0', amountAtomic: '1' },
      endpoint: 'https://untrusted.example.test',
    }).success,
  ).toBe(false);
});
it('rejects unsupported payment networks/assets and malformed account IDs', () => {
  expect(
    c.PaymentBudgetSchema.safeParse({
      ...c.agentTaskFixture.budget,
      network: 'hedera:mainnet',
    }).success,
  ).toBe(false);
  expect(
    c.PaymentBudgetSchema.safeParse({
      ...c.agentTaskFixture.budget,
      asset: '0.0.123',
    }).success,
  ).toBe(false);
  for (const account of ['wallet', '0.0.-1', '0.00.1', '0.0.1e8'])
    expect(c.HederaAccountIdSchema.safeParse(account).success).toBe(false);
});
it('requires completed run evidence and matching receipt references', () => {
  for (const field of [
    'selectedServiceId',
    'paymentRequirements',
    'paymentReceipt',
    'result',
  ]) {
    expect(
      c.AgentRunSchema.safeParse({
        ...c.completedAgentRunFixture,
        [field]: null,
      }).success,
      field,
    ).toBe(false);
  }
  expect(
    c.AgentRunSchema.safeParse({
      ...c.createdAgentRunFixture,
      result: c.completedAgentRunFixture.result,
    }).success,
  ).toBe(false);
  expect(
    c.AgentRunSchema.safeParse({
      ...c.completedAgentRunFixture,
      paymentReceipt: {
        ...c.fictionalPaymentReceiptFixture,
        runId: 'another_run',
      },
    }).success,
  ).toBe(false);
  expect(
    c.AgentRunSchema.safeParse({ ...c.createdAgentRunFixture, events: [] })
      .success,
  ).toBe(false);
  expect(
    c.AgentRunSchema.safeParse({
      ...c.createdAgentRunFixture,
      events: [
        { status: 'FAILED', occurredAt: c.createdAgentRunFixture.createdAt },
      ],
    }).success,
  ).toBe(false);
});
it('allows a failed execution to retain a settled receipt', () => {
  const failed = {
    ...c.completedAgentRunFixture,
    status: 'FAILED',
    result: null,
    error: {
      code: 'SERVICE_EXECUTION_FAILED',
      message: 'Service execution failed after payment.',
    },
    events: [
      ...c.completedAgentRunFixture.events.slice(0, -1),
      { status: 'FAILED', occurredAt: c.completedAgentRunFixture.updatedAt },
    ],
  };
  expect(c.AgentRunSchema.safeParse(failed).success).toBe(true);
  expect(c.AgentRunSchema.safeParse({ ...failed, error: null }).success).toBe(
    false,
  );
});
it('rejects mismatched discovery provider references', () => {
  expect(
    c.DiscoveryServiceSchema.safeParse({
      service: c.activeServiceFixture,
      provider: c.unverifiedProviderFixture,
    }).success,
  ).toBe(false);
});

it('parses every documented JSON example through its exported schema', () => {
  const markdown = readFileSync(
    new URL('../../../docs/api-contract.md', import.meta.url),
    'utf8',
  );
  const examples = [
    ...markdown.matchAll(/<!-- schema: (\w+) -->\s*```json\n([\s\S]*?)\n```/g),
  ];
  expect(examples.length).toBeGreaterThanOrEqual(17);
  expect(examples.length).toBe([...markdown.matchAll(/```json\n/g)].length);
  const exports: Record<string, unknown> = c;
  for (const match of examples) {
    const name = match[1];
    const source = match[2];
    if (!name || !source)
      throw new Error('Missing schema annotation or example');
    const schema = exports[name];
    if (
      typeof schema !== 'object' ||
      schema === null ||
      !('safeParse' in schema) ||
      typeof schema.safeParse !== 'function'
    )
      throw new Error(`Unknown schema ${name}`);
    const value: unknown = JSON.parse(source);
    expect(schema.safeParse(value).success, name).toBe(true);
  }
});
