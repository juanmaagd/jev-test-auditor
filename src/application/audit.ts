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
import type { Diagnostic, TestCase } from '../domain/test-understanding.js';
import type { EvidenceBundle } from '../domain/evidence.js';
import type { JevEvaluation } from '../domain/jev-gateway.js';

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
 * Runs `worker` over `items` with at most `limit` concurrently in flight,
 * writing each result to its own fixed index rather than appending as
 * workers settle — so `results[i]` always corresponds to `items[i]`
 * regardless of which one actually finishes first (Phase 4, task P4-4:
 * "Deterministic result ordering regardless of completion order"). A
 * non-positive, non-integer, or otherwise invalid `limit` (including
 * `NaN`) falls back to `1` rather than silently running zero or an
 * unbounded number of workers.
 */
async function runBoundedPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  const poolSize = Number.isInteger(limit) && limit > 0 ? Math.min(limit, items.length) : 1;
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      const item = items[currentIndex];
      if (item === undefined) throw new Error(`unreachable: pool index ${currentIndex} out of range`);
      results[currentIndex] = await worker(item);
    }
  }

  await Promise.all(Array.from({ length: poolSize }, runWorker));
  return results;
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
 * Evaluates every evaluable test case across `files` through
 * `evaluationPort`, bounded by `concurrency` (Phase 4 Decisions: "a fixed
 * bounded pool from existing `concurrency` configuration, with no adaptive
 * throttling"). A rejected `evaluate` call is isolated to its own test case:
 * it contributes no entry to `classifications` (never a fabricated verdict)
 * and produces one `evaluation-failed` diagnostic naming the test case id
 * and the error's typed kind — never the request body, and never the API
 * key (the gateway's own error types are constructed so a key can never
 * reach their `message` in the first place; see `src/domain/jev-gateway.ts`).
 *
 * When `store`/`runId` are both given (Phase 5, task P5-1: `ports.store` is
 * opt-in exactly like `ports.evaluation`), every terminal work item this
 * function reaches — `skipped` up front (already known before the pool
 * starts), then `completed`/`cached`/`failed` as each pool worker settles —
 * is persisted through `store.recordWorkItem` before that worker's outcome
 * is returned, so an interrupted run still leaves every already-terminal
 * item committed. `runBoundedPool` itself is untouched: this only adds a
 * side effect inside the existing worker callback, never changes dispatch
 * order or concurrency (that is Phase 5, task P5-3's job).
 *
 * When `cache` is also given (Phase 5, task P5-2; requires `store`/`runId`
 * too — caching without persistence has nothing to look anything up in),
 * each item's cache key is computed first. Unless `cache.fresh` is `true`,
 * `store.lookup` runs before ever calling `evaluationPort.evaluate`: a hit
 * records a `cached` work item and reuses the stored judgment, skipping
 * the provider call entirely; a miss (or `cache.fresh`) dispatches exactly
 * as before, and a successful dispatch's `completed` record now also
 * carries the computed key, so a later run can find it. `cache.fresh`
 * never skips recording — it only skips the lookup — so a fresh dispatch's
 * result is still a new, immutable, appended `completed` record; it never
 * mutates or deletes the judgment(s) already stored under that key.
 */
async function runEvaluation(
  files: readonly AuditFileResult[],
  evaluationPort: AuditEvaluationPort,
  concurrency: number,
  store?: AuditStorePort,
  runId?: string,
  cache?: EvaluationCacheOptions,
): Promise<EvaluationRunResult> {
  const { items, skippedByReason, skippedItems } = collectEvaluableItems(files);
  const cacheEnabled = store !== undefined && runId !== undefined && cache !== undefined;

  if (store !== undefined && runId !== undefined) {
    for (const skipped of skippedItems) {
      await store.recordWorkItem(runId, { state: 'skipped', identity: identityOf(skipped.testCase), reason: skipped.reason });
    }
  }

  const outcomes = await runBoundedPool<EvaluableItem, EvaluationOutcome>(items, concurrency, async (item) => {
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
            return { kind: 'cached', testCase: item.testCase, classification: hit.classification };
          }
        }
      }
    }

    try {
      const { classification, evaluation } = await evaluationPort.evaluate({ testCase: item.testCase, bundle: item.bundle });
      if (store !== undefined && runId !== undefined) {
        await store.recordWorkItem(runId, {
          state: 'completed',
          identity: identityOf(item.testCase),
          ...(cacheKey === undefined ? {} : { cacheKey }),
          evaluation,
          classification,
        });
      }
      return { kind: 'success', testCase: item.testCase, classification, evaluation };
    } catch (error) {
      if (store !== undefined && runId !== undefined) {
        await store.recordWorkItem(runId, {
          state: 'failed',
          identity: identityOf(item.testCase),
          errorKind: evaluationErrorKind(error),
          errorMessage: messageOf(error),
        });
      }
      return { kind: 'failure', testCase: item.testCase, error };
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
    const evaluationRun = await runEvaluation(results, ports.evaluation, request.concurrency, ports.store, runId, cache);
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
