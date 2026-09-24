import {
  AuditResumeLegacyRootDirError,
  AuditResumeRootDirMismatchError,
  AuditResumeRunNotFoundError,
  AuditResumeUnavailableError,
  type AuditCacheKeyPort,
  type AuditEvaluationPort,
  type AuditEvaluationResult,
  type AuditEvaluationTotals,
  type AuditPorts,
  type AuditProgressPort,
  type AuditRequest,
  type AuditResult,
  type AuditResumeSummary,
  type AuditDiagnostic,
  type AuditFileResult,
  type AuditStoreCachedJudgment,
  type AuditStorePort,
  type AuditStoreRunState,
  type AuditStoreWorkItemIdentity,
  type AuditStoreWorkItemOutcome,
} from '../domain/audit.js';
import type { ClassificationResult, OverallClassificationStatus } from '../domain/classification.js';
import { classifyTestCase, type DryRunSkippedReason } from '../domain/estimate.js';
import { createAdaptiveConcurrencyController, DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW, type ThrottleSignal } from '../domain/scheduler.js';
import type { ResolvedScheduleConfiguration } from '../domain/config.js';
import type { Diagnostic, TestCase, TestCaseId } from '../domain/test-understanding.js';
import type { EvidenceBundle } from '../domain/evidence.js';
import type { JevEvaluation } from '../domain/jev-gateway.js';
import {
  createRequestTokenBudgetGate,
  defaultSchedulerClock,
  defaultSchedulerSleep,
  runAdaptiveSchedule,
  type SchedulerClock,
  type SchedulerSleep,
} from './scheduler.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The typed error `code` (see `src/domain/jev-gateway.ts`'s `JevGatewayError` union) when `error` carries one, else `'unknown'`. Duck-typed rather than an `instanceof` check against a specific error class, since `AuditEvaluationPort` is a domain-typed port any adapter may implement — not only the shipped TypeSafe HTTP gateway. */
function evaluationErrorKind(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'unknown';
}

function comparePath(left: { readonly repositoryRelativePath: string }, right: { readonly repositoryRelativePath: string }): number {
  return left.repositoryRelativePath < right.repositoryRelativePath ? -1
    : left.repositoryRelativePath > right.repositoryRelativePath ? 1 : 0;
}

function withPath(diagnostic: Diagnostic, repositoryRelativePath: string): AuditDiagnostic {
  return { ...diagnostic, repositoryRelativePath };
}

/**
 * `error`'s reported HTTP-attempt count (see `src/domain/jev-gateway.ts`'s
 * `JevGatewayErrorBase.attempts`) when `error` carries one, else `1` — a
 * conservative fallback for a foreign `AuditEvaluationPort` implementation
 * that throws something with no `attempts` field: `evaluate()` was
 * definitely called at least once, so `1` (never `0`) is the safe minimum
 * to fold into the request budget (see {@link RequestTokenBudgetGate.recordDispatch}'s
 * own doc in `src/application/scheduler.ts`).
 */
function evaluationErrorAttempts(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'attempts' in error) {
    const attempts = (error as { readonly attempts: unknown }).attempts;
    if (typeof attempts === 'number' && Number.isFinite(attempts) && attempts >= 0) return attempts;
  }
  return 1;
}

/** `true` for the two typed error kinds that mean "the provider itself pushed back" (429/529 — see `src/domain/jev-gateway.ts`'s `JevRateLimitError`/`JevOverloadedError`), as opposed to every other failure (auth, malformed request/response, timeout, abort), which carries no throttling evidence at all. */
function isThrottleErrorKind(kind: string): boolean {
  return kind === 'rate-limit' || kind === 'overloaded';
}

interface EvaluableItem {
  readonly testCase: TestCase;
  readonly bundle: EvidenceBundle;
}

/**
 * Splits every extracted test case across every file into the evaluable
 * ones (with their matched evidence bundle) and a skip-reason tally, using
 * exactly `classifyTestCase` from `src/domain/estimate.ts` — the same
 * function `estimateDryRun` uses — so "what counts as evaluable" is shared
 * with the dry-run estimator, never redefined here (Phase 4, task P4-4:
 * "reuse `classifyTestCase` ... so the definition of evaluable ... is
 * shared, not duplicated"). Preserves `files`' own order (already sorted by
 * path) and each file's own `testCases` order, so the resulting list's
 * order is deterministic independent of evaluation itself.
 */
interface SkippedItem {
  readonly testCase: TestCase;
  readonly reason: DryRunSkippedReason;
}

function collectEvaluableItems(files: readonly AuditFileResult[]): {
  readonly items: readonly EvaluableItem[];
  readonly skippedByReason: Record<DryRunSkippedReason, number>;
  /** Same skipped test cases as `skippedByReason`, kept individually (Phase 5, task P5-1) so `runEvaluation` can persist one `skipped` work item per test case, not only a tally. */
  readonly skippedItems: readonly SkippedItem[];
} {
  const items: EvaluableItem[] = [];
  const skippedByReason: Record<DryRunSkippedReason, number> = { skip: 0, todo: 0, 'evidence-unavailable': 0 };
  const skippedItems: SkippedItem[] = [];

  for (const file of files) {
    const bundlesByTestCaseId = new Map(file.evidence.map((bundle) => [bundle.testCaseId, bundle]));
    for (const testCase of file.testCases) {
      const bundle = bundlesByTestCaseId.get(testCase.id);
      const classification = classifyTestCase(testCase, bundle);
      if (classification.status === 'skipped') {
        skippedByReason[classification.reason] += 1;
        skippedItems.push({ testCase, reason: classification.reason });
        continue;
      }
      if (bundle === undefined) {
        // Unreachable: `classifyTestCase` only returns `evaluable` when `evidenceBundle` is defined.
        throw new Error(`unreachable: evaluable test case ${testCase.id} has no evidence bundle`);
      }
      items.push({ testCase, bundle });
    }
  }

  return { items, skippedByReason, skippedItems };
}

type EvaluationOutcome =
  | { readonly kind: 'success'; readonly testCase: TestCase; readonly classification: ClassificationResult; readonly evaluation: JevEvaluation }
  | { readonly kind: 'cached'; readonly testCase: TestCase; readonly classification: ClassificationResult }
  | { readonly kind: 'failure'; readonly testCase: TestCase; readonly error: unknown };

/**
 * Content-addressed caching inputs (Phase 5, task P5-2), bundled together
 * since all three matter only as a whole: `port` computes the key,
 * `sourceTextByPath` supplies the one ingredient `AuditFileResult` itself
 * never carries (the file's full raw source text — see `runAudit`'s own
 * comment on why it is never retained past this point), and `fresh`
 * bypasses lookup without disabling recording. Optional on `runEvaluation`
 * exactly like `store`/`runId`: absent, caching is skipped entirely and
 * every evaluable item dispatches exactly as it did before this task.
 */
