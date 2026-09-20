import { canonicalizeEvidenceBundle, utf8ByteLength, type EvidenceBundle } from './evidence.js';
import {
  buildJevQuestions,
  buildJevRequest,
  canonicalizeJevRequest,
  canonicalizeJevRequestQuestions,
} from './jev-request.js';
import {
  estimateTokensFromBytes,
  JEV_ESTIMATE_SNAPSHOT,
  JEV_VERIFIED_RATE_LIMITS,
  validateJevEstimateSnapshot,
  type DryRunRange,
  type JevEstimateSnapshot,
} from './jev-pricing.js';
import { RUBRIC_V2, type Rubric } from './rubric.js';
import type { TestCase, TestCaseId } from './test-understanding.js';

// Re-exported for backward compatibility: every existing caller (`src/index.ts`,
// `src/cli/index.ts`, tests) imports these pricing/conversion primitives from
// `estimate.js`. Their canonical definitions now live in `./jev-pricing.js` — see
// that module's own doc for why (breaking a real ES module import cycle with
// `jev-request.ts`, which `estimateDryRun` below needs to build a real request).
export {
  estimateTokensFromBytes,
  JEV_ESTIMATE_SNAPSHOT,
  JEV_VERIFIED_RATE_LIMITS,
  validateJevEstimateSnapshot,
  type DryRunRange,
  type JevEstimateSnapshot,
};

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

export interface DryRunEstimate {
  readonly snapshotVersion: number;
  readonly model: string;
  readonly asOf: string;
  readonly discovered: number;
  readonly evaluable: number;
  readonly skipped: DryRunSkippedTotals;
  /**
   * One initial Jev call per evaluable test case that is not already served
   * from the content-addressed cache (Phase 5, task P5-5) — exact. Equals
   * `evaluable` when `estimateDryRun` was called with no cache-hit set (the
   * common case: no audit store exists yet, so nothing could be excluded).
   */
  readonly initialCalls: number;
  /**
   * Count of evaluable test cases served from an existing content-addressed
   * cache instead of a fresh Jev request (Phase 5, task P5-5), already
   * excluded from `initialCalls`/`followUpCalls`/`estimatedInputTokens`/
   * `estimatedFollowUpInputTokens`/`estimatedUsd` above. Present (even as
   * `0`) only when `estimateDryRun` was given a `cacheHitTestCaseIds` set at
   * all — its own doc explains why "0 hits, but consulted" and "not
   * consulted" are deliberately distinguishable rather than collapsed to
   * the same reported shape.
   */
  readonly cacheHits?: number;
  /** Possible follow-up call range; a follow-up happens only when an earlier result identifies a specific evidence need (never an automatic retry), so the true count is unknown ahead of time. */
  readonly followUpCalls: DryRunRange;
  /** Exact sum of UTF-8 byte lengths of `canonicalizeEvidenceBundle(bundle)` over every evaluable bundle. Still reported for its own sake (the local evidence footprint), but no longer what token/cost estimates are derived from — see `requestBytes`. */
  readonly evidenceBytes: number;
  /** Exact sum of UTF-8 byte lengths of the real `canonicalizeJevRequest(buildJevRequest({testCase, bundle, rubric}))` over every evaluable test case — the actual request Jev would receive (state plus every rubric question), not evidence bytes plus a guessed overhead. This is what `estimatedInputTokens` converts to a token range. */
  readonly requestBytes: number;
  /** Exact UTF-8 byte length of just the rubric's own canonical `questions` map (`canonicalizeJevRequestQuestions(buildJevQuestions(rubric))`) — the same for every evaluable request under this rubric, independent of test case count. Reported separately from `requestBytes` so a reader can see how much of each request's cost the rubric itself accounts for (93% for `RUBRIC_V1` against the first real run's average request — see `docs/technical-design.md`). Computed even when `evaluable` is 0: it depends only on the rubric, not on how many test cases were found. */
  readonly rubricBytesPerRequest: number;
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
 * evaluable call's real request tokens — never less than the rubric's own
 * `rubricBytesPerRequest` alone converted through `bytesPerToken.max` —
 * priced at `usdPerMillionInputTokens`, comfortably above the ~1e-6
 * threshold where `Number#toString` would switch to exponential form).
 */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

