/**
 * Deterministic, non-compensatory classification (Phase 4, task P4-3; boundary-mass
 * gate added by `odd/tasks/classification-calibration.md` task C-1): turns
 * one normalized {@link JevEvaluation} into a per-dimension judgment, an
 * overall verdict, and findings — all pure code, no Node imports, no adapter
 * imports, no network. Jev supplies bounded probabilities and scores; this
 * module composes the actual decision (PRD principle 5, "Code owns policy").
 *
 * PROVISIONAL THRESHOLDS — READ BEFORE CHANGING: every numeric threshold on
 * {@link ClassificationPolicyV1} and {@link ClassificationPolicyV2} is an
 * uncalibrated guess versioned with the rubric (`odd/tasks/phase-4-jev-evaluation.md`
 * Decisions: "Thresholds are provisional data versioned with the rubric, not
 * calibrated claims"; `odd/tasks/classification-calibration.md` Scope: "Thresholds
 * stay provisional and versioned; no calibrated-accuracy claim may appear
 * anywhere"). Nothing in this file, its tests, or any caller may imply these
 * numbers were validated against real outcomes — Phase 7's deterministic
 * benchmark corpus is what calibrates them (PRD "Rules are hypotheses"). A
 * future recalibration is a new policy version, e.g. `CLASSIFICATION_POLICY_V3`,
 * never a silent edit of a shipped policy constant.
 *
 * `CLASSIFICATION_POLICY_V1` gated a dimension's quality on `confidence`, a
 * measure of concentration on a single level — which reads as "uncertain"
 * even when both a level's neighbours sit on the same side of the only
 * boundary a verdict depends on (deficient vs. acceptable). Measured on the
 * discrimination fixture and the pr-hero subset (2026-09-20), this produced
 * `needs-review` for dimensions Jev actually judged clearly (see the task
 * doc's "Measured evidence"). `CLASSIFICATION_POLICY_V2` replaces that gate
 * with {@link judgeDimensionV2}'s boundary-mass decision, computed directly
 * from the quality answer's `probabilities` distribution across the four
 * {@link CLASSIFICATION_LEVELS} instead of from `confidence`.
 * `CLASSIFICATION_POLICY_V1` and its code path (`judgeDimensionV1`) are kept
 * — exported, still validated, still covered by their original tests — as a
 * historical artifact; nothing in this codebase constructs one anymore.
 */
import type { JevAnswer, JevEvaluation, JevUsage } from './jev-gateway.js';
import { validateRubric, type Rubric, type RubricDimensionId } from './rubric.js';
import type { TestCaseId } from './test-understanding.js';

/** The four ordered quality levels a judged dimension may land on (PRD "Global classification"). Lower-case, distinct from the wire-facing, capitalized {@link RUBRIC_QUALITY_LEVELS} in `rubric.ts`. */
export const CLASSIFICATION_LEVELS = ['misleading', 'weak', 'acceptable', 'strong'] as const;

export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number];

const CLASSIFICATION_LEVEL_SET: ReadonlySet<string> = new Set(CLASSIFICATION_LEVELS);

/** The overall, non-compensatory verdict for one test case (PRD "Global classification"). */
export type OverallClassificationStatus = 'healthy' | 'weak' | 'misleading' | 'needs-review';

/**
 * Why a dimension could not be judged even though it is (or might be)
 * applicable. `low-confidence` is produced only by {@link judgeDimensionV1}
 * (`CLASSIFICATION_POLICY_V1`'s retired confidence gate). `missing-answer`
 * covers an absent, wrong-shaped, or — for {@link judgeDimensionV2} — a
 * `probabilities` map that does not validate (see {@link extractProbabilityQuartet}):
 * a malformed distribution is never guessed at, so it is reported exactly
 * like a missing one. `boundary-straddle` is produced only by
 * {@link judgeDimensionV2}: the probability mass did not clear
 * `sideMin` on either side of the deficient/acceptable boundary.
 */
export type DimensionNeedsReviewReason = 'low-confidence' | 'missing-answer' | 'boundary-straddle';

export type DimensionJudgmentStatus = 'judged' | 'not-applicable' | 'needs-review';

/**
 * Three ascending cut points separating the four {@link CLASSIFICATION_LEVELS}
 * over the weighted quality `score` (nominally 0..3), shared by both policy
 * versions. Boundary convention — left-closed, right-open, with the top
 * level unbounded above:
 *   - `score < levelCutPoints[0]` → `misleading`
 *   - `levelCutPoints[0] <= score < levelCutPoints[1]` → `weak`
 *   - `levelCutPoints[1] <= score < levelCutPoints[2]` → `acceptable`
 *   - `score >= levelCutPoints[2]` → `strong`
 * A score exactly at a cut point belongs to the HIGHER level. This is a
 * deliberate alternative to naive nearest-level rounding (which would put
 * the boundaries at `levelCutPoints[i] - 0.5`): Phase 4 Decisions reject
 * rounding by name ("a score below 0.5 distance from the next level is not
 * rounded ... the policy compares the weighted score against fixed cut
 * points"), so `CLASSIFICATION_POLICY_V1` places each cut point at a
 * level's own index (1, 2, 3) — reaching level N requires the
 * probability-weighted score to actually reach N, not merely round to it,
 * which is the more conservative (harder to over-credit) of the two
 * reasonable readings and fits PRD principle 3, "Uncertainty is not
 * quality." `judgeDimensionV2` only ever consults `levelCutPoints[2]`
 * (the `acceptable`/`strong` split): see {@link ClassificationPolicyV2}.
 */