interface EvaluationCacheOptions {
  readonly port: AuditCacheKeyPort;
  readonly sourceTextByPath: ReadonlyMap<string, string>;
  readonly fresh: boolean;
}

interface EvaluationRunResult {
  readonly evaluation: AuditEvaluationResult;
  /** Root-level diagnostics (already carrying `repositoryRelativePath`), one per failed evaluation. */
  readonly diagnostics: readonly AuditDiagnostic[];
  /** The same failures, grouped by owning file path, as plain `Diagnostic`s (no path field) for merging into that file's own `diagnostics` — parity with how `evidence-selection-failed` is merged. */
  readonly fileDiagnosticsByPath: ReadonlyMap<string, readonly Diagnostic[]>;
  /** `undefined` unless resuming (Phase 5, task P5-4): how many currently evaluable items were outstanding (dispatched, or would have been) vs. already terminal and reused as-is. */
  readonly resumeCounts?: { readonly outstanding: number; readonly reused: number };
}

function identityOf(testCase: TestCase): AuditStoreWorkItemIdentity {
  return { testCaseId: testCase.id, repositoryRelativePath: testCase.repositoryRelativePath, name: testCase.name };
}

/** A stable string key for a work-item identity (Phase 5, task P5-4), so a resumed run's `terminalWorkItems` (loaded by identity fields, not by array position) can be matched against the currently discovered evaluable/skippable items via a `Map`. */
function identityKey(identity: AuditStoreWorkItemIdentity): string {
  return JSON.stringify([identity.testCaseId, identity.repositoryRelativePath, identity.name]);
}

/**
 * Reconstructs the exact `evaluation-failed` diagnostic a previously
 * recorded `failed` work item would have produced (Phase 5, task P5-4):
 * `messageOf` reads `.message` (an `Error` instance), and
 * `evaluationErrorKind` duck-types `.code` — both satisfied here with the
 * ORIGINAL `errorKind`/`errorMessage` a resumed run reuses rather than
 * regenerates, so a reused failure's diagnostic reads identically to the
 * one the interrupted attempt itself produced.
 */
class ResumedEvaluationFailure extends Error {
  readonly code: string;

  constructor(errorKind: string, errorMessage: string) {
    super(errorMessage);
    this.name = 'ResumedEvaluationFailure';
    this.code = errorKind;
  }
}

/**
 * One evaluable item's already-terminal outcome from a resumed run's
 * `AuditStoreRunState.terminalWorkItems` (Phase 5, task P5-4), narrowed to
 * the three states that can ever apply to a currently-evaluable item — a
 * `skipped` terminal record is never passed here (see `runEvaluation`'s own
 * resume-partitioning comment for why: it would mean the source changed
 * between the interrupted attempt and this resume, and that drift is
 * handled by treating the item as outstanding instead, not by reuse).
 */
type ResumableTerminalOutcome = Extract<AuditStoreWorkItemOutcome, { readonly state: 'completed' | 'cached' | 'failed' }>;

function isResumableTerminal(outcome: AuditStoreWorkItemOutcome): outcome is ResumableTerminalOutcome {
  return outcome.state === 'completed' || outcome.state === 'cached' || outcome.state === 'failed';
}

/** Reconstructs the `EvaluationOutcome` a resumed run reuses in place of dispatching, from a previously recorded terminal work item — never a fresh provider request. */
function outcomeFromTerminal(testCase: TestCase, terminal: ResumableTerminalOutcome): EvaluationOutcome {
  if (terminal.state === 'completed') return { kind: 'success', testCase, classification: terminal.classification, evaluation: terminal.evaluation };
  if (terminal.state === 'cached') return { kind: 'cached', testCase, classification: terminal.classification };
  return { kind: 'failure', testCase, error: new ResumedEvaluationFailure(terminal.errorKind, terminal.errorMessage) };
}

/**
 * `--resume <runId>` inputs (Phase 5, task P5-4), built once by `runAudit`
 * from `AuditStorePort.loadRunState`'s `terminalWorkItems`, keyed by
 * identity for O(1) lookup per currently evaluable/skippable item.
 */
interface EvaluationResumeOptions {
  readonly terminalByIdentityKey: ReadonlyMap<string, AuditStoreWorkItemOutcome>;
}

/**
 * Scheduling inputs (Phase 5, task P5-3), always present — unlike
 * `store`/`cache`, adaptive throttling and budget observance are not
 * opt-in: every real evaluation dispatch respects them, store or no store.
 * `clock`/`sleep` are the only timer seam `runEvaluation` touches (see
 * `src/application/scheduler.ts`'s own doc); `runAudit` defaults them to
 * `defaultSchedulerClock`/`defaultSchedulerSleep` when a caller (the CLI)
 * supplies neither.
 */
interface EvaluationSchedulerOptions {
  readonly clock: SchedulerClock;
  readonly sleep: SchedulerSleep;
  readonly budget: ResolvedScheduleConfiguration;
}

