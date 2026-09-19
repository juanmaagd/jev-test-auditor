import { canonicalizeEvidenceBundle, utf8ByteLength, type EvidenceBundle } from './evidence.js';
import type { TestCase, TestCaseId } from './test-understanding.js';

/**
 * A versioned, local snapshot of Jev pricing and per-request overhead
 * assumptions, used only to produce an approximate, clearly-labeled
 * `--dry-run` preview (see {@link estimateDryRun}). Nothing here is a
 * wire-accurate token count: Phase 4 replaces the token math with the exact
 * request `state` and `questions`, and Phase 5 adds cache-hit/billable-call
 * accuracy. `version` lets a later phase detect which snapshot produced a
 * given estimate.
 */
export interface JevEstimateSnapshot {
  readonly version: number;
  readonly model: string;
  /** ISO date (`YYYY-MM-DD`) the figures below were last confirmed against the provider. */
  readonly asOf: string;
  readonly usdPerMillionInputTokens: number;
  /** Jev's current pricing has no output-token charge; kept explicit so a future paid-output snapshot is a visible, versioned change rather than a silent one — this estimator never adds an output-token cost term. `validateJevEstimateSnapshot` rejects `true` fail-closed: enabling output billing requires adding an output-token count/cost model to `estimateDryRun` first, not just flipping this field. */
  readonly outputTokensBilled: boolean;
  /** Bytes-per-token conversion range used to turn exact evidence bytes into an approximate token range. */
  readonly bytesPerToken: { readonly min: number; readonly max: number };
  /**
   * Provisional per-request overhead range (in tokens), standing in for the
   * rubric system prompt plus all batched questions for one request — one
   * request evaluates all seven rubric dimensions' Noul and Score questions
   * together (14 questions), so this is that system prompt plus 14
   * questions' worth of text. NOT measured against the real Jev rubric
   * wording — that lands in Phase 4, which replaces this range with a
   * measured constant from the exact `questions` payload. `min` assumes
   * terse ~40-token questions plus a compact ~60-token system prompt
   * (14 * 40 + 60 = 620); `max` assumes verbose ~160-token questions (with
   * full 0-3 criteria text) plus a larger ~200-token system prompt
   * (14 * 160 + 200 = 2440).
   */
  readonly requestOverheadTokens: { readonly min: number; readonly max: number };
  /** Upper bound on follow-up requests per evaluable test case; a follow-up is allowed only when an earlier result identifies a specific evidence need (see `docs/technical-design.md`), never an automatic retry. */
  readonly maxFollowUpsPerTest: number;
  /** Provider's total per-request token ceiling (state + all batched questions). */
  readonly requestTokenCeiling: number;
}

/**
 * Fixed facts as of {@link JevEstimateSnapshot.asOf}: Jev `1.13` (TypeSafe),
 * USD 0.042 per 1,000,000 input tokens, output tokens unbilled, one request
 * per evaluable test case (one state, all rubric questions batched), and a
 * 64k-token provider request ceiling. See `requestOverheadTokens`'s own doc
 * for how its provisional range was derived; every other numeric fact here
 * is a verified pricing/provider fact, not a guess.
 */
export const JEV_ESTIMATE_SNAPSHOT: JevEstimateSnapshot = {
  version: 1,
  model: 'jev-1.13',
  asOf: '2026-09-19',
  usdPerMillionInputTokens: 0.042,
  outputTokensBilled: false,
  bytesPerToken: { min: 2.5, max: 4.5 },
  requestOverheadTokens: { min: 620, max: 2440 },
  maxFollowUpsPerTest: 1,
  requestTokenCeiling: 64_000,
};

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateRange(
  range: { readonly min: number; readonly max: number },
  name: string,
  allowZero: boolean,
): void {
  const minValid = Number.isFinite(range.min) && (allowZero ? range.min >= 0 : range.min > 0);
  const maxValid = Number.isFinite(range.max) && (allowZero ? range.max >= 0 : range.max > 0);
  if (!minValid) {
    throw new RangeError(
      `Jev estimate snapshot ${name}.min must be a ${allowZero ? 'non-negative' : 'positive'} finite number: ${range.min}`,
    );
  }
  if (!maxValid) {
    throw new RangeError(
      `Jev estimate snapshot ${name}.max must be a ${allowZero ? 'non-negative' : 'positive'} finite number: ${range.max}`,
    );
  }
  if (range.min > range.max) {
    throw new RangeError(
      `Jev estimate snapshot ${name}.min (${range.min}) must not exceed ${name}.max (${range.max})`,
    );
  }
}

