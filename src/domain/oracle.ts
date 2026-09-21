/**
 * Deciding *whether an operator's declared effect held* (task P7-2,
 * `odd/tasks/phase-7-benchmarks.md`). Pure, exactly like every other module
 * under `src/domain`: no I/O, no timers, no process spawning (enforced by
 * `test/architecture-boundary.test.ts`). *Producing* an observation — copying
 * files to a scratch directory, spawning a test runner, enforcing a timeout —
 * is `src/adapters/oracle-runner.ts`'s job; this module only ever computes
 * with strings and already-recorded observations it is handed.
 *
 * **Two questions, two kinds of function.** (1) *What should be run?*
 * {@link buildOraclePlan} turns one already-parsed {@link CorpusCase} into an
 * {@link OraclePlan}: a small, ordered list of {@link OracleRun}s, each a
 * complete, self-contained file set plus which file in it is the spec entry.
 * Building a plan never runs anything — it only ever transforms strings
 * already in memory (`CorpusCase.baseTest`/`productionSources`, read by
 * `src/adapters/corpus-store.ts` from the committed corpus) into *new*
 * strings for a *different* run to execute; it can therefore never touch,
 * let alone mutate, the Git-stored corpus, and the "never mutate the corpus"
 * guarantee is structural rather than a discipline this module has to
 * remember. (2) *What did that mean?* {@link decideProof} takes a
 * {@link CorpusCase} and the {@link RunObservation}s an adapter recorded for
 * its plan's runs, and decides `'proven'` or `'unproven'` (with a specific
 * reason) — never a bare boolean, so a caller can always say *why* a case did
 * not count.
 *
 * **Every case gets a baseline run first.** Per the phase Decisions, a
 * fixture case is "a base test that genuinely passes against its production
 * code" — a claim P7-1 stored but never executed. `buildOraclePlan` always
 * puts an unmutated `'baseline'` run first in `OraclePlan.runs`; `decideProof`
 * treats anything other than a `'passed'` baseline as `'baseline-failed'`
 * regardless of what any later run observed, since a case whose own baseline
 * does not pass was never a valid triple to begin with.
 *
 * **Declarative, named, anchor-checked mutations.** Per this phase's own
 * instruction to prefer "a small set of deterministic, declarative mutations
 * ... whose effect is obvious to a reviewer reading the diff" over a general
 * mutation engine: every production mutation and every prescriptive-operator
 * test variant is one named {@link TextTransform} — an exact substring
 * (`anchor`) replaced by fixed text — applied by {@link applyTextTransform},
 * which throws unless the anchor occurs in the source *exactly* once. A
 * transform that cannot find its anchor (a corpus case's file changed under
 * it) fails loudly, at plan-build time, before anything is ever spawned;
 * {@link buildOraclePlan} catches that and reports the case
 * `'unrealizable'` (`mutation-anchor-not-found`) rather than silently
 * producing an unmutated, meaningless plan.
 *
 * **`oracleKind` does not change the mechanical procedure this module runs.**
 * Reading each of the 11 real corpus cases' own `productionEffect` prose
 * (see `odd/tasks/phase-7-benchmarks.md`'s P7-2 report): every
 * `'descriptive'` case, regardless of its declared `oracleKind`
 * (`production-mutation` or `semantics-preserving-refactor`), is proven by
 * exactly one declarative production-side transform plus a single run of the
 * unmodified base test against it. Every `'prescriptive'` case — regardless
 * of whether its `oracleKind` is `production-mutation` or
 * `assertion-mutation` — is proven by the *same* two-run comparison: the
 * unmodified base test against one fixed production mutation (expected to
 * flip to failing), then the operator-derived *variant* test against that
 * *same* mutation (expected to keep passing, showing the operator hides the
 * defect the base test caught). `oracleKind` therefore only ever selects
 * *which* transform is meaningful for a given case's own claim — never a
 * different run shape — in this corpus. `'repeated-randomized-execution'`
 * (exactly one real case, `records-history-shared-state`) is the one
 * genuinely different mechanical shape: see {@link duplicateDescribeBlock}.
 */
