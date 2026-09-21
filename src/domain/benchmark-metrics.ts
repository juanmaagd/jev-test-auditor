/**
 * Per-dimension benchmark metrics (task P7-4, `odd/tasks/phase-7-benchmarks.md`).
 * Pure — no I/O, no timers (enforced by `test/architecture-boundary.test.ts`,
 * exactly like every other `src/domain` module): takes already-loaded
 * benchmark runs (`BenchmarkStorePort.loadRun`'s own result, one or more of
 * them) and computes precision, recall, false-positive rate, needs-review
 * routing, probability calibration, run-to-run stability, cost, and latency,
 * one figure per {@link RubricDimensionId} — never touches a database or the
 * network itself.
 *
 * **Every reported rate carries its own sample count, inseparably.** A
 * {@link RateMetric} is a fraction (`numerator`/`denominator`), never a bare
 * decimal: the sample size is structurally part of the value, not a footnote
 * next to it. `kind` further distinguishes three states:
 *   - `'not-computable'`: the denominator is zero (or, for precision/false-positive
 *     rate specifically, the corpus has no case of the OTHER ground-truth
 *     class for this dimension at all — see {@link OPERATOR_DIMENSION}'s own
 *     doc) — `value` is always `undefined` here; there is nothing to report.
 *   - `'below-minimum-sample'`: the denominator is below {@link MIN_SAMPLE_FOR_RATE}.
 *     `value` is still populated (the raw evidence is never hidden), but a
 *     caller must not print it as a headline decimal the way a `'computed'`
 *     value can be — see this module's own callers (`src/cli/benchmark.ts`)
 *     for how that distinction is rendered.
 *   - `'computed'`: the denominator meets {@link MIN_SAMPLE_FOR_RATE}.
 * The same three-state discipline applies to {@link SampledMetric} (calibration,
 * cost, latency), which are means rather than fractions and so carry
 * `sampleCount` instead of a numerator/denominator pair.
 *
 * **Only proven cases count** (Decisions, and this task's own instruction).
 * A case whose oracle proof did not hold (`proofStatus.kind !== 'proven'`) is
 * excluded from every metric below and reported once, separately, in
 * {@link BenchmarkMetricsReport.unprovenCases} — never averaged in, never
 * silently absent. A case that IS proven but whose sampling attempt failed
 * (`sampleFailure` present, or no `sample` at all) carries no Jev judgment to
 * measure anything from; it is reported separately in
 * {@link BenchmarkMetricsReport.notSampledCases}.
 *
 * **A dimension with no proven case reports that plainly, never as zero**
 * (this task's own acceptance criterion): {@link BenchmarkMetricsDimensionReport.provenCaseCount}
 * is `0`, and every accuracy metric for that dimension is `'not-computable'`
 * with `value: undefined` — never a `0` a reader could mistake for "measured
 * to be zero."
 *
 * **`OPERATOR_DIMENSION` is a closed, operator-keyed mapping, not a
 * caseId-keyed registry.** P7-2 already shipped one caseId-keyed registry
 * (`CASE_ORACLE_RECIPES` in `src/domain/oracle.ts`) and flagged it, in its
 * own report, as a scaling smell: a corpus that grows to the 35-70 cases this
 * phase's own Decisions anticipate would mean editing that registry by hand
 * for every new case. This module's own hard constraint — "design so growing
 * the corpus changes the numbers, not the code" — makes a second caseId
 * registry the wrong choice here. `operator` is a closed, six-member
 * vocabulary (`CorpusOperatorId`) that every corpus case already declares
 * (`src/domain/corpus.ts`) and that `BenchmarkStorePort.loadRun` already
 * returns on every {@link BenchmarkCaseOutcome} — so a NEW corpus case needs
 * no change here at all, only a `case.json` declaring one of the six existing
 * operators, and `OPERATOR_DIMENSION` attributes it automatically. The
 * mapping is typed `Record<CorpusOperatorId, RubricDimensionId>` (not
 * `Partial`), so a future SEVENTH operator added to `CORPUS_OPERATOR_IDS`
 * without an entry here fails `tsc`, not silently falls through.
 *
 * Each assignment below is read directly off `src/domain/rubric.ts`'s own
 * "Misleading" quality-criterion text for the target dimension, quoted where
 * the match is verbatim, and cross-checked against every real corpus case's
 * own `testEffect`/`productionEffect` prose (every `case.json` under
 * `test/fixtures/corpus/discrimination/`):
 *   - `remove-assertion` → `falsifiability`: falsifiability's own Misleading
 *     text names "asserting a mock was defined, asserting a variable exists
 *     ... or asserting a tautology" and "the test body never actually
 *     invokes the behavior under test" — matching `exposes-checkout-helper`
 *     (`toBeDefined()`) and `checkout-tautology` (`checkout` never called)
 *     verbatim. `discount-throws-range-error` (the paired prescriptive good
 *     control) removes the SAME kind of assertion and its own
 *     `productionEffect` states plainly that the regression "would go
 *     undetected" once removed — literally "can this test fail," which is
 *     falsifiability's own definition.
 *   - `weaken-expectation` → `assertion-strength`: assertion-strength's own
 *     Misleading/Weak text names "checks only truthiness, type, or
 *     definedness" and "an assertion against a fixed literal unconnected to
 *     the act under test" — matching `computes-subtotal-truthy`
 *     (`toBeTruthy()`), `discount-returns-number` (`typeof ... 'number'`),
 *     and `works-boolean-check` (`Boolean(...)` coercion) directly; the
 *     paired prescriptive control, `subtotal-exact-value`, weakens the exact
 *     same assertion.
 *   - `mock-owned-logic` → `test-double-quality`: its own Misleading text is
 *     "mocking the function under test itself" — `mocks-discount-logic`
 *     never calls the real `applyDiscount` at all, replacing it with a
 *     canned mock; `checkout-applies-percent` is the paired prescriptive
 *     control using the real logic.
 *   - `pin-implementation-detail` → `refactor-resistance`: the sole real case,
 *     `spies-on-math-round`, declares `oracleKind: 'semantics-preserving-refactor'`
 *     — precisely refactor-resistance's own quality question ("if the code
 *     under test were reorganized internally ... while its externally
 *     observed behavior stayed the same, would this test keep passing?").
 *   - `add-shared-state` / `introduce-uncontrolled-time` → `determinism-isolation`:
 *     both operators mutate a test's dependence on shared or uncontrolled
 *     state, which is determinism-isolation's own definition exactly; the
 *     sole real case, `records-history-shared-state`, mutates module-level
 *     shared state and unseeded randomness (`Math.random()`).
 *
 * This leaves TWO of the seven rubric dimensions — `behavioral-focus` and
 * `diagnostic-quality` — permanently unreachable by any of the six corpus
 * operators: a real, disclosed Phase 7 finding (returned to the orchestrator
 * in this task's own report), not a bug in this mapping. Authoring a new
 * operator for either is out of this task's authorized scope (P7-1 fixed the
 * six-operator catalog); until one exists, those two dimensions will always
 * report `provenCaseCount: 0` and `'not-computable'` for every accuracy
 * metric, however large the corpus grows — exactly the behavior this
 * module's own "no proven case reports that plainly" rule exists to make
 * visible rather than hide.
 */
