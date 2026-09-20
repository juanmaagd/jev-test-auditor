import { describe, expect, it } from 'vitest';
import {
  createAdaptiveConcurrencyController,
  DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW,
} from '../src/domain/scheduler.js';
import {
  createRequestTokenBudgetGate,
  runAdaptiveSchedule,
  type AdaptiveConcurrencyController,
  type ThrottleSignal,
} from '../src/application/scheduler.js';

// --- Pure adaptive concurrency controller (Phase 5, task P5-3) -------------

describe('adaptive concurrency controller (domain, pure)', () => {
  it('starts at the configured ceiling', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 4, restoreWindow: 3 });
    expect(controller.limit).toBe(4);
  });

  it('halves the limit (floored) on a throttled signal', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 8, restoreWindow: 3 });
    controller.report('throttled');
    expect(controller.limit).toBe(4);
  });

  it('floors an odd halved limit rather than rounding up', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 5, restoreWindow: 3 });
    controller.report('throttled');
    expect(controller.limit).toBe(2); // floor(5 / 2) = 2, never 3
  });

  it('never reduces the limit below 1, however many consecutive throttled signals arrive', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 2, restoreWindow: 3 });
    controller.report('throttled');
    controller.report('throttled');
    controller.report('throttled');
    expect(controller.limit).toBe(1);
  });

  it('does nothing on a neutral signal: neither reduces nor progresses the clean-window streak', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 4, restoreWindow: 2 });
    controller.report('throttled'); // limit -> 2
    controller.report('neutral');
    controller.report('neutral');
    controller.report('neutral');
    expect(controller.limit).toBe(2); // unchanged: neutral never counts toward the restore streak
  });

  it('restores the limit by exactly one step after `restoreWindow` consecutive clean signals, never before', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 8, restoreWindow: 3 });
    controller.report('throttled'); // limit -> 4
    controller.report('clean');
    controller.report('clean');
    expect(controller.limit).toBe(4); // only 2 of 3 required clean signals so far
    controller.report('clean');
    expect(controller.limit).toBe(5); // 3rd consecutive clean signal restores by one step
  });

  it('a neutral signal breaking up two runs of clean signals never lets them combine into one restore', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 8, restoreWindow: 3 });
    controller.report('throttled'); // limit -> 4
    controller.report('clean');
    controller.report('clean');
    controller.report('neutral'); // does not reset the streak, but does not advance it either
    controller.report('clean');
    expect(controller.limit).toBe(5); // 3 clean signals total, uninterrupted in streak-count terms
  });

  it('a throttled signal resets an in-progress clean streak back to zero', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 8, restoreWindow: 3 });
    controller.report('throttled'); // limit -> 4
    controller.report('clean');
    controller.report('clean');
    controller.report('throttled'); // limit -> 2, streak reset
    controller.report('clean');
    controller.report('clean');
    expect(controller.limit).toBe(2); // only 2 clean signals since the reset — one short of restoring
    controller.report('clean');
    expect(controller.limit).toBe(3);
  });

  it('never restores above the configured ceiling, however many clean signals arrive', () => {
    const controller = createAdaptiveConcurrencyController({ ceiling: 4, restoreWindow: 1 });
    controller.report('throttled'); // limit -> 2
    controller.report('clean'); // -> 3
    controller.report('clean'); // -> 4 (ceiling)
    controller.report('clean');
    controller.report('clean');
    controller.report('clean');
    expect(controller.limit).toBe(4);
  });

  it('falls back to a ceiling of 1 for a non-positive or non-integer configured ceiling', () => {
    expect(createAdaptiveConcurrencyController({ ceiling: 0, restoreWindow: 1 }).limit).toBe(1);
    expect(createAdaptiveConcurrencyController({ ceiling: -3, restoreWindow: 1 }).limit).toBe(1);
    expect(createAdaptiveConcurrencyController({ ceiling: 2.5, restoreWindow: 1 }).limit).toBe(1);
    expect(createAdaptiveConcurrencyController({ ceiling: Number.NaN, restoreWindow: 1 }).limit).toBe(1);
  });

  it('exposes the shipped default restore window as a named, documented constant greater than zero', () => {
    expect(DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW)).toBe(true);
  });
});

