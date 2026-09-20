/**
 * Deterministic, non-compensatory classification (Phase 4, task P4-3): turns
 * one normalized {@link JevEvaluation} into a per-dimension judgment, an
 * overall verdict, and findings — all pure code, no Node imports, no adapter
 * imports, no network. Jev supplies bounded probabilities and scores; this
 * module composes the actual decision (PRD principle 5, "Code owns policy").
 *
 * PROVISIONAL THRESHOLDS — READ BEFORE CHANGING: {@link CLASSIFICATION_POLICY_V1}'s
 * `applicabilityMin`, `confidenceMin`, and `levelCutPoints` are uncalibrated
 * guesses versioned with the rubric (`odd/tasks/phase-4-jev-evaluation.md`
 * Decisions: "Thresholds are provisional data versioned with the rubric, not
 * calibrated claims"). Nothing in this file, its tests, or any caller may
 * imply these numbers were validated against real outcomes — Phase 7's
 * deterministic benchmark corpus is what calibrates them (PRD "Rules are
 * hypotheses"). A future recalibration is a new policy version, e.g.
 * `CLASSIFICATION_POLICY_V2`, never a silent edit of `CLASSIFICATION_POLICY_V1`.
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

/** Why a dimension could not be judged even though it is (or might be) applicable. */
export type DimensionNeedsReviewReason = 'low-confidence' | 'missing-answer';

export type DimensionJudgmentStatus = 'judged' | 'not-applicable' | 'needs-review';

/**
 * Versioned, provisional classification thresholds (see the module doc's
 * PROVISIONAL THRESHOLDS notice). `rubricVersion` pins which {@link Rubric}
 * version this policy's cut points were chosen against — {@link classifyEvaluation}
 * fails closed on a mismatch, since cut points chosen for one rubric's
 * question wording carry no guarantee against a different one.
 */
export interface ClassificationPolicy {
  readonly version: number;
  readonly rubricVersion: number;
  /** A dimension's applicability `noul` probability must be at least this to count as applicable (`>=`, not `>`). */
  readonly applicabilityMin: number;
  /** A dimension's quality `confidence` must be at least this to use its score (`>=`, not `>`). */
  readonly confidenceMin: number;
  /**
   * Three ascending cut points separating the four {@link CLASSIFICATION_LEVELS}
   * over the weighted quality `score` (nominally 0..3). Boundary convention —
   * left-closed, right-open, with the top level unbounded above:
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
   * quality."
   */
  readonly levelCutPoints: readonly [number, number, number];
  /** The level whose presence in any applicable, judged dimension forces the overall verdict to `misleading` (PRD: "A strong score in one dimension cannot cancel a critical failure in another"). */
  readonly criticalLevel: ClassificationLevel;
}

/**
 * The shipped, provisional Phase 4 policy. See the module doc's PROVISIONAL
 * THRESHOLDS notice — none of these numbers carry an accuracy claim.
 */
export const CLASSIFICATION_POLICY_V1: ClassificationPolicy = {
  version: 1,
  rubricVersion: 1,
  applicabilityMin: 0.5,
  confidenceMin: 0.6,
  levelCutPoints: [1, 2, 3],
  criticalLevel: 'misleading',
};

function isUnitProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validates a {@link ClassificationPolicy} deterministically, throwing
 * `RangeError` on the first violation found: positive integer `version` and
 * `rubricVersion`, `applicabilityMin`/`confidenceMin` within `[0, 1]`,
 * exactly three finite, strictly ascending `levelCutPoints`, and a
 * `criticalLevel` drawn from {@link CLASSIFICATION_LEVELS}.
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
  if (!isUnitProbability(policy.confidenceMin)) {
    throw new RangeError(`Classification policy confidenceMin must be a finite number within [0, 1]: ${policy.confidenceMin}`);
  }
  const [first, second, third] = policy.levelCutPoints;
  for (const cutPoint of [first, second, third]) {
    if (!Number.isFinite(cutPoint)) {
      throw new RangeError(`Classification policy levelCutPoints must all be finite numbers: ${JSON.stringify(policy.levelCutPoints)}`);
    }
  }
  if (!(first < second && second < third)) {
    throw new RangeError(`Classification policy levelCutPoints must be strictly ascending: ${JSON.stringify(policy.levelCutPoints)}`);
  }
  if (!CLASSIFICATION_LEVEL_SET.has(policy.criticalLevel)) {
    throw new RangeError(`Classification policy criticalLevel must be one of ${JSON.stringify(CLASSIFICATION_LEVELS)}: got "${policy.criticalLevel}"`);
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
 * `reason` are typed `T | undefined` (not optional) so `exactOptionalPropertyTypes`
 * still lets this file assign `undefined` explicitly when a value truly
 * was not judged, invented, or observed — never a placeholder like `0` or
 * an empty string standing in for "unknown".
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
}

/** One finding, carrying both the judgment detail and the identifiers a report needs — taken from the caller's {@link ClassificationTestCaseIdentity}, never looked up by this module. */
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

function levelForScore(score: number, cutPoints: ClassificationPolicy['levelCutPoints']): ClassificationLevel {
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

/**
 * Judges one dimension from its two independent answers (Phase 4 Decisions):
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
function judgeDimension(
  dimensionId: RubricDimensionId,
  dimensionLabel: string,
  answers: Readonly<Record<string, JevAnswer>>,
  policy: ClassificationPolicy,
): DimensionJudgment {
  const applicabilityAnswer = answers[`${dimensionId}.applicable`];
  const qualityAnswer = answers[`${dimensionId}.quality`];

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
  };
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
