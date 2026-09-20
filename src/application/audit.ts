import type {
  AuditCacheKeyPort,
  AuditEvaluationPort,
  AuditEvaluationResult,
  AuditEvaluationTotals,
  AuditPorts,
  AuditRequest,
  AuditResult,
  AuditDiagnostic,
  AuditFileResult,
  AuditStorePort,
  AuditStoreWorkItemIdentity,
} from '../domain/audit.js';
import type { ClassificationResult, OverallClassificationStatus } from '../domain/classification.js';
import { classifyTestCase, type DryRunSkippedReason } from '../domain/estimate.js';
import { createAdaptiveConcurrencyController, DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW, type ThrottleSignal } from '../domain/scheduler.js';
import type { ResolvedScheduleConfiguration } from '../domain/config.js';
import type { Diagnostic, TestCase } from '../domain/test-understanding.js';
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
}

function identityOf(testCase: TestCase): AuditStoreWorkItemIdentity {
  return { testCaseId: testCase.id, repositoryRelativePath: testCase.repositoryRelativePath, name: testCase.name };
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
 * records a `cached` work item and reuses the stored judgment, skipping
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
): Promise<EvaluationRunResult> {
  const { items, skippedByReason, skippedItems } = collectEvaluableItems(files);
  const cacheEnabled = store !== undefined && runId !== undefined && cache !== undefined;
  const controller = createAdaptiveConcurrencyController({ ceiling: concurrency, restoreWindow: DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW });
  const budgetGate = createRequestTokenBudgetGate(scheduler.budget, scheduler.clock, scheduler.sleep);

  if (store !== undefined && runId !== undefined) {
    for (const skipped of skippedItems) {
      await store.recordWorkItem(runId, { state: 'skipped', identity: identityOf(skipped.testCase), reason: skipped.reason });
    }
    // Phase 5, task P5-3: every evaluable item's intended work is made durable BEFORE the
    // scheduler dispatches anything at all — see `AuditStoreWorkItemOutcome`'s own doc for why a
    // later phase's `--resume <runId>` needs this recorded up front, not only once an item starts.
    for (const item of items) {
      await store.recordWorkItem(runId, { state: 'pending', identity: identityOf(item.testCase) });
    }
  }

  const outcomes = await runAdaptiveSchedule<EvaluableItem, EvaluationOutcome>(items, controller, async (item) => {
    if (store !== undefined && runId !== undefined) {
      await store.recordWorkItem(runId, { state: 'running', identity: identityOf(item.testCase) });
    }

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
            await store.recordWorkItem(runId, {
              state: 'cached',
              identity: identityOf(item.testCase),
              cacheKey,
              classification: hit.classification,
            });
            return { result: { kind: 'cached', testCase: item.testCase, classification: hit.classification }, signal: 'neutral' };
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
      const signal: ThrottleSignal = isThrottleErrorKind(evaluationErrorKind(error)) ? 'throttled' : 'neutral';
      return { result: { kind: 'failure', testCase: item.testCase, error }, signal };
    }
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

  for (const outcome of outcomes) {
    if (outcome.kind === 'success' || outcome.kind === 'cached') {
      classifications.push(outcome.classification);
      statusCounts[outcome.classification.status] += 1;
      if (!outcome.classification.model.matchesPin) modelMismatches += 1;
      if (respondedModel === undefined) respondedModel = outcome.classification.model.responded;
      if (outcome.kind === 'success') {
        evaluated += 1;
        // A cache hit spends zero tokens THIS run — its classification's `usage` reflects the
        // ORIGINAL evaluation's cost, recorded when that judgment was first computed, never a
        // fresh spend. Folding it into this run's totals would overstate what this run actually
        // billed.
        inputTokens += outcome.classification.usage.inputTokens;
        outputTokens += outcome.classification.usage.outputTokens;
      } else {
        cached += 1;
      }
      continue;
    }

    failed += 1;
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

  return { evaluation: { classifications, totals }, diagnostics, fileDiagnosticsByPath };
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
}

export async function runAudit(
  request: AuditRequest,
  ports: AuditPorts,
  options: RunAuditOptions = {},
): Promise<AuditResult> {
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
  // whole run. This map is local to `runAudit`, discarded once evaluation finishes, and populated
  // only when evaluation was actually requested at all (`ports.evaluation !== undefined`), since
  // an offline audit never consults it.
  const sourceTextByPath: Map<string, string> | undefined = ports.evaluation === undefined ? undefined : new Map();

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
      continue;
    }

    try {
      const extraction = ports.extractor.extract({
        repositoryRelativePath: discovered.repositoryRelativePath,
        sourceText,
        frameworkHint: discovered.framework,
      });
      const fileDiagnostics: Diagnostic[] = [...extraction.diagnostics];
      diagnostics.push(...extraction.diagnostics.map((diagnostic) => withPath(diagnostic, discovered.repositoryRelativePath)));

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
        discovered,
        testCases: extraction.testCases,
        dynamicMetadata: extraction.dynamicMetadata,
        diagnostics: fileDiagnostics,
        evidence,
      });
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
    }
  }

  // Opt-in evaluation (Phase 4, task P4-4): `ports.evaluation` is the entire
  // gate — see its own doc on `AuditEvaluationPort` in `src/domain/audit.ts`.
  // When absent, evaluation is skipped entirely: no gateway is constructed,
  // no API key is read, nothing here reaches the network.
  let finalFiles: readonly AuditFileResult[] = results;
  let evaluation: AuditEvaluationResult | undefined;
  if (ports.evaluation !== undefined) {
    // Phase 5, task P5-1: `ports.store` is opt-in exactly like `ports.evaluation` (see
    // `AuditStorePort`'s own doc) — `beginRun`/`finishRun` bracket this one run only when a store
    // is actually present, so an offline or store-less `--evaluate` run never touches it.
    const runId = ports.store === undefined ? undefined : await ports.store.beginRun(request.rootDir);
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
    const evaluationRun = await runEvaluation(results, ports.evaluation, request.concurrency, scheduler, ports.store, runId, cache);
    evaluation = evaluationRun.evaluation;
    diagnostics.push(...evaluationRun.diagnostics);
    finalFiles = withEvaluationDiagnostics(results, evaluationRun.fileDiagnosticsByPath);
    if (ports.store !== undefined && runId !== undefined) await ports.store.finishRun(runId);
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
    files: finalFiles,
    excluded,
    diagnostics,
    totals,
    reportingOnly: true,
    ...(evaluation === undefined ? {} : { evaluation }),
  };
}