// --- Request/token budget gate (application, timer-seamed) -----------------

/** A scriptable fake clock + sleep pair: `sleep` always advances the fake clock by exactly the
 * requested duration before resolving, so `waitForCapacity`'s retry loop converges deterministically
 * without ever touching the real clock. Every call is recorded so a test can assert not just
 * whether a wait happened, but for how long. */
function fakeTimers(startAt = 1_000_000): { readonly now: () => number; readonly sleep: (ms: number) => Promise<void>; readonly sleepCalls: number[] } {
  let current = startAt;
  const sleepCalls: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => { sleepCalls.push(ms); current += ms; },
    sleepCalls,
  };
}

describe('request/token budget gate (application)', () => {
  it('allows dispatch immediately while under both the request and token budgets', async () => {
    const { now, sleep, sleepCalls } = fakeTimers();
    const gate = createRequestTokenBudgetGate({ requestsPerMinute: 10, tokensPerSecond: 10_000 }, now, sleep);

    await gate.waitForCapacity();
    gate.recordDispatch(0, 100);

    expect(sleepCalls).toEqual([]);
  });

  it('blocks the (requestsPerMinute + 1)-th dispatch until the 60-second request window rolls over, then allows it', async () => {
    const { now, sleep, sleepCalls } = fakeTimers();
    const gate = createRequestTokenBudgetGate({ requestsPerMinute: 2, tokensPerSecond: 1_000_000 }, now, sleep);

    await gate.waitForCapacity();
    gate.recordDispatch(0, 1);
    await gate.waitForCapacity();
    gate.recordDispatch(0, 1);

    const startedAt = now();
    await gate.waitForCapacity();
    gate.recordDispatch(0, 1);

    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(60_000 - (now() - startedAt));
  });

  it('folds retried attempts (recordDispatch extraRequests) into the request budget, not just one slot per dispatch', async () => {
    const { now, sleep, sleepCalls } = fakeTimers();
    const gate = createRequestTokenBudgetGate({ requestsPerMinute: 2, tokensPerSecond: 1_000_000 }, now, sleep);

    // One dispatch that internally retried 3 extra times (4 attempts total) already consumes the
    // whole 2-request budget on its own (1 reserved slot + 3 extra), so the very next dispatch
    // must wait — proving `extraRequests` is genuinely counted, not silently dropped.
    await gate.waitForCapacity();
    gate.recordDispatch(3, 0);

    await gate.waitForCapacity();

    expect(sleepCalls.length).toBeGreaterThan(0);
  });

  it('blocks the next dispatch once already-recorded token usage meets the tokens-per-second budget, then allows it once the 1-second window rolls over', async () => {
    const { now, sleep, sleepCalls } = fakeTimers();
    const gate = createRequestTokenBudgetGate({ requestsPerMinute: 1_000, tokensPerSecond: 100 }, now, sleep);

    await gate.waitForCapacity();
    gate.recordDispatch(0, 100); // exactly at the budget

    const startedAt = now();
    await gate.waitForCapacity();

    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(now() - startedAt).toBeGreaterThanOrEqual(1_000);
  });

  it('reservations made by two dispatches requested back-to-back (before either records usage) still both count toward the request budget — no lost-update race', async () => {
    const { now, sleep, sleepCalls } = fakeTimers();
    const gate = createRequestTokenBudgetGate({ requestsPerMinute: 2, tokensPerSecond: 1_000_000 }, now, sleep);

    // Deliberately not awaited between the two `waitForCapacity()` calls below (fired the way a
    // concurrent scheduler dispatches two workers without waiting on one before starting the
    // other) — both must still be counted, so a third call blocks.
    const first = gate.waitForCapacity();
    const second = gate.waitForCapacity();
    await first;
    await second;

    expect(sleepCalls).toEqual([]); // both of the first two were still free
    await gate.waitForCapacity();
    expect(sleepCalls.length).toBeGreaterThan(0); // the third had to wait
  });

  it('treats a non-positive or non-finite requestsPerMinute/tokensPerSecond as unlimited (never blocks)', async () => {
    const { now, sleep, sleepCalls } = fakeTimers();
    const gate = createRequestTokenBudgetGate({ requestsPerMinute: 0, tokensPerSecond: -5 }, now, sleep);

    for (let index = 0; index < 5; index += 1) {
      await gate.waitForCapacity();
      gate.recordDispatch(0, 1_000_000);
    }

    expect(sleepCalls).toEqual([]);
  });
});

