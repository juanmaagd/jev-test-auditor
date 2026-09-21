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
 *
 * **Independent samples (confirmed defect, fixed after P7-4 shipped).**
 * `MIN_SAMPLE_FOR_RATE` exists to guard against too few *cases* — repeating
 * the SAME case (a stability run resamples the identical corpus, up to five
 * times) adds no independent evidence about the dimension, only about that
 * one case's own run-to-run consistency, which {@link BenchmarkMetricsDimensionReport.stability}
 * already reports on its own terms. The first P7-4 implementation computed
 * precision/recall/falsePositiveRate/needsReviewRouting/calibration with a
 * denominator counting samples (case x run) rather than distinct cases: one
 * case measured five times cleared `MIN_SAMPLE_FOR_RATE` and printed a
 * confident `5/5 (100.0%)` from a single observation — exactly the "coin
 * flip printed to two decimals" this module's own threshold exists to
 * prevent, and self-concealing besides, since a larger corpus (this phase's
 * own 35-70 case target) makes an inflated denominator look plausible rather
 * than obviously wrong. Fixed here: every accuracy metric above
 * (`precision`, `recall`, `falsePositiveRate`, `needsReviewRouting`,
 * `calibration`) is computed over {@link BenchmarkMetricsDimensionReport.provenCaseCount}
 * DISTINCT proven cases, never {@link BenchmarkMetricsDimensionReport.designatedSampleCount}
 * samples — `cost`, `latency`, and `stability` are deliberately UNCHANGED
 * (still per-sample), since for those three, repeated measurement genuinely
 * IS what is being measured (a case's five separate API calls have five
 * separate real costs and latencies; run-to-run agreement is stability's own
 * subject).
 *
 * **The collapse rule, chosen and justified, not left implicit.** A case
 * proven+sampled in N runs contributes N repeated judgments for a given
 * dimension; these must fold into exactly ONE observation before entering
 * precision/recall/falsePositiveRate/needsReviewRouting (calibration is
 * handled separately below). {@link majorityVerdict} takes the STRICT
 * PLURALITY across a case's repetitions — for a two-way vote (deficient vs.
 * healthy; needs-review vs. judged) this is an ordinary majority. Majority
 * vote is chosen over strict unanimity because unanimity would discard
 * exactly the case this task's own instructions named as the motivating
 * example ("judged deficient in three runs and healthy in two") — a 3-vs-2
 * split has a real, dominant answer, and discarding it wastes the very
 * repeated measurement the corpus paid for. Majority vote is chosen over
 * "disagreement as its own outcome" because a third confusion-matrix bucket
 * has no principled TP/FP/FN/TN slot to land in without inventing new policy
 * this task did not authorize (`src/domain/classification.ts` already owns
 * per-sample policy; this module only aggregates). The vote's ELECTORATE is
 * `judged` repetitions only for the accuracy vote (a repetition that itself
 * came back `needs-review` or `not-applicable` abstains — matching the prior
 * per-sample code's own skip of non-`judged` statuses) and non-`not-applicable`
 * repetitions for the routing vote (matching that metric's own prior
 * per-sample exclusion). An EXACT TIE (no strict plurality — only possible
 * when the electorate is even, since ties are structurally impossible across
 * an odd count with two categories) has no principled majority to report:
 * the case is EXCLUDED from that metric — never defaulted to either side —
 * and reported in {@link BenchmarkMetricsDimensionReport.splitVerdictCases},
 * mirroring this module's own `unprovenCases`/`notSampledCases` discipline of
 * disclosing an exclusion rather than silently shrinking a denominator.
 *
 * **Calibration's collapse is a mean, not a vote — a different, genuinely
 * distinct semantic change from the confusion-matrix metrics above.**
 * `deficientMass` is a continuous probability, not a category, so there is
 * no majority to take; a case's repeated `deficientMass` observations are
 * averaged into one MEAN mass first, and the Brier score is computed once
 * against that mean (`(meanMass - groundTruthIndicator)^2`) — never the mean
 * of N per-repetition Brier scores, which is a DIFFERENT number whenever the
 * repetitions disagree (mean-then-square is not square-then-mean; the gap
 * between them is exactly the variance of `deficientMass` across
 * repetitions — the same variance {@link BenchmarkMetricsDimensionReport.stability}
 * already reports on its own terms, so folding it into calibration too would
 * double-count it). `calibration.sampleCount` is therefore a DISTINCT CASE
 * count, unlike `cost.sampleCount`/`latency.sampleCount`, which remain
 * genuine per-sample counts — see each field's own doc.
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
  /** Distinct proven case ids (across every given run) whose declared operator maps to this dimension — never a per-run or per-sample count. This is the denominator {@link MIN_SAMPLE_FOR_RATE} is actually judged against for precision/recall/falsePositiveRate/calibration below (see this module's own "Independent samples" doc section) — never {@link designatedSampleCount}. */
  readonly provenCaseCount: number;
  /**
   * Total samples (case x run pairs, across every given run) among the cases designated to this
   * dimension — always `>= provenCaseCount`, and strictly greater whenever a designated case was
   * proven+sampled in more than one of the given runs. Reported so a caller can never mistake
   * `provenCaseCount` (the independent-observation count precision/recall/falsePositiveRate/
   * calibration are actually computed over) for the larger, repetition-inflated sample count — see
   * this module's own "Independent samples" doc section for the defect this distinction exists to
   * prevent. `needsReviewRouting` pools a WIDER case set than `provenCaseCount`/this field (every
   * proven+sampled case, not only this dimension's designated ones — see that field's own doc);
   * its own `RateMetric.denominator` is the case count that matters for it.
   */
  readonly designatedSampleCount: number;
  readonly precision: RateMetric;
  readonly recall: RateMetric;
  readonly falsePositiveRate: RateMetric;
  /** Pools every proven+sampled case's judgment of THIS dimension, regardless of which dimension that case was designed to test (Jev judges all seven dimensions per sample) — see this module's own doc for why this denominator can exceed `provenCaseCount`. Computed over distinct cases exactly like the accuracy metrics above (see "Independent samples"): `denominator` counts cases, not case x run samples. */
  readonly needsReviewRouting: RateMetric;
  /** Mean Brier score (`(deficientMass - groundTruthIndicator)^2`, lower is better) against this dimension's own designated proven+sampled cases, one score per DISTINCT case: each case's own repetitions are first averaged into one mean `deficientMass`, then squared against ground truth once (Brier-of-the-mean, not mean-of-the-Briers — see "Independent samples"). Includes `needs-review` (`boundary-straddle`) judgments, since a validated `deficientMass` reflects the model's stated probability regardless of whether the policy's boundary-mass gate happened to clear. `sampleCount` here is a DISTINCT CASE count, unlike `cost`/`latency` below where it is a genuine sample count — see those fields' own docs. */
  readonly calibration: SampledMetric;
  /** Mean USD cost per SAMPLE (case x run) designated to this dimension (input tokens only — Jev's output tokens are unbilled; see {@link JEV_ESTIMATE_SNAPSHOT}). Deliberately NOT collapsed by case — every repeated call has its own real, independent cost; see this module's own "Independent samples" doc section for why this metric is excluded from that collapse. `sampleCount` is a genuine sample count here. */
  readonly cost: SampledMetric;
  /** Mean latency in milliseconds, over SAMPLES (case x run) that recorded one (`latencyMs` is optional on {@link BenchmarkSampleRecord}). Deliberately NOT collapsed by case, for the same reason as `cost` above. `sampleCount` is a genuine sample count here. */
  readonly latency: SampledMetric;
  /** Pairwise agreement rate on this dimension's judgment across every pair of the given runs, pooled over this dimension's designated cases — `'not-computable'` with fewer than two runs. Deliberately still computed over samples (run pairs), never collapsed by case: run-to-run agreement across repetitions is exactly what this metric measures, so collapsing repetitions here would erase its own subject. */
  readonly stability: RateMetric;
  /**
   * Cases designated to this dimension whose repetitions produced an exact tie under this
   * module's majority-vote collapse (see "Independent samples") — for the accuracy confusion
   * matrix, or, for a case pooled into `needsReviewRouting`, that routing vote. A tied case is
   * excluded from the metric(s) named in its own `reasons`, never guessed at by picking a side
   * arbitrarily; distinct from `unprovenCases`/`notSampledCases` at the report's top level (those
   * are excluded because no evidence exists at all — a split-verdict case has evidence, but that
   * evidence does not agree with itself).
   */
  readonly splitVerdictCases: readonly BenchmarkSplitVerdictCaseSummary[];
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

/** See {@link BenchmarkMetricsDimensionReport.splitVerdictCases}. */
export interface BenchmarkSplitVerdictCaseSummary {
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

  return { proven, unproven: summarizeCaseReasons(unprovenReasons), notSampled: summarizeCaseReasons(notSampledReasons) };
}

/** Shared by every case-keyed, reason-collecting summary this module builds (`unprovenCases`, `notSampledCases`, `splitVerdictCases`) — deterministic order, reasons deduplicated and sorted. */
function summarizeCaseReasons(map: ReadonlyMap<string, ReadonlySet<string>>): readonly { readonly caseId: string; readonly reasons: readonly string[] }[] {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([caseId, reasons]) => ({ caseId, reasons: [...reasons].sort() }));
}