import type {
  CorpusCase,
  CorpusExpectedOutcome,
  CorpusOperatorId,
  CorpusOperatorRole,
  CorpusOracleKind,
  CorpusSourceFile,
} from './corpus.js';

/** One committed file's exact bytes, ready to be materialized by an adapter — never written by this module itself. */
export interface OracleProofFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * One thing an adapter must actually run: a complete, self-contained file
 * set (every production file the case declares, plus exactly one test
 * file), which of those files is the spec entry (`testFile`, matched by
 * `path` against one entry of `files`), how many individual test results
 * the adapter should expect to see if this run truly executed as intended
 * (`expectedTestCount` — a mismatch means the run never really happened:
 * a load/parse error, a renamed file, or a mutation that broke the file's
 * syntax), and which of `files` differ from the case's own committed bytes
 * (`mutatedFiles`, empty for `'baseline'`).
 */
export interface OracleRun {
  readonly label: string;
  readonly files: readonly OracleProofFile[];
  readonly testFile: string;
  readonly expectedTestCount: number;
  readonly mutatedFiles: readonly string[];
}

/** One case's full set of runs, in the order an adapter should execute them. */
export interface OraclePlan {
  readonly caseId: string;
  readonly runs: readonly OracleRun[];
}

/**
 * `buildOraclePlan` never throws: a case with no registered recipe, or whose
 * registered transform's anchor no longer matches its committed bytes, is
 * `'unrealizable'` with a specific `reason` — never a silently-empty or
 * silently-unmutated plan.
 */
export type OraclePlanResult =
  | { readonly kind: 'plan'; readonly plan: OraclePlan }
  | { readonly kind: 'unrealizable'; readonly reason: string };

/** One exact-substring, applied-at-most-once declarative text mutation. See {@link applyTextTransform}. */
export interface TextTransform {
  readonly id: string;
  readonly anchor: string;
  readonly replacement: string;
}