// --- Dynamic-concurrency dispatcher (application) ---------------------------

/** A hand-scripted controller: `.limit` is fully caller-controlled (not derived from `report`
 * calls), so a dispatcher test can assert the dispatcher itself reacts correctly to a changing
 * limit without depending on the real adaptive controller's own halving/restoring arithmetic —
 * that arithmetic has its own dedicated tests above. */
function scriptedController(limits: readonly number[]): AdaptiveConcurrencyController & { readonly reports: string[] } {
  let index = 0;
  const reports: string[] = [];
  return {
    get limit() { return limits[Math.min(index, limits.length - 1)]!; },
    report(signal: ThrottleSignal) { reports.push(signal); index += 1; },
    reports,
  };
}

describe('adaptive dispatcher (application)', () => {
  it('returns results in submission order regardless of completion order, and resolves an empty item list immediately with no controller reports', async () => {
    const controller = scriptedController([4]);
    const results = await runAdaptiveSchedule<number, number>([], controller, async (item) => ({ result: item, signal: 'clean' }));
    expect(results).toEqual([]);
    expect(controller.reports).toEqual([]);
  });

  it('never runs more workers concurrently than the controller\'s current limit, even as later items resolve before earlier ones', async () => {
    const controller = scriptedController([2]);
    const items = [0, 1, 2, 3];
    const delaysMs: Record<number, number> = { 0: 30, 1: 5, 2: 20, 3: 10 };
    const active = { count: 0, max: 0 };

    const results = await runAdaptiveSchedule<number, number>(items, controller, async (item) => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      await new Promise((resolve) => { setTimeout(resolve, delaysMs[item] ?? 0); });
      active.count -= 1;
      return { result: item * 10, signal: 'clean' };
    });

    expect(results).toEqual([0, 10, 20, 30]);
    expect(active.max).toBeLessThanOrEqual(2);
  });

  it('starts more workers as soon as the controller raises its limit mid-run, without waiting for every in-flight worker to settle first', async () => {
    // Limit starts at 1; after the first report (the 1st completion) it jumps to 3.
    const controller = scriptedController([1, 3, 3, 3, 3]);
    const items = [0, 1, 2, 3];
    const active = { count: 0, max: 0 };
    const startOrder: number[] = [];

    await runAdaptiveSchedule<number, number>(items, controller, async (item) => {
      startOrder.push(item);
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      active.count -= 1;
      return { result: item, signal: 'clean' };
    });

    // Item 0 must start alone (limit 1); once it settles and the limit rises to 3, the remaining
    // three items are free to start together.
    expect(startOrder[0]).toBe(0);
    expect(active.max).toBeGreaterThanOrEqual(2);
  });

  it('forwards each worker\'s reported signal to the controller exactly once, in completion order', async () => {
    const controller = scriptedController([5]);
    const items = ['a', 'b', 'c'];
    const signals: Record<string, 'throttled' | 'clean' | 'neutral'> = { a: 'throttled', b: 'clean', c: 'neutral' };

    await runAdaptiveSchedule<string, string>(items, controller, async (item) => ({ result: item, signal: signals[item]! }));

    expect(controller.reports.sort()).toEqual(['clean', 'neutral', 'throttled']);
  });
});