/**
 * Builds the aggregate `--dry-run` preview described in
 * `odd/tasks/phase-3-evidence-bundles.md` (task P3-5): exact discovered /
 * evaluable / skipped-by-reason counts, exact initial-call count and
 * evidence/request bytes, and approximate (clearly separate) token/cost
 * ranges. Throws `RangeError` (via {@link validateJevEstimateSnapshot}, or
 * via `buildJevQuestions`'s own `validateRubric` call for an invalid
 * `rubric`) before reading any file when either input is invalid.
 *
 * `rubric` defaults to {@link RUBRIC_V2} — the same rubric
 * `buildJevRequest` uses for a real evaluation (`src/adapters/jev-evaluation-port.ts`,
 * since task C-2 of `odd/tasks/classification-calibration.md`) — so ordinary
 * callers (the CLI's `--dry-run`) need no override; a caller may inject a
 * different rubric (e.g. a smaller fixture rubric in a test) to preview its
 * own cost instead.
 *
 * Token/cost method (calibrated 2026-09-20 from the first real Jev run —
 * see {@link JEV_ESTIMATE_SNAPSHOT}'s own doc for why the previous
 * evidence-bytes-plus-guessed-overhead method was replaced):
 * - For every evaluable test case, the real request is built
 *   (`buildJevRequest({ testCase, bundle, rubric })`) and its exact
 *   canonical byte length measured (`canonicalizeJevRequest`) — this is
 *   `requestBytes`, summed across every evaluable test case. Unlike the
 *   evidence-bundle bytes still reported separately as `evidenceBytes`,
 *   `requestBytes` includes the full rubric text (all 14 questions for
 *   the shipped rubric), which the first real run under `RUBRIC_V1` showed
 *   dominates the actual request (93% of the average request's bytes) — see
 *   `rubricBytesPerRequest`.
 * - Each evaluable test case's own `requestBytes` converts to a token range
 *   by dividing by `bytesPerToken.{max,min}` — dividing by the larger
 *   bytes-per-token bound gives fewer tokens (the `min` bound), dividing by
 *   the smaller gives more tokens (the `max` bound) — then rounding OUTWARD
 *   (`floor` for `min`, `ceil` for `max`) so the reported range never
 *   under-covers the true value it approximates, and the per-test-case
 *   ranges are summed into `estimatedInputTokens`.
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
 * - `bundlesOverCeiling` counts evaluable test cases whose own real request's
 *   worst-case tokens (`ceil(requestBytes / bytesPerToken.min)`) would
 *   exceed `requestTokenCeiling` — a coarse whole-request check; the finer
 *   32k state-plus-longest-question provider sub-limit needs per-question
 *   text and is `checkJevRequestBudget`'s concern (`src/domain/jev-request.ts`).
 *
 * `cacheHitTestCaseIds` (Phase 5, task P5-5) is plain data, never a port or
 * a filesystem read — this function stays a pure domain function with no
 * I/O. The application/CLI layer is the one that actually opens the audit
 * store, computes each evaluable test case's content-addressed cache key
 * (`AuditCacheKeyPort`), looks it up (`AuditStorePort.lookup`), and hands in
 * the resulting set of test-case ids that hit; `estimateDryRun` itself never
 * touches a store. When `undefined` (no audit store was found, or none was
 * consulted at all), every evaluable test case is billable — byte-identical
 * to this function's behavior before this task. When supplied (even an
 * empty `Set`, meaning "consulted, found nothing"), a test case whose id is
 * in the set is excluded from `initialCalls`/`followUpCalls`/
 * `estimatedInputTokens`/`estimatedFollowUpInputTokens`/`estimatedUsd` and
 * counted in `cacheHits` instead; `evaluable`/`evidenceBytes`/`requestBytes`/
 * `rubricBytesPerRequest`/`bundlesOverCeiling` stay scoped to every
 * evaluable test case regardless — they describe the discovered work itself,
 * not what would be billed for it. An id with no matching evaluable test
 * case (e.g. stale content since renamed or deleted) is simply never
 * matched; it can never produce a negative count.
 */
export function estimateDryRun(
  snapshot: JevEstimateSnapshot,
  files: readonly DryRunFileInput[],
  rubric: Rubric = RUBRIC_V2,
  cacheHitTestCaseIds?: ReadonlySet<TestCaseId>,
): DryRunEstimate {
  validateJevEstimateSnapshot(snapshot);
  // Computed unconditionally (even with zero evaluable test cases): it depends only on the
  // rubric, and validates `rubric` up front (via `buildJevQuestions`'s own `validateRubric`
  // call) before any file is touched, mirroring the snapshot's own fail-fast validation.
  const rubricBytesPerRequest = utf8ByteLength(canonicalizeJevRequestQuestions(buildJevQuestions(rubric)));

  let discovered = 0;
  let evaluable = 0;
  const skippedByReason: Record<DryRunSkippedReason, number> = { skip: 0, todo: 0, 'evidence-unavailable': 0 };

  let evidenceBytes = 0;
  let requestBytes = 0;
  let initialTokensMin = 0;
  let initialTokensMax = 0;
  let bundlesOverCeiling = 0;
  let billableCalls = 0;
  let cacheHitCount = 0;

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
      evidenceBytes += utf8ByteLength(canonicalizeEvidenceBundle(bundle));

      const request = buildJevRequest({ testCase, bundle, rubric });
      const testCaseRequestBytes = utf8ByteLength(canonicalizeJevRequest(request));
      requestBytes += testCaseRequestBytes;
      const { min: requestTokensMin, max: requestTokensMax } = estimateTokensFromBytes(
        testCaseRequestBytes,
        snapshot.bytesPerToken,
      );
      if (requestTokensMax > snapshot.requestTokenCeiling) {
        bundlesOverCeiling += 1;
      }

      // Phase 5, task P5-5: a cache hit is excluded from the billable token/cost math and
      // counted separately instead — see `cacheHitTestCaseIds`'s own doc above. With no set
      // supplied at all, `cacheHitTestCaseIds?.has(...)` is always `false`, so every evaluable
      // test case falls into the `else` branch exactly as it did before this task.
      if (cacheHitTestCaseIds?.has(testCase.id) === true) {
        cacheHitCount += 1;
      } else {
        billableCalls += 1;
        initialTokensMin += requestTokensMin;
        initialTokensMax += requestTokensMax;
      }
    }
  }

  const followUpCalls: DryRunRange = { min: 0, max: billableCalls * snapshot.maxFollowUpsPerTest };
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
    initialCalls: billableCalls,
    ...(cacheHitTestCaseIds === undefined ? {} : { cacheHits: cacheHitCount }),
    followUpCalls,
    evidenceBytes,
    requestBytes,
    rubricBytesPerRequest,
    estimatedInputTokens: { min: initialTokensMin, max: initialTokensMax },
    estimatedFollowUpInputTokens,
    estimatedUsd,
    bundlesOverCeiling,
    requestTokenCeiling: snapshot.requestTokenCeiling,
  };
}