import type { BenchmarkCaseOutcome } from './benchmark-store.js';
import type { ClassificationLevel, DimensionJudgment } from './classification.js';
import type { CorpusOperatorId, CorpusOperatorRole } from './corpus.js';
import { JEV_ESTIMATE_SNAPSHOT } from './jev-pricing.js';
import { RUBRIC_DIMENSION_IDS, type RubricDimensionId } from './rubric.js';

/**
 * Below this many observations, a rate's decimal value carries no
 * information a reader could act on: a Wilson 95% confidence interval for
 * any observed binomial proportion at `n < 5` spans more than 0.7 of the
 * `[0, 1]` range, regardless of which value was observed — printing that
 * decimal next to a case count of 1, 2, 3, or 4 is exactly the "coin flip
 * printed to two decimals" this task's own instructions warn against. `5`
 * also matches this task's own authorized stability-run cap (at most five
 * repetitions), so a single authorized stability run is, by design, the
 * smallest sample this module will ever present as decisively "computed."
 */
export const MIN_SAMPLE_FOR_RATE = 5;

/**
 * The closed operator -> rubric-dimension attribution this module's metrics
 * are computed from. See this module's own doc for the full per-operator
 * justification and the two structurally-unreachable dimensions
 * (`behavioral-focus`, `diagnostic-quality`) this mapping cannot cover.
 */