/** Validates {@link JevEstimateSnapshot} inputs deterministically, throwing `RangeError` for the first invalid value found. */
export function validateJevEstimateSnapshot(snapshot: JevEstimateSnapshot): void {
  if (!Number.isInteger(snapshot.version) || snapshot.version <= 0) {
    throw new RangeError(`Jev estimate snapshot version must be a positive integer: ${snapshot.version}`);
  }
  if (typeof snapshot.model !== 'string' || snapshot.model.length === 0) {
    throw new RangeError(`Jev estimate snapshot model must be a non-empty string: ${snapshot.model}`);
  }
  if (typeof snapshot.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(snapshot.asOf)) {
    throw new RangeError(`Jev estimate snapshot asOf must be an ISO date (YYYY-MM-DD): ${snapshot.asOf}`);
  }
  if (!isPositiveFinite(snapshot.usdPerMillionInputTokens)) {
    throw new RangeError(
      `Jev estimate snapshot usdPerMillionInputTokens must be a positive finite number: ${snapshot.usdPerMillionInputTokens}`,
    );
  }
  if (typeof snapshot.outputTokensBilled !== 'boolean') {
    throw new RangeError(`Jev estimate snapshot outputTokensBilled must be a boolean: ${snapshot.outputTokensBilled}`);
  }
  // Fail-closed: this estimator has no output-token model (no output-token count anywhere
  // in `estimateDryRun`'s formulas), so a snapshot claiming output tokens ARE billed would
  // silently under-estimate cost rather than error. Enabling output billing requires adding
  // an output-token count/estimate to the formula first, not just flipping this field.
  if (snapshot.outputTokensBilled) {
    throw new RangeError(
      'Jev estimate snapshot outputTokensBilled must be false: this estimator has no output-token cost model yet, '
      + 'so billed output tokens cannot be reflected in estimatedUsd without silently under-estimating',
    );
  }
  validateRange(snapshot.bytesPerToken, 'bytesPerToken', false);
  validateRange(snapshot.requestOverheadTokens, 'requestOverheadTokens', true);
  if (!Number.isInteger(snapshot.maxFollowUpsPerTest) || snapshot.maxFollowUpsPerTest < 0) {
    throw new RangeError(
      `Jev estimate snapshot maxFollowUpsPerTest must be a non-negative integer: ${snapshot.maxFollowUpsPerTest}`,
    );
  }
  if (!Number.isInteger(snapshot.requestTokenCeiling) || snapshot.requestTokenCeiling <= 0) {
    throw new RangeError(
      `Jev estimate snapshot requestTokenCeiling must be a positive integer: ${snapshot.requestTokenCeiling}`,
    );
  }
}

/**
 * Converts an exact UTF-8 byte count into an approximate token range using
 * `bytesPerToken`'s min/max bounds, rounding OUTWARD (`floor` for the
 * fewer-tokens `min` bound, via the larger `bytesPerToken.max` divisor;
 * `ceil` for the more-tokens `max` bound, via the smaller `bytesPerToken.min`
 * divisor) so the reported range never under-covers the true value it
 * approximates. Exported so `src/domain/jev-request.ts`'s provider-budget
 * check (Phase 4, task P4-1) reuses this exact conversion instead of
 * duplicating it; `estimateDryRun` below uses it for the same reason.
 */
export function estimateTokensFromBytes(
  bytes: number,
  bytesPerToken: { readonly min: number; readonly max: number },
): DryRunRange {
  return {
    min: Math.floor(bytes / bytesPerToken.max),
    max: Math.ceil(bytes / bytesPerToken.min),
  };
}

export type DryRunSkippedReason = 'skip' | 'todo' | 'evidence-unavailable';

export type DryRunClassification =
  | { readonly status: 'evaluable' }
  | { readonly status: 'skipped'; readonly reason: DryRunSkippedReason };

/**
 * Classifies one extracted test case for the dry-run preview.
 *
 * - `skip`/`todo`: the test carries that static modifier, checked first —
 *   a skip/todo test with no built evidence bundle is still reported under
 *   its modifier reason, never `evidence-unavailable`.
 * - `evidence-unavailable`: no `skip`/`todo` modifier, but evidence
 *   selection produced no bundle for this test case (see
 *   `evidence-selection-failed` in `src/adapters/evidence-audit-port.ts`).
 * - `evaluable`: everything else, including a `skipIf`/`runIf` conditional
 *   modifier — those are runtime-conditional, not statically known to be
 *   skipped, so they count as evaluable here (per task P3-5's decision).
 */