/**
 * Evaluates every evaluable test case across `files` through
 * `evaluationPort`, dispatched by the adaptive scheduler
 * (`src/application/scheduler.ts`'s `runAdaptiveSchedule`, Phase 5, task
 * P5-3 — replacing Phase 4's fixed-size `runBoundedPool`): it starts at
 * `concurrency` (never exceeding it), halves on an observed provider
 * throttle, and restores by one step after enough consecutive clean
 * dispatches (see `src/domain/scheduler.ts`'s own doc for the exact
 * transitions). Every real dispatch also passes through
 * `scheduler.budget`'s request/token gate first (`createRequestTokenBudgetGate`),
 * so this run never issues more than the configured requests-per-minute or
 * tokens-per-second, independent of concurrency. A rejected `evaluate` call
 * is isolated to its own test case: it contributes no entry to
 * `classifications` (never a fabricated verdict) and produces one
 * `evaluation-failed` diagnostic naming the test case id and the error's
 * typed kind — never the request body, and never the API key (the
 * gateway's own error types are constructed so a key can never reach their
 * `message` in the first place; see `src/domain/jev-gateway.ts`).
 *
 * **Throttle-signal derivation** (Phase 5 Decisions: "derived from observed
 * provider responses ... not from a wall-clock heuristic"): the gateway
 * retries 429/529 internally and surfaces only the final outcome, so this
 * function never sees a 429 directly. It reuses two seams that already
 * cross the port boundary rather than widening the gateway contract —
 * `JevEvaluation.attempts` (a successful dispatch's own attempt count,
 * already persisted as `attempts.attempts`) and the failure's typed error
 * kind: `attempts > 1` on a success is possible ONLY because the gateway
 * retries exclusively on 429/529 (see `src/adapters/jev-http-gateway.ts`'s
 * own doc — no other outcome is ever retried), so it is an exact, existing
 * signal of "the provider pushed back, then let this one through" — never
 * a guess. A failure whose kind is `'rate-limit'`/`'overloaded'`
 * (`JevRateLimitError`/`JevOverloadedError`) is throttling that was never
 * recovered from. Every other outcome (a cache hit, or any other failure
 * kind) reports `'neutral'` — see `ThrottleSignal`'s own doc
 * (`src/domain/scheduler.ts`) for why an unrelated failure must stay
 * invisible to the adaptive controller rather than being folded into
 * either direction.
 *
 * When `store`/`runId` are both given (Phase 5, task P5-1: `ports.store` is
 * opt-in exactly like `ports.evaluation`), every evaluable item gets a
 * `pending` checkpoint recorded up front, before the scheduler dispatches
 * anything at all, then a `running` checkpoint the moment the scheduler
 * actually picks it up, then its terminal outcome
 * (`completed`/`cached`/`failed`) once it settles — persisted through
 * `store.recordWorkItem` before that worker's outcome is returned, so an
 * interrupted run still leaves every already-reached checkpoint committed
 * (a `skipped` item, already known before the scheduler starts at all,
 * skips straight to its terminal record — it is never dispatched, so it
 * has no `pending`/`running` checkpoint of its own). See
 * `AuditStoreWorkItemOutcome`'s own doc (`src/domain/audit.ts`) for exactly
 * what a later phase's `--resume <runId>` can read back from this trail.
 *
 * When `cache` is also given (Phase 5, task P5-2; requires `store`/`runId`
 * too — caching without persistence has nothing to look anything up in),
 * each item's cache key is computed first. Unless `cache.fresh` is `true`,
 * `store.lookup` runs before ever calling `evaluationPort.evaluate`: a hit
 * records a `cached` work item whose judgment is re-derived locally from the
 * stored raw answers under the current policy (`cache.port.classifyCached`), skipping
 * the provider call (and the request/token budget gate, and any throttle
 * signal — a cache hit is `'neutral'`) entirely; a miss (or `cache.fresh`)
 * dispatches exactly as before, and a successful dispatch's `completed`
 * record now also carries the computed key, so a later run can find it.
 * `cache.fresh` never skips recording — it only skips the lookup — so a
 * fresh dispatch's result is still a new, immutable, appended `completed`
 * record; it never mutates or deletes the judgment(s) already stored under
 * that key.
 */