type LevelCutPoints = readonly [number, number, number];

/**
 * `CLASSIFICATION_POLICY_V1`'s shape (Phase 4, task P4-3): gates a
 * dimension's quality on `confidence`, a measure of how concentrated the
 * answer's probability mass is on a single level. See the module doc's
 * PROVISIONAL THRESHOLDS notice and {@link judgeDimensionV1}. Superseded for
 * new callers by {@link ClassificationPolicyV2} (task C-1 of
 * `odd/tasks/classification-calibration.md`); kept only as a historical,
 * still-validated, still-tested artifact.
 */
export interface ClassificationPolicyV1 {
  readonly version: number;
  readonly rubricVersion: number;
  /** A dimension's applicability `noul` probability must be at least this to count as applicable (`>=`, not `>`). */
  readonly applicabilityMin: number;
  /** A dimension's quality `confidence` must be at least this to use its score (`>=`, not `>`). */
  readonly confidenceMin: number;
  readonly levelCutPoints: LevelCutPoints;
  /** The level whose presence in any applicable, judged dimension forces the overall verdict to `misleading` (PRD: "A strong score in one dimension cannot cancel a critical failure in another"). */
  readonly criticalLevel: ClassificationLevel;
}

/**
 * `CLASSIFICATION_POLICY_V2`'s shape (task C-1 of
 * `odd/tasks/classification-calibration.md`): replaces `confidence` gating
 * with a decision taken directly from the quality answer's `probabilities`
 * distribution across the four {@link CLASSIFICATION_LEVELS} — see
 * {@link judgeDimensionV2}. The verdict only ever depends on one boundary,
 * deficient (`misleading`/`weak`) versus acceptable (`acceptable`/`strong`),
 * so the gate asks whether the mass falls decisively on one side of that
 * boundary rather than whether it concentrates on one level.
 */
export interface ClassificationPolicyV2 {
  readonly version: number;
  readonly rubricVersion: number;
  /** A dimension's applicability `noul` probability must be at least this to count as applicable (`>=`, not `>`). Same gate and threshold as {@link ClassificationPolicyV1.applicabilityMin} — task C-1 does not change applicability (task C-2 does). */
  readonly applicabilityMin: number;
  /**
   * A dimension is `deficient` when `P(level <= weak) >= sideMin`, and
   * `acceptable` when `P(level >= acceptable) >= sideMin` (`>=`, not `>`).
   * Must be strictly greater than `0.5` (enforced by
   * {@link validateClassificationPolicy}): at `0.5` a perfectly even split
   * (e.g. `{0: 0.25, 1: 0.25, 2: 0.25, 3: 0.25}`) would clear *both* sides
   * at once, since the two masses are complementary (`deficientMass +
   * acceptableMass === 1`) and can only both reach a threshold that low.
   * Neither side clearing `sideMin` is reported `needs-review` with reason
   * `boundary-straddle`.
   */
  readonly sideMin: number;
  /**
   * A `deficient` dimension is reported `misleading` only when
   * `P(misleading) >= criticalMin` (`>=`, not `>`); otherwise it is `weak`.
   * This keeps a critical accusation from resting on a distribution that is
   * merely deficient overall — e.g. `{0: 0.01, 1: 0.99, 2: 0, 3: 0}` is
   * decisively deficient (deficientMass 1.0) but the mass is almost
   * entirely on `weak`, not `misleading`.
   */
  readonly criticalMin: number;
  /**
   * Reused only for the `acceptable`-vs-`strong` split reported for an
   * already-acceptable dimension (index `[2]`, the `strong` cut point);
   * indices `[0]` and `[1]` (the `misleading`/`weak` boundaries) are not
   * consulted by {@link judgeDimensionV2}, since that boundary is now
   * decided by `sideMin`/`criticalMin` on the probability mass instead.
   * Kept as the same three-cut-point shape as {@link ClassificationPolicyV1}
   * for validation symmetry and so a report can compare the two versions'
   * nominal score bands directly.
   */
  readonly levelCutPoints: LevelCutPoints;
  /** The level whose presence in any applicable, judged dimension forces the overall verdict to `misleading` (PRD: "A strong score in one dimension cannot cancel a critical failure in another"). */
  readonly criticalLevel: ClassificationLevel;
}

/**
 * Versioned, provisional classification thresholds (see the module doc's
 * PROVISIONAL THRESHOLDS notice). `rubricVersion` pins which {@link Rubric}
 * version this policy's cut points were chosen against — {@link classifyEvaluation}
 * fails closed on a mismatch, since cut points chosen for one rubric's
 * question wording carry no guarantee against a different one. A
 * {@link ClassificationPolicyV2} is told apart from a
 * {@link ClassificationPolicyV1} structurally (see {@link isClassificationPolicyV2}),
 * not by `version` number, since `version` is deliberately generic (so a
 * deliberately-invalid test policy can still set it to `0` or `1.5`).
 */
