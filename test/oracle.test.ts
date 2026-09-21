import { describe, expect, it } from 'vitest';
import { loadCorpusCase } from '../src/adapters/corpus-store.js';
import {
  applyTextTransform,
  buildOraclePlan,
  decideProof,
  duplicateDescribeBlock,
  PRODUCTION_TRANSFORMS,
  TEST_VARIANT_TRANSFORMS,
  type OraclePlan,
  type RunObservation,
} from '../src/domain/oracle.js';
import type { CorpusCase } from '../src/domain/corpus.js';

const CORPUS_ROOT = 'test/fixtures/corpus/discrimination';

async function loadCase(id: string): Promise<CorpusCase> {
  return loadCorpusCase(`${CORPUS_ROOT}/${id}`);
}

function planFor(plan: OraclePlan, label: string) {
  const run = plan.runs.find((candidate) => candidate.label === label);
  if (run === undefined) throw new Error(`No run labeled "${label}" in plan for case "${plan.caseId}"`);
  return run;
}

function fileContents(run: { readonly files: readonly { readonly path: string; readonly contents: string }[] }, path: string): string {
  const file = run.files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`No file "${path}" in run`);
  return file.contents;
}

describe('applyTextTransform', () => {
  it('replaces an anchor that occurs exactly once', () => {
    const result = applyTextTransform('const x = 1;\nconst y = 2;', { id: 'bump-x', anchor: 'const x = 1;', replacement: 'const x = 99;' });
    expect(result).toBe('const x = 99;\nconst y = 2;');
  });

  it('throws when the anchor does not occur', () => {
    expect(() => applyTextTransform('const x = 1;', { id: 'missing', anchor: 'const z = 1;', replacement: 'nope' }))
      .toThrow(/anchor/i);
  });

  it('throws when the anchor occurs more than once', () => {
    expect(() => applyTextTransform('a(); a();', { id: 'ambiguous', anchor: 'a();', replacement: 'b();' }))
      .toThrow(/anchor/i);
  });
});

describe('PRODUCTION_TRANSFORMS and TEST_VARIANT_TRANSFORMS catalog', () => {
  it('every registered production transform actually applies to the real corpus file it targets', async () => {
    const cases = [
      'checkout-applies-percent', 'checkout-tautology', 'computes-subtotal-truthy', 'discount-returns-number',
      'discount-throws-range-error', 'exposes-checkout-helper', 'mocks-discount-logic', 'spies-on-math-round',
      'subtotal-exact-value', 'works-boolean-check',
    ];
    for (const id of cases) {
      const corpusCase = await loadCase(id);
      const plan = buildOraclePlan(corpusCase);
      expect(plan.kind, `plan for "${id}"`).toBe('plan');
    }
  });
});

