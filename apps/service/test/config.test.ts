import { describe, expect, it } from 'vitest';
import { loadServiceConfig, ServiceConfigurationError } from '../src/config.js';

const validEnvironment = {
  TRIAGE_SERVICE_HOST: '127.0.0.1',
  TRIAGE_SERVICE_PORT: '3002',
  TRIAGE_SERVICE_ENDPOINT: 'https://triage.example.test/v1/triage',
  X402_RECEIVER_ACCOUNT_ID: '0.0.123456',
  X402_PRICE_TINYBAR: '1000000',
  BLOCKY402_FACILITATOR_URL: 'https://api.testnet.blocky402.com',
  TRIAGE_MODEL_PROVIDER: 'gemini',
  TRIAGE_MODEL: 'gemini-3.8-flash',
  GEMINI_API_KEY: 'fictional-placeholder',
};

const fictionalAuthorizationKey =
  'AQ.fictional:auth/key+with=punctuation!2026_demo-keys';
const fictionalConventionalGoogleKey = 'AIzaSyFictionalGoogleApiKey_1234567890';

describe('service configuration', () => {
  it('loads valid configuration without converting payment values', () => {
    const config = loadServiceConfig(validEnvironment);

    expect(config.priceTinybar).toBe('1000000');
    expect(typeof config.priceTinybar).toBe('string');
    expect(config.receiverAccountId).toBe('0.0.123456');
    expect(config.modelProvider).toBe('gemini');
    expect(config.model).toBe('gemini-3.8-flash');
    expect(config.geminiApiKey).toBe('fictional-placeholder');
  });

  it('has no OpenAI runtime requirement', () => {
    expect(
      loadServiceConfig({
        ...validEnvironment,
        OPENAI_API_KEY: undefined,
      }).modelProvider,
    ).toBe('gemini');
  });

  it.each([
    ['opaque authorization key', fictionalAuthorizationKey],
    ['conventional Google key', fictionalConventionalGoogleKey],
  ])('accepts a fictional %s', (_description, geminiApiKey) => {
    expect(fictionalAuthorizationKey).toHaveLength(53);
    expect(
      loadServiceConfig({
        ...validEnvironment,
        GEMINI_API_KEY: geminiApiKey,
      }).geminiApiKey,
    ).toBe(geminiApiKey);
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
    ['TRIAGE_MODEL_PROVIDER', 'openai'],
    ['TRIAGE_MODEL', '../untrusted-model'],
    ['TRIAGE_SERVICE_PORT', '70000'],
    ['TRIAGE_SERVICE_ENDPOINT', 'https://example.test/wrong'],
    ['BLOCKY402_FACILITATOR_URL', 'file:///tmp/facilitator'],
  ])('rejects invalid %s without exposing its value', (name, value) => {
    expect(() =>
      loadServiceConfig({ ...validEnvironment, [name]: value }),
    ).toThrow('Invalid protected service configuration.');
  });

  it.each([
    ['empty', ''],
    ['too short', 'too-short'],
    ['too long', 'x'.repeat(513)],
    ['leading whitespace', ' fictional-valid-key'],
    ['trailing whitespace', 'fictional-valid-key '],
    ['internal space', 'fictional key with space'],
    ['internal tab', 'fictional-key\twith-tab'],
    ['CRLF header injection', 'fictional-key\r\nx-extra-header: injected'],
    ['NUL control character', 'fictional-key\0with-nul'],
    ['other control character', 'fictional-key\u001fwith-control'],
    ['DEL character', 'fictional-key\u007fwith-del'],
    ['non-ASCII character', 'fictional-key-with-é'],
  ])('rejects a fictional Gemini key with %s', (_description, geminiApiKey) => {
    expect(() =>
      loadServiceConfig({
        ...validEnvironment,
        GEMINI_API_KEY: geminiApiKey,
      }),
    ).toThrow('Invalid protected service configuration.');
  });

  it('never includes a supplied Gemini key in configuration errors', () => {
    const fictionalSecret = `fictional-sensitive-key-${'x'.repeat(512)}`;
    let capturedError: unknown;

    try {
      loadServiceConfig({
        ...validEnvironment,
        GEMINI_API_KEY: fictionalSecret,
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(ServiceConfigurationError);
    expect(String(capturedError)).not.toContain(fictionalSecret);
    if (capturedError instanceof Error) {
      expect(capturedError.message).toBe(
        'Invalid protected service configuration.',
      );
      expect(capturedError.stack ?? '').not.toContain(fictionalSecret);
    }
  });

  it('fails closed without a Gemini key even if an OpenAI key is present', () => {
    expect(() =>
      loadServiceConfig({
        ...validEnvironment,
        GEMINI_API_KEY: undefined,
        OPENAI_API_KEY: 'SENSITIVE_UNUSED_OPENAI_KEY',
      }),
    ).toThrow('Invalid protected service configuration.');
  });
});
