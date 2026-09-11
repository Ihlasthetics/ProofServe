import { expect, it } from 'vitest';
import {
  draftFormData,
  providerFormData,
} from '../src/lib/onboarding-form-data';

it('converts provider FormData using text fields only and trims whitespace', () => {
  const data = new FormData();
  data.set('displayName', '  Operator  ');
  data.set('payoutAccount', ' 0.0.123 ');
  data.set('verification', 'VERIFIED');
  expect(providerFormData(data)).toEqual({
    displayName: 'Operator',
    payoutAccount: '0.0.123',
  });
});
it('preserves large atomic strings and only selects the supported service configuration', () => {
  const data = new FormData();
  data.set('name', ' Triage ');
  data.set('description', ' Support ');
  data.set('amountAtomic', ' 9999999999999999999999999999 ');
  data.set('providerId', 'attacker');
  data.set('endpoint', 'https://evil.example.test');
  expect(draftFormData(data)).toEqual({
    name: 'Triage',
    description: 'Support',
    capability: 'SUPPORT_TICKET_TRIAGE',
    price: {
      network: 'hedera:testnet',
      asset: '0.0.0',
      amountAtomic: '9999999999999999999999999999',
    },
  });
});
it('leaves missing, duplicate and file values invalid instead of stringifying them', () => {
  const data = new FormData();
  data.append('displayName', 'First');
  data.append('displayName', 'Second');
  data.set('payoutAccount', new Blob(['secret']), 'key.txt');
  expect(providerFormData(data)).toEqual({
    displayName: '',
    payoutAccount: '',
  });
  expect(draftFormData(data).name).toBe('');
});