async function runEvaluation(
  files: readonly AuditFileResult[],
  evaluationPort: AuditEvaluationPort,
  concurrency: number,
  scheduler: EvaluationSchedulerOptions,
  store?: AuditStorePort,
  runId?: string,
  cache?: EvaluationCacheOptions,
  resume?: EvaluationResumeOptions,
  /**
   * Terminal-progress reporting (Phase 6, task P6-3), independent of `store`/`runId` — see
   * `AuditProgressPort`'s own doc (`src/domain/audit.ts`) for why: progress describes what THIS
   * RUN is doing, not what gets persisted. Notified at exactly the same checkpoints
   * `store.recordWorkItem` is, but never gated on `store`/`runId` being present — a run with no
   * store still reports every transition.
   */
  progress?: AuditProgressPort,
): Promise<EvaluationRunResult> {
  const { items, skippedByReason, skippedItems } = collectEvaluableItems(files);
  const cacheEnabled = store !== undefined && runId !== undefined && cache !== undefined;
  const controller = createAdaptiveConcurrencyController({ ceiling: concurrency, restoreWindow: DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW });
  const budgetGate = createRequestTokenBudgetGate(scheduler.budget, scheduler.clock, scheduler.sleep);

  // Phase 5, task P5-4: partition every currently evaluable item into "already terminal under
  // this run id — reuse, never redispatch" and "outstanding — dispatch normally," using the
  // resumed run's own last-recorded state per identity. A `skipped` terminal match is
  // deliberately NOT reused here (only `completed`/`cached`/`failed` are, via
  // `ResumableTerminalOutcome`): it can only mean the audited source changed between the
  // interrupted attempt and this resume (a currently-evaluable item cannot have been correctly
  // classified `skipped` before, since skip/evaluable status is a deterministic function of the
  // test's own source) — the documented assumption is an unchanged repository, but drifting into
  // "treat it as outstanding and dispatch it for real" degrades safely rather than silently
  // losing coverage or crashing.
  const preloadedOutcomes: (EvaluationOutcome | undefined)[] = new Array(items.length);
  const outstandingIndices: number[] = [];
  const outstandingItems: EvaluableItem[] = [];
  items.forEach((item, index) => {
    const terminal = resume?.terminalByIdentityKey.get(identityKey(identityOf(item.testCase)));
    if (terminal !== undefined && isResumableTerminal(terminal)) {
      preloadedOutcomes[index] = outcomeFromTerminal(item.testCase, terminal);
      return;
    }
    outstandingIndices.push(index);
    outstandingItems.push(item);
  });

  // A skipped item whose identity already carries a `skipped` terminal record under this run
  // (the ordinary case: it was recorded before the interruption, or this is the run's very first
  // pass) is never re-recorded — an honest, minimal append, not a duplicate checkpoint for work
  // that was never dispatched in the first place. Any OTHER terminal state matched against a
  // now-skipped identity (the source-drift case above) still gets a fresh `skipped` record, since
  // none exists yet under that state.
  const skippedToRecord = resume === undefined
    ? skippedItems
    : skippedItems.filter((skipped) => resume.terminalByIdentityKey.get(identityKey(identityOf(skipped.testCase)))?.state !== 'skipped');

  // T3: the last pre-dispatch phase marker, right before `begin` — only when caching is actually
  // enabled (a store, a run id, and a cache-key port all present); with no cache to check, nothing
  // would be checked, and this phase never fires (see `AuditPrePhase`'s own doc).
  if (cacheEnabled) progress?.phase?.({ phase: 'checking-cache' });

  // Phase 6, task P6-3: `begin` fires exactly once, before any per-item transition, naming
  // precisely how many work items will reach a terminal state THIS run — see
  // `AuditProgressPort.begin`'s own doc for why an already-terminal, reused item on a resumed run
  // is deliberately excluded from this count (never `items.length` unconditionally).
  progress?.begin(skippedToRecord.length + outstandingItems.length);

  for (const skipped of skippedToRecord) {
    if (store !== undefined && runId !== undefined) {
      await store.recordWorkItem(runId, { state: 'skipped', identity: identityOf(skipped.testCase), reason: skipped.reason });
    }
    progress?.report({ state: 'skipped', identity: identityOf(skipped.testCase), concurrencyLimit: controller.limit });
  }
  // Phase 5, task P5-3: every evaluable item's intended work is made durable BEFORE the
  // scheduler dispatches anything at all — see `AuditStoreWorkItemOutcome`'s own doc for why a
  // later phase's `--resume <runId>` needs this recorded up front, not only once an item starts.
  // Phase 5, task P5-4: only the OUTSTANDING items get this checkpoint on a resumed run — an
  // already-terminal item is reused, never re-announced as pending. Appending another `pending`
  // row for an item that already had one (e.g. it reached `running` before the interruption) is
  // still honest, append-only history: "we are attempting this item again, as of now."
  for (const item of outstandingItems) {
    if (store !== undefined && runId !== undefined) {
      await store.recordWorkItem(runId, { state: 'pending', identity: identityOf(item.testCase) });
    }
    progress?.report({ state: 'pending', identity: identityOf(item.testCase), concurrencyLimit: controller.limit });
  }

  const dispatchedOutcomes = await runAdaptiveSchedule<EvaluableItem, EvaluationOutcome>(outstandingItems, controller, async (item) => {
    if (store !== undefined && runId !== undefined) {
      await store.recordWorkItem(runId, { state: 'running', identity: identityOf(item.testCase) });
    }
    progress?.report({ state: 'running', identity: identityOf(item.testCase), concurrencyLimit: controller.limit });

    let cacheKey: string | undefined;
    if (cacheEnabled) {
      // Believed unreachable: every evaluable item's file was successfully read (a read failure
      // leaves that file with zero test cases, so it never reaches `collectEvaluableItems`).
      // Handled gracefully rather than thrown, so a cache-plumbing gap degrades to "cache
      // disabled for this one item" instead of crashing the whole run.
      const sourceText = cache.sourceTextByPath.get(item.testCase.repositoryRelativePath);
      if (sourceText !== undefined) {
        cacheKey = cache.port.computeKey({ testCase: item.testCase, bundle: item.bundle }, sourceText);
        if (!cache.fresh) {
          const hit = await store.lookup(cacheKey);
          if (hit !== undefined) {
            // Re-derived locally under the CURRENT policy from the stored raw answers, never the
            // stored verdict (`odd/tasks/policy-free-cache-and-calibration.md`, task T1): a policy
            // change must never cost a provider request.
            const classification = cache.port.classifyCached({ testCase: item.testCase, bundle: item.bundle }, hit.evaluation);
            await store.recordWorkItem(runId, {
              state: 'cached',
              identity: identityOf(item.testCase),
              cacheKey,
              classification,
            });
            progress?.report({ state: 'cached', identity: identityOf(item.testCase), concurrencyLimit: controller.limit });
            return { result: { kind: 'cached', testCase: item.testCase, classification }, signal: 'neutral' };
          }
        }
      }
    }

    await budgetGate.waitForCapacity();
    try {
      const { classification, evaluation } = await evaluationPort.evaluate({ testCase: item.testCase, bundle: item.bundle });
      budgetGate.recordDispatch(Math.max(0, evaluation.attempts - 1), evaluation.usage.inputTokens + evaluation.usage.outputTokens);
      if (store !== undefined && runId !== undefined) {
        await store.recordWorkItem(runId, {
          state: 'completed',
          identity: identityOf(item.testCase),
          ...(cacheKey === undefined ? {} : { cacheKey }),
          evaluation,
          classification,
        });
      }
      progress?.report({ state: 'completed', identity: identityOf(item.testCase), concurrencyLimit: controller.limit });
      const signal: ThrottleSignal = evaluation.attempts > 1 ? 'throttled' : 'clean';
      return { result: { kind: 'success', testCase: item.testCase, classification, evaluation }, signal };
    } catch (error) {
      budgetGate.recordDispatch(Math.max(0, evaluationErrorAttempts(error) - 1), 0);
      if (store !== undefined && runId !== undefined) {
        await store.recordWorkItem(runId, {
          state: 'failed',
          identity: identityOf(item.testCase),
          errorKind: evaluationErrorKind(error),
          errorMessage: messageOf(error),
        });
      }
      progress?.report({ state: 'failed', identity: identityOf(item.testCase), concurrencyLimit: controller.limit });
      const signal: ThrottleSignal = isThrottleErrorKind(evaluationErrorKind(error)) ? 'throttled' : 'neutral';
      return { result: { kind: 'failure', testCase: item.testCase, error }, signal };
    }
  });

  // Merge dispatched results back into `items`' own deterministic order (Phase 5, task P5-4): a
  // reused item's preloaded outcome, or an outstanding item's fresh dispatch result — every index
  // is covered by exactly one of the two, since the partition above is exhaustive.
  const outcomes: EvaluationOutcome[] = new Array(items.length);
  outstandingIndices.forEach((originalIndex, dispatchedIndex) => {
    outcomes[originalIndex] = dispatchedOutcomes[dispatchedIndex]!;
  });
  preloadedOutcomes.forEach((outcome, index) => {
    if (outcome !== undefined) outcomes[index] = outcome;
  });

  const classifications: ClassificationResult[] = [];
  const diagnostics: AuditDiagnostic[] = [];
  const fileDiagnosticsByPath = new Map<string, Diagnostic[]>();
  let evaluated = 0;
  let cached = 0;
  let failed = 0;
  let modelMismatches = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const statusCounts: Record<OverallClassificationStatus, number> = {
    healthy: 0, weak: 0, misleading: 0, 'needs-review': 0,
  };
  let respondedModel: string | undefined;
  // Phase 6, task P6-2: per-evaluable-test-case cache provenance and fresh-dispatch latency — see
  // `TestCaseCacheStatus`/`TestCaseLatency`'s own docs (`src/domain/audit.ts`). Built in this same
  // pass over `outcomes` (already the run's one deterministic, fully-merged — dispatched and
  // resume-reused alike — outcome list) rather than a second traversal, so it can never disagree
  // with `classifications`/`totals` about which items were cached/fresh/failed.
  const cacheStatusByTestCaseId = new Map<TestCaseId, 'cached' | 'fresh' | 'not-evaluated'>();
  const latencyByTestCaseId = new Map<TestCaseId, { readonly latencyMs: number; readonly attemptLatenciesMs?: readonly number[] }>();

  for (const outcome of outcomes) {
    if (outcome.kind === 'success' || outcome.kind === 'cached') {
      classifications.push(outcome.classification);
      statusCounts[outcome.classification.status] += 1;
      if (!outcome.classification.model.matchesPin) modelMismatches += 1;
      if (respondedModel === undefined) respondedModel = outcome.classification.model.responded;
      if (outcome.kind === 'success') {
        evaluated += 1;
        cacheStatusByTestCaseId.set(outcome.testCase.id, 'fresh');
        // Never fabricated: absent from `outcome.evaluation` (a resumed item reconstructed from a
        // pre-P6-1 store row) means genuinely never measured, not zero — see `TestCaseLatency`'s
        // own doc.
        if (outcome.evaluation.latencyMs !== undefined) {
          latencyByTestCaseId.set(outcome.testCase.id, {
            latencyMs: outcome.evaluation.latencyMs,
            ...(outcome.evaluation.attemptLatenciesMs === undefined ? {} : { attemptLatenciesMs: outcome.evaluation.attemptLatenciesMs }),
          });
        }
        // A cache hit spends zero tokens THIS run — its classification's `usage` reflects the
        // ORIGINAL evaluation's cost, recorded when that judgment was first computed, never a
        // fresh spend. Folding it into this run's totals would overstate what this run actually
        // billed.
        inputTokens += outcome.classification.usage.inputTokens;
        outputTokens += outcome.classification.usage.outputTokens;
      } else {
        cached += 1;
        cacheStatusByTestCaseId.set(outcome.testCase.id, 'cached');
      }
      continue;
    }

    failed += 1;
    cacheStatusByTestCaseId.set(outcome.testCase.id, 'not-evaluated');
    const plainDiagnostic: Diagnostic = {
      code: 'evaluation-failed',
      message: `Unable to evaluate test case ${outcome.testCase.id} ("${outcome.testCase.name}"): `
        + `${evaluationErrorKind(outcome.error)}: ${messageOf(outcome.error)}`,
      severity: 'error',
    };
    diagnostics.push(withPath(plainDiagnostic, outcome.testCase.repositoryRelativePath));
    const existing = fileDiagnosticsByPath.get(outcome.testCase.repositoryRelativePath) ?? [];
    fileDiagnosticsByPath.set(outcome.testCase.repositoryRelativePath, [...existing, plainDiagnostic]);
  }

  const skippedTotal = skippedByReason.skip + skippedByReason.todo + skippedByReason['evidence-unavailable'];
  const totals: AuditEvaluationTotals = {
    evaluated,
    cached,
    failed,
    skipped: { total: skippedTotal, byReason: skippedByReason },
    usage: { inputTokens, outputTokens },
    statusCounts,
    respondedModel,
    modelMismatches,
  };

  return {
    evaluation: { classifications, totals, cacheStatusByTestCaseId, latencyByTestCaseId },
    diagnostics,
    fileDiagnosticsByPath,
    ...(resume === undefined ? {} : { resumeCounts: { outstanding: outstandingItems.length, reused: items.length - outstandingItems.length } }),
  };
}

