import type {
  AuditEvaluationPort,
  AuditEvaluationResult,
  AuditEvaluationTotals,
  AuditPorts,
  AuditRequest,
  AuditResult,
  AuditDiagnostic,
  AuditFileResult,
} from '../domain/audit.js';
import type { ClassificationResult, OverallClassificationStatus } from '../domain/classification.js';
import { classifyTestCase, type DryRunSkippedReason } from '../domain/estimate.js';
import type { Diagnostic, TestCase } from '../domain/test-understanding.js';
import type { EvidenceBundle } from '../domain/evidence.js';

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
function collectEvaluableItems(files: readonly AuditFileResult[]): {
  readonly items: readonly EvaluableItem[];
  readonly skippedByReason: Record<DryRunSkippedReason, number>;
} {
  const items: EvaluableItem[] = [];
  const skippedByReason: Record<DryRunSkippedReason, number> = { skip: 0, todo: 0, 'evidence-unavailable': 0 };

  for (const file of files) {
    const bundlesByTestCaseId = new Map(file.evidence.map((bundle) => [bundle.testCaseId, bundle]));
    for (const testCase of file.testCases) {
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
      items.push({ testCase, bundle });
    }
  }

  return { items, skippedByReason };
}

type EvaluationOutcome =
  | { readonly kind: 'success'; readonly classification: ClassificationResult }
  | { readonly kind: 'failure'; readonly testCase: TestCase; readonly error: unknown };

interface EvaluationRunResult {
  readonly evaluation: AuditEvaluationResult;
  /** Root-level diagnostics (already carrying `repositoryRelativePath`), one per failed evaluation. */
  readonly diagnostics: readonly AuditDiagnostic[];
  /** The same failures, grouped by owning file path, as plain `Diagnostic`s (no path field) for merging into that file's own `diagnostics` — parity with how `evidence-selection-failed` is merged. */
  readonly fileDiagnosticsByPath: ReadonlyMap<string, readonly Diagnostic[]>;
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
 */
async function runEvaluation(
  files: readonly AuditFileResult[],
  evaluationPort: AuditEvaluationPort,
  concurrency: number,
): Promise<EvaluationRunResult> {
  const { items, skippedByReason } = collectEvaluableItems(files);

  const outcomes = await runBoundedPool<EvaluableItem, EvaluationOutcome>(items, concurrency, async (item) => {
    try {
      const classification = await evaluationPort.evaluate({ testCase: item.testCase, bundle: item.bundle });
      return { kind: 'success', classification };
    } catch (error) {
      return { kind: 'failure', testCase: item.testCase, error };
    }
  });

  const classifications: ClassificationResult[] = [];
  const diagnostics: AuditDiagnostic[] = [];
  const fileDiagnosticsByPath = new Map<string, Diagnostic[]>();
  let failed = 0;
  let modelMismatches = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const statusCounts: Record<OverallClassificationStatus, number> = {
    healthy: 0, weak: 0, misleading: 0, 'needs-review': 0,
  };
  let respondedModel: string | undefined;

  for (const outcome of outcomes) {
    if (outcome.kind === 'success') {
      classifications.push(outcome.classification);
      inputTokens += outcome.classification.usage.inputTokens;
      outputTokens += outcome.classification.usage.outputTokens;
      statusCounts[outcome.classification.status] += 1;
      if (!outcome.classification.model.matchesPin) modelMismatches += 1;
      if (respondedModel === undefined) respondedModel = outcome.classification.model.responded;
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
    evaluated: classifications.length,
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

export async function runAudit(
  request: AuditRequest,
  ports: AuditPorts,
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

  for (const discovered of files) {
    let sourceText: string;
    try {
      sourceText = await ports.sourceReader.read({
        rootDir: request.rootDir,
        repositoryRelativePath: discovered.repositoryRelativePath,
      });
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
    const evaluationRun = await runEvaluation(results, ports.evaluation, request.concurrency);
    evaluation = evaluationRun.evaluation;
    diagnostics.push(...evaluationRun.diagnostics);
    finalFiles = withEvaluationDiagnostics(results, evaluationRun.fileDiagnosticsByPath);
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