export const OPERATOR_DIMENSION: Readonly<Record<CorpusOperatorId, RubricDimensionId>> = {
  'remove-assertion': 'falsifiability',
  'weaken-expectation': 'assertion-strength',
  'add-shared-state': 'determinism-isolation',
  'mock-owned-logic': 'test-double-quality',
  'pin-implementation-detail': 'refactor-resistance',
  'introduce-uncontrolled-time': 'determinism-isolation',
};

export type RateMetricKind = 'computed' | 'below-minimum-sample' | 'not-computable';

/**
 * A fraction, never a bare decimal — see this module's own doc for why
 * `numerator`/`denominator` are never optional the way `value` is.
 */
export interface RateMetric {
  readonly kind: RateMetricKind;
  readonly numerator: number;
  readonly denominator: number;
  /** `undefined` exactly when `kind === 'not-computable'`; present (never hidden) otherwise, including `'below-minimum-sample'`. */
  readonly value: number | undefined;
  /** Populated exactly when `kind === 'not-computable'`, naming the specific structural reason — never a bare `undefined` a caller has to guess at. */
  readonly reason: string | undefined;
}

export type SampledMetricKind = RateMetricKind;

/** A mean-based metric (calibration, cost, latency) — the same three-state discipline as {@link RateMetric}, keyed by `sampleCount` instead of a fraction. */
export interface SampledMetric {
  readonly kind: SampledMetricKind;
  readonly sampleCount: number;
  readonly value: number | undefined;
  readonly reason: string | undefined;
}

export interface BenchmarkMetricsDimensionReport {
  readonly dimensionId: RubricDimensionId;
  /** Distinct proven case ids (across every given run) whose declared operator maps to this dimension — never a per-run or per-sample count. */
  readonly provenCaseCount: number;
  readonly precision: RateMetric;
  readonly recall: RateMetric;
  readonly falsePositiveRate: RateMetric;
  /** Pools every proven+sampled case's judgment of THIS dimension, regardless of which dimension that case was designed to test (Jev judges all seven dimensions per sample) — see this module's own doc for why this denominator can exceed `provenCaseCount`. */
  readonly needsReviewRouting: RateMetric;
  /** Mean Brier score (`(deficientMass - groundTruthIndicator)^2`, lower is better) against this dimension's own designated proven+sampled cases; includes `needs-review` (`boundary-straddle`) judgments, since a validated `deficientMass` reflects the model's stated probability regardless of whether the policy's boundary-mass gate happened to clear. */
  readonly calibration: SampledMetric;
  /** Mean USD cost per proven+sampled case designated to this dimension (input tokens only — Jev's output tokens are unbilled; see {@link JEV_ESTIMATE_SNAPSHOT}). */
  readonly cost: SampledMetric;
  /** Mean latency in milliseconds, over cases that recorded one (`latencyMs` is optional on {@link BenchmarkSampleRecord}). */
  readonly latency: SampledMetric;
  /** Pairwise agreement rate on this dimension's judgment across every pair of the given runs, pooled over this dimension's designated cases — `'not-computable'` with fewer than two runs. */
  readonly stability: RateMetric;
}

export interface BenchmarkUnprovenCaseSummary {
  readonly caseId: string;
  /** Every distinct unproven reason seen for this case across the given runs (almost always one — oracle proof is deterministic over identical committed bytes — but never silently collapsed if runs disagree). */
  readonly reasons: readonly string[];
}