/** Merges each failed evaluation's plain diagnostic into its owning file's own `diagnostics` array, exactly like `evidence-selection-failed` is merged — leaving every unaffected file's object reference untouched. */
function withEvaluationDiagnostics(
  files: readonly AuditFileResult[],
  fileDiagnosticsByPath: ReadonlyMap<string, readonly Diagnostic[]>,
): readonly AuditFileResult[] {
  if (fileDiagnosticsByPath.size === 0) return files;
  return files.map((file) => {
    const extra = fileDiagnosticsByPath.get(file.discovered.repositoryRelativePath);
    return extra === undefined ? file : { ...file, diagnostics: [...file.diagnostics, ...extra] };
  });
}

/**
 * Per-invocation run-mode options for {@link runAudit} (Phase 5, task
 * P5-2), kept separate from {@link AuditRequest}/`ResolvedConfiguration`
 * exactly like the CLI's own `--dry-run`/`--evaluate`/`--json` flags: these
 * are how this one call behaves, not audit-target configuration.
 */
export interface RunAuditOptions {
  /**
   * Bypasses cache lookup for every evaluable test case (`--fresh` at the
   * CLI): dispatches a fresh provider request regardless of a warm cache.
   * Never skips recording — a fresh dispatch's result is still written as
   * a new, immutable, appended `completed` record; it never mutates or
   * deletes any judgment already stored under that key. Has no effect
   * without a cache-key port and store both present (see
   * {@link AuditPorts.cacheKey}'s own doc). Defaults to `false`.
   */
  readonly fresh?: boolean;
  /**
   * Test seam only (Phase 5, task P5-3): overrides the adaptive scheduler's
   * notion of wall-clock time and its wait mechanism, so a request/token
   * budget test never sleeps on the real clock. Production default:
   * `defaultSchedulerClock`/`defaultSchedulerSleep` (`src/application/scheduler.ts`,
   * real `Date.now`/a real `setTimeout`-based wait). Has no effect unless
   * `ports.evaluation` is present — an offline audit never constructs a
   * scheduler at all.
   */
  readonly clock?: SchedulerClock;
  readonly sleep?: SchedulerSleep;
  /**
   * Resumes a previously started, interrupted run (Phase 5, task P5-4,
   * `--resume <runId>` at the CLI): reloads `runId`'s durable state
   * (`AuditStorePort.loadRunState`) and completes only its outstanding
   * work items — see `runAudit`'s own doc for the full preflight contract
   * (not-found / root-dir-mismatch / already-finished) this triggers.
   * Requires `ports.store` (and, transitively, `ports.evaluation` — the
   * CLI itself only ever offers `--resume` alongside `--evaluate`).
   * Has no effect on an offline audit; passing it without a store throws
   * {@link AuditResumeUnavailableError} rather than silently starting a
   * fresh run.
   */
  readonly resume?: string;
  /**
   * Retains every discovered file's full raw source text and exposes it on
   * `AuditResult.sourceTextByPath` (Phase 5, task P5-5) — the one ingredient
   * a cache-aware `audit --dry-run` preview needs to compute each evaluable
   * test case's content-addressed cache key without re-reading every file.
   * `false` by default: an ordinary audit (including `--evaluate`, which
   * already builds this map internally for its own cache-key lookups) never
   * pays for retaining every file's content past the run it was read for,
   * and never grows a new field on its result, unless a caller explicitly
   * asks for it.
   */
  readonly retainSourceText?: boolean;
}

const EMPTY_AUDIT_TOTALS = {
  files: 0,
  excluded: 0,
  testCases: 0,
  dynamicMetadata: 0,
  diagnostics: 0,
  unsupportedFrameworkFiles: 0,
  evidenceBundles: 0,
  evidenceFragments: 0,
  evidenceTruncatedFragments: 0,
  evidenceOmitted: 0,
  evidenceDenied: 0,
  evidenceUnresolved: 0,
};