export type ClassificationPolicy = ClassificationPolicyV1 | ClassificationPolicyV2;

/** Structural discriminator: a {@link ClassificationPolicyV2} is the only variant with `sideMin`. */
export function isClassificationPolicyV2(policy: ClassificationPolicy): policy is ClassificationPolicyV2 {
  return 'sideMin' in policy;
}

/**
 * The shipped, provisional Phase 4 policy. See the module doc's PROVISIONAL
 * THRESHOLDS notice — none of these numbers carry an accuracy claim. Kept as
 * a historical artifact (see the module doc); nothing in this codebase
 * constructs a {@link ClassificationPolicyV1} anymore.
 */
export const CLASSIFICATION_POLICY_V1: ClassificationPolicyV1 = {
  version: 1,
  rubricVersion: 1,
  applicabilityMin: 0.5,
  confidenceMin: 0.6,
  levelCutPoints: [1, 2, 3],
  criticalLevel: 'misleading',
};

/**
 * The shipped, provisional task-C-1 policy (`odd/tasks/classification-calibration.md`).
 * `sideMin` and `criticalMin` are chosen from the gaps actually observed in
 * the 2026-09-20 discrimination-fixture recording
 * (`test/fixtures/recorded/discrimination-raw-2026-09-20.json`, replayed by
 * `test/classification-replay.test.ts`) — they are still provisional
 * guesses, not a calibrated fit, and are picked mid-gap rather than hugging
 * either edge so a slightly different capture does not immediately cross
 * them:
 *
 * - `sideMin: 0.65`. Across every applicable, scored dimension of the 8
 *   deliberately bad recorded tests, the highest deficientMass that still
 *   straddled both sides (neither decisively deficient nor acceptable) was
 *   `0.58` (`calls subtotal once during checkout` / `assertion-strength`,
 *   `{0.19, 0.39, 0.38, 0.04}`), and the lowest deficientMass that was
 *   decisively on one side was `0.71` (`records history across runs` /
 *   `falsifiability`, `{0.06, 0.65, 0.26, 0.03}`). `0.65` sits near the
 *   middle of that `(0.58, 0.71]` gap rather than at its `0.71` edge, so it
 *   is not riding the single closest recorded data point. Separately, every
 *   applicable, scored dimension of the 3 good recorded tests had an
 *   acceptableMass of at least `0.81`, comfortably above `0.65`.
 * - `criticalMin: 0.5`. Among the 20 dimensions the fixture makes
 *   decisively deficient (deficientMass `>= sideMin`), the observed
 *   `P(misleading)` values cluster into two bands with a gap between them:
 *   `0`–`0.26` (merely deficient — the mass leans `weak`, not `misleading`;
 *   highest observed `0.26`, `works` / `falsifiability`) and `0.78`–`1.0`
 *   (overwhelmingly `misleading`; lowest observed `0.78`, `calls subtotal
 *   once during checkout` / `refactor-resistance`). `0.5` sits in that gap
 *   and reads naturally as "more likely `misleading` than not."
 *
 * No accuracy claim is made for either number; `odd/tasks/classification-calibration.md`
 * task C-3 re-measures this policy against the live pr-hero subset.
 */
export const CLASSIFICATION_POLICY_V2: ClassificationPolicyV2 = {
  version: 2,
  rubricVersion: 1,
  applicabilityMin: 0.5,
  sideMin: 0.65,
  criticalMin: 0.5,
  levelCutPoints: [1, 2, 3],
  criticalLevel: 'misleading',
};

/**
 * How far a quality answer's four `probabilities` may sum from exactly `1`
 * before {@link judgeDimensionV2} treats the distribution as malformed
 * (`needs-review`, reason `missing-answer`) rather than trusting it.
 * `0.02` is chosen, not an arbitrarily tight epsilon, because the provider
 * reports each probability rounded to 2 decimal places: four independently
 * rounded values can legitimately sum to anywhere in `[0.98, 1.02]` (at most
 * `0.005` of rounding error each, `4 * 0.005 = 0.02` in the worst case).
 * Every quality answer in the 2026-09-20 discrimination-fixture recording
 * actually sums to `1` within floating-point epsilon (`~1e-16`), so this
 * tolerance is deliberately looser than anything observed — it exists to
 * absorb legitimate provider rounding on a future response, not to explain
 * away the recorded evidence, and it is still far tighter than treating a
 * genuinely malformed distribution (e.g. one summing to `0.5`) as valid.
 */
export const PROBABILITY_SUM_TOLERANCE = 0.02;

function isUnitProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateLevelCutPoints(levelCutPoints: LevelCutPoints): void {
  const [first, second, third] = levelCutPoints;
  for (const cutPoint of [first, second, third]) {
    if (!Number.isFinite(cutPoint)) {
      throw new RangeError(`Classification policy levelCutPoints must all be finite numbers: ${JSON.stringify(levelCutPoints)}`);
    }
  }
  if (!(first < second && second < third)) {
    throw new RangeError(`Classification policy levelCutPoints must be strictly ascending: ${JSON.stringify(levelCutPoints)}`);
  }
}