function countOccurrences(source: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = source.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Applies one named {@link TextTransform} to `source`. Throws a
 * `RangeError` naming the transform's `id` unless `transform.anchor` occurs
 * in `source` *exactly* once — zero occurrences means the transform no
 * longer applies to this file (it drifted, or was never valid for it); more
 * than one means the transform is ambiguous about which occurrence it means,
 * which this module refuses to guess at. Both failure shapes are exactly
 * what makes every mutation here "obvious to a reviewer reading the diff":
 * there is never more than one place the diff could have landed.
 */
export function applyTextTransform(source: string, transform: TextTransform): string {
  const occurrences = countOccurrences(source, transform.anchor);
  if (occurrences !== 1) {
    throw new RangeError(
      `Text transform "${transform.id}" expects its anchor to occur exactly once, found ${occurrences}: ${JSON.stringify(transform.anchor)}`,
    );
  }
  return source.replace(transform.anchor, transform.replacement);
}

/**
 * Production-side declarative mutations (Decisions: "removing an assertion,
 * weakening an expectation, ..." are TEST-side operators; these are the
 * PRODUCTION-side corruptions/refactors the four oracle kinds act on —
 * see the module doc's "`oracleKind` does not change the mechanical
 * procedure" note). Every anchor/replacement pair below is taken verbatim
 * from the corresponding case's own `productionEffect` "(for example ...)"
 * parenthetical in its `case.json` (`test/fixtures/corpus/discrimination/*
 * /case.json`), so a reviewer can check this catalog against the corpus's
 * own prose without needing to run anything.
 */
export const PRODUCTION_TRANSFORMS: Readonly<Record<string, TextTransform>> = {
  'corrupt-discount-sign': {
    id: 'corrupt-discount-sign',
    anchor: 'Math.round(amount * (100 - percent)) / 100',
    replacement: 'Math.round(amount * (100 + percent)) / 100',
  },
  'subtotal-ignores-qty': {
    id: 'subtotal-ignores-qty',
    anchor: 'return items.reduce((total, item) => total + item.price * item.qty, 0);',
    replacement: 'return items.reduce((total, item) => total + item.price, 0);',
  },
  'discount-returns-amount-unchanged': {
    id: 'discount-returns-amount-unchanged',
    anchor: 'return Math.round(amount * (100 - percent)) / 100;',
    replacement: 'return amount;',
  },
  'discount-returns-zero': {
    id: 'discount-returns-zero',
    anchor: 'return Math.round(amount * (100 - percent)) / 100;',
    replacement: 'return 0;',
  },
  'remove-range-guard': {
    id: 'remove-range-guard',
    anchor: "  if (percent < 0 || percent > 100) throw new RangeError('percent must be between 0 and 100');\n",
    replacement: '',
  },
  'checkout-returns-nan': {
    id: 'checkout-returns-nan',
    anchor: 'return applyDiscount(subtotal(items), percent);',
    replacement: 'return NaN;',
  },
  'checkout-returns-one': {
    id: 'checkout-returns-one',
    anchor: 'return applyDiscount(subtotal(items), percent);',
    replacement: 'return 1;',
  },
  'round-via-toFixed': {
    id: 'round-via-toFixed',
    anchor: 'return Math.round(amount * (100 - percent)) / 100;',
    replacement: 'return Number(((amount * (100 - percent)) / 100).toFixed(2));',
  },
  'record-only-first-call': {
    id: 'record-only-first-call',
    anchor: 'export function record(entry: string): void { entries.push(entry); }',
    replacement:
      'let __recordCalls = 0;\n'
      + 'export function record(entry: string): void { __recordCalls += 1; if (__recordCalls === 1) entries.push(entry); }',
  },
  'record-skips-history-append': {
    id: 'record-skips-history-append',
    anchor: 'export function record(entry: string): void { entries.push(formatter.format(entry)); }',
    replacement: 'export function record(entry: string): void { formatter.format(entry); }',
  },
  'session-timeout-multiplied': {
    id: 'session-timeout-multiplied',
    anchor: 'return now - session.createdAt >= timeoutMs;',
    replacement: 'return now - session.createdAt >= timeoutMs * 10;',
  },
};

/**
 * Test-side transforms a `'prescriptive'` case's own declared `operator`
 * actually applies to the base test to produce its comparison variant — see
 * the module doc's "the *same* two-run comparison" note. Each is taken
 * verbatim from that case's own `testEffect` prose.
 */
export const TEST_VARIANT_TRANSFORMS: Readonly<Record<string, TextTransform>> = {
  'weaken-assertion-to-truthy': {
    id: 'weaken-assertion-to-truthy',
    anchor: 'expect(subtotal(items)).toBe(25);',
    replacement: 'expect(subtotal(items)).toBeTruthy();',
  },
  'remove-throw-assertion': {
    id: 'remove-throw-assertion',
    anchor: 'expect(() => applyDiscount(100, 101)).toThrow(RangeError);',
    replacement: 'try { applyDiscount(100, 101); } catch { /* assertion removed by the remove-assertion operator */ }',
  },
  'mock-checkout-call': {
    id: 'mock-checkout-call',
    anchor: 'expect(checkout(items, 10)).toBe(22.5);',
    replacement: 'const mockCheckout = (): number => 22.5;\n    expect(mockCheckout()).toBe(22.5);',
  },
  'introduce-real-clock': {
    id: 'introduce-real-clock',
    anchor: 'expect(isSessionExpired(session, 500, start + 600)).toBe(true);',
    replacement: 'expect(isSessionExpired(session, 500, Date.now() + 10_000)).toBe(true);',
  },
};

interface SingleMutationRecipe {
  readonly kind: 'single-mutation';
  readonly targetFile: string;
  readonly transformId: string;
  readonly variantTransformId?: string;
}

interface RepeatedExecutionRecipe {
  readonly kind: 'repeated-execution';
  readonly targetFile: string;
  readonly transformId: string;
  readonly repeatCount: number;
}

type CaseOracleRecipe = SingleMutationRecipe | RepeatedExecutionRecipe;

/**
 * Case id -> how to realize its declared claim. One entry per real corpus
 * case (`test/fixtures/corpus/discrimination/*`); a case id with no entry
 * here is `'unrealizable'` (`no-mutation-declared`), never silently skipped.
 * A `productionMutation` field on the manifest itself (P7-1's `case.json`)
 * would be the cleaner long-term home for this binding, but retrofitting
 * P7-1's parser and all 11 manifests is out of this task's authorized scope
 * — returned as an open decision, not done here.
 */
const CASE_ORACLE_RECIPES: Readonly<Record<string, CaseOracleRecipe>> = {
  'checkout-applies-percent': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'corrupt-discount-sign', variantTransformId: 'mock-checkout-call' },
  'checkout-tautology': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'corrupt-discount-sign' },
  'computes-subtotal-truthy': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'subtotal-ignores-qty' },
  'discount-returns-number': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'discount-returns-amount-unchanged' },
  'discount-throws-range-error': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'remove-range-guard', variantTransformId: 'remove-throw-assertion' },
  'exposes-checkout-helper': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'checkout-returns-nan' },
  'mocks-discount-logic': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'discount-returns-zero' },
  'records-history-shared-state': { kind: 'repeated-execution', targetFile: 'audit-log.ts', transformId: 'record-only-first-call', repeatCount: 2 },
  'spies-on-math-round': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'round-via-toFixed' },
  'subtotal-exact-value': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'subtotal-ignores-qty', variantTransformId: 'weaken-assertion-to-truthy' },
  'works-boolean-check': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'checkout-returns-one' },
  'asserts-helper-call-count': { kind: 'single-mutation', targetFile: 'audit-log.ts', transformId: 'record-skips-history-append' },
  'generic-boolean-summary': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'corrupt-discount-sign' },
  'session-expiry-controlled-clock': { kind: 'single-mutation', targetFile: 'session.ts', transformId: 'session-timeout-multiplied', variantTransformId: 'introduce-real-clock' },
};