/** Groups already-proven case entries by `caseId`, preserving each caseId's own run order — the shared grouping both the accuracy/calibration collapse and the needs-review-routing collapse fold repetitions over (see this module's own "Independent samples" doc section). */
function groupByCaseId(entries: readonly ProvenCaseEntry[]): ReadonlyMap<string, readonly ProvenCaseEntry[]> {
  const grouped = new Map<string, ProvenCaseEntry[]>();
  for (const entry of entries) {
    const existing = grouped.get(entry.caseId) ?? [];
    existing.push(entry);
    grouped.set(entry.caseId, existing);
  }
  return grouped;
}

/**
 * Collapses N repeated categorical votes cast by one case's separate repetitions into a single
 * verdict: the value with a STRICT plurality (strictly more votes than every other distinct
 * value present). Returns `undefined` when no value holds a strict plurality — an exact tie among
 * the top vote-getters — which every caller treats as EXCLUDED from the metric it would otherwise
 * feed, never defaulted to either side; see this module's own "Independent samples" doc section
 * for the full justification.
 */
function majorityVerdict<T>(votes: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  let winner: T | undefined;
  let winnerCount = 0;
  let tied = false;
  for (const [value, count] of counts) {
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
      tied = false;
    } else if (count === winnerCount) {
      tied = true;
    }
  }
  return tied ? undefined : winner;
}