/**
 * Validates a {@link ClassificationPolicy} deterministically, throwing
 * `RangeError` on the first violation found. Shared across both versions:
 * positive integer `version` and `rubricVersion`, `applicabilityMin` within
 * `[0, 1]`, exactly three finite, strictly ascending `levelCutPoints`, and a
 * `criticalLevel` drawn from {@link CLASSIFICATION_LEVELS}. Version-specific:
 * a {@link ClassificationPolicyV1} additionally requires `confidenceMin`
 * within `[0, 1]`; a {@link ClassificationPolicyV2} additionally requires
 * `criticalMin` within `[0, 1]` and `sideMin` strictly greater than `0.5`
 * and at most `1` (see {@link ClassificationPolicyV2.sideMin} for why `0.5`
 * itself is rejected).
 */
export function validateClassificationPolicy(policy: ClassificationPolicy): void {
  if (!Number.isInteger(policy.version) || policy.version <= 0) {
    throw new RangeError(`Classification policy version must be a positive integer: ${policy.version}`);
  }
  if (!Number.isInteger(policy.rubricVersion) || policy.rubricVersion <= 0) {
    throw new RangeError(`Classification policy rubricVersion must be a positive integer: ${policy.rubricVersion}`);
  }
  if (!isUnitProbability(policy.applicabilityMin)) {
    throw new RangeError(`Classification policy applicabilityMin must be a finite number within [0, 1]: ${policy.applicabilityMin}`);
  }
  validateLevelCutPoints(policy.levelCutPoints);
  if (!CLASSIFICATION_LEVEL_SET.has(policy.criticalLevel)) {
    throw new RangeError(`Classification policy criticalLevel must be one of ${JSON.stringify(CLASSIFICATION_LEVELS)}: got "${policy.criticalLevel}"`);
  }

  if (isClassificationPolicyV2(policy)) {
    if (!(policy.sideMin > 0.5) || policy.sideMin > 1) {
      throw new RangeError(
        `Classification policy sideMin must be greater than 0.5 (so deficient and acceptable masses cannot both `
        + `clear it) and at most 1: ${policy.sideMin}`,
      );
    }
    if (!isUnitProbability(policy.criticalMin)) {
      throw new RangeError(`Classification policy criticalMin must be a finite number within [0, 1]: ${policy.criticalMin}`);
    }
    return;
  }

  if (!isUnitProbability(policy.confidenceMin)) {
    throw new RangeError(`Classification policy confidenceMin must be a finite number within [0, 1]: ${policy.confidenceMin}`);
  }
}

/** Identifies the test case a {@link ClassificationResult} judges — taken directly from the caller, never re-derived from evidence or run state. */
export interface ClassificationTestCaseIdentity {
  readonly testCaseId: TestCaseId;
  readonly repositoryRelativePath: string;
  readonly name: string;
}

/**
 * One dimension's judgment. Every field the interface promises is always
 * present as a key; `level`/`score`/`confidence`/`applicabilityProbability`/
 * `reason`/`probabilities`/`deficientMass`/`acceptableMass`/`criticalMass`
 * are typed `T | undefined` (not optional) so `exactOptionalPropertyTypes`
 * still lets this file assign `undefined` explicitly when a value truly
 * was not judged, invented, or observed — never a placeholder like `0` or
 * an empty string standing in for "unknown".
 *
 * `probabilities`/`deficientMass`/`acceptableMass`/`criticalMass` are
 * populated only by {@link judgeDimensionV2}, and only once the quality
 * answer's distribution validates (see {@link extractProbabilityQuartet}):
 * they let a reader of the JSON report audit exactly which mass produced
 * this verdict, per `odd/tasks/classification-calibration.md` task C-1's
 * "Expose per-level probabilities in the report" requirement. They are
 * always `undefined` for a {@link judgeDimensionV1} judgment (kept
 * `undefined`, never omitted, for the same reason as the other optional
 * fields — `JSON.stringify` drops an `undefined`-valued key either way, so
 * this changes nothing about `--evaluate --json`'s existing output when
 * `CLASSIFICATION_POLICY_V1` is used). `probabilities` is always the
 * canonical `{"0", "1", "2", "3"}` object (in that key order) built fresh
 * from the validated quartet, never the provider's own map passed through —
 * so `JSON.stringify` stays deterministic regardless of the key order a
 * future response happens to use.
 */
export interface DimensionJudgment {
  readonly dimensionId: RubricDimensionId;
  readonly dimensionLabel: string;
  readonly applicable: boolean;
  readonly applicabilityProbability: number | undefined;
  readonly level: ClassificationLevel | undefined;
  readonly score: number | undefined;
  readonly confidence: number | undefined;
  readonly status: DimensionJudgmentStatus;
  readonly reason: DimensionNeedsReviewReason | undefined;
  readonly probabilities: Readonly<Record<'0' | '1' | '2' | '3', number>> | undefined;
  readonly deficientMass: number | undefined;
  readonly acceptableMass: number | undefined;
  readonly criticalMass: number | undefined;
}