export function classifyTestCase(
  testCase: Pick<TestCase, 'modifiers'>,
  evidenceBundle: EvidenceBundle | undefined,
): DryRunClassification {
  const staticModifier = testCase.modifiers.find((modifier) => modifier.kind === 'skip' || modifier.kind === 'todo');
  if (staticModifier !== undefined) {
    return { status: 'skipped', reason: staticModifier.kind as 'skip' | 'todo' };
  }
  if (evidenceBundle === undefined) {
    return { status: 'skipped', reason: 'evidence-unavailable' };
  }
  return { status: 'evaluable' };
}

/** One discovered file's test cases plus its successfully built evidence bundles, matched by `EvidenceBundle.testCaseId` — structurally compatible with `AuditFileResult` (see `src/domain/audit.ts`), which callers pass directly. */
export interface DryRunFileInput {
  readonly testCases: readonly TestCase[];
  readonly evidence: readonly EvidenceBundle[];
}

export interface DryRunSkippedTotals {
  readonly total: number;
  readonly byReason: Readonly<Record<DryRunSkippedReason, number>>;
}

export interface DryRunRange {
  readonly min: number;
  readonly max: number;
}

export interface DryRunEstimate {
  readonly snapshotVersion: number;
  readonly model: string;
  readonly asOf: string;
  readonly discovered: number;
  readonly evaluable: number;
  readonly skipped: DryRunSkippedTotals;
  /** One initial Jev call per evaluable test case, exact. */
  readonly initialCalls: number;
  /** Possible follow-up call range; a follow-up happens only when an earlier result identifies a specific evidence need (never an automatic retry), so the true count is unknown ahead of time. */
  readonly followUpCalls: DryRunRange;
  /** Exact sum of UTF-8 byte lengths of `canonicalizeEvidenceBundle(bundle)` over every evaluable bundle. */
  readonly evidenceBytes: number;
  /** Approximate input-token range for the initial calls only. */
  readonly estimatedInputTokens: DryRunRange;
  /** Approximate additional input-token range contributed by possible follow-up calls (a follow-up re-sends the same state). */
  readonly estimatedFollowUpInputTokens: DryRunRange;
  /** Approximate USD range, `estimatedInputTokens.min` (no follow-ups) through `estimatedInputTokens.max + estimatedFollowUpInputTokens.max` (every possible follow-up), at `usdPerMillionInputTokens`. */
  readonly estimatedUsd: DryRunRange;
  /** Count of evaluable bundles whose own worst-case single-request tokens would exceed `requestTokenCeiling`; expected 0 under the current evidence budgets. */
  readonly bundlesOverCeiling: number;
  readonly requestTokenCeiling: number;
}

/**
 * Rounds to nano-dollar (9 decimal place) precision: far finer than
 * `usdPerMillionInputTokens`'s own scale, so it only absorbs floating-point
 * arithmetic noise (~1e-16 relative error) and never the estimate's real
 * precision. Deterministic — identical inputs always produce the identical
 * rounded double, and its `toString()`/`JSON.stringify` output never uses
 * scientific notation for any value this estimator's formulas can produce
 * (the smallest nonzero `estimatedUsd.min` is bounded below by one
 * evaluable call's `requestOverheadTokens.min` priced at
 * `usdPerMillionInputTokens`, comfortably above the ~1e-6 threshold where
 * `Number#toString` would switch to exponential form).
 */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

