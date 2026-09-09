import { describe, expect, it } from 'vitest';
import { loadServiceConfig, ServiceConfigurationError } from '../src/config.js';

const validEnvironment = {
  TRIAGE_SERVICE_HOST: '127.0.0.1',
  TRIAGE_SERVICE_PORT: '3002',
  TRIAGE_SERVICE_ENDPOINT: 'https://triage.example.test/v1/triage',
  X402_RECEIVER_ACCOUNT_ID: '0.0.123456',
  X402_PRICE_TINYBAR: '1000000',
  BLOCKY402_FACILITATOR_URL: 'https://api.testnet.blocky402.com',
  TRIAGE_MODEL_PROVIDER: 'openai',
  TRIAGE_MODEL: 'configured-model',
  OPENAI_API_KEY: 'fictional-test-key',
};

describe('service configuration', () => {
  it('loads valid configuration without converting payment values', () => {
    const config = loadServiceConfig(validEnvironment);

    expect(config.priceTinybar).toBe('1000000');
    expect(typeof config.priceTinybar).toBe('string');
    expect(config.receiverAccountId).toBe('0.0.123456');
    expect(config.modelProvider).toBe('openai');
  });

  it('fails safely when required configuration is missing', () => {
    expect(() => loadServiceConfig({})).toThrow(ServiceConfigurationError);
    expect(() => loadServiceConfig({})).toThrow(
      'Invalid protected service configuration.',
    );
  });

  it.each([
    ['X402_RECEIVER_ACCOUNT_ID', 'not-an-account'],
    ['X402_PRICE_TINYBAR', '1.5'],
    ['X402_PRICE_TINYBAR', '0001'],
    ['TRIAGE_MODEL_PROVIDER', 'fake'],
    ['TRIAGE_SERVICE_PORT', '70000'],
    ['TRIAGE_SERVICE_ENDPOINT', 'https://example.test/wrong'],
    ['BLOCKY402_FACILITATOR_URL', 'file:///tmp/facilitator'],
  ])('rejects invalid %s without exposing its value', (name, value) => {
    expect(() =>
      loadServiceConfig({ ...validEnvironment, [name]: value }),
    ).toThrow('Invalid protected service configuration.');
  });
});