/** Renders a boolean vote breakdown for a {@link BenchmarkSplitVerdictCaseSummary} reason — e.g. `"2 deficient / 2 healthy"`. */
function voteTally(votes: readonly boolean[], trueLabel: string, falseLabel: string): string {
  const trueCount = votes.filter(Boolean).length;
  return `${trueCount} ${trueLabel} / ${votes.length - trueCount} ${falseLabel}`;
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
  const designatedByCase = groupByCaseId(designated);

  let hasPrescriptive = false;
  let hasDescriptive = false;
  const costValues: number[] = [];
  const latencyValues: number[] = [];

  // Cost and latency stay computed over SAMPLES (case x run), never collapsed by case — repeated
  // measurement genuinely IS what these two are measuring (see this module's own "Independent
  // samples" doc section). Deliberately a separate, flat loop from the per-case accuracy/
  // calibration collapse below.
  for (const entry of designated) {
    if (entry.operatorRole === 'prescriptive') hasPrescriptive = true;
    else hasDescriptive = true;

    const sample = entry.outcome.sample;
    if (sample === undefined) continue;
    costValues.push(sampleCostUsd(sample.usage));
    if (sample.latencyMs !== undefined) latencyValues.push(sample.latencyMs);
  }

  // Precision/recall/falsePositiveRate/calibration: ONE observation per DISTINCT case (see this
  // module's own "Independent samples" doc section) — a case's repeated judgments are collapsed
  // by majority vote (confusion matrix) or mean (calibration's continuous `deficientMass`) before
  // entering these counters, never counted once per repetition.
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  const calibrationValues: number[] = [];
  const splitVerdictReasons = new Map<string, Set<string>>();

  const addSplitVerdictReason = (caseId: string, reason: string): void => {
    const reasons = splitVerdictReasons.get(caseId) ?? new Set<string>();
    reasons.add(reason);
    splitVerdictReasons.set(caseId, reasons);
  };

  for (const [caseId, repetitions] of designatedByCase) {
    const operatorRole = repetitions[0]!.operatorRole;
    const truth = groundTruthDeficient(operatorRole);

    const accuracyVotes: boolean[] = [];
    const massValues: number[] = [];
    for (const entry of repetitions) {
      if (entry.outcome.sample === undefined) continue;
      const dimension = findDimension(entry.outcome, dimensionId);
      if (dimension === undefined) continue;
      if (dimension.deficientMass !== undefined) massValues.push(dimension.deficientMass);
      if (dimension.status !== 'judged') continue;
      const predictedDeficient = isDeficientLevel(dimension.level);
      if (predictedDeficient !== undefined) accuracyVotes.push(predictedDeficient);
    }

    if (accuracyVotes.length > 0) {
      const majority = majorityVerdict(accuracyVotes);
      if (majority === undefined) {
        addSplitVerdictReason(caseId, `"${dimensionId}" accuracy vote tied (${voteTally(accuracyVotes, 'deficient', 'healthy')}) across ${accuracyVotes.length} judged repetition(s) — excluded from precision/recall/false-positive-rate`);
      } else if (majority && truth) truePositive += 1;
      else if (majority && !truth) falsePositive += 1;
      else if (!majority && truth) falseNegative += 1;
      else trueNegative += 1;
    }

    if (massValues.length > 0) {
      const meanMass = massValues.reduce((sum, value) => sum + value, 0) / massValues.length;
      calibrationValues.push((meanMass - (truth ? 1 : 0)) ** 2);
    }
  }

  // Needs-review routing pools EVERY proven+sampled case's judgment of this dimension, regardless
  // of that case's own designated dimension — routing needs no ground truth, so it is not limited
  // to `designated` the way the accuracy metrics above are (see this module's own doc). Computed
  // over distinct cases exactly like the accuracy metrics above: each case's repeated routing
  // outcomes are collapsed by majority vote before entering these counters.
  let routingNeedsReview = 0;
  let routingAttempts = 0;
  for (const [caseId, repetitions] of provenByCase) {
    const routingVotes: boolean[] = [];
    for (const entry of repetitions) {
      const dimension = findDimension(entry.outcome, dimensionId);
      if (dimension === undefined) continue;
      if (dimension.status === 'not-applicable') continue;
      routingVotes.push(dimension.status === 'needs-review');
    }
    if (routingVotes.length === 0) continue;
    const majority = majorityVerdict(routingVotes);
    if (majority === undefined) {
      addSplitVerdictReason(caseId, `"${dimensionId}" needs-review routing vote tied (${voteTally(routingVotes, 'needs-review', 'judged')}) across ${routingVotes.length} applicable repetition(s) — excluded from needs-review routing`);
      continue;
    }
    routingAttempts += 1;
    if (majority) routingNeedsReview += 1;
  }

  const noNegativeClassReason = hasDescriptive && !hasPrescriptive
    ? `no prescriptive (good-control) proven case exists for "${dimensionId}" in the given run(s); precision/false-positive rate need a negative-class case to mean anything`
    : undefined;

  return {
    dimensionId,
    designatedSampleCount: designated.filter((entry) => entry.outcome.sample !== undefined).length,
    splitVerdictCases: summarizeCaseReasons(splitVerdictReasons),
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
  const provenByCase = groupByCaseId(proven);

  return {
    runsConsidered: runs.length,
    provenCaseCount: provenByCase.size,
    unprovenCases: unproven,
    notSampledCases: notSampled,
    dimensions: RUBRIC_DIMENSION_IDS.map((dimensionId) => computeDimensionReport(dimensionId, proven, provenByCase, runs.length)),
  };
}
