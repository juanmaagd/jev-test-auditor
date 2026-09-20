/**
 * Application-layer scheduling primitives (Phase 5, task P5-3): a
 * request/token budget gate that observes the verified provider limits
 * (`JEV_VERIFIED_RATE_LIMITS`, `src/domain/jev-pricing.ts`) and a
 * dynamic-concurrency dispatcher that replaces Phase 4's fixed-size
 * `runBoundedPool` (`src/application/audit.ts`). Both are wired from
 * `runEvaluation`; neither does any I/O of its own — `SchedulerClock`/
 * `SchedulerSleep` are the only seams either one touches, always
 * caller-injected so a test never sleeps on the real clock (this
 * repository's Phase 5 TDD mode: "inject a clock or a scheduler seam
 * rather than sleeping on the real clock, so the suite stays fast and does
 * not flake").
 */
export type { AdaptiveConcurrencyController, ThrottleSignal } from '../domain/scheduler.js';
import type { AdaptiveConcurrencyController, ThrottleSignal } from '../domain/scheduler.js';

export type SchedulerClock = () => number;
export type SchedulerSleep = (ms: number) => Promise<void>;

/** Real wall-clock time — the production default when `runAudit` is not given a test seam. */
export const defaultSchedulerClock: SchedulerClock = () => Date.now();

/** A real, cancelable-free `setTimeout` wait — the production default. Never used by a test, which always injects a fake `SchedulerSleep` instead. */
export const defaultSchedulerSleep: SchedulerSleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

const REQUEST_WINDOW_MS = 60_000;
const TOKEN_WINDOW_MS = 1_000;

export interface RequestTokenBudgetConfig {
  /** Requests allowed per rolling 60-second window. Verified default: `JEV_VERIFIED_RATE_LIMITS.requestsPerMinute` (`src/domain/jev-pricing.ts`). A non-positive or non-finite value is treated as unlimited (the gate never blocks on the request budget). */
  readonly requestsPerMinute: number;
  /** Tokens allowed per rolling 1-second window. Verified default: `JEV_VERIFIED_RATE_LIMITS.tokensPerSecond`. A non-positive or non-finite value is treated as unlimited. */
  readonly tokensPerSecond: number;
}

export interface RequestTokenBudgetGate {
  /**
   * Waits until dispatching one more request would not exceed either
   * budget, then reserves exactly one request slot before returning
   * (synchronously, on the same tick that found capacity — no `await`
   * happens between the check and the reservation), so two dispatches
   * requested back-to-back by a concurrent scheduler — neither of which has
   * reported its own usage yet — cannot both slip through a stale check
   * (verified by `test/scheduler.test.ts`'s "no lost-update race" case).
   * The token budget has no equivalent reservation: a request's real token
   * cost is never known before the provider responds, so it can only be
   * observed reactively, via {@link recordDispatch} after the fact — see
   * that method's own doc.
   */
  waitForCapacity(): Promise<void>;
  /**
   * Records a just-completed dispatch's real cost. `extraRequests` is the
   * dispatch's internal HTTP attempts beyond the one slot
   * {@link waitForCapacity} already reserved for it — `0` for a dispatch
   * that succeeded (or failed) on its first attempt, `attempts - 1` for one
   * the gateway had to retry internally (see `src/adapters/jev-http-gateway.ts`'s
   * own 429/529 backoff, left untouched by this phase). `tokens` is the
   * total input+output tokens actually billed; `0` for a dispatch that
   * never received a usage figure (every failure).
   */
  recordDispatch(extraRequests: number, tokens: number): void;
}

interface UsageEntry {
  readonly at: number;
  readonly amount: number;
}

function pruneExpired(entries: UsageEntry[], now: number, windowMs: number): void {
  while (entries.length > 0 && now - entries[0]!.at >= windowMs) entries.shift();
}

function sumAmounts(entries: readonly UsageEntry[]): number {
  return entries.reduce((total, entry) => total + entry.amount, 0);
}

/** `true` for a budget value that should never block dispatch — non-positive, non-finite, or `NaN` — treated as "unlimited" rather than "always blocked" (a `0` or negative configured value is a misconfiguration, not a request to halt every evaluation forever). */
function isUnlimited(value: number): boolean {
  return !Number.isFinite(value) || value <= 0;
}