export interface BenchmarkNotSampledCaseSummary {
  readonly caseId: string;
  readonly reasons: readonly string[];
}

export interface BenchmarkMetricsReport {
  readonly runsConsidered: number;
  /** Distinct proven case ids across every given run. */
  readonly provenCaseCount: number;
  readonly unprovenCases: readonly BenchmarkUnprovenCaseSummary[];
  readonly notSampledCases: readonly BenchmarkNotSampledCaseSummary[];
  /** Always all seven {@link RUBRIC_DIMENSION_IDS}, in that order — a dimension with zero cases still gets an entry (see this module's own doc). */
  readonly dimensions: readonly BenchmarkMetricsDimensionReport[];
}

/** One already-loaded benchmark run — `runId` plus `BenchmarkStorePort.loadRun`'s own result for it. */
export interface BenchmarkMetricsRun {
  readonly runId: string;
  readonly outcomes: readonly BenchmarkCaseOutcome[];
}

const DEFICIENT_LEVELS: ReadonlySet<ClassificationLevel> = new Set(['misleading', 'weak']);

function isDeficientLevel(level: ClassificationLevel | undefined): boolean | undefined {
  if (level === undefined) return undefined;
  return DEFICIENT_LEVELS.has(level);
}

/** Ground truth for a case's designated dimension: a descriptive (deliberately bad) case should be judged deficient; a prescriptive (good-control) case should be judged healthy. Mirrors `isCaseCorrect`'s own prescriptive/descriptive convention (`src/domain/benchmark-comparison.ts`), applied to one dimension's level rather than the whole case's overall status. */
function groundTruthDeficient(operatorRole: CorpusOperatorRole): boolean {
  return operatorRole === 'descriptive';
}

function computeRate(numerator: number, denominator: number, notComputableReason?: string): RateMetric {
  if (notComputableReason !== undefined || denominator === 0) {
    return { kind: 'not-computable', numerator, denominator, value: undefined, reason: notComputableReason ?? 'no case in this run set produced a usable observation' };
  }
  const value = numerator / denominator;
  return { kind: denominator >= MIN_SAMPLE_FOR_RATE ? 'computed' : 'below-minimum-sample', numerator, denominator, value, reason: undefined };
}

function computeSampled(values: readonly number[], noDataReason: string): SampledMetric {
  if (values.length === 0) return { kind: 'not-computable', sampleCount: 0, value: undefined, reason: noDataReason };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { kind: values.length >= MIN_SAMPLE_FOR_RATE ? 'computed' : 'below-minimum-sample', sampleCount: values.length, value: mean, reason: undefined };
}

function sampleCostUsd(usage: { readonly inputTokens: number; readonly outputTokens: number }): number {
  // Fails loud rather than silently under-pricing: this function only ever prices input tokens,
  // exactly matching JEV_ESTIMATE_SNAPSHOT's own current contract (Jev has no output-token
  // charge). A future paid-output snapshot must update this computation before it can be trusted.
  if (JEV_ESTIMATE_SNAPSHOT.outputTokensBilled) {
    throw new RangeError(
      'JEV_ESTIMATE_SNAPSHOT.outputTokensBilled is true, but benchmark-metrics.ts\'s sampleCostUsd only prices '
      + 'input tokens; update this function before trusting its cost figures.',
    );
  }
  return (usage.inputTokens * JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens) / 1_000_000;
}

interface ProvenCaseEntry {
  readonly runId: string;
  readonly caseId: string;
  readonly operator: CorpusOperatorId;
  readonly operatorRole: CorpusOperatorRole;
  readonly outcome: BenchmarkCaseOutcome;
}