/** One finding, carrying both the judgment detail and the identifiers a report needs — taken from the caller's {@link ClassificationTestCaseIdentity}, never looked up by this module. Carries the same `probabilities`/mass fields as {@link DimensionJudgment} (see its doc), so a finding is self-contained for audit without cross-referencing the full `dimensions` array. */
export interface ClassificationFinding {
  readonly testCaseId: TestCaseId;
  readonly repositoryRelativePath: string;
  readonly name: string;
  readonly dimensionId: RubricDimensionId;
  readonly dimensionLabel: string;
  readonly level: ClassificationLevel | undefined;
  readonly score: number | undefined;
  readonly confidence: number | undefined;
  readonly applicabilityProbability: number | undefined;
  readonly status: DimensionJudgmentStatus;
  readonly reason: DimensionNeedsReviewReason | undefined;
  readonly probabilities: Readonly<Record<'0' | '1' | '2' | '3', number>> | undefined;
  readonly deficientMass: number | undefined;
  readonly acceptableMass: number | undefined;
  readonly criticalMass: number | undefined;
}

/**
 * The full result of classifying one evaluation. `dimensions` and `findings`
 * are always sorted by `dimensionId` regardless of rubric or answer input
 * order (see {@link classifyEvaluation}), so `JSON.stringify` on this record
 * is deterministic for logically-equivalent inputs — the stability reports
 * and a future cache (Phase 5) depend on.
 */
export interface ClassificationResult {
  readonly testCaseId: TestCaseId;
  readonly repositoryRelativePath: string;
  readonly name: string;
  readonly status: OverallClassificationStatus;
  readonly dimensions: readonly DimensionJudgment[];
  readonly findings: readonly ClassificationFinding[];
  readonly policyVersion: number;
  readonly rubricVersion: number;
  readonly model: {
    readonly requested: string;
    readonly responded: string;
    readonly matchesPin: boolean;
  };
  readonly usage: JevUsage;
}

export interface ClassifyEvaluationInput {
  readonly testCase: ClassificationTestCaseIdentity;
  readonly evaluation: JevEvaluation;
  readonly rubric: Rubric;
  readonly policy: ClassificationPolicy;
}

function compareDimensionIds(left: RubricDimensionId, right: RubricDimensionId): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function levelForScore(score: number, cutPoints: LevelCutPoints): ClassificationLevel {
  const [first, second, third] = cutPoints;
  if (score < first) return 'misleading';
  if (score < second) return 'weak';
  if (score < third) return 'acceptable';
  return 'strong';
}

function isNoulAnswer(answer: JevAnswer | undefined): answer is Extract<JevAnswer, { type: 'noul' }> {
  return answer !== undefined && answer.type === 'noul';
}

function isScoreAnswer(answer: JevAnswer | undefined): answer is Extract<JevAnswer, { type: 'score' }> {
  return answer !== undefined && answer.type === 'score';
}

/** A validated, four-level probability distribution: see {@link extractProbabilityQuartet}. */
interface ProbabilityQuartet {
  readonly p0: number;
  readonly p1: number;
  readonly p2: number;
  readonly p3: number;
}

/**
 * A pure IEEE-754 rounding slack for the tolerance comparison in
 * {@link extractProbabilityQuartet} — not a second, looser tolerance. Four
 * decimal literals that sum to exactly `1.02` mathematically (e.g. `0.3 +
 * 0.3 + 0.3 + 0.12`) can land on `1.0200000000000000178` in IEEE-754
 * double-precision arithmetic, which is *greater* than a `0.02` tolerance
 * bound compared with a bare `>`. Without this slack, a distribution that
 * is exactly within {@link PROBABILITY_SUM_TOLERANCE} could be rejected
 * purely because of how its particular values happen to round in binary
 * floating point — not because it is actually malformed.
 */
const FLOATING_POINT_SLACK = 1e-9;

/**
 * `mass >= threshold`, but immune to the same IEEE-754 rounding noise
 * {@link FLOATING_POINT_SLACK} documents: e.g. `0.3 + 0.35` (two of the
 * provider's 2-decimal probabilities) lands on `0.6499999999999999` in
 * double-precision arithmetic — mathematically exactly `0.65`, but a hair
 * under it in binary. A bare `>=` would misclassify a distribution as not
 * clearing a threshold it conceptually sits exactly on; every threshold
 * comparison in {@link judgeDimensionV2} goes through this helper instead
 * of a raw `>=`.
 */
function clearsThreshold(mass: number, threshold: number): boolean {
  return mass >= threshold - FLOATING_POINT_SLACK;
}

