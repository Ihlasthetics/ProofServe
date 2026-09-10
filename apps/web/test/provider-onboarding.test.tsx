import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  activeServiceFixture,
  apiErrorFixture,
  draftServiceFixture,
  fixtureNotice,
  fixtureReferenceTime,
  unverifiedProviderFixture,
  verifiedProviderFixture,
} from '@proofserve/shared';
import Page from '../src/app/page';
import { ProviderOnboarding } from '../src/components/provider-onboarding';

const markup = renderToStaticMarkup(<ProviderOnboarding />);
function snapshot(id: string) {
  const article = markup.match(
    new RegExp(
      `<article[^>]*aria-labelledby="onboarding-${id}"[^>]*>(.*?)</article>`,
    ),
  )?.[1];
  expect(article).toBeDefined();
  return article ?? '';
}

it.each([
  ['draft', 'Draft service'],
  ['unverified', 'Unverified provider'],
  ['blocked', 'Activation blocked'],
  ['pending', 'Verification pending'],
  ['verified', 'Verified provider'],
  ['active', 'Active service'],
  ['error', 'Verification error'],
])(
  'renders the %s state with its own heading and fictional label',
  (id, title) => {
    const article = snapshot(id);
    expect(article).toContain(`<h3 id="onboarding-${id}">${title}</h3>`);
    expect(article).toContain('Fictional onboarding snapshot');
    expect(article).toContain('fictional reference scenario');
  },
);

it('shows the shared draft and unverified provider without claiming eligibility', () => {
  expect(snapshot('draft')).toContain(draftServiceFixture.name);
  expect(snapshot('draft')).toContain('Service: Draft');
  expect(snapshot('draft')).toContain('not discoverable or payable');
  expect(snapshot('unverified')).toContain(
    unverifiedProviderFixture.displayName,
  );
  expect(snapshot('unverified')).toContain(
    'No successful verification is recorded',
  );
});

it('shows the shared activation error and keeps the service draft', () => {
  const blocked = snapshot('blocked');
  expect(blocked).toContain(apiErrorFixture.error.code);
  expect(blocked).toContain(apiErrorFixture.error.message);
  expect(blocked).toContain('Demo activation blocked');
  expect(blocked).toContain('Service: Draft');
  expect(blocked).toContain('No current liveness verification');
  expect(blocked).not.toContain('Service: Active');
});

it.each(['pending', 'error'])(
  '%s never promotes verification or service status',
  (id) => {
    const article = snapshot(id);
    expect(article).toContain(unverifiedProviderFixture.displayName);
    expect(article).toContain('No current liveness verification');
    expect(article).toContain('Service: Draft');
    expect(article).toMatch(/activation stays blocked/i);
    expect(article).not.toMatch(/Liveness verified|Service: Active/);
    expect(article).toContain('presentation only');
  },
);

it('describes pending and error honestly without implying a real attempt', () => {
  expect(snapshot('pending')).toContain('No request is running');
  expect(snapshot('pending')).toContain('will not advance automatically');
  expect(snapshot('error')).toContain('No real World attempt failed');
  expect(snapshot('error')).toContain(
    'In the future live flow, retry verification',
  );
});

it('shows verified and active shared fixtures only as fixed-time examples', () => {
  for (const id of ['verified', 'active']) {
    expect(snapshot(id)).toContain(verifiedProviderFixture.displayName);
    expect(snapshot(id)).toContain('Liveness verified');
    expect(snapshot(id)).toContain('reference time');
  }
  expect(snapshot('verified')).toContain('not evidence of a real World check');
  expect(snapshot('verified')).toContain(
    'verification alone does not activate',
  );
  expect(snapshot('active')).toContain(activeServiceFixture.name);
  expect(snapshot('active')).toContain('Service: Active');
  expect(snapshot('active')).toContain('No activation was performed here');
  expect(markup).toContain(fixtureNotice);
  expect(markup).toContain(`<time dateTime="${fixtureReferenceTime}">`);
  expect(markup).toContain(
    'not a live onboarding session or a real World verification result',
  );
});

it('integrates with I01 navigation using unique, accessible targets and no action controls', () => {
  const page = renderToStaticMarkup(<Page />);
  expect(page).toContain('href="#provider-onboarding"');
  expect(page).toContain(markup);
  const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const [, target] of page.matchAll(/aria-labelledby="([^"]+)"/g)) {
    expect(ids).toContain(target);
  }
  expect(markup).not.toMatch(/<(?:button|form|input)\b/);
});
