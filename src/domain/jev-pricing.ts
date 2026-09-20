/**
 * Jev pricing snapshot and the pure byte-to-token conversion it drives.
 *
 * Deliberately its own module, separate from `src/domain/estimate.ts` and
 * `src/domain/jev-request.ts`, even though both of those import from here:
 * `estimate.ts`'s `estimateDryRun` builds a real request via
 * `buildJevRequest`/`canonicalizeJevRequest` (`jev-request.ts`) to measure
 * its exact bytes, while `jev-request.ts`'s own `JEV_REQUEST_LIMITS` reads
 * `JEV_ESTIMATE_SNAPSHOT.bytesPerToken` at module load time. If those two
 * pricing primitives lived in `estimate.ts` itself, that would make
 * `estimate.ts` and `jev-request.ts` import each other — a real ES module
 * cycle, not just an awkward layering: depending on which of the two a
 * consumer imports first, the cyclic partner can end up reading the other's
 * `const` before it has been initialized (a TDZ `ReferenceError`) at
 * runtime. Keeping the pricing/conversion primitives here, with no
 * dependency on `jev-request.ts`, keeps the module graph a DAG:
 * `jev-pricing.ts` → `jev-request.ts` → `estimate.ts`, and `jev-pricing.ts`
 * → `estimate.ts` directly for the re-export below. `estimate.ts`
 * re-exports every name from here so this split is invisible to existing
 * callers (`src/index.ts`, `src/cli/index.ts`, tests) that import them from
 * `estimate.js`.
 */
import { JEV_MODEL_ID } from './rubric.js';

/**
 * A versioned, local snapshot of Jev pricing assumptions, used only to
 * produce an approximate, clearly-labeled `--dry-run` preview (see
 * `estimateDryRun` in `src/domain/estimate.ts`). Nothing here is a
 * wire-accurate token count — `bytesPerToken` is still an approximate
 * byte-to-token conversion range, calibrated from real measurements (see
 * its own doc) — but per-request overhead is no longer a separate guessed
 * field: the rubric is in the repository, so `estimateDryRun` builds the
 * real request (`buildJevRequest`) and measures its exact canonical byte
 * length instead of adding a `requestOverheadTokens` estimate on top of
 * evidence bytes (removed in snapshot `version: 2` — see the correction
 * that replaced the ~2.5x-wrong 620–2,440-token guess with a measured
 * request). `version` lets a later phase detect which snapshot produced a
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
  /**
   * Bytes-per-token conversion range used to turn exact canonical request
   * bytes into an approximate token range. Calibrated 2026-09-20 from the
   * first real Jev run (11 requests, small fixture, English prose plus
   * TypeScript/JSON): billed input tokens totalled 71,855 against 320,360
   * measured canonical request bytes, an observed ratio of 4.458
   * bytes/token.
   *
   * `min: 3.0` and `max: 4.8` bracket that ratio, but NOT symmetrically —
   * the two bounds fail in different directions, and only one of them is
   * harmful:
   * - A real ratio ABOVE `max` (content tokenizes MORE efficiently than
   *   4.8 bytes/token) makes `estimatedInputTokens.min` an overestimate of
   *   the true token count — the cost is reported as higher than it will
   *   actually be. Annoying, but harmless.
   * - A real ratio BELOW `min` (content tokenizes LESS efficiently — more
   *   tokens per byte) makes `estimatedInputTokens.max` an underestimate —
   *   the reported range would not even contain what the user is actually
   *   billed. That is the exact failure this whole correction exists to
   *   fix (the old `requestOverheadTokens`-guess estimate didn't contain
   *   71,855 either), so `min` is set deliberately conservative (low)
   *   rather than tight around the single observed sample.
   *
   * The rubric text itself is fixed English (and dominates request bytes —
   * see `rubricBytesPerRequest` on `DryRunEstimate` in
   * `src/domain/estimate.ts`), but the evidence half of every request is
   * whatever the audited repository contains: JSON-heavy or minified
   * fixtures, and especially non-Latin/CJK source (UTF-8 multibyte
   * characters that often cost a full token each), can tokenize well below
   * 3.0 bytes/token — below even this conservative floor. This range rests
   * on ONE real run of 11 English/TypeScript requests, not a broad
   * statistical sample; a repository whose evidence is mostly non-Latin
   * source is a known current limit, not yet covered, until more real runs
   * across varied content are measured.
   */
  readonly bytesPerToken: { readonly min: number; readonly max: number };
  /** Upper bound on follow-up requests per evaluable test case; a follow-up is allowed only when an earlier result identifies a specific evidence need (see `docs/technical-design.md`), never an automatic retry. */
  readonly maxFollowUpsPerTest: number;
  /** Provider's total per-request token ceiling (state + all batched questions). */
  readonly requestTokenCeiling: number;
}