/**
 * Validates a quality answer's `probabilities` map for {@link judgeDimensionV2}:
 * keys `"0"`–`"3"` (one per {@link CLASSIFICATION_LEVELS}) must each be
 * present and a finite number within `[0, 1]`, and the four must sum to `1`
 * within {@link PROBABILITY_SUM_TOLERANCE} (plus {@link FLOATING_POINT_SLACK}).
 * Returns `undefined` on any violation — never a guess, never a default of
 * `0` for a missing key — which {@link judgeDimensionV2} reports as
 * `needs-review`, reason `missing-answer`, exactly like an absent quality
 * answer. Ignores any extra keys beyond `"0"`–`"3"` (the provider contract
 * does not forbid them; only the four defined levels matter to this policy).
 */
function extractProbabilityQuartet(
  probabilities: Readonly<Record<string, number>>,
  tolerance: number,
): ProbabilityQuartet | undefined {
  const p0 = probabilities['0'];
  const p1 = probabilities['1'];
  const p2 = probabilities['2'];
  const p3 = probabilities['3'];
  if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) return undefined;
  if (![p0, p1, p2, p3].every(isUnitProbability)) return undefined;
  const sum = p0 + p1 + p2 + p3;
  if (Math.abs(sum - 1) > tolerance + FLOATING_POINT_SLACK) return undefined;
  return { p0, p1, p2, p3 };
}

/**
 * Judges one dimension from its two independent answers under
 * `CLASSIFICATION_POLICY_V1` (Phase 4 Decisions) — kept exactly as shipped
 * for Phase 4; see the module doc for why this code path is retained but no
 * longer constructed:
 * - An applicability answer missing or of the wrong shape means applicability
 *   itself cannot be determined; the dimension is kept in consideration
 *   (`applicable: true`) rather than silently dropped, since excluding it
 *   would hide the very uncertainty this branch exists to surface.
 * - `applicabilityProbability < policy.applicabilityMin` excludes the
 *   dimension from the overall verdict outright (PRD: "The application
 *   ignores quality scores without sufficient evidence") — its score is
 *   never recorded, even if a quality answer is present.
 * - A missing or malformed quality answer, once the dimension is applicable,
 *   needs review rather than inventing a level.
 * - `confidence < policy.confidenceMin` records the score for visibility but
 *   withholds the level, since a low-confidence score cannot support a
 *   quality claim (PRD principle 3).
 * - Otherwise the dimension is judged, with its level resolved from
 *   {@link levelForScore}.
 */
function judgeDimensionV1(
  dimensionId: RubricDimensionId,
  dimensionLabel: string,
  answers: Readonly<Record<string, JevAnswer>>,
  policy: ClassificationPolicyV1,
): DimensionJudgment {
  const applicabilityAnswer = answers[`${dimensionId}.applicable`];
  const qualityAnswer = answers[`${dimensionId}.quality`];
  const NO_MASS_FIELDS = { probabilities: undefined, deficientMass: undefined, acceptableMass: undefined, criticalMass: undefined } as const;

  if (!isNoulAnswer(applicabilityAnswer)) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: true,
      applicabilityProbability: undefined,
      level: undefined,
      score: isScoreAnswer(qualityAnswer) ? qualityAnswer.score : undefined,
      confidence: isScoreAnswer(qualityAnswer) ? qualityAnswer.confidence : undefined,
      status: 'needs-review',
      reason: 'missing-answer',
      ...NO_MASS_FIELDS,
    };
  }

  const applicabilityProbability = applicabilityAnswer.probability;
  if (applicabilityProbability < policy.applicabilityMin) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: false,
      applicabilityProbability,
      level: undefined,
      score: undefined,
      confidence: undefined,
      status: 'not-applicable',
      reason: undefined,
      ...NO_MASS_FIELDS,
    };
  }

  if (!isScoreAnswer(qualityAnswer)) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: true,
      applicabilityProbability,
      level: undefined,
      score: undefined,
      confidence: undefined,
      status: 'needs-review',
      reason: 'missing-answer',
      ...NO_MASS_FIELDS,
    };
  }

  const { score, confidence } = qualityAnswer;
  if (confidence < policy.confidenceMin) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: true,
      applicabilityProbability,
      level: undefined,
      score,
      confidence,
      status: 'needs-review',
      reason: 'low-confidence',
      ...NO_MASS_FIELDS,
    };
  }

  return {
    dimensionId,
    dimensionLabel,
    applicable: true,
    applicabilityProbability,
    level: levelForScore(score, policy.levelCutPoints),
    score,
    confidence,
    status: 'judged',
    reason: undefined,
    ...NO_MASS_FIELDS,
  };
}