/**
 * Duplicates a test file's `describe(...)` block (and everything after it)
 * `times` times, keeping the file's own `import`s exactly once. This is the
 * mechanical shape `'repeated-randomized-execution'` needs, and it needs
 * only for `records-history-shared-state`: "running this exact test body
 * twice in a row within the same process, sharing one loaded module" (that
 * case's own `productionEffect`) means two `it(...)`s inside one file, so
 * the module they both import is loaded exactly once by the adapter's
 * spawned test runner. Throws if the source has no `describe(` to
 * duplicate — a plan for a case whose base test does not use `describe`
 * would be meaningless here, and `buildOraclePlan` turns that into an
 * `'unrealizable'` case rather than a silently unduplicated run.
 */
export function duplicateDescribeBlock(source: string, times: number): string {
  const marker = 'describe(';
  const index = source.indexOf(marker);
  if (index === -1) throw new RangeError('Expected a "describe(" block to duplicate, found none');
  const head = source.slice(0, index);
  const block = source.slice(index);
  return head + block.repeat(times);
}

function baselineRun(corpusCase: CorpusCase): OracleRun {
  return {
    label: 'baseline',
    files: [...corpusCase.productionSources, corpusCase.baseTest],
    testFile: corpusCase.baseTest.path,
    expectedTestCount: 1,
    mutatedFiles: [],
  };
}

function withMutatedProductionFile(
  corpusCase: CorpusCase,
  targetFile: string,
  mutatedContents: string,
): readonly OracleProofFile[] {
  return corpusCase.productionSources.map((file) => (file.path === targetFile ? { path: file.path, contents: mutatedContents } : file));
}

function findProductionSource(corpusCase: CorpusCase, path: string): CorpusSourceFile {
  const file = corpusCase.productionSources.find((entry) => entry.path === path);
  if (file === undefined) {
    throw new RangeError(`Case "${corpusCase.id}" has no production file "${path}" to mutate`);
  }
  return file;
}