/**
 * `runAudit`'s `--resume <runId>` preflight (Phase 5, task P5-4), run
 * BEFORE any discovery/extraction/evidence work at all — mirroring the
 * discovery-failure early return just below it: a resume-specific problem
 * is diagnosed (or, for "already finished," honestly disclosed as nothing
 * to do) without paying for a pipeline run whose result would just be
 * discarded.
 *
 * Four named outcomes (Phase 5 Decisions, this task, plus the rootDir-identity
 * defect fix of 2026-09-20): `runId` does not exist at all (throws
 * {@link AuditResumeRunNotFoundError}); `runId` was recorded before this fix
 * started persisting a canonical `rootDir` and cannot be safely
 * re-interpreted (throws {@link AuditResumeLegacyRootDirError} — checked
 * BEFORE the mismatch comparison below, since a legacy run's raw stored
 * string is never a trustworthy input to that comparison at all); `runId`
 * belongs to a different root directory than `request.rootDir`, once both
 * sides are canonicalized through {@link AuditStorePort.canonicalizeRootDir}
 * (throws {@link AuditResumeRootDirMismatchError} — its own message still
 * names the raw `request.rootDir` the caller typed, never the canonicalized
 * form, so the error is legible against what was actually passed on the
 * command line); `runId` is already finished (`AuditStoreRunState.finished`)
 * — NOT an error, `runAudit` returns immediately with
 * `resume.nothingOutstanding: true` and an honest all-zero report, exactly
 * like a fresh, empty run would look, never a fabricated evaluation of work
 * that already happened. Every other case returns the loaded
 * {@link AuditStoreRunState} for `runAudit` to continue with (reusing
 * `runId` instead of minting a new one via `beginRun`).
 */
async function preflightResume(
  request: AuditRequest,
  ports: AuditPorts,
  runId: string,
): Promise<{ readonly earlyResult: AuditResult } | { readonly runState: AuditStoreRunState }> {
  if (ports.store === undefined) throw new AuditResumeUnavailableError(runId);
  const state = await ports.store.loadRunState(runId);
  if (state === undefined) throw new AuditResumeRunNotFoundError(runId);
  if (!state.rootDirCanonical) throw new AuditResumeLegacyRootDirError(runId, state.rootDir);
  const canonicalRequestRootDir = await ports.store.canonicalizeRootDir(request.rootDir);
  if (state.rootDir !== canonicalRequestRootDir) throw new AuditResumeRootDirMismatchError(runId, state.rootDir, request.rootDir);
  if (state.finished) {
    return {
      earlyResult: {
        rootDir: request.rootDir,
        // Phase 6, task P6-2b: this early return continues an existing run identity exactly like
        // the ordinary resumed path below does — `runId` here is never independent of `resume.runId`.
        runId,
        files: [],
        excluded: [],
        diagnostics: [],
        totals: EMPTY_AUDIT_TOTALS,
        reportingOnly: true,
        resume: { runId, outstanding: 0, reused: 0, nothingOutstanding: true },
      },
    };
  }
  return { runState: state };
}

