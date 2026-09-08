import { readFileSync, readdirSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { expect, expectTypeOf, it } from 'vitest';
import {
  activeServiceFixture,
  verifiedProviderFixture,
  fixtureReferenceTime,
  type Provider,
  type ServiceListing,
} from '@proofserve/shared';
import Page from '../src/app/page';
import { ServiceCard } from '../src/components/service-card';

const markup = renderToStaticMarkup(<Page />);
const warning =
  'Wireframe uses fictional development/test content. It is not evidence of completed verification or payment.';

it('renders semantic landmarks and links to existing page targets', () => {
  for (const tag of ['header', 'nav', 'main', 'footer']) {
    expect(markup).toMatch(new RegExp(`<${tag}(?: |>)`));
  }
  expect(markup.match(/<h1(?: |>)/g)).toHaveLength(1);
  expect(markup).toContain('Skip to main content');
  expect(markup).toContain('id="main" tabindex="-1"');
  const links = [...markup.matchAll(/href="([^"]+)"/g)];
  expect(links.length).toBeGreaterThan(0);
  for (const [, href] of links) {
    expect(href).toMatch(/^#[a-z-]+$/);
    expect(markup).toContain(`id="${href?.slice(1)}"`);
  }
});

it('renders the shared service and matching provider with shared prop types', () => {
  expectTypeOf<
    Parameters<typeof ServiceCard>[0]['service']
  >().toEqualTypeOf<ServiceListing>();
  expectTypeOf<
    Parameters<typeof ServiceCard>[0]['provider']
  >().toEqualTypeOf<Provider>();
  expect(activeServiceFixture.providerId).toBe(verifiedProviderFixture.id);
  for (const value of [
    activeServiceFixture.name,
    activeServiceFixture.description,
    activeServiceFixture.capability.replaceAll('_', ' ').toLowerCase(),
    activeServiceFixture.paymentRequirements.network,
    verifiedProviderFixture.displayName,
    fixtureReferenceTime,
  ]) {
    expect(markup).toContain(value);
  }
  expect(markup).toContain('0.01 HBAR — fictional example');
  expect(markup).toContain('Service: Active');
  expect(markup).toContain('Liveness verified');
  expect(markup).toContain('fictional reference scenario');
});

it('places the visible warning immediately after the heading and preserves boundaries', () => {
  expect(markup).toContain(`</h1><p class="notice">${warning}</p>`);
  expect(markup).toContain('Fictional development/test service preview');
  expect(markup).toContain('Real integrations are not implemented.');
  expect(markup).toContain('ProofServe — planned Hedera testnet demo');
  expect(markup).toContain(
    'Verification describes recent liveness, not a service-quality guarantee.',
  );
  expect(markup).not.toMatch(
    /trusted|scam-free|globally unique|unique human|bot-proof|bots cannot enter|bots can never enter/i,
  );
  expect(markup).not.toMatch(/<(?:button|form|input)\b/);
});

it('renders supplied props instead of privately copied fixtures', () => {
  const alternate: ServiceListing = {
    ...activeServiceFixture,
    name: 'Another fixture label',
  };
  const rendered = renderToStaticMarkup(
    createElement(ServiceCard, {
      service: alternate,
      provider: verifiedProviderFixture,
    }),
  );
  expect(rendered).toContain(alternate.name);
  expect(rendered).not.toContain(activeServiceFixture.name);
  expect(() =>
    renderToStaticMarkup(
      <ServiceCard
        service={{ ...activeServiceFixture, providerId: 'mismatch' }}
        provider={verifiedProviderFixture}
      />,
    ),
  ).toThrow('Service and provider must match.');
});

it('does not declare private Provider or ServiceListing types', () => {
  const root = new URL('../src/', import.meta.url);
  const sources = readdirSync(root, {
    recursive: true,
    encoding: 'utf8',
  }).filter((file) => /\.tsx?$/.test(file));
  expect(sources.length).toBeGreaterThan(0);
  for (const file of sources) {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(file, root), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const inspect = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        expect(['Provider', 'ServiceListing']).not.toContain(node.name.text);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
});