function collectProvenCases(runs: readonly BenchmarkMetricsRun[]): {
  readonly proven: readonly ProvenCaseEntry[];
  readonly unproven: readonly BenchmarkUnprovenCaseSummary[];
  readonly notSampled: readonly BenchmarkNotSampledCaseSummary[];
} {
  const proven: ProvenCaseEntry[] = [];
  const unprovenReasons = new Map<string, Set<string>>();
  const notSampledReasons = new Map<string, Set<string>>();

  for (const { runId, outcomes } of runs) {
    for (const outcome of outcomes) {
      if (outcome.proofStatus.kind !== 'proven') {
        const reasons = unprovenReasons.get(outcome.caseId) ?? new Set<string>();
        reasons.add(outcome.proofStatus.reason);
        unprovenReasons.set(outcome.caseId, reasons);
        continue;
      }
      proven.push({ runId, caseId: outcome.caseId, operator: outcome.operator, operatorRole: outcome.operatorRole, outcome });
      if (outcome.sample === undefined) {
        const reasons = notSampledReasons.get(outcome.caseId) ?? new Set<string>();
        reasons.add(outcome.sampleFailure === undefined ? 'sampling was never attempted' : outcome.sampleFailure.errorMessage);
        notSampledReasons.set(outcome.caseId, reasons);
      }
    }
  }

  const toSummaries = (map: Map<string, Set<string>>): readonly BenchmarkUnprovenCaseSummary[] =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([caseId, reasons]) => ({ caseId, reasons: [...reasons].sort() }));

  return { proven, unproven: toSummaries(unprovenReasons), notSampled: toSummaries(notSampledReasons) };
}

function findDimension(outcome: BenchmarkCaseOutcome, dimensionId: RubricDimensionId): DimensionJudgment | undefined {
  return outcome.sample?.classification.dimensions.find((dimension) => dimension.dimensionId === dimensionId);
}

function stabilityKey(judgment: DimensionJudgment): string {
  if (judgment.status === 'judged') return `judged:${judgment.level ?? 'unknown'}`;
  return judgment.status;
}

/** Pairwise agreement over every distinct pair of runs that both proved+sampled `caseId`, pooled across every case designated to `dimensionId`. */
function computeStability(
  provenByCase: ReadonlyMap<string, readonly ProvenCaseEntry[]>,
  designatedCaseIds: ReadonlySet<string>,
  dimensionId: RubricDimensionId,
  runCount: number,
): RateMetric {
  if (runCount < 2) return computeRate(0, 0, 'run-to-run stability requires at least two runs of the same corpus; only one was given');

  let agreeingPairs = 0;
  let totalPairs = 0;
  for (const caseId of designatedCaseIds) {
    const entries = (provenByCase.get(caseId) ?? []).filter((entry) => entry.outcome.sample !== undefined);
    const keys = entries
      .map((entry) => findDimension(entry.outcome, dimensionId))
      .filter((dimension): dimension is DimensionJudgment => dimension !== undefined)
      .map(stabilityKey);
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        totalPairs += 1;
        if (keys[i] === keys[j]) agreeingPairs += 1;
      }
    }
  }
  return computeRate(agreeingPairs, totalPairs, totalPairs === 0 ? 'no case designated to this dimension was proven and sampled in more than one run' : undefined);
}