export async function runAudit(
  request: AuditRequest,
  ports: AuditPorts,
  options: RunAuditOptions = {},
): Promise<AuditResult> {
  let resumeState: AuditStoreRunState | undefined;
  if (options.resume !== undefined) {
    const preflight = await preflightResume(request, ports, options.resume);
    if ('earlyResult' in preflight) return preflight.earlyResult;
    resumeState = preflight.runState;
  }

  // T3 (`odd/tasks/audit-run-responsiveness.md`): the very first thing a caller with progress
  // wired ever sees — before discovery itself has even resolved, so a large suite (15–20s of
  // silent discovery/extraction/evidence-selection before `progress.begin()`, per this task's own
  // evidence) shows SOMETHING from the first second rather than nothing until dispatch starts.
  // `--resume`'s own preflight above (when present) still runs first: a resume-specific failure is
  // diagnosed before this run does any pipeline work at all, exactly like the discovery-failure
  // early return just below it.
  ports.progress?.phase?.({ phase: 'discovering' });

  let discovery;
  try {
    discovery = await ports.discovery.discover({
      rootDir: request.rootDir,
      include: request.include,
      exclude: request.exclude,
    });
  } catch (error) {
    const diagnostics: readonly AuditDiagnostic[] = [{
      code: 'discovery-failed',
      message: `Unable to discover test files: ${messageOf(error)}`,
      severity: 'error',
    }];
    return {
      rootDir: request.rootDir,
      files: [],
      excluded: [],
      diagnostics,
      totals: {
        files: 0,
        excluded: 0,
        testCases: 0,
        dynamicMetadata: 0,
        diagnostics: diagnostics.length,
        unsupportedFrameworkFiles: 0,
        evidenceBundles: 0,
        evidenceFragments: 0,
        evidenceTruncatedFragments: 0,
        evidenceOmitted: 0,
        evidenceDenied: 0,
        evidenceUnresolved: 0,
      },
      reportingOnly: true,
    };
  }

  const files = [...discovery.files].sort(comparePath);
  const excluded = [...discovery.excluded].sort((left, right) => {
    const pathOrder = comparePath(left, right);
    return pathOrder !== 0 ? pathOrder : left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
  });
  const diagnostics: AuditDiagnostic[] = [...discovery.diagnostics];
  const results: AuditFileResult[] = [];
  // Phase 5, task P5-2: the cache key needs each evaluable test case's whole-file source (see
  // `src/adapters/cache-key.ts`'s own doc on why `state.fragments` alone is not enough), which
  // `AuditFileResult` itself never carries — deliberately: retaining full raw source there would
  // let it leak into `AuditResult`/JSON reports and hold every file's content in memory for the
  // whole run. This map is local to `runAudit`, discarded once evaluation finishes (unless
  // `options.retainSourceText` says otherwise — see below), and populated when either evaluation
  // was actually requested at all (`ports.evaluation !== undefined`, for its own internal
  // cache-key lookups) or a caller explicitly asked to retain it (Phase 5, task P5-5: a
  // cache-aware `audit --dry-run` preview, which has no evaluation port of its own).
  const needsSourceText = ports.evaluation !== undefined || options.retainSourceText === true;
  const sourceTextByPath: Map<string, string> | undefined = needsSourceText ? new Map() : undefined;

  // T3: one combined `'extracting'` phase event per file, covering extraction AND evidence
  // selection together — they happen back-to-back for the same file in this same loop iteration,
  // so two alternating phase labels would only flicker a TTY line and double a non-TTY log for no
  // benefit (see `AuditPrePhase`'s own doc, `src/domain/audit.ts`). Throttled to at most ~20
  // updates regardless of suite size (a count-based gate, not time-based, so this stays
  // deterministic and needs no fake clock to test) — bounded output on a suite of 7,000 test cases
  // across hundreds of files, exactly as free as a suite of 3 files.
  const phaseEveryFiles = Math.max(1, Math.floor(files.length / 20));
  let filesProcessed = 0;
  let extractedTestCases = 0;
  function reportExtractingPhase(testCasesInThisFile: number): void {
    filesProcessed += 1;
    extractedTestCases += testCasesInThisFile;
    if (ports.progress?.phase === undefined) return;
    if (filesProcessed === files.length || filesProcessed % phaseEveryFiles === 0) {
      ports.progress.phase({ phase: 'extracting', done: filesProcessed, total: files.length, testCases: extractedTestCases });
    }
  }

  for (const discovered of files) {
    let sourceText: string;
    try {
      sourceText = await ports.sourceReader.read({
        rootDir: request.rootDir,
        repositoryRelativePath: discovered.repositoryRelativePath,
      });
      sourceTextByPath?.set(discovered.repositoryRelativePath, sourceText);
    } catch (error) {
      const diagnostic = withPath({
        code: 'source-read-failed',
        message: `Unable to read ${discovered.repositoryRelativePath}: ${messageOf(error)}`,
        severity: 'error',
      }, discovered.repositoryRelativePath);
      diagnostics.push(diagnostic);
      results.push({
        discovered,
        testCases: [],
        dynamicMetadata: [],
        diagnostics: [{ code: diagnostic.code, message: diagnostic.message, severity: diagnostic.severity }],
        evidence: [],
      });
      reportExtractingPhase(0); // never reached extraction at all — 0 test cases from this file
      continue;
    }

    try {
      // `odd/tasks/jest-ambient-globals.md`: `discovered.framework` already
      // reflects every import-based signal discovery itself has (see
      // `src/adapters/repository-discovery.ts`); `jestFrameworkHint` is
      // consulted ONLY when that came back `'unknown'` — import-based
      // attribution always wins, this is a fallback of last resort, exactly
      // like `extractTestCases`'s own `bindings.frameworks[0] ??
      // request.frameworkHint ?? 'unknown'` precedence (unchanged) already
      // treats whatever hint it receives.
      const configFrameworkHint = discovered.framework === 'unknown'
        ? await ports.jestFrameworkHint?.resolve(discovered.repositoryRelativePath)
        : undefined;
      const frameworkHint = discovered.framework !== 'unknown' ? discovered.framework : (configFrameworkHint ?? 'unknown');
      const extraction = ports.extractor.extract({
        repositoryRelativePath: discovered.repositoryRelativePath,
        sourceText,
        frameworkHint,
      });
      const fileDiagnostics: Diagnostic[] = [...extraction.diagnostics];
      diagnostics.push(...extraction.diagnostics.map((diagnostic) => withPath(diagnostic, discovered.repositoryRelativePath)));
      // The config hint, once it changes what `extractTestCases` actually
      // attributed (carried on every one of this file's own test cases —
      // they all share one `context.framework`, see `test-extraction.ts`),
      // is also reflected back onto the `discovered` record this run
      // reports: `AuditFileResult.discovered.framework` otherwise stays
      // discovery's own stale `'unknown'` verbatim, and that field is what
      // both the CLI's discovered-files line and the JSON/HTML report print
      // (`src/cli/index.ts`, `src/domain/report.ts`) — not the per-test-case
      // value. `frameworkEvidence` is deliberately left untouched: it has no
      // `'config'` source (`FrameworkEvidenceSource` is `'import' |
      // 'package'`, a `src/domain/discovery.ts` type this task's scope does
      // not touch), so a config-attributed file reports `framework: 'jest'`
      // with an empty `frameworkEvidence` — see README/technical-design.
      const resolvedFramework = extraction.testCases[0]?.framework ?? discovered.framework;
      const effectiveDiscovered = resolvedFramework === discovered.framework
        ? discovered
        : { ...discovered, framework: resolvedFramework };

      let evidence: readonly EvidenceBundle[] = [];
      if (extraction.testCases.length > 0) {
        try {
          const evidenceResult = await ports.evidence.build({
            rootDir: request.rootDir,
            repositoryRelativePath: discovered.repositoryRelativePath,
            sourceText,
            testCases: extraction.testCases,
            budget: { maxFragmentBytes: request.evidence.maxFragmentBytes, maxBundleBytes: request.evidence.maxBundleBytes },
            deny: request.evidence.deny,
          });
          evidence = evidenceResult.bundles;
          fileDiagnostics.push(...evidenceResult.diagnostics);
          diagnostics.push(...evidenceResult.diagnostics.map((diagnostic) => withPath(diagnostic, discovered.repositoryRelativePath)));
        } catch (error) {
          const diagnostic = withPath({
            code: 'evidence-failed',
            message: `Unable to build evidence for ${discovered.repositoryRelativePath}: ${messageOf(error)}`,
            severity: 'error',
          }, discovered.repositoryRelativePath);
          diagnostics.push(diagnostic);
          fileDiagnostics.push({ code: diagnostic.code, message: diagnostic.message, severity: diagnostic.severity });
          evidence = [];
        }
      }

      results.push({
        discovered: effectiveDiscovered,
        testCases: extraction.testCases,
        dynamicMetadata: extraction.dynamicMetadata,
        diagnostics: fileDiagnostics,
        evidence,
      });
      reportExtractingPhase(extraction.testCases.length);
    } catch (error) {
      const diagnostic = withPath({
        code: 'extraction-failed',
        message: `Unable to extract ${discovered.repositoryRelativePath}: ${messageOf(error)}`,
        severity: 'error',
      }, discovered.repositoryRelativePath);
      diagnostics.push(diagnostic);
      results.push({
        discovered,
        testCases: [],
        dynamicMetadata: [],
        diagnostics: [{ code: diagnostic.code, message: diagnostic.message, severity: diagnostic.severity }],
        evidence: [],
      });
      reportExtractingPhase(0); // extraction itself failed — 0 test cases from this file
    }
  }

  // Opt-in evaluation (Phase 4, task P4-4): `ports.evaluation` is the entire
  // gate — see its own doc on `AuditEvaluationPort` in `src/domain/audit.ts`.
  // When absent, evaluation is skipped entirely: no gateway is constructed,
  // no API key is read, nothing here reaches the network.
  let finalFiles: readonly AuditFileResult[] = results;
  let evaluation: AuditEvaluationResult | undefined;
  let resumeSummary: AuditResumeSummary | undefined;
  // Phase 6, task P6-2b: hoisted out of the `if` block below so this run's persisted identity (or
  // its genuine absence) reaches the returned `AuditResult` — see `AuditResult.runId`'s own doc.
  let runId: string | undefined;
  if (ports.evaluation !== undefined) {
    // Phase 5, task P5-1: `ports.store` is opt-in exactly like `ports.evaluation` (see
    // `AuditStorePort`'s own doc) — `beginRun`/`finishRun` bracket this one run only when a store
    // is actually present, so an offline or store-less `--evaluate` run never touches it.
    // Phase 5, task P5-4: a resumed run CONTINUES `options.resume` rather than minting a fresh id
    // via `beginRun` — the preflight above already confirmed it exists, belongs to this rootDir,
    // and is not already finished, so `runs.finished_at` simply gets set (again, harmlessly) by
    // `finishRun` below once this pass completes.
    // Defect fix (2026-09-20): `beginRun` always receives an already-canonicalized rootDir — never
    // the raw `request.rootDir` — so what gets PERSISTED is the same absolute, symlink-resolved
    // identity `preflightResume` compares a later `--resume` request against. Canonicalizing here,
    // at persist time, rather than only at compare time, is the fix itself: re-resolving a raw
    // stored value later would resolve it against the WRONG (resume-time) working directory (see
    // `AuditStorePort.canonicalizeRootDir`'s own doc).
    runId = resumeState !== undefined
      ? options.resume
      : ports.store === undefined ? undefined : await ports.store.beginRun(await ports.store.canonicalizeRootDir(request.rootDir));
    // Phase 5, task P5-2: caching is meaningful only alongside persistence (a lookup needs
    // somewhere to look things up in), so `cache` is built only when `ports.cacheKey` is present —
    // never independently of `ports.store`/`runId`, which `runEvaluation` itself also re-checks.
    const cache = ports.cacheKey === undefined || sourceTextByPath === undefined
      ? undefined
      : { port: ports.cacheKey, sourceTextByPath, fresh: options.fresh ?? false };
    // Phase 5, task P5-3: scheduling (adaptive concurrency and the request/token budget gate) is
    // never opt-in — every real evaluation dispatch goes through it, store or no store, cache or
    // no cache. `clock`/`sleep` default to the real clock/timer exactly once evaluation is
    // actually requested at all (never constructed for an offline audit).
    const scheduler = {
      clock: options.clock ?? defaultSchedulerClock,
      sleep: options.sleep ?? defaultSchedulerSleep,
      budget: request.schedule,
    };
    // Phase 5, task P5-4: `resumeOptions` is built once here, keyed by identity, from the
    // preflight's already-loaded `terminalWorkItems` — `runEvaluation` never re-queries the store.
    const resumeOptions = resumeState === undefined
      ? undefined
      : { terminalByIdentityKey: new Map(resumeState.terminalWorkItems.map((outcome) => [identityKey(outcome.identity), outcome])) };
    const evaluationRun = await runEvaluation(results, ports.evaluation, request.concurrency, scheduler, ports.store, runId, cache, resumeOptions, ports.progress);
    evaluation = evaluationRun.evaluation;
    diagnostics.push(...evaluationRun.diagnostics);
    finalFiles = withEvaluationDiagnostics(results, evaluationRun.fileDiagnosticsByPath);
    if (ports.store !== undefined && runId !== undefined) await ports.store.finishRun(runId);
    if (options.resume !== undefined && evaluationRun.resumeCounts !== undefined) {
      const { outstanding, reused } = evaluationRun.resumeCounts;
      resumeSummary = { runId: options.resume, outstanding, reused, nothingOutstanding: outstanding === 0 };
    }
  }

  const evidenceBundles = finalFiles.flatMap((file) => file.evidence);
  const totals = {
    files: finalFiles.length,
    excluded: excluded.length,
    testCases: finalFiles.reduce((total, file) => total + file.testCases.length, 0),
    dynamicMetadata: finalFiles.reduce((total, file) => total + file.dynamicMetadata.length, 0),
    diagnostics: diagnostics.length,
    // B-1: one file, one count, regardless of how many `unsupported-framework`
    // diagnostics it happens to carry (extraction emits at most one).
    unsupportedFrameworkFiles: finalFiles.filter((file) => file.diagnostics.some((diagnostic) => diagnostic.code === 'unsupported-framework')).length,
    evidenceBundles: evidenceBundles.length,
    evidenceFragments: evidenceBundles.reduce((total, bundle) => total + bundle.totals.fragments, 0),
    evidenceTruncatedFragments: evidenceBundles.reduce((total, bundle) => total + bundle.totals.truncatedFragments, 0),
    evidenceOmitted: evidenceBundles.reduce((total, bundle) => total + bundle.omitted.length, 0),
    evidenceDenied: evidenceBundles.reduce((total, bundle) => total + bundle.denied.length, 0),
    evidenceUnresolved: evidenceBundles.reduce((total, bundle) => total + bundle.unresolved.length, 0),
  };
  return {
    rootDir: request.rootDir,
    ...(runId === undefined ? {} : { runId }),
    files: finalFiles,
    excluded,
    diagnostics,
    totals,
    reportingOnly: true,
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(resumeSummary === undefined ? {} : { resume: resumeSummary }),
    ...(options.retainSourceText === true && sourceTextByPath !== undefined ? { sourceTextByPath } : {}),
  };
}

