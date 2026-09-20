/**
 * Pure adaptive concurrency state machine (Phase 5, task P5-3). Decides the
 * evaluation scheduler's current effective concurrency limit from observed
 * provider throttling signals only — never a wall-clock heuristic
 * (`odd/tasks/phase-5-persistence.md` Decisions: "Adaptive throttling is
 * derived from observed provider responses ... not from a wall-clock
 * heuristic"). No I/O, no timers, no randomness: every transition is a
 * synchronous, deterministic function of the signal fed to it, so this file
 * is trivially unit-testable and stays pure per this repository's hexagonal
 * boundaries (`src/domain` never imports an adapter or the application
 * layer — see `test/architecture-boundary.test.ts`).
 *
 * The caller (`src/application/scheduler.ts`'s `runAdaptiveSchedule`, wired
 * from `src/application/audit.ts`'s `runEvaluation`) is responsible for
 * classifying each completed dispatch into exactly one {@link ThrottleSignal}
 * and reporting it here; this module only reacts.
 */

/**
 * One dispatch's classification, reported once per completed worker:
 *
 * - `'throttled'`: the dispatch's observed outcome indicates the provider
 *   pushed back (see `src/application/audit.ts`'s own doc on how a
 *   successful evaluation with `attempts > 1`, or a failure whose typed
 *   error kind is `'rate-limit'`/`'overloaded'`, is derived from the
 *   gateway's already-existing retry seam — never a new gateway signal).
 *   Halves the limit and resets the clean-window streak.
 * - `'clean'`: the dispatch completed with no throttling signal at all (a
 *   first-attempt success). Extends the clean-window streak; once it
 *   reaches {@link AdaptiveConcurrencyOptions.restoreWindow} consecutive
 *   `'clean'` reports, the limit is raised by one step.
 * - `'neutral'`: the dispatch produced no throttling evidence either way (a
 *   cache hit, which made no provider request at all, or a failure of some
 *   other kind entirely — auth, malformed response, timeout, abort). Never
 *   changes the limit and never advances or resets the clean-window streak:
 *   an unrelated failure storm must not look like either "the provider is
 *   throttling us" or "traffic is clean," so it is invisible to this state
 *   machine by design.
 */
export type ThrottleSignal = 'throttled' | 'clean' | 'neutral';

export interface AdaptiveConcurrencyOptions {
  /** The starting limit, and the ceiling {@link AdaptiveConcurrencyController.limit} is never raised above — always the configured `concurrency` (Phase 5 Decisions: "never exceeds the configured `concurrency` ceiling"). A non-positive or non-integer value falls back to `1`, mirroring Phase 4's `runBoundedPool` fallback for the same shape of input. */
  readonly ceiling: number;
  /** Consecutive `'clean'` reports required before the limit is raised by one step. A non-positive or non-integer value falls back to `1` (restore on every single clean report). */
  readonly restoreWindow: number;
}

export interface AdaptiveConcurrencyController {
  /** The current effective concurrency limit; always an integer in `[1, ceiling]`. */
  readonly limit: number;
  /** Reports one completed dispatch's classification; see {@link ThrottleSignal}'s own doc for exactly what each value does. */
  report(signal: ThrottleSignal): void;
}

/**
 * The default consecutive-clean-dispatch count required to restore the
 * limit by one step after a throttle event. `5` is a deliberately
 * conservative choice — restoring too eagerly after a single lucky success
 * risks walking straight back into the same 429/529 that triggered the
 * reduction, while `5` genuinely-clean dispatches is real, repeated
 * evidence that the provider has recovered. Not itself derived from a
 * verified provider fact (unlike {@link JEV_VERIFIED_RATE_LIMITS} in
 * `src/domain/jev-pricing.ts`), so it is a named, documented constant
 * rather than a magic number, and deliberately not exposed as user-facing
 * configuration (Phase 5, task P5-3 scope: only the request/token budgets
 * are configuration-worthy facts about the provider; this is a scheduling
 * policy choice).
 */
export const DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW = 5;

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Creates an {@link AdaptiveConcurrencyController} starting at
 * `options.ceiling`. See {@link ThrottleSignal}'s own doc for the exact
 * transition each report triggers.
 */
export function createAdaptiveConcurrencyController(options: AdaptiveConcurrencyOptions): AdaptiveConcurrencyController {
  const ceiling = normalizePositiveInteger(options.ceiling, 1);
  const restoreWindow = normalizePositiveInteger(options.restoreWindow, 1);

  let limit = ceiling;
  let cleanStreak = 0;

  return {
    get limit(): number {
      return limit;
    },
    report(signal: ThrottleSignal): void {
      if (signal === 'neutral') return;
      if (signal === 'throttled') {
        cleanStreak = 0;
        limit = Math.max(1, Math.floor(limit / 2));
        return;
      }
      // 'clean'
      if (limit >= ceiling) {
        cleanStreak = 0;
        return;
      }
      cleanStreak += 1;
      if (cleanStreak >= restoreWindow) {
        limit = Math.min(ceiling, limit + 1);
        cleanStreak = 0;
      }
    },
  };
}