/**
 * Judges one dimension from its two independent answers under
 * `CLASSIFICATION_POLICY_V2` (`odd/tasks/classification-calibration.md` task
 * C-1) — the boundary-mass gate that replaces `judgeDimensionV1`'s
 * confidence gate:
 * - Applicability is decided exactly like {@link judgeDimensionV1}: a
 *   missing/wrong-shaped applicability answer needs review; below
 *   `policy.applicabilityMin` the dimension is `not-applicable` and its
 *   score is never recorded. Task C-1 does not change this gate (task C-2
 *   does).
 * - A missing or wrong-shaped quality answer, once applicable, needs review
 *   (`missing-answer`) — same as V1.
 * - The quality answer's `probabilities` must validate (see
 *   {@link extractProbabilityQuartet}); a malformed or missing distribution
 *   needs review (`missing-answer`) rather than a guess. `score`/`confidence`
 *   are still recorded for transparency even here, since they come straight
 *   from the (separately well-typed) quality answer and are no longer gates.
 * - `deficientMass = P(misleading) + P(weak)`, `acceptableMass =
 *   P(acceptable) + P(strong)`, `criticalMass = P(misleading)`. The
 *   dimension is `deficient` when `deficientMass >= policy.sideMin`,
 *   `acceptable` when `acceptableMass >= policy.sideMin`; `sideMin > 0.5`
 *   (enforced by {@link validateClassificationPolicy}) makes these mutually
 *   exclusive. Neither clearing `sideMin` needs review (`boundary-straddle`)
 *   — the mass sits across the boundary the verdict actually depends on.
 * - A `deficient` dimension is `misleading` when `criticalMass >=
 *   policy.criticalMin`, else `weak` — a merely-deficient distribution never
 *   reads as a critical accusation.
 * - An `acceptable` dimension keeps reporting `acceptable` vs. `strong` from
 *   `policy.levelCutPoints[2]` (via {@link levelForScore}, clamped away from
 *   `misleading`/`weak`) so the report still distinguishes them, but that
 *   distinction can never itself produce `needs-review`.
 */
function judgeDimensionV2(
  dimensionId: RubricDimensionId,
  dimensionLabel: string,
  answers: Readonly<Record<string, JevAnswer>>,
  policy: ClassificationPolicyV2,
): DimensionJudgment {
  const applicabilityAnswer = answers[`${dimensionId}.applicable`];
  const qualityAnswer = answers[`${dimensionId}.quality`];
  const NO_MASS_FIELDS = { probabilities: undefined, deficientMass: undefined, acceptableMass: undefined, criticalMass: undefined } as const;

  if (!isNoulAnswer(applicabilityAnswer)) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: true,
      applicabilityProbability: undefined,
      level: undefined,
      score: isScoreAnswer(qualityAnswer) ? qualityAnswer.score : undefined,
      confidence: isScoreAnswer(qualityAnswer) ? qualityAnswer.confidence : undefined,
      status: 'needs-review',
      reason: 'missing-answer',
      ...NO_MASS_FIELDS,
    };
  }

  const applicabilityProbability = applicabilityAnswer.probability;
  if (applicabilityProbability < policy.applicabilityMin) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: false,
      applicabilityProbability,
      level: undefined,
      score: undefined,
      confidence: undefined,
      status: 'not-applicable',
      reason: undefined,
      ...NO_MASS_FIELDS,
    };
  }

  if (!isScoreAnswer(qualityAnswer)) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: true,
      applicabilityProbability,
      level: undefined,
      score: undefined,
      confidence: undefined,
      status: 'needs-review',
      reason: 'missing-answer',
      ...NO_MASS_FIELDS,
    };
  }

  const { score, confidence, probabilities: rawProbabilities } = qualityAnswer;
  const quartet = extractProbabilityQuartet(rawProbabilities, PROBABILITY_SUM_TOLERANCE);
  if (quartet === undefined) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: true,
      applicabilityProbability,
      level: undefined,
      score,
      confidence,
      status: 'needs-review',
      reason: 'missing-answer',
      ...NO_MASS_FIELDS,
    };
  }

  const { p0, p1, p2, p3 } = quartet;
  const deficientMass = p0 + p1;
  const acceptableMass = p2 + p3;
  const criticalMass = p0;
  const canonicalProbabilities = { '0': p0, '1': p1, '2': p2, '3': p3 } as const;

  if (clearsThreshold(deficientMass, policy.sideMin)) {
    return {
      dimensionId,
      dimensionLabel,
      applicable: true,
      applicabilityProbability,
      level: clearsThreshold(criticalMass, policy.criticalMin) ? 'misleading' : 'weak',
      score,
      confidence,
      status: 'judged',
      reason: undefined,
      probabilities: canonicalProbabilities,
      deficientMass,
      acceptableMass,
      criticalMass,
    };
  }

  if (clearsThreshold(acceptableMass, policy.sideMin)) {
    const scoreLevel = levelForScore(score, policy.levelCutPoints);
    return {
      dimensionId,
      dimensionLabel,
      applicable: true,
      applicabilityProbability,
      level: scoreLevel === 'strong' ? 'strong' : 'acceptable',
      score,
      confidence,
      status: 'judged',
      reason: undefined,
      probabilities: canonicalProbabilities,
      deficientMass,
      acceptableMass,
      criticalMass,
    };
  }

  return {
    dimensionId,
    dimensionLabel,
    applicable: true,
    applicabilityProbability,
    level: undefined,
    score,
    confidence,
    status: 'needs-review',
    reason: 'boundary-straddle',
    probabilities: canonicalProbabilities,
    deficientMass,
    acceptableMass,
    criticalMass,
  };
}