/**
 * Computes the set of currently evaluable test-case ids that already have a
 * stored judgment under their content-addressed cache key (Phase 5, task
 * P5-5) — the one piece of I/O a cache-aware `audit --dry-run` preview
 * needs before calling `estimateDryRun` (`src/domain/estimate.ts`, a pure
 * domain function that never touches a store itself).
 *
 * Reuses `collectEvaluableItems` (the exact same "what counts as
 * evaluable" `runEvaluation` above uses) and, for each item, computes its
 * key through the caller-supplied `cacheKeyPort` and looks it up through
 * the caller-supplied `lookup` — the identical two calls `runEvaluation`
 * itself makes before a real dispatch (`cache.port.computeKey(...)` then
 * `store.lookup(cacheKey)`). Calling the exact same functions with the
 * exact same inputs, rather than independently re-deriving an equivalent
 * key, is what guarantees a dry run's reported billable count agrees with
 * what a subsequent real `--evaluate` run over the same fixture and the
 * same store actually dispatches — by construction, not by careful
 * duplication that could quietly drift.
 *
 * `sourceTextByPath` must be the same per-file raw source map `runAudit`
 * itself can expose (`RunAuditOptions.retainSourceText`,
 * `AuditResult.sourceTextByPath`). An evaluable item whose file's source is
 * missing here is simply skipped — never counted as a hit, never looked up
 * at all — the same "believed unreachable, handled gracefully" posture
 * `runEvaluation` takes for the identical gap (a file that failed to read
 * never reaches `collectEvaluableItems` at all, so in practice this never
 * triggers for real discovered files; it degrades a plumbing gap to "this
 * one item is not cache-aware" rather than crashing the whole preview).
 */
export async function computeDryRunCacheHits(
  files: readonly AuditFileResult[],
  sourceTextByPath: ReadonlyMap<string, string>,
  cacheKeyPort: AuditCacheKeyPort,
  lookup: (cacheKey: string) => Promise<AuditStoreCachedJudgment | undefined>,
): Promise<ReadonlySet<TestCaseId>> {
  const { items } = collectEvaluableItems(files);
  const hits = new Set<TestCaseId>();
  for (const item of items) {
    const sourceText = sourceTextByPath.get(item.testCase.repositoryRelativePath);
    if (sourceText === undefined) continue;
    const cacheKey = cacheKeyPort.computeKey({ testCase: item.testCase, bundle: item.bundle }, sourceText);
    const hit = await lookup(cacheKey);
    if (hit !== undefined) hits.add(item.testCase.id);
  }
  return hits;
}