describe('buildOraclePlan', () => {
  it('builds a baseline + single mutation run for a descriptive production-mutation case', async () => {
    const corpusCase = await loadCase('computes-subtotal-truthy');
    const result = buildOraclePlan(corpusCase);
    if (result.kind !== 'plan') throw new Error(`Expected a plan, got unrealizable: ${result.reason}`);
    expect(result.plan.runs.map((run) => run.label)).toEqual(['baseline', 'base-under-mutation']);

    const baseline = planFor(result.plan, 'baseline');
    expect(fileContents(baseline, 'cart.ts')).toBe(corpusCase.productionSources[0]?.contents);
    expect(baseline.mutatedFiles).toEqual([]);

    const mutated = planFor(result.plan, 'base-under-mutation');
    expect(mutated.mutatedFiles).toEqual(['cart.ts']);
    expect(fileContents(mutated, 'cart.ts')).toContain('total + item.price,');
    expect(fileContents(mutated, 'cart.ts')).not.toContain('total + item.price * item.qty');
    expect(fileContents(mutated, corpusCase.baseTest.path)).toBe(corpusCase.baseTest.contents);
  });

  it('builds baseline + mutation + variant runs for a prescriptive case', async () => {
    const corpusCase = await loadCase('checkout-applies-percent');
    const result = buildOraclePlan(corpusCase);
    if (result.kind !== 'plan') throw new Error(`Expected a plan, got unrealizable: ${result.reason}`);
    expect(result.plan.runs.map((run) => run.label)).toEqual(['baseline', 'base-under-mutation', 'variant-under-mutation']);

    const mutated = planFor(result.plan, 'base-under-mutation');
    expect(fileContents(mutated, 'cart.ts')).toContain('(100 + percent)');
    expect(fileContents(mutated, corpusCase.baseTest.path)).toBe(corpusCase.baseTest.contents);

    const variant = planFor(result.plan, 'variant-under-mutation');
    expect(fileContents(variant, 'cart.ts')).toContain('(100 + percent)');
    expect(fileContents(variant, corpusCase.baseTest.path)).toContain('mockCheckout');
    expect(fileContents(variant, corpusCase.baseTest.path)).not.toContain('checkout(items, 10)');
  });

  it('builds a repeated-execution plan whose mutation run duplicates the describe block and breaks the second call', async () => {
    const corpusCase = await loadCase('records-history-shared-state');
    const result = buildOraclePlan(corpusCase);
    if (result.kind !== 'plan') throw new Error(`Expected a plan, got unrealizable: ${result.reason}`);
    const mutated = planFor(result.plan, 'base-under-mutation');
    expect(mutated.expectedTestCount).toBe(2);
    expect(mutated.mutatedFiles).toEqual(['audit-log.ts']);
    const testSource = fileContents(mutated, corpusCase.baseTest.path);
    expect(testSource.match(/describe\(/g)?.length).toBe(2);
    expect(fileContents(mutated, 'audit-log.ts')).toContain('__recordCalls');

    const baseline = planFor(result.plan, 'baseline');
    expect(baseline.expectedTestCount).toBe(1);
  });

  it('reports unrealizable for a case with no registered oracle recipe', async () => {
    const corpusCase = await loadCase('computes-subtotal-truthy');
    const unknownCase: CorpusCase = { ...corpusCase, id: 'not-a-real-case' };
    const result = buildOraclePlan(unknownCase);
    expect(result).toEqual({ kind: 'unrealizable', reason: expect.stringMatching(/no-mutation-declared/) });
  });
});

describe('duplicateDescribeBlock', () => {
  it('duplicates the describe(...) block N times, preserving imports once', () => {
    const source = "import { describe, it } from 'vitest';\ndescribe('x', () => { it('y', () => {}); });";
    const result = duplicateDescribeBlock(source, 2);
    expect(result.match(/describe\(/g)?.length).toBe(2);
    expect(result.match(/^import/gm)?.length).toBe(1);
  });

  it('throws when there is no describe( block to duplicate', () => {
    expect(() => duplicateDescribeBlock('const x = 1;', 2)).toThrow(/describe/i);
  });
});

function passed(): RunObservation['observation'] { return { kind: 'passed' }; }
function failed(detail = 'assertion failed'): RunObservation['observation'] { return { kind: 'failed', detail }; }
function timedOut(): RunObservation['observation'] { return { kind: 'timed-out' }; }
function runnerError(detail = 'boom'): RunObservation['observation'] { return { kind: 'runner-error', detail }; }

function observation(label: string, observationValue: RunObservation['observation']): RunObservation {
  return { label, observation: observationValue, contentHash: 'deadbeef' };
}

describe('decideProof', () => {
  it('proves a descriptive case whose mutated observation matches its declared expectedOutcome', async () => {
    const corpusCase = await loadCase('computes-subtotal-truthy'); // expected-to-keep-passing
    const status = decideProof(corpusCase, [observation('baseline', passed()), observation('base-under-mutation', passed())]);
    expect(status).toEqual({ kind: 'proven' });
  });

  it('reports unproven when the baseline itself did not pass', async () => {
    const corpusCase = await loadCase('computes-subtotal-truthy');
    const status = decideProof(corpusCase, [observation('baseline', failed()), observation('base-under-mutation', passed())]);
    expect(status).toEqual({ kind: 'unproven', reason: expect.stringMatching(/baseline-failed/) });
  });

  it('reports unproven when a descriptive case predicts the wrong outcome', async () => {
    const corpusCase = await loadCase('computes-subtotal-truthy'); // real: expected-to-keep-passing
    const flipped: CorpusCase = { ...corpusCase, expectedOutcome: 'expected-to-fail' };
    // The mutated production still leaves the test passing (as it genuinely does) but the case now predicts failure.
    const status = decideProof(flipped, [observation('baseline', passed()), observation('base-under-mutation', passed())]);
    expect(status).toEqual({ kind: 'unproven', reason: expect.stringMatching(/prediction-not-held/) });
  });

  it('proves a prescriptive case whose base fails as predicted and whose variant keeps passing', async () => {
    const corpusCase = await loadCase('checkout-applies-percent'); // expected-to-fail, prescriptive
    const status = decideProof(corpusCase, [
      observation('baseline', passed()),
      observation('base-under-mutation', failed()),
      observation('variant-under-mutation', passed()),
    ]);
    expect(status).toEqual({ kind: 'proven' });
  });

  it('reports unproven when a prescriptive operator does not hide the defect (variant still fails)', async () => {
    const corpusCase = await loadCase('checkout-applies-percent');
    const status = decideProof(corpusCase, [
      observation('baseline', passed()),
      observation('base-under-mutation', failed()),
      observation('variant-under-mutation', failed()),
    ]);
    expect(status).toEqual({ kind: 'unproven', reason: expect.stringMatching(/operator-did-not-hide-defect/) });
  });

  it('reports a prescriptive case declaring expected-to-keep-passing as incoherent, without needing to inspect the variant', async () => {
    const corpusCase = await loadCase('checkout-applies-percent');
    const incoherent: CorpusCase = { ...corpusCase, expectedOutcome: 'expected-to-keep-passing' };
    const status = decideProof(incoherent, [
      observation('baseline', passed()),
      observation('base-under-mutation', passed()),
    ]);
    expect(status).toEqual({ kind: 'unproven', reason: expect.stringMatching(/incoherent-declaration/) });
  });

  it('reports unproven, naming the run, when any run timed out', async () => {
    const corpusCase = await loadCase('computes-subtotal-truthy');
    const status = decideProof(corpusCase, [observation('baseline', passed()), observation('base-under-mutation', timedOut())]);
    expect(status).toEqual({ kind: 'unproven', reason: expect.stringMatching(/base-under-mutation.*timed-out/) });
  });

  it('reports unproven, naming the run, when any run hit a runner error', async () => {
    const corpusCase = await loadCase('computes-subtotal-truthy');
    const status = decideProof(corpusCase, [observation('baseline', passed()), observation('base-under-mutation', runnerError('no report file'))]);
    expect(status).toEqual({ kind: 'unproven', reason: expect.stringMatching(/base-under-mutation.*runner-error/) });
  });
});

// Sanity check that the catalogs referenced above are exported and non-empty, so a future edit that
// accidentally stops exporting one is caught here rather than only inside buildOraclePlan's own tests.
describe('exported catalogs', () => {
  it('exposes at least one production transform and one test-variant transform', () => {
    expect(Object.keys(PRODUCTION_TRANSFORMS).length).toBeGreaterThan(0);
    expect(Object.keys(TEST_VARIANT_TRANSFORMS).length).toBeGreaterThan(0);
  });
});