/**
 * Creates a {@link RequestTokenBudgetGate} tracking two independent rolling
 * windows: requests over the last 60 seconds, tokens over the last 1
 * second — matching the verified provider contract's own per-minute and
 * per-second units (`JEV_VERIFIED_RATE_LIMITS`). `clock`/`sleep` are always
 * caller-injected (see this module's own doc).
 */
export function createRequestTokenBudgetGate(
  config: RequestTokenBudgetConfig,
  clock: SchedulerClock,
  sleep: SchedulerSleep,
): RequestTokenBudgetGate {
  const requestsPerMinute = config.requestsPerMinute;
  const tokensPerSecond = config.tokensPerSecond;
  const requestEntries: UsageEntry[] = [];
  const tokenEntries: UsageEntry[] = [];

  return {
    async waitForCapacity(): Promise<void> {
      for (;;) {
        const now = clock();
        pruneExpired(requestEntries, now, REQUEST_WINDOW_MS);
        pruneExpired(tokenEntries, now, TOKEN_WINDOW_MS);

        const requestBlocked = !isUnlimited(requestsPerMinute) && sumAmounts(requestEntries) >= requestsPerMinute;
        const tokenBlocked = !isUnlimited(tokensPerSecond) && sumAmounts(tokenEntries) >= tokensPerSecond;

        if (!requestBlocked && !tokenBlocked) {
          // Reserve the one slot this dispatch is about to spend, synchronously, before this
          // function's first (and only, on this path) `await` — see this method's own doc.
          requestEntries.push({ at: now, amount: 1 });
          return;
        }

        const requestWaitMs = requestBlocked ? REQUEST_WINDOW_MS - (now - requestEntries[0]!.at) : 0;
        const tokenWaitMs = tokenBlocked ? TOKEN_WINDOW_MS - (now - tokenEntries[0]!.at) : 0;
        await sleep(Math.max(requestWaitMs, tokenWaitMs, 1));
      }
    },

    recordDispatch(extraRequests: number, tokens: number): void {
      const now = clock();
      if (extraRequests > 0) requestEntries.push({ at: now, amount: extraRequests });
      if (tokens > 0) tokenEntries.push({ at: now, amount: tokens });
    },
  };
}

// --- Dynamic-concurrency dispatcher ------------------------------------------------------

export interface ScheduledWorkOutcome<R> {
  readonly result: R;
  /** This dispatch's throttle classification, forwarded verbatim to `controller.report` exactly once. See {@link ThrottleSignal}'s own doc (`src/domain/scheduler.ts`). */
  readonly signal: ThrottleSignal;
}

/**
 * Replaces Phase 4's fixed-size `runBoundedPool` (`src/application/audit.ts`)
 * with a dynamic-concurrency dispatcher: `controller.limit` is re-read
 * before every new dispatch decision, so a mid-run change (a throttle
 * reduction or a clean-window restoration) takes effect on the very next
 * decision — never only at the start of the run. Like `runBoundedPool`,
 * `results[i]` always corresponds to `items[i]` regardless of completion
 * order (Phase 4, task P4-4: "Deterministic result ordering regardless of
 * completion order"), and an in-flight worker started under a higher limit
 * is never cancelled when the limit later drops — a reduction only ever
 * withholds the *next* dispatch, matching Phase 5 Decisions: "never exceeds
 * the configured `concurrency` ceiling" (the ceiling bounds how many are
 * ever *started* concurrently, since `controller.limit` itself is capped
 * at that ceiling — see `AdaptiveConcurrencyOptions.ceiling`'s own doc).
 */
export function runAdaptiveSchedule<T, R>(
  items: readonly T[],
  controller: AdaptiveConcurrencyController,
  worker: (item: T) => Promise<ScheduledWorkOutcome<R>>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return Promise.resolve(results);

  let nextIndex = 0;
  let active = 0;
  let settled = 0;

  return new Promise<R[]>((resolve, reject) => {
    function pump(): void {
      while (active < controller.limit && nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        active += 1;
        const item = items[currentIndex];
        if (item === undefined) {
          reject(new Error(`unreachable: schedule index ${currentIndex} out of range`));
          return;
        }
        worker(item).then(
          (outcome) => {
            results[currentIndex] = outcome.result;
            controller.report(outcome.signal);
            active -= 1;
            settled += 1;
            if (settled === items.length) resolve(results);
            else pump();
          },
          (error: unknown) => { reject(error); },
        );
      }
    }
    pump();
  });
}
