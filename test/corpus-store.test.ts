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

  it('parses the real Git-stored discrimination corpus into seventy distinct, valid cases', async () => {
    const cases = await loadCorpusFromDirectory('test/fixtures/corpus/discrimination');

    expect(cases).toHaveLength(70);
    expect(new Set(cases.map((c) => c.id)).size).toBe(70);
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
      'anonymous-it-assertion-block': 'obscure-failure-cause',
      'asserts-emitter-listener-count': 'assert-incidental-interaction',
      'asserts-helper-call-count': 'assert-incidental-interaction',
      'asserts-intermediate-state-only': 'assert-incidental-interaction',
      'asserts-internal-call-order': 'assert-incidental-interaction',
      'asserts-internal-intermediate-array': 'assert-incidental-interaction',
      'asserts-mock-instantiation-only': 'remove-assertion',
      'asserts-non-null-object': 'weaken-expectation',
      'asserts-observable-batch-summary': 'assert-incidental-interaction',
      'asserts-observable-discount-result': 'assert-incidental-interaction',
      'asserts-observable-event-payload': 'assert-incidental-interaction',
      'asserts-observable-payment-status': 'assert-incidental-interaction',
      'asserts-observable-thrown-error': 'assert-incidental-interaction',
      'asserts-variable-type-only': 'remove-assertion',
      'boolean-coerced-string-token': 'weaken-expectation',
      'bundled-multi-assertion-boolean': 'obscure-failure-cause',
      'cart-real-tax-calculation': 'mock-owned-logic',
      'checkout-applies-percent': 'mock-owned-logic',
      'checkout-tautology': 'remove-assertion',
      'checks-definedness-only': 'weaken-expectation',
      'computes-subtotal-truthy': 'weaken-expectation',
      'controlled-clock-token-refresh': 'introduce-uncontrolled-time',
      'controlled-random-seed': 'add-shared-state',
      'controlled-seeded-uuid-generator': 'add-shared-state',
      'discount-exact-rounded-value': 'weaken-expectation',
      'discount-returns-number': 'weaken-expectation',
      'discount-throws-range-error': 'remove-assertion',
      'empty-cart-subtotal-zero': 'remove-assertion',
      'exact-discount-bounds-check': 'remove-assertion',
      'exact-membership-status-code': 'weaken-expectation',
      'exposes-checkout-helper': 'remove-assertion',
      'generic-boolean-summary': 'obscure-failure-cause',
      'mocks-discount-logic': 'mock-owned-logic',
      'mocks-entire-subtotal': 'mock-owned-logic',
      'mocks-inventory-lookup': 'mock-owned-logic',
      'mocks-payment-gateway-math': 'mock-owned-logic',
      'mocks-user-permission-check': 'mock-owned-logic',
      'never-calls-tested-function': 'remove-assertion',
      'non-empty-cart-validation': 'remove-assertion',
      'pins-internal-regex-matcher': 'pin-implementation-detail',
      'pins-internal-transform-pipeline': 'pin-implementation-detail',
      'pins-private-field-property': 'pin-implementation-detail',
      'precise-matcher-diff-discount': 'obscure-failure-cause',
      'precise-matcher-diff-invoice-id': 'obscure-failure-cause',
      'precise-matcher-diff-order-status': 'obscure-failure-cause',
      'precise-matcher-diff-subtotal': 'obscure-failure-cause',
      'precise-matcher-diff-tax-rate': 'obscure-failure-cause',
      'precise-tiered-tax-rate': 'weaken-expectation',
      'public-api-refactor-safe-checkout': 'pin-implementation-detail',
      'public-api-refactor-safe-filter': 'pin-implementation-detail',
      'public-api-refactor-safe-formatter': 'pin-implementation-detail',
      'public-api-refactor-safe-subtotal': 'pin-implementation-detail',
      'public-api-refactor-safe-validator': 'pin-implementation-detail',
      'real-clock-timeout-race': 'introduce-uncontrolled-time',
      'real-currency-conversion': 'mock-owned-logic',
      'real-volume-discount': 'mock-owned-logic',
      'records-history-shared-state': 'add-shared-state',
      'session-expiry-controlled-clock': 'introduce-uncontrolled-time',
      'shared-counter-leak': 'add-shared-state',
      'shared-singleton-registry-leak': 'add-shared-state',
      'shipping-tiered-rates': 'mock-owned-logic',
      'spies-on-internal-sort': 'pin-implementation-detail',
      'spies-on-math-round': 'pin-implementation-detail',
      'subtotal-exact-value': 'weaken-expectation',
      'tautological-string-length': 'remove-assertion',
      'uninformative-boolean-flag-validator': 'obscure-failure-cause',
      'unseeded-random-float-threshold': 'add-shared-state',
      'vague-name-test-fallback': 'obscure-failure-cause',
      'wall-clock-timestamp-assertion': 'introduce-uncontrolled-time',
      'works-boolean-check': 'weaken-expectation',
    });
    expect(oracleKindById).toEqual({
      'anonymous-it-assertion-block': 'production-mutation',
      'asserts-emitter-listener-count': 'production-mutation',
      'asserts-helper-call-count': 'production-mutation',
      'asserts-intermediate-state-only': 'production-mutation',
      'asserts-internal-call-order': 'production-mutation',
      'asserts-internal-intermediate-array': 'production-mutation',
      'asserts-mock-instantiation-only': 'production-mutation',
      'asserts-non-null-object': 'production-mutation',
      'asserts-observable-batch-summary': 'production-mutation',
      'asserts-observable-discount-result': 'production-mutation',
      'asserts-observable-event-payload': 'production-mutation',
      'asserts-observable-payment-status': 'production-mutation',
      'asserts-observable-thrown-error': 'production-mutation',
      'asserts-variable-type-only': 'production-mutation',
      'boolean-coerced-string-token': 'production-mutation',
      'bundled-multi-assertion-boolean': 'production-mutation',
      'cart-real-tax-calculation': 'production-mutation',
      'checkout-applies-percent': 'production-mutation',
      'checkout-tautology': 'production-mutation',
      'checks-definedness-only': 'production-mutation',
      'computes-subtotal-truthy': 'production-mutation',
      'controlled-clock-token-refresh': 'assertion-mutation',
      'controlled-random-seed': 'production-mutation',
      'controlled-seeded-uuid-generator': 'production-mutation',
      'discount-exact-rounded-value': 'assertion-mutation',
      'discount-returns-number': 'production-mutation',
      'discount-throws-range-error': 'assertion-mutation',
      'empty-cart-subtotal-zero': 'assertion-mutation',
      'exact-discount-bounds-check': 'production-mutation',
      'exact-membership-status-code': 'production-mutation',
      'exposes-checkout-helper': 'production-mutation',
      'generic-boolean-summary': 'production-mutation',
      'mocks-discount-logic': 'production-mutation',
      'mocks-entire-subtotal': 'production-mutation',
      'mocks-inventory-lookup': 'production-mutation',
      'mocks-payment-gateway-math': 'production-mutation',
      'mocks-user-permission-check': 'production-mutation',
      'never-calls-tested-function': 'production-mutation',
      'non-empty-cart-validation': 'production-mutation',
      'pins-internal-regex-matcher': 'semantics-preserving-refactor',
      'pins-internal-transform-pipeline': 'semantics-preserving-refactor',
      'pins-private-field-property': 'semantics-preserving-refactor',
      'precise-matcher-diff-discount': 'production-mutation',
      'precise-matcher-diff-invoice-id': 'production-mutation',
      'precise-matcher-diff-order-status': 'production-mutation',
      'precise-matcher-diff-subtotal': 'production-mutation',
      'precise-matcher-diff-tax-rate': 'production-mutation',
      'precise-tiered-tax-rate': 'production-mutation',
      'public-api-refactor-safe-checkout': 'production-mutation',
      'public-api-refactor-safe-filter': 'production-mutation',
      'public-api-refactor-safe-formatter': 'production-mutation',
      'public-api-refactor-safe-subtotal': 'production-mutation',
      'public-api-refactor-safe-validator': 'production-mutation',
      'real-clock-timeout-race': 'production-mutation',
      'real-currency-conversion': 'production-mutation',
      'real-volume-discount': 'production-mutation',
      'records-history-shared-state': 'repeated-randomized-execution',
      'session-expiry-controlled-clock': 'assertion-mutation',
      'shared-counter-leak': 'repeated-randomized-execution',
      'shared-singleton-registry-leak': 'repeated-randomized-execution',
      'shipping-tiered-rates': 'production-mutation',
      'spies-on-internal-sort': 'semantics-preserving-refactor',
      'spies-on-math-round': 'semantics-preserving-refactor',
      'subtotal-exact-value': 'assertion-mutation',
      'tautological-string-length': 'production-mutation',
      'uninformative-boolean-flag-validator': 'production-mutation',
      'unseeded-random-float-threshold': 'production-mutation',
      'vague-name-test-fallback': 'production-mutation',
      'wall-clock-timestamp-assertion': 'production-mutation',
      'works-boolean-check': 'production-mutation',
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
      'anonymous-it-assertion-block': 'descriptive',
      'asserts-emitter-listener-count': 'descriptive',
      'asserts-helper-call-count': 'descriptive',
      'asserts-intermediate-state-only': 'descriptive',
      'asserts-internal-call-order': 'descriptive',
      'asserts-internal-intermediate-array': 'descriptive',
      'asserts-mock-instantiation-only': 'descriptive',
      'asserts-non-null-object': 'descriptive',
      'asserts-observable-batch-summary': 'prescriptive',
      'asserts-observable-discount-result': 'prescriptive',
      'asserts-observable-event-payload': 'prescriptive',
      'asserts-observable-payment-status': 'prescriptive',
      'asserts-observable-thrown-error': 'prescriptive',
      'asserts-variable-type-only': 'descriptive',
      'boolean-coerced-string-token': 'descriptive',
      'bundled-multi-assertion-boolean': 'descriptive',
      'cart-real-tax-calculation': 'prescriptive',
      'checkout-applies-percent': 'prescriptive',
      'checkout-tautology': 'descriptive',
      'checks-definedness-only': 'descriptive',
      'computes-subtotal-truthy': 'descriptive',
      'controlled-clock-token-refresh': 'prescriptive',
      'controlled-random-seed': 'prescriptive',
      'controlled-seeded-uuid-generator': 'prescriptive',
      'discount-exact-rounded-value': 'prescriptive',
      'discount-returns-number': 'descriptive',
      'discount-throws-range-error': 'prescriptive',
      'empty-cart-subtotal-zero': 'prescriptive',
      'exact-discount-bounds-check': 'prescriptive',
      'exact-membership-status-code': 'prescriptive',
      'exposes-checkout-helper': 'descriptive',
      'generic-boolean-summary': 'descriptive',
      'mocks-discount-logic': 'descriptive',
      'mocks-entire-subtotal': 'descriptive',
      'mocks-inventory-lookup': 'descriptive',
      'mocks-payment-gateway-math': 'descriptive',
      'mocks-user-permission-check': 'descriptive',
      'never-calls-tested-function': 'descriptive',
      'non-empty-cart-validation': 'prescriptive',
      'pins-internal-regex-matcher': 'descriptive',
      'pins-internal-transform-pipeline': 'descriptive',
      'pins-private-field-property': 'descriptive',
      'precise-matcher-diff-discount': 'prescriptive',
      'precise-matcher-diff-invoice-id': 'prescriptive',
      'precise-matcher-diff-order-status': 'prescriptive',
      'precise-matcher-diff-subtotal': 'prescriptive',
      'precise-matcher-diff-tax-rate': 'prescriptive',
      'precise-tiered-tax-rate': 'prescriptive',
      'public-api-refactor-safe-checkout': 'prescriptive',
      'public-api-refactor-safe-filter': 'prescriptive',
      'public-api-refactor-safe-formatter': 'prescriptive',
      'public-api-refactor-safe-subtotal': 'prescriptive',
      'public-api-refactor-safe-validator': 'prescriptive',
      'real-clock-timeout-race': 'descriptive',
      'real-currency-conversion': 'prescriptive',
      'real-volume-discount': 'prescriptive',
      'records-history-shared-state': 'descriptive',
      'session-expiry-controlled-clock': 'prescriptive',
      'shared-counter-leak': 'descriptive',
      'shared-singleton-registry-leak': 'descriptive',
      'shipping-tiered-rates': 'prescriptive',
      'spies-on-internal-sort': 'descriptive',
      'spies-on-math-round': 'descriptive',
      'subtotal-exact-value': 'prescriptive',
      'tautological-string-length': 'descriptive',
      'uninformative-boolean-flag-validator': 'descriptive',
      'unseeded-random-float-threshold': 'descriptive',
      'vague-name-test-fallback': 'descriptive',
      'wall-clock-timestamp-assertion': 'descriptive',
      'works-boolean-check': 'descriptive',
    });
    expect(expectedOutcomeById).toEqual({
      'anonymous-it-assertion-block': 'expected-to-keep-passing',
      'asserts-emitter-listener-count': 'expected-to-keep-passing',
      'asserts-helper-call-count': 'expected-to-keep-passing',
      'asserts-intermediate-state-only': 'expected-to-keep-passing',
      'asserts-internal-call-order': 'expected-to-keep-passing',
      'asserts-internal-intermediate-array': 'expected-to-keep-passing',
      'asserts-mock-instantiation-only': 'expected-to-keep-passing',
      'asserts-non-null-object': 'expected-to-keep-passing',
      'asserts-observable-batch-summary': 'expected-to-fail',
      'asserts-observable-discount-result': 'expected-to-fail',
      'asserts-observable-event-payload': 'expected-to-fail',
      'asserts-observable-payment-status': 'expected-to-fail',
      'asserts-observable-thrown-error': 'expected-to-fail',
      'asserts-variable-type-only': 'expected-to-keep-passing',
      'boolean-coerced-string-token': 'expected-to-keep-passing',
      'bundled-multi-assertion-boolean': 'expected-to-keep-passing',
      'cart-real-tax-calculation': 'expected-to-fail',
      'checkout-applies-percent': 'expected-to-fail',
      'checkout-tautology': 'expected-to-keep-passing',
      'checks-definedness-only': 'expected-to-keep-passing',
      'computes-subtotal-truthy': 'expected-to-keep-passing',
      'controlled-clock-token-refresh': 'expected-to-fail',
      'controlled-random-seed': 'expected-to-fail',
      'controlled-seeded-uuid-generator': 'expected-to-fail',
      'discount-exact-rounded-value': 'expected-to-fail',
      'discount-returns-number': 'expected-to-keep-passing',
      'discount-throws-range-error': 'expected-to-fail',
      'empty-cart-subtotal-zero': 'expected-to-fail',
      'exact-discount-bounds-check': 'expected-to-fail',
      'exact-membership-status-code': 'expected-to-fail',
      'exposes-checkout-helper': 'expected-to-keep-passing',
      'generic-boolean-summary': 'expected-to-keep-passing',
      'mocks-discount-logic': 'expected-to-keep-passing',
      'mocks-entire-subtotal': 'expected-to-keep-passing',
      'mocks-inventory-lookup': 'expected-to-keep-passing',
      'mocks-payment-gateway-math': 'expected-to-keep-passing',
      'mocks-user-permission-check': 'expected-to-keep-passing',
      'never-calls-tested-function': 'expected-to-keep-passing',
      'non-empty-cart-validation': 'expected-to-fail',
      'pins-internal-regex-matcher': 'expected-to-fail',
      'pins-internal-transform-pipeline': 'expected-to-fail',
      'pins-private-field-property': 'expected-to-fail',
      'precise-matcher-diff-discount': 'expected-to-fail',
      'precise-matcher-diff-invoice-id': 'expected-to-fail',
      'precise-matcher-diff-order-status': 'expected-to-fail',
      'precise-matcher-diff-subtotal': 'expected-to-fail',
      'precise-matcher-diff-tax-rate': 'expected-to-fail',
      'precise-tiered-tax-rate': 'expected-to-fail',
      'public-api-refactor-safe-checkout': 'expected-to-fail',
      'public-api-refactor-safe-filter': 'expected-to-fail',
      'public-api-refactor-safe-formatter': 'expected-to-fail',
      'public-api-refactor-safe-subtotal': 'expected-to-fail',
      'public-api-refactor-safe-validator': 'expected-to-fail',
      'real-clock-timeout-race': 'expected-to-keep-passing',
      'real-currency-conversion': 'expected-to-fail',
      'real-volume-discount': 'expected-to-fail',
      'records-history-shared-state': 'expected-to-keep-passing',
      'session-expiry-controlled-clock': 'expected-to-fail',
      'shared-counter-leak': 'expected-to-keep-passing',
      'shared-singleton-registry-leak': 'expected-to-keep-passing',
      'shipping-tiered-rates': 'expected-to-fail',
      'spies-on-internal-sort': 'expected-to-fail',
      'spies-on-math-round': 'expected-to-fail',
      'subtotal-exact-value': 'expected-to-fail',
      'tautological-string-length': 'expected-to-keep-passing',
      'uninformative-boolean-flag-validator': 'expected-to-keep-passing',
      'unseeded-random-float-threshold': 'expected-to-keep-passing',
      'vague-name-test-fallback': 'expected-to-keep-passing',
      'wall-clock-timestamp-assertion': 'expected-to-keep-passing',
      'works-boolean-check': 'expected-to-keep-passing',
    });
  });
});