function buildSingleMutationPlan(corpusCase: CorpusCase, recipe: SingleMutationRecipe): OraclePlan {
  const target = findProductionSource(corpusCase, recipe.targetFile);
  const transform = PRODUCTION_TRANSFORMS[recipe.transformId];
  if (transform === undefined) throw new RangeError(`Unknown production transform id "${recipe.transformId}"`);
  const mutatedContents = applyTextTransform(target.contents, transform);
  const mutatedProductionFiles = withMutatedProductionFile(corpusCase, recipe.targetFile, mutatedContents);

  const runs: OracleRun[] = [
    baselineRun(corpusCase),
    {
      label: 'base-under-mutation',
      files: [...mutatedProductionFiles, corpusCase.baseTest],
      testFile: corpusCase.baseTest.path,
      expectedTestCount: 1,
      mutatedFiles: [recipe.targetFile],
    },
  ];

  if (corpusCase.operatorRole === 'prescriptive') {
    if (recipe.variantTransformId === undefined) {
      throw new RangeError(`Case "${corpusCase.id}" is prescriptive but declares no variant transform`);
    }
    const variantTransform = TEST_VARIANT_TRANSFORMS[recipe.variantTransformId];
    if (variantTransform === undefined) throw new RangeError(`Unknown test-variant transform id "${recipe.variantTransformId}"`);
    const variantTestContents = applyTextTransform(corpusCase.baseTest.contents, variantTransform);
    runs.push({
      label: 'variant-under-mutation',
      files: [...mutatedProductionFiles, { path: corpusCase.baseTest.path, contents: variantTestContents }],
      testFile: corpusCase.baseTest.path,
      expectedTestCount: 1,
      mutatedFiles: [recipe.targetFile, corpusCase.baseTest.path],
    });
  }

  return { caseId: corpusCase.id, runs };
}

function buildRepeatedExecutionPlan(corpusCase: CorpusCase, recipe: RepeatedExecutionRecipe): OraclePlan {
  const target = findProductionSource(corpusCase, recipe.targetFile);
  const transform = PRODUCTION_TRANSFORMS[recipe.transformId];
  if (transform === undefined) throw new RangeError(`Unknown production transform id "${recipe.transformId}"`);
  const mutatedContents = applyTextTransform(target.contents, transform);
  const mutatedProductionFiles = withMutatedProductionFile(corpusCase, recipe.targetFile, mutatedContents);
  const duplicatedTestContents = duplicateDescribeBlock(corpusCase.baseTest.contents, recipe.repeatCount);

  return {
    caseId: corpusCase.id,
    runs: [
      baselineRun(corpusCase),
      {
        label: 'base-under-mutation',
        files: [...mutatedProductionFiles, { path: corpusCase.baseTest.path, contents: duplicatedTestContents }],
        testFile: corpusCase.baseTest.path,
        expectedTestCount: recipe.repeatCount,
        mutatedFiles: [recipe.targetFile],
      },
    ],
  };
}

/**
 * Turns one already-parsed {@link CorpusCase} into an {@link OraclePlan} an
 * adapter can execute, or reports it `'unrealizable'`. Never throws: a
 * missing recipe, an unknown transform id, or a transform whose anchor no
 * longer matches this case's committed bytes are all caught here and turned
 * into a specific `reason` string, so a caller never has to wrap this in its
 * own `try`/`catch` to get a safe result.
 */
