import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCorpusCase, loadCorpusFromDirectory } from '../src/adapters/corpus-store.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-corpus-store-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

function manifest(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    id: 'case-a',
    operators: ['remove-assertion'],
    operatorRole: 'descriptive',
    oracleKind: 'assertion-mutation',
    testEffect: 'The real assertion is removed.',
    productionEffect: 'A production mutation would not be caught.',
    expectedOutcome: 'expected-to-keep-passing',
    testFile: 'test.ts',
    productionFiles: ['production.ts'],
    ...overrides,
  });
}

describe('loadCorpusCase', () => {
  it('reads a manifest and its declared files off disk, byte for byte', async () => {
    const root = await fixture({
      'case.json': manifest(),
      'test.ts': "it('x', () => {});\n",
      'production.ts': 'export const x = 1;\n',
    });

    const result = await loadCorpusCase(root);

    expect(result.id).toBe('case-a');
    expect(result.operator).toBe('remove-assertion');
    expect(result.oracleKind).toBe('assertion-mutation');
    expect(result.baseTest).toEqual({ path: 'test.ts', contents: "it('x', () => {});\n" });
    expect(result.productionSources).toEqual([{ path: 'production.ts', contents: 'export const x = 1;\n' }]);
    expect(result.proofStatus).toBe('unverified');
  });

  it('reads multiple declared production files in the manifest\'s own order', async () => {
    const root = await fixture({
      'case.json': manifest({ productionFiles: ['b.ts', 'a.ts'] }),
      'test.ts': '// test\n',
      'a.ts': '// a\n',
      'b.ts': '// b\n',
    });

    const result = await loadCorpusCase(root);

    expect(result.productionSources.map((source) => source.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('propagates the domain parser\'s rejection of a malformed manifest', async () => {
    const root = await fixture({
      'case.json': manifest({ operators: ['remove-assertion', 'mock-owned-logic'] }),
      'test.ts': '// test\n',
      'production.ts': '// production\n',
    });

    await expect(loadCorpusCase(root)).rejects.toThrow(/exactly one operator/);
  });
});

describe('loadCorpusFromDirectory', () => {
  it('reads every immediate case directory in a fixed, sorted order regardless of creation order', async () => {
    const root = await fixture({
      'zeta/case.json': manifest({ id: 'zeta' }),
      'zeta/test.ts': '// test\n',
      'zeta/production.ts': '// production\n',
      'alpha/case.json': manifest({ id: 'alpha' }),
      'alpha/test.ts': '// test\n',
      'alpha/production.ts': '// production\n',
    });

    const cases = await loadCorpusFromDirectory(root);

    expect(cases.map((c) => c.id)).toEqual(['alpha', 'zeta']);
  });

  it('rejects a case whose manifest id does not match its own directory name', async () => {
    const root = await fixture({
      'case-a/case.json': manifest({ id: 'case-b' }),
      'case-a/test.ts': '// test\n',
      'case-a/production.ts': '// production\n',
    });

    await expect(loadCorpusFromDirectory(root)).rejects.toThrow(/case-a/);
  });

  it('parses the real Git-stored discrimination corpus into thirty-five distinct, valid cases', async () => {
    const cases = await loadCorpusFromDirectory('test/fixtures/corpus/discrimination');

    expect(cases).toHaveLength(35);
    expect(new Set(cases.map((c) => c.id)).size).toBe(35);
    for (const corpusCase of cases) {
      expect(corpusCase.proofStatus).toBe('unverified');
      expect(corpusCase.baseTest.contents.length).toBeGreaterThan(0);
      expect(corpusCase.productionSources.length).toBeGreaterThan(0);
    }
  });

  /**
   * Pins each real case's declared operator AND oracleKind so a copy-paste
   * mistake between two case.json files (or a parser that ignored either
   * field) is detectable. Verified by mutation: temporarily swapping two of
   * these case.json "operators" values on disk turns this exact test RED
   * (see the task report) — nothing here checks it automatically on every
   * run, since a real filesystem mutation is not something a source-only
   * test suite can assert against itself.
   */
  it('parses each real discrimination case with its own declared operator and oracleKind, not another case\'s', async () => {
    const cases = await loadCorpusFromDirectory('test/fixtures/corpus/discrimination');
    const operatorById = Object.fromEntries(cases.map((c) => [c.id, c.operator]));
    const oracleKindById = Object.fromEntries(cases.map((c) => [c.id, c.oracleKind]));

    expect(operatorById).toEqual({
      'exposes-checkout-helper': 'remove-assertion',
      'works-boolean-check': 'weaken-expectation',
      'computes-subtotal-truthy': 'weaken-expectation',
      'discount-returns-number': 'weaken-expectation',
      'checkout-tautology': 'remove-assertion',
      'spies-on-math-round': 'pin-implementation-detail',
      'mocks-discount-logic': 'mock-owned-logic',
      'records-history-shared-state': 'add-shared-state',
      'subtotal-exact-value': 'weaken-expectation',
      'discount-throws-range-error': 'remove-assertion',
      'checkout-applies-percent': 'mock-owned-logic',
      'asserts-helper-call-count': 'assert-incidental-interaction',
      'generic-boolean-summary': 'obscure-failure-cause',
      'session-expiry-controlled-clock': 'introduce-uncontrolled-time',
      'discount-exact-rounded-value': 'weaken-expectation',
      'empty-cart-subtotal-zero': 'remove-assertion',
      'asserts-variable-type-only': 'remove-assertion',
      'cart-real-tax-calculation': 'mock-owned-logic',
      'shipping-tiered-rates': 'mock-owned-logic',
      'mocks-entire-subtotal': 'mock-owned-logic',
      'shared-counter-leak': 'add-shared-state',
      'real-clock-timeout-race': 'introduce-uncontrolled-time',
      'controlled-random-seed': 'add-shared-state',
      'pins-private-field-property': 'pin-implementation-detail',
      'pins-internal-transform-pipeline': 'pin-implementation-detail',
      'public-api-refactor-safe-subtotal': 'pin-implementation-detail',
      'public-api-refactor-safe-checkout': 'pin-implementation-detail',
      'asserts-internal-call-order': 'assert-incidental-interaction',
      'asserts-intermediate-state-only': 'assert-incidental-interaction',
      'asserts-observable-discount-result': 'assert-incidental-interaction',
      'asserts-observable-thrown-error': 'assert-incidental-interaction',
      'vague-name-test-fallback': 'obscure-failure-cause',
      'bundled-multi-assertion-boolean': 'obscure-failure-cause',
      'precise-matcher-diff-discount': 'obscure-failure-cause',
      'precise-matcher-diff-subtotal': 'obscure-failure-cause',
    });
    expect(oracleKindById).toEqual({
      'exposes-checkout-helper': 'production-mutation',
      'works-boolean-check': 'production-mutation',
      'computes-subtotal-truthy': 'production-mutation',
      'discount-returns-number': 'production-mutation',
      'checkout-tautology': 'production-mutation',
      'spies-on-math-round': 'semantics-preserving-refactor',
      'mocks-discount-logic': 'production-mutation',
      'records-history-shared-state': 'repeated-randomized-execution',
      'subtotal-exact-value': 'assertion-mutation',
      'discount-throws-range-error': 'assertion-mutation',
      'checkout-applies-percent': 'production-mutation',
      'asserts-helper-call-count': 'production-mutation',
      'generic-boolean-summary': 'production-mutation',
      'session-expiry-controlled-clock': 'assertion-mutation',
      'discount-exact-rounded-value': 'assertion-mutation',
      'empty-cart-subtotal-zero': 'assertion-mutation',
      'asserts-variable-type-only': 'production-mutation',
      'cart-real-tax-calculation': 'production-mutation',
      'shipping-tiered-rates': 'production-mutation',
      'mocks-entire-subtotal': 'production-mutation',
      'shared-counter-leak': 'repeated-randomized-execution',
      'real-clock-timeout-race': 'production-mutation',
      'controlled-random-seed': 'production-mutation',
      'pins-private-field-property': 'semantics-preserving-refactor',
      'pins-internal-transform-pipeline': 'semantics-preserving-refactor',
      'public-api-refactor-safe-subtotal': 'production-mutation',
      'public-api-refactor-safe-checkout': 'production-mutation',
      'asserts-internal-call-order': 'production-mutation',
      'asserts-intermediate-state-only': 'production-mutation',
      'asserts-observable-discount-result': 'production-mutation',
      'asserts-observable-thrown-error': 'production-mutation',
      'vague-name-test-fallback': 'production-mutation',
      'bundled-multi-assertion-boolean': 'production-mutation',
      'precise-matcher-diff-discount': 'production-mutation',
      'precise-matcher-diff-subtotal': 'production-mutation',
    });
  });

  /**
   * Pins each real case's declared `operatorRole` and `expectedOutcome` —
   * the two fields that turn each case's prose (`testEffect`/
   * `productionEffect`) into a machine-checkable prediction. A future edit
   * that silently flips one (or a parser that stops threading either field
   * through) is caught here rather than absorbed. Verified by mutation: see
   * the task report for the exact flip-and-restore run against a real
   * `case.json` on disk.
   */
  it('parses each real discrimination case with its own declared operatorRole and expectedOutcome, not another case\'s', async () => {
    const cases = await loadCorpusFromDirectory('test/fixtures/corpus/discrimination');
    const operatorRoleById = Object.fromEntries(cases.map((c) => [c.id, c.operatorRole]));
    const expectedOutcomeById = Object.fromEntries(cases.map((c) => [c.id, c.expectedOutcome]));

    expect(operatorRoleById).toEqual({
      'checkout-applies-percent': 'prescriptive',
      'checkout-tautology': 'descriptive',
      'computes-subtotal-truthy': 'descriptive',
      'discount-returns-number': 'descriptive',
      'discount-throws-range-error': 'prescriptive',
      'exposes-checkout-helper': 'descriptive',
      'mocks-discount-logic': 'descriptive',
      'records-history-shared-state': 'descriptive',
      'spies-on-math-round': 'descriptive',
      'subtotal-exact-value': 'prescriptive',
      'works-boolean-check': 'descriptive',
      'asserts-helper-call-count': 'descriptive',
      'generic-boolean-summary': 'descriptive',
      'session-expiry-controlled-clock': 'prescriptive',
      'discount-exact-rounded-value': 'prescriptive',
      'empty-cart-subtotal-zero': 'prescriptive',
      'asserts-variable-type-only': 'descriptive',
      'cart-real-tax-calculation': 'prescriptive',
      'shipping-tiered-rates': 'prescriptive',
      'mocks-entire-subtotal': 'descriptive',
      'shared-counter-leak': 'descriptive',
      'real-clock-timeout-race': 'descriptive',
      'controlled-random-seed': 'prescriptive',
      'pins-private-field-property': 'descriptive',
      'pins-internal-transform-pipeline': 'descriptive',
      'public-api-refactor-safe-subtotal': 'prescriptive',
      'public-api-refactor-safe-checkout': 'prescriptive',
      'asserts-internal-call-order': 'descriptive',
      'asserts-intermediate-state-only': 'descriptive',
      'asserts-observable-discount-result': 'prescriptive',
      'asserts-observable-thrown-error': 'prescriptive',
      'vague-name-test-fallback': 'descriptive',
      'bundled-multi-assertion-boolean': 'descriptive',
      'precise-matcher-diff-discount': 'prescriptive',
      'precise-matcher-diff-subtotal': 'prescriptive',
    });
    expect(expectedOutcomeById).toEqual({
      'checkout-applies-percent': 'expected-to-fail',
      'checkout-tautology': 'expected-to-keep-passing',
      'computes-subtotal-truthy': 'expected-to-keep-passing',
      'discount-returns-number': 'expected-to-keep-passing',
      'discount-throws-range-error': 'expected-to-fail',
      'exposes-checkout-helper': 'expected-to-keep-passing',
      'mocks-discount-logic': 'expected-to-keep-passing',
      'records-history-shared-state': 'expected-to-keep-passing',
      'spies-on-math-round': 'expected-to-fail',
      'subtotal-exact-value': 'expected-to-fail',
      'works-boolean-check': 'expected-to-keep-passing',
      'asserts-helper-call-count': 'expected-to-keep-passing',
      'generic-boolean-summary': 'expected-to-keep-passing',
      'session-expiry-controlled-clock': 'expected-to-fail',
      'discount-exact-rounded-value': 'expected-to-fail',
      'empty-cart-subtotal-zero': 'expected-to-fail',
      'asserts-variable-type-only': 'expected-to-keep-passing',
      'cart-real-tax-calculation': 'expected-to-fail',
      'shipping-tiered-rates': 'expected-to-fail',
      'mocks-entire-subtotal': 'expected-to-keep-passing',
      'shared-counter-leak': 'expected-to-keep-passing',
      'real-clock-timeout-race': 'expected-to-keep-passing',
      'controlled-random-seed': 'expected-to-fail',
      'pins-private-field-property': 'expected-to-fail',
      'pins-internal-transform-pipeline': 'expected-to-fail',
      'public-api-refactor-safe-subtotal': 'expected-to-fail',
      'public-api-refactor-safe-checkout': 'expected-to-fail',
      'asserts-internal-call-order': 'expected-to-keep-passing',
      'asserts-intermediate-state-only': 'expected-to-keep-passing',
      'asserts-observable-discount-result': 'expected-to-fail',
      'asserts-observable-thrown-error': 'expected-to-fail',
      'vague-name-test-fallback': 'expected-to-keep-passing',
      'bundled-multi-assertion-boolean': 'expected-to-keep-passing',
      'precise-matcher-diff-discount': 'expected-to-fail',
      'precise-matcher-diff-subtotal': 'expected-to-fail',
    });
  });
});