function computeDimensionReport(
  dimensionId: RubricDimensionId,
  allProven: readonly ProvenCaseEntry[],
  provenByCase: ReadonlyMap<string, readonly ProvenCaseEntry[]>,
  runCount: number,
): BenchmarkMetricsDimensionReport {
  const designated = allProven.filter((entry) => OPERATOR_DIMENSION[entry.operator] === dimensionId);
  const designatedCaseIds = new Set(designated.map((entry) => entry.caseId));

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  let hasPrescriptive = false;
  let hasDescriptive = false;
  const calibrationValues: number[] = [];
  const costValues: number[] = [];
  const latencyValues: number[] = [];

  for (const entry of designated) {
    if (entry.operatorRole === 'prescriptive') hasPrescriptive = true;
    else hasDescriptive = true;

    const sample = entry.outcome.sample;
    if (sample === undefined) continue;

    costValues.push(sampleCostUsd(sample.usage));
    if (sample.latencyMs !== undefined) latencyValues.push(sample.latencyMs);

    const dimension = findDimension(entry.outcome, dimensionId);
    if (dimension === undefined) continue;

    if (dimension.deficientMass !== undefined) {
      const truth = groundTruthDeficient(entry.operatorRole) ? 1 : 0;
      calibrationValues.push((dimension.deficientMass - truth) ** 2);
    }

    if (dimension.status !== 'judged') continue;
    const predictedDeficient = isDeficientLevel(dimension.level);
    if (predictedDeficient === undefined) continue;
    const truth = groundTruthDeficient(entry.operatorRole);
    if (predictedDeficient && truth) truePositive += 1;
    else if (predictedDeficient && !truth) falsePositive += 1;
    else if (!predictedDeficient && truth) falseNegative += 1;
    else trueNegative += 1;
  }

  // Needs-review routing pools EVERY proven+sampled case's judgment of this dimension, regardless
  // of that case's own designated dimension — routing needs no ground truth, so it is not limited
  // to `designated` the way the accuracy metrics above are (see this module's own doc).
  let routingNeedsReview = 0;
  let routingAttempts = 0;
  for (const entry of allProven) {
    const dimension = findDimension(entry.outcome, dimensionId);
    if (dimension === undefined) continue;
    if (dimension.status === 'not-applicable') continue;
    routingAttempts += 1;
    if (dimension.status === 'needs-review') routingNeedsReview += 1;
  }

  const noNegativeClassReason = hasDescriptive && !hasPrescriptive
    ? `no prescriptive (good-control) proven case exists for "${dimensionId}" in the given run(s); precision/false-positive rate need a negative-class case to mean anything`
    : undefined;

  return {
    dimensionId,
    provenCaseCount: designatedCaseIds.size,
    precision: computeRate(truePositive, truePositive + falsePositive, noNegativeClassReason ?? (truePositive + falsePositive === 0 ? `no case designated to "${dimensionId}" was judged (not needs-review/not-applicable) as deficient or healthy` : undefined)),
    recall: computeRate(truePositive, truePositive + falseNegative, truePositive + falseNegative === 0 ? `no proven, judged descriptive case exists for "${dimensionId}"` : undefined),
    falsePositiveRate: computeRate(falsePositive, falsePositive + trueNegative, falsePositive + trueNegative === 0 ? `no proven, judged prescriptive case exists for "${dimensionId}"` : undefined),
    needsReviewRouting: computeRate(routingNeedsReview, routingAttempts, routingAttempts === 0 ? `no proven, sampled case produced a judged-or-needs-review outcome for "${dimensionId}"` : undefined),
    calibration: computeSampled(calibrationValues, `no proven, sampled case designated to "${dimensionId}" produced a validated probability distribution`),
    cost: computeSampled(costValues, `no proven, sampled case is designated to "${dimensionId}"`),
    latency: computeSampled(latencyValues, `no proven, sampled case designated to "${dimensionId}" recorded a latency`),
    stability: computeStability(provenByCase, designatedCaseIds, dimensionId, runCount),
  };
}

/**
 * Computes the full per-dimension metrics report from one or more already-loaded benchmark runs.
 * See this module's own doc for the sample-count discipline, the proven/unproven/not-sampled
 * split, and the closed operator -> dimension attribution this is built on.
 */
export function computeBenchmarkMetricsReport(runs: readonly BenchmarkMetricsRun[]): BenchmarkMetricsReport {
  const { proven, unproven, notSampled } = collectProvenCases(runs);

  const provenByCase = new Map<string, ProvenCaseEntry[]>();
  for (const entry of proven) {
    const existing = provenByCase.get(entry.caseId) ?? [];
    existing.push(entry);
    provenByCase.set(entry.caseId, existing);
  }

  return {
    runsConsidered: runs.length,
    provenCaseCount: provenByCase.size,
    unprovenCases: unproven,
    notSampledCases: notSampled,
    dimensions: RUBRIC_DIMENSION_IDS.map((dimensionId) => computeDimensionReport(dimensionId, proven, provenByCase, runs.length)),
  };
}