export function buildOraclePlan(corpusCase: CorpusCase): OraclePlanResult {
  const recipe = CASE_ORACLE_RECIPES[corpusCase.id];
  if (recipe === undefined) {
    return { kind: 'unrealizable', reason: `no-mutation-declared: no oracle recipe is registered for case "${corpusCase.id}"` };
  }
  try {
    const plan = recipe.kind === 'repeated-execution'
      ? buildRepeatedExecutionPlan(corpusCase, recipe)
      : buildSingleMutationPlan(corpusCase, recipe);
    return { kind: 'plan', plan };
  } catch (error) {
    return { kind: 'unrealizable', reason: `mutation-anchor-not-found: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** What one {@link OracleRun} was actually observed to do, recorded by the adapter that ran it. */
export type Observation =
  | { readonly kind: 'passed' }
  | { readonly kind: 'failed'; readonly detail?: string }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'runner-error'; readonly detail: string };

/** One run's recorded observation, plus the content hash of the exact bytes that produced it (Decisions: "a benchmark that re-derives its own ground truth ... can drift silently"). */
export interface RunObservation {
  readonly label: string;
  readonly observation: Observation;
  readonly contentHash: string;
}

export type CaseProofStatus =
  | { readonly kind: 'proven' }
  | { readonly kind: 'unproven'; readonly reason: string };

function findObservation(observations: readonly RunObservation[], label: string): RunObservation | undefined {
  return observations.find((entry) => entry.label === label);
}

function outcomeOf(observation: Observation): CorpusExpectedOutcome | undefined {
  if (observation.kind === 'passed') return 'expected-to-keep-passing';
  if (observation.kind === 'failed') return 'expected-to-fail';
  return undefined;
}

function nonTerminalReason(label: string, observation: Observation): string | undefined {
  if (observation.kind === 'timed-out') return `${label} timed-out`;
  if (observation.kind === 'runner-error') return `${label} runner-error: ${observation.detail}`;
  return undefined;
}

/**
 * Decides whether a case's declared claim held, from the {@link RunObservation}s
 * an adapter recorded for the {@link OraclePlan} {@link buildOraclePlan} built
 * for it. Never a bare boolean — every non-`'proven'` result carries a
 * specific machine-matchable `reason`:
 *
 * - `'baseline-failed'`: the case's own "genuinely passes against its
 *   production code" precondition (Decisions) did not hold.
 * - `'<label> timed-out'` / `'<label> runner-error: ...'`: a run never
 *   reached a real pass/fail outcome at all.
 * - `'incoherent-declaration'`: a `'prescriptive'` case declared
 *   `'expected-to-keep-passing'` — incoherent, because the entire point of a
 *   prescriptive good control is that its unmodified base test *catches* the
 *   fixed production mutation (fails), which only a declared
 *   `'expected-to-fail'` can express. Decided before even looking at the
 *   mutation/variant observations, since no execution result could make this
 *   declaration coherent.
 * - `'prediction-not-held'`: the base-under-mutation run's own pass/fail did
 *   not match the case's declared `expectedOutcome`.
 * - `'operator-did-not-hide-defect'`: (`'prescriptive'` only) the base test
 *   correctly caught the mutation, but the operator-derived variant *also*
 *   failed under it — the operator did not, in fact, hide the defect.
 */
export function decideProof(corpusCase: CorpusCase, observations: readonly RunObservation[]): CaseProofStatus {
  const baseline = findObservation(observations, 'baseline');
  if (baseline === undefined || baseline.observation.kind !== 'passed') {
    return { kind: 'unproven', reason: 'baseline-failed: the case\'s base test did not pass against its own unmutated production code' };
  }

  if (corpusCase.operatorRole === 'prescriptive' && corpusCase.expectedOutcome !== 'expected-to-fail') {
    return {
      kind: 'unproven',
      reason: 'incoherent-declaration: a prescriptive case must declare expected-to-fail (the base test is expected to catch the fixed mutation the variant is expected to hide)',
    };
  }

  const baseUnderMutation = findObservation(observations, 'base-under-mutation');
  if (baseUnderMutation === undefined) {
    return { kind: 'unproven', reason: 'base-under-mutation: no observation was recorded for this run' };
  }
  const baseNonTerminal = nonTerminalReason('base-under-mutation', baseUnderMutation.observation);
  if (baseNonTerminal !== undefined) return { kind: 'unproven', reason: baseNonTerminal };

  const baseOutcome = outcomeOf(baseUnderMutation.observation);
  if (baseOutcome !== corpusCase.expectedOutcome) {
    return { kind: 'unproven', reason: `prediction-not-held: declared "${corpusCase.expectedOutcome}" but observed "${baseOutcome}"` };
  }

  if (corpusCase.operatorRole === 'descriptive') {
    return { kind: 'proven' };
  }

  const variant = findObservation(observations, 'variant-under-mutation');
  if (variant === undefined) {
    return { kind: 'unproven', reason: 'variant-under-mutation: no observation was recorded for this run' };
  }
  const variantNonTerminal = nonTerminalReason('variant-under-mutation', variant.observation);
  if (variantNonTerminal !== undefined) return { kind: 'unproven', reason: variantNonTerminal };

  if (variant.observation.kind !== 'passed') {
    return { kind: 'unproven', reason: 'operator-did-not-hide-defect: the operator-derived variant did not keep passing under the same mutation the base test caught' };
  }

  return { kind: 'proven' };
}

export type { CorpusOperatorId, CorpusOperatorRole, CorpusOracleKind };