/**
 * Fixed facts as of {@link JevEstimateSnapshot.asOf}: Jev {@link JEV_MODEL_ID}
 * (TypeSafe), USD 0.042 per 1,000,000 input tokens, output tokens unbilled,
 * one request per evaluable test case (one state, all rubric questions
 * batched), and a 64k-token provider request ceiling. `model` reuses
 * {@link JEV_MODEL_ID} directly (never a re-typed literal) so the estimator
 * can never silently drift from the exact pinned model the rubric and every
 * real request use (Phase 4, task P4-4 alignment fix — the estimator
 * previously carried the non-existent alias `jev-1.13`).
 *
 * `version: 2` (bumped from 1): the first real Jev run (11 requests,
 * 2026-09-20) measured 71,855 billed input tokens against this snapshot's
 * `version: 1` estimate of 12,747–37,523 — the estimate did not even
 * contain the true value, because `requestOverheadTokens` guessed the
 * rubric's cost (620–2,440 tokens) instead of measuring it, when the real
 * rubric text alone costs ~5,900 tokens (~26,979 bytes) per request, about
 * 93% of the ~29,124-byte average real request. `requestOverheadTokens` is
 * deleted as of `version: 2`: `estimateDryRun` now builds the real request
 * per evaluable test case (`buildJevRequest`) and measures its exact bytes
 * instead. See `bytesPerToken`'s own doc for how its range was
 * re-calibrated from that same run; every other numeric fact here is a
 * verified pricing/provider fact, not a guess.
 */
export const JEV_ESTIMATE_SNAPSHOT: JevEstimateSnapshot = {
  version: 2,
  model: JEV_MODEL_ID,
  asOf: '2026-09-20',
  usdPerMillionInputTokens: 0.042,
  outputTokensBilled: false,
  bytesPerToken: { min: 3.0, max: 4.8 },
  maxFollowUpsPerTest: 1,
  requestTokenCeiling: 64_000,
};

/**
 * Verified TypeSafe/Jev provider rate limits (2026-09-20, docs.typesafe.ai/models):
 * 250,000 input tokens per second and 1,200 requests per minute. Recorded
 * here, next to {@link JEV_ESTIMATE_SNAPSHOT}, as documented facts. Phase 4
 * did no adaptive throttling against them (Phase 5's "resilience" concern
 * per `odd/tasks/phase-4-jev-evaluation.md`'s Decisions: "Concurrency in
 * this phase is a fixed bounded pool from existing `concurrency`
 * configuration, with no adaptive throttling"). Phase 5, task P5-3 is the
 * first to actually enforce them at runtime: these exact numbers are
 * `ResolvedConfiguration.schedule`'s default (`src/domain/config.ts`),
 * consulted by `createRequestTokenBudgetGate` (`src/application/scheduler.ts`)
 * to gate every real evaluation dispatch.
 */
export const JEV_VERIFIED_RATE_LIMITS: { readonly tokensPerSecond: number; readonly requestsPerMinute: number } = {
  tokensPerSecond: 250_000,
  requestsPerMinute: 1_200,
};

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Validates a positive, non-inverted `{min, max}` range. */
function validateRange(range: { readonly min: number; readonly max: number }, name: string): void {
  const minValid = Number.isFinite(range.min) && range.min > 0;
  const maxValid = Number.isFinite(range.max) && range.max > 0;
  if (!minValid) {
    throw new RangeError(`Jev estimate snapshot ${name}.min must be a positive finite number: ${range.min}`);
  }
  if (!maxValid) {
    throw new RangeError(`Jev estimate snapshot ${name}.max must be a positive finite number: ${range.max}`);
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
  validateRange(snapshot.bytesPerToken, 'bytesPerToken');
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

/** A `{min, max}` token count range — the shared shape `estimateTokensFromBytes` returns and `DryRunEstimate` (`src/domain/estimate.ts`) reports throughout. */
export interface DryRunRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Converts an exact UTF-8 byte count into an approximate token range using
 * `bytesPerToken`'s min/max bounds, rounding OUTWARD (`floor` for the
 * fewer-tokens `min` bound, via the larger `bytesPerToken.max` divisor;
 * `ceil` for the more-tokens `max` bound, via the smaller `bytesPerToken.min`
 * divisor) so the reported range never under-covers the true value it
 * approximates. Used by both `src/domain/jev-request.ts`'s provider-budget
 * check and `src/domain/estimate.ts`'s `estimateDryRun`.
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