/** Dispatches to {@link judgeDimensionV1} or {@link judgeDimensionV2} by which shape `policy` structurally is (see {@link isClassificationPolicyV2}). */
function judgeDimension(
  dimensionId: RubricDimensionId,
  dimensionLabel: string,
  answers: Readonly<Record<string, JevAnswer>>,
  policy: ClassificationPolicy,
): DimensionJudgment {
  return isClassificationPolicyV2(policy)
    ? judgeDimensionV2(dimensionId, dimensionLabel, answers, policy)
    : judgeDimensionV1(dimensionId, dimensionLabel, answers, policy);
}

/**
 * Derives the overall, non-compensatory verdict (PRD "Global classification").
 * Only `applicable` dimensions are considered at all — a `not-applicable`
 * dimension's score is excluded, never merely outvoted. Branch order matters
 * and is exactly the PRD's own precedence: a critical level anywhere forces
 * `misleading` before anything else is even inspected, so no `strong`
 * dimension anywhere can offset it.
 */
function classifyOverall(
  dimensions: readonly DimensionJudgment[],
  evaluation: JevEvaluation,
  policy: ClassificationPolicy,
): OverallClassificationStatus {
  const applicableDimensions = dimensions.filter((dimension) => dimension.applicable);
  const judgedDimensions = applicableDimensions.filter((dimension) => dimension.status === 'judged');

  if (judgedDimensions.some((dimension) => dimension.level === policy.criticalLevel)) {
    return 'misleading';
  }
  if (judgedDimensions.some((dimension) => dimension.level === 'weak')) {
    return 'weak';
  }
  if (
    applicableDimensions.length === 0
    || applicableDimensions.some((dimension) => dimension.status === 'needs-review')
    || !evaluation.modelMatchesPin
  ) {
    return 'needs-review';
  }
  return 'healthy';
}

function toFinding(judgment: DimensionJudgment, testCase: ClassificationTestCaseIdentity): ClassificationFinding {
  return {
    testCaseId: testCase.testCaseId,
    repositoryRelativePath: testCase.repositoryRelativePath,
    name: testCase.name,
    dimensionId: judgment.dimensionId,
    dimensionLabel: judgment.dimensionLabel,
    level: judgment.level,
    score: judgment.score,
    confidence: judgment.confidence,
    applicabilityProbability: judgment.applicabilityProbability,
    status: judgment.status,
    reason: judgment.reason,
    probabilities: judgment.probabilities,
    deficientMass: judgment.deficientMass,
    acceptableMass: judgment.acceptableMass,
    criticalMass: judgment.criticalMass,
  };
}

/**
 * Whether a dimension's judgment is worth surfacing as a finding: a judged
 * `misleading`/`weak` level, or any `needs-review` dimension (a deliberate
 * choice among the "misleading or weak, and optionally needs-review" options
 * the feature allows — surfacing `needs-review` findings keeps missing or
 * uncertain evidence visible in the report rather than silently absent,
 * matching PRD principle 3, "Uncertainty is not quality"). A `not-applicable`
 * or judged `acceptable`/`strong` dimension is never a finding.
 */
function isFindingWorthy(judgment: DimensionJudgment): boolean {
  if (judgment.status === 'needs-review') return true;
  return judgment.status === 'judged' && (judgment.level === 'misleading' || judgment.level === 'weak');
}

/**
 * Classifies one Jev evaluation into a full {@link ClassificationResult}:
 * validates `policy` and `rubric` first (throwing `RangeError` before doing
 * any judgment work on the first violation), judges every rubric dimension
 * independently, derives the non-compensatory overall status, and collects
 * findings — all pure, deterministic, and canonically ordered by dimension
 * id. Identifiers (`testCase`) are taken exactly as given; this function
 * never reaches into evidence or run state to look anything up. Raw answers
 * (`evaluation.answers`) are untouched here and remain available to the
 * caller, so a future policy version can recompute this result without
 * another Jev call.
 */
export function classifyEvaluation(input: ClassifyEvaluationInput): ClassificationResult {
  validateClassificationPolicy(input.policy);
  validateRubric(input.rubric);
  if (input.rubric.version !== input.policy.rubricVersion) {
    throw new RangeError(
      `Classification policy rubricVersion (${input.policy.rubricVersion}) does not match the rubric version `
      + `(${input.rubric.version})`,
    );
  }

  const dimensions = input.rubric.dimensions
    .map((dimension) => judgeDimension(dimension.id, dimension.label, input.evaluation.answers, input.policy))
    .sort((left, right) => compareDimensionIds(left.dimensionId, right.dimensionId));

  const status = classifyOverall(dimensions, input.evaluation, input.policy);

  const findings = dimensions
    .filter(isFindingWorthy)
    .map((judgment) => toFinding(judgment, input.testCase))
    .sort((left, right) => compareDimensionIds(left.dimensionId, right.dimensionId));

  return {
    testCaseId: input.testCase.testCaseId,
    repositoryRelativePath: input.testCase.repositoryRelativePath,
    name: input.testCase.name,
    status,
    dimensions,
    findings,
    policyVersion: input.policy.version,
    rubricVersion: input.rubric.version,
    model: {
      requested: input.evaluation.requestedModel,
      responded: input.evaluation.respondedModel,
      matchesPin: input.evaluation.modelMatchesPin,
    },
    usage: input.evaluation.usage,
  };
}
