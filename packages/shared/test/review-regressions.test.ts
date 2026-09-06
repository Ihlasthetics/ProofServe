import { expect, expectTypeOf, it } from 'vitest';
import * as c from '../src/index.js';

const variants = [
  [
    'UNVERIFIED',
    c.UnverifiedVerificationRecordSchema,
    c.unverifiedVerificationFixture,
  ],
  [
    'VERIFIED',
    c.VerifiedVerificationRecordSchema,
    c.verifiedVerificationFixture,
  ],
  [
    'EXPIRED',
    c.ExpiredVerificationRecordSchema,
    { ...c.verifiedVerificationFixture, status: 'EXPIRED' },
  ],
] as const;

it.each(variants)(
  'accepts the strict %s variant and its union representation',
  (_status, schema, record) => {
    expect(schema.safeParse(record).success).toBe(true);
    expect(c.VerificationRecordSchema.safeParse(record).success).toBe(true);
    for (const field of [
      'unexpected',
      'rawProof',
      'idkitResult',
      'selfieImage',
      'biometricData',
      'privateKey',
      'secret',
      'nullifier',
    ]) {
      const privateRecord = { ...record, [field]: 'forbidden-test-marker' };
      expect(schema.safeParse(privateRecord).success, field).toBe(false);
      expect(
        c.VerificationRecordSchema.safeParse(privateRecord).success,
        field,
      ).toBe(false);
    }
  },
);

it.each(['UNVERIFIED', 'EXPIRED'])(
  'rejects %s as a successful World response',
  (status) => {
    const record =
      status === 'UNVERIFIED'
        ? c.unverifiedVerificationFixture
        : { ...c.verifiedVerificationFixture, status };
    expect(c.WorldVerificationResponseSchema.safeParse(record).success).toBe(
      false,
    );
  },
);

it('exports a World response with exactly the VERIFIED status type', () => {
  expectTypeOf<
    c.WorldVerificationResponse['status']
  >().toEqualTypeOf<'VERIFIED'>();
  expectTypeOf<
    c.UnverifiedVerificationRecord['status']
  >().toEqualTypeOf<'UNVERIFIED'>();
  expectTypeOf<
    c.ExpiredVerificationRecord['status']
  >().toEqualTypeOf<'EXPIRED'>();
  expectTypeOf<c.WorldVerificationResponse>().toEqualTypeOf<c.VerifiedVerificationRecord>();
  expect(c.WorldVerificationResponseSchema).toBe(
    c.VerifiedVerificationRecordSchema,
  );
  expect(
    c.WorldVerificationResponseSchema.safeParse(c.verifiedVerificationFixture)
      .success,
  ).toBe(true);
});

it.each([
  c.VerifiedVerificationRecordSchema,
  c.ExpiredVerificationRecordSchema,
])('preserves required ordered verification timestamps', (schema) => {
  const record = {
    ...c.verifiedVerificationFixture,
    status: schema.shape.status.value,
  };
  expect(schema.safeParse({ ...record, verifiedAt: null }).success).toBe(false);
  expect(
    schema.safeParse({ ...record, expiresAt: record.verifiedAt }).success,
  ).toBe(false);
});

it.each([
  ['network', 'hedera:mainnet'],
  ['asset', '0.0.123'],
  ['amountAtomic', '1000001'],
  ['payTo', '0.0.654321'],
])('rejects a receipt with a mismatched %s', (field, value) => {
  const receipt = {
    ...c.fictionalPaymentReceiptFixture,
    paymentRequirements: {
      ...c.fictionalPaymentReceiptFixture.paymentRequirements,
      [field]: value,
    },
  };
  const result = c.AgentRunSchema.safeParse({
    ...c.completedAgentRunFixture,
    paymentReceipt: receipt,
  });
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Mismatched receipt accepted');
  expect(
    result.error.issues.some((issue) => issue.path[0] === 'paymentReceipt'),
  ).toBe(true);
  // Network/asset alternatives are already excluded by the MVP literal schemas.
  if (field === 'amountAtomic' || field === 'payTo') {
    expect(c.PaymentReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(result.error.issues.some((issue) => issue.code === 'custom')).toBe(
      true,
    );
  }
});

it.each(['runId', 'serviceId'])('preserves receipt %s consistency', (field) => {
  expect(
    c.AgentRunSchema.safeParse({
      ...c.completedAgentRunFixture,
      paymentReceipt: {
        ...c.fictionalPaymentReceiptFixture,
        [field]: 'different_reference',
      },
    }).success,
  ).toBe(false);
});

it('requires payment requirements even on a failed run retaining a receipt', () => {
  const failed = {
    ...c.completedAgentRunFixture,
    status: 'FAILED',
    result: null,
    error: {
      code: 'SERVICE_EXECUTION_FAILED',
      message: 'Execution failed after settlement.',
    },
    events: [
      ...c.completedAgentRunFixture.events.slice(0, -1),
      { status: 'FAILED', occurredAt: c.completedAgentRunFixture.updatedAt },
    ],
  };
  expect(c.AgentRunSchema.safeParse(failed).success).toBe(true);
  expect(
    c.AgentRunSchema.safeParse({ ...failed, paymentRequirements: null })
      .success,
  ).toBe(false);
});

it('exports a deterministic clock anchoring fixture timestamps', () => {
  expect(c.TimestampSchema.parse(c.fixtureReferenceTime)).toBe(
    '2026-09-06T10:00:00.000Z',
  );
  expect(c.verifiedVerificationFixture.verifiedAt).toBe(c.fixtureReferenceTime);
  for (const record of [
    c.verifiedProviderFixture,
    c.unverifiedProviderFixture,
    c.activeServiceFixture,
    c.draftServiceFixture,
    c.createdAgentRunFixture,
    c.completedAgentRunFixture,
  ]) {
    expect(record.createdAt).toBe(c.fixtureReferenceTime);
  }
  expect(c.completedAgentRunFixture.events[0]?.occurredAt).toBe(
    c.fixtureReferenceTime,
  );
  expect(
    Date.parse(c.fictionalPaymentReceiptFixture.settledAt) -
      Date.parse(c.fixtureReferenceTime),
  ).toBe(5000);
  expect(
    Date.parse(c.completedAgentRunFixture.updatedAt) -
      Date.parse(c.fixtureReferenceTime),
  ).toBe(7000);
});