/**
 * Builds the aggregate `--dry-run` preview described in
 * `odd/tasks/phase-3-evidence-bundles.md` (task P3-5): exact discovered /
 * evaluable / skipped-by-reason counts, exact initial-call count and
 * evidence bytes, and approximate (clearly separate) token/cost ranges.
 * Throws `RangeError` (via {@link validateJevEstimateSnapshot}) before
 * reading any file when `snapshot` itself is invalid.
 *
 * Approximation method, all provisional until Phase 4 has exact wire
 * `state`/`questions`:
 * - Per evaluable bundle, its canonical byte length converts to a token
 *   range by dividing by `bytesPerToken.{max,min}` — dividing by the larger
 *   bytes-per-token bound gives fewer tokens (the `min` bound), dividing by
 *   the smaller gives more tokens (the `max` bound) — then rounding OUTWARD
 *   (`floor` for `min`, `ceil` for `max`) so the reported range never
 *   under-covers the true value it approximates.
 * - `requestOverheadTokens.{min,max}` is added once per evaluable call.
 * - A follow-up re-sends the same state, so the worst case — every
 *   evaluable test using its full `maxFollowUpsPerTest` follow-up budget,
 *   each costing as much as the initial calls did in aggregate — is
 *   `estimatedInputTokens.max * maxFollowUpsPerTest`; the best case is zero
 *   follow-ups (`min: 0`).
 * - `estimatedUsd` prices `estimatedInputTokens.min` (no follow-ups)
 *   through `estimatedInputTokens.max + estimatedFollowUpInputTokens.max`
 *   (every possible follow-up), at `usdPerMillionInputTokens`. Jev's output
 *   tokens are unbilled (`outputTokensBilled: false`), so no output-token
 *   term is ever added.
 * - `bundlesOverCeiling` counts evaluable bundles whose own worst-case
 *   single-request tokens (`ceil(bytes / bytesPerToken.min) +
 *   requestOverheadTokens.max`) would exceed `requestTokenCeiling` — a
 *   coarse whole-request check; the finer 32k state-plus-longest-question
 *   provider sub-limit needs per-question text and is a Phase 4 concern.
 */
export function estimateDryRun(
  snapshot: JevEstimateSnapshot,
  files: readonly DryRunFileInput[],
): DryRunEstimate {
  validateJevEstimateSnapshot(snapshot);

  let discovered = 0;
  let evaluable = 0;
  const skippedByReason: Record<DryRunSkippedReason, number> = { skip: 0, todo: 0, 'evidence-unavailable': 0 };

  let evidenceBytes = 0;
  let initialTokensMin = 0;
  let initialTokensMax = 0;
  let bundlesOverCeiling = 0;

  for (const file of files) {
    const bundlesByTestCaseId = new Map<TestCaseId, EvidenceBundle>(
      file.evidence.map((bundle) => [bundle.testCaseId, bundle]),
    );
    for (const testCase of file.testCases) {
      discovered += 1;
      const bundle = bundlesByTestCaseId.get(testCase.id);
      const classification = classifyTestCase(testCase, bundle);
      if (classification.status === 'skipped') {
        skippedByReason[classification.reason] += 1;
        continue;
      }
      if (bundle === undefined) {
        // Unreachable: `classifyTestCase` only returns `evaluable` when `evidenceBundle` is defined.
        throw new Error(`unreachable: evaluable test case ${testCase.id} has no evidence bundle`);
      }
      evaluable += 1;
      const bytes = utf8ByteLength(canonicalizeEvidenceBundle(bundle));
      evidenceBytes += bytes;
      const { min: bundleTokensMin, max: bundleTokensMax } = estimateTokensFromBytes(bytes, snapshot.bytesPerToken);
      initialTokensMin += bundleTokensMin;
      initialTokensMax += bundleTokensMax;
      if (bundleTokensMax + snapshot.requestOverheadTokens.max > snapshot.requestTokenCeiling) {
        bundlesOverCeiling += 1;
      }
    }
  }

  initialTokensMin += evaluable * snapshot.requestOverheadTokens.min;
  initialTokensMax += evaluable * snapshot.requestOverheadTokens.max;

  const followUpCalls: DryRunRange = { min: 0, max: evaluable * snapshot.maxFollowUpsPerTest };
  const followUpTokensMax = initialTokensMax * snapshot.maxFollowUpsPerTest;
  const estimatedFollowUpInputTokens: DryRunRange = { min: 0, max: followUpTokensMax };

  const estimatedUsd: DryRunRange = {
    min: roundUsd((initialTokensMin * snapshot.usdPerMillionInputTokens) / 1_000_000),
    max: roundUsd(((initialTokensMax + followUpTokensMax) * snapshot.usdPerMillionInputTokens) / 1_000_000),
  };

  const skippedTotal = skippedByReason.skip + skippedByReason.todo + skippedByReason['evidence-unavailable'];

  return {
    snapshotVersion: snapshot.version,
    model: snapshot.model,
    asOf: snapshot.asOf,
    discovered,
    evaluable,
    skipped: { total: skippedTotal, byReason: skippedByReason },
    initialCalls: evaluable,
    followUpCalls,
    evidenceBytes,
    estimatedInputTokens: { min: initialTokensMin, max: initialTokensMax },
    estimatedFollowUpInputTokens,
    estimatedUsd,
    bundlesOverCeiling,
    requestTokenCeiling: snapshot.requestTokenCeiling,
  };
}
