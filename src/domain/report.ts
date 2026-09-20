/**
 * The canonical audit report (Phase 6, task P6-2): one versioned, self-describing JSON shape that
 * replaces `--evaluate --json`'s previous ad-hoc envelope as the tool's single machine-readable
 * output contract. Pure domain: `buildAuditReport` is a plain function over an already-computed
 * {@link AuditResult} plus a small, caller-supplied {@link AuditReportContext} of build-time
 * constants (the currently active model/rubric/policy pin and the store's own schema version) —
 * no I/O, no timers, no adapter imports. The CLI (`src/cli/index.ts`) is the only place that
 * assembles `AuditReportContext` and serializes the result with `JSON.stringify`.
 *
 * **Report version is its own thing** (orchestrator decision, Phase 6 feature document,
 * "Decisions"): {@link REPORT_VERSION} is this envelope's own contract number, independent of the
 * store's internal schema version (`src/adapters/sqlite-audit-store.ts`'s `AUDIT_STORE_SCHEMA_VERSION`),
 * `classification.rubricVersion`, and `classification.policyVersion`. All three of those already
 * exist and mean different things — conflating them would make the report lie about what changed.
 * `versions` carries the latter three explicitly (as this build's currently active pins; an
 * individual classification's own `rubricVersion`/`policyVersion` may differ for an older cached
 * judgment reused from a prior version — see `ClassificationResult`'s own doc), clearly
 * distinguished from `reportVersion` at the top level.
 *
 * **Stable key order.** Every object here is built as one object literal with a fixed key
 * insertion order (never spread from an intermediate object whose own order could drift), because
 * `JSON.stringify` preserves string-key insertion order — this is what makes the golden tests in
 * `test/report.test.ts`/`test/cli.test.ts` meaningful proof of stability, not merely of content.
 */
import {
  EMPTY_AUDIT_EVALUATION_TOTALS,
  type AuditDiagnostic,
  type AuditEvaluationTotals,
  type AuditResult,
  type AuditTotals,
  type TestCaseCacheStatus,
  type TestCaseLatency,
} from './audit.js';
import type { ClassificationResult } from './classification.js';
import type { DeniedEvidence, EvidenceBundle, OmittedEvidence, UnresolvedEvidence } from './evidence.js';
import type { TestCaseId } from './test-understanding.js';

/** This envelope's own contract number — see this module's own doc for why it is never conflated with any other version. Bump only for a deliberate, documented shape change. */
export const REPORT_VERSION = 1;

/** Build-time constants the CLI composition root supplies — never derived by `buildAuditReport` itself, since none of them are reachable from `AuditResult` alone (see this module's own doc). */
export interface AuditReportContext {
  /** The exact pinned model id every request targets (`JEV_MODEL_ID`, `src/domain/rubric.ts`) — carried alongside, not inside, `versions`: it is a model identifier, not a version number. */
  readonly modelRequested: string;
  /** The currently active rubric's own `version` (`RUBRIC_V2.version`) — the rubric THIS BUILD evaluates with, not necessarily every classification's own `rubricVersion` (a cached judgment can be older). */
  readonly rubricVersion: number;
  /** The currently active classification policy's own `version` (`CLASSIFICATION_POLICY_V2.version`) — same caveat as `rubricVersion` above. */
  readonly policyVersion: number;
  /** This build's persistence schema version (`AUDIT_STORE_SCHEMA_VERSION`, `src/adapters/sqlite-audit-store.ts`) — a compile-time constant naming which migration generation this build's persistence layer targets, present regardless of whether a store actually opened for this particular run. */
  readonly storeSchemaVersion: number;
}

export interface AuditReportVersions {
  readonly storeSchema: number;
  readonly rubric: number;
  readonly policy: number;
}

export interface AuditReportDiscoveredFile {
  readonly path: string;
  readonly framework: string;
  readonly testCaseCount: number;
  readonly dynamicMetadataCount: number;
  readonly evidenceBundleCount: number;
}

export interface AuditReportExcludedFile {
  readonly path: string;
  readonly reason: string;
}

/** Discovery decisions (technical design "Reports": "discover decisions") — which files were found, included, or excluded and why, plus the same aggregate {@link AuditTotals} the ordinary (non-`--evaluate`) summary already exposes. */
export interface AuditReportDiscovery {
  readonly files: readonly AuditReportDiscoveredFile[];
  readonly excluded: readonly AuditReportExcludedFile[];
  readonly totals: AuditTotals;
}

/**
 * Aggregate latency across every test case with a measured fresh-dispatch latency this run (see
 * {@link TestCaseLatency}). The four statistic fields are present only when `measuredTestCases >
 * 0` — omitted entirely (never a fabricated `0`) when nothing was measured, matching this
 * project's established convention for "genuinely absent" vs. "measured and zero" (e.g.
 * `JevEvaluation.latencyMs` itself, `DryRunEstimate.cacheHits`).
 */
export interface AuditReportLatencySummary {
  readonly measuredTestCases: number;
  readonly totalMs?: number;
  readonly meanMs?: number;
  readonly minMs?: number;
  readonly maxMs?: number;
}

/** One evaluable test case's cache provenance (technical design "Reports": "cache status") — see {@link TestCaseCacheStatus}'s own doc (`src/domain/audit.ts`) for exactly what each value means and which test cases are excluded (skipped ones). */
export interface AuditReportCacheStatusEntry {
  readonly testCaseId: TestCaseId;
  readonly repositoryRelativePath: string;
  readonly name: string;
  readonly status: TestCaseCacheStatus;
}

/**
 * Payload provenance (technical design "Reports": "payload provenance") for one test case's
 * evidence bundle: fragment counts, plus the full denial/unresolved/omission DECISIONS (rule,
 * specifier+reason, path+reason) — never the fragments' own source CONTENT, which stays out of
 * this report (see this task's own report to the orchestrator for why that is a decision gap
 * handed back rather than resolved here).
 */
export interface AuditReportEvidenceProvenance {
  readonly fragments: number;
  readonly truncatedFragments: number;
  readonly denied: readonly DeniedEvidence[];
  readonly unresolved: readonly UnresolvedEvidence[];
  readonly omitted: readonly OmittedEvidence[];
}

/** A classification's cache status is always `cached` or `fresh` — a `not-evaluated` test case never produced a `ClassificationResult` to attach one to (see {@link TestCaseCacheStatus}'s own doc). */
export type AuditReportClassificationCacheStatus = Exclude<TestCaseCacheStatus, 'not-evaluated'>;

/** One test case's full report entry: the existing {@link ClassificationResult} shape (scores, probabilities, findings, model/rubric/policy — unchanged from the pre-P6-2 `--evaluate --json` payload) plus this task's three additions. */
export interface AuditReportClassification extends ClassificationResult {
  readonly cache: AuditReportClassificationCacheStatus;
  /** Present only when a fresh dispatch's latency was actually measured this run — see {@link TestCaseLatency}'s own doc. */
  readonly latency?: TestCaseLatency;
  readonly evidence: AuditReportEvidenceProvenance;
}

export interface AuditReport {
  readonly reportVersion: number;
  readonly rootDir: string;
  readonly reportingOnly: true;
  /** `false` only when this run's own evaluation never ran at all (e.g. discovery failed before evaluation could start) — see {@link incompleteReasonFor}. Never `false` merely because some test cases failed, were skipped, needed review, or mismatched the model pin: those are ordinary per-test outcomes this report already carries in full (`totals`, `classifications`, `diagnostics`). */
  readonly complete: boolean;
  /** Present only when `complete` is `false`. */
  readonly incompleteReason?: string;
  readonly versions: AuditReportVersions;
  readonly modelRequested: string;
  readonly discovery: AuditReportDiscovery;
  readonly totals: AuditEvaluationTotals;
  readonly latency: AuditReportLatencySummary;
  readonly cacheStatus: readonly AuditReportCacheStatusEntry[];
  readonly classifications: readonly AuditReportClassification[];
  readonly diagnostics: readonly Record<string, unknown>[];
  readonly resume?: { readonly runId: string; readonly outstanding: number; readonly reused: number };
}

function diagnosticsJson(diagnostics: readonly AuditDiagnostic[]): readonly Record<string, unknown>[] {
  return diagnostics.map((diagnostic) => ({
    ...(diagnostic.repositoryRelativePath === undefined ? {} : { path: diagnostic.repositoryRelativePath }),
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
  }));
}

function bundlesByTestCaseId(result: AuditResult): ReadonlyMap<TestCaseId, EvidenceBundle> {
  const map = new Map<TestCaseId, EvidenceBundle>();
  for (const file of result.files) {
    for (const bundle of file.evidence) map.set(bundle.testCaseId, bundle);
  }
  return map;
}

function evidenceProvenance(bundle: EvidenceBundle | undefined): AuditReportEvidenceProvenance {
  if (bundle === undefined) return { fragments: 0, truncatedFragments: 0, denied: [], unresolved: [], omitted: [] };
  return {
    fragments: bundle.totals.fragments,
    truncatedFragments: bundle.totals.truncatedFragments,
    denied: bundle.denied,
    unresolved: bundle.unresolved,
    omitted: bundle.omitted,
  };
}

/**
 * The one run-level truncation signal actually reachable from an {@link AuditResult}
 * (orchestrator decision, this task): `result.evaluation` is `undefined` if and only if this
 * run's evaluation pipeline never ran at all — in production wiring, that happens only when
 * `runAudit` returns before ever reaching `ports.evaluation` (a `discovery-failed` diagnostic;
 * see `src/application/audit.ts`'s early return). Every other candidate this task's feature
 * document names is deliberately NOT treated as run incompleteness, because each is already an
 * ordinary, fully-disclosed per-test (or per-run-summary) outcome elsewhere in this same report:
 *
 * - a failed work item — counted in `totals.failed` and named in `diagnostics`;
 * - a resumed run — `runEvaluation` drives every outstanding item to a terminal state before
 *   `runAudit` ever returns, so a resumed `AuditResult` this function ever sees is, by
 *   construction, already fully resolved (see `resume.outstanding`/`resume.reused`, both already
 *   final counts, never a promise of more work to come);
 * - a model-pin mismatch — counted in `totals.modelMismatches` and on each affected
 *   `classification.model.matchesPin`;
 * - a `needs-review` dimension or overall status — a `DimensionJudgmentStatus`/
 *   `OverallClassificationStatus` value like any other, fully present in `classifications`.
 *
 * Treating any of those as "incomplete" would train a reader to ignore the disclosure the moment
 * it fires on an ordinary run (it would fire constantly); treating NONE of them, including the
 * one genuine case above, as incomplete is the failure this criterion exists to prevent — a
 * report presenting zero evaluated test cases as if that were the whole, honest story.
 */
function incompleteReasonFor(result: AuditResult): string | undefined {
  if (result.evaluation !== undefined) return undefined;
  const discoveryFailure = result.diagnostics.find((diagnostic) => diagnostic.code === 'discovery-failed');
  return discoveryFailure !== undefined
    ? `discovery failed before evaluation could run: ${discoveryFailure.message}`
    : 'evaluation did not run for this audit run (no evaluation outcome is available); see diagnostics for details';
}

function latencySummary(latencyByTestCaseId: ReadonlyMap<TestCaseId, TestCaseLatency>): AuditReportLatencySummary {
  const values = [...latencyByTestCaseId.values()].map((entry) => entry.latencyMs);
  if (values.length === 0) return { measuredTestCases: 0 };
  const totalMs = values.reduce((sum, value) => sum + value, 0);
  return {
    measuredTestCases: values.length,
    totalMs,
    meanMs: totalMs / values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  };
}

/**
 * One entry per test case this run considered evaluable (dispatched fresh, served from cache, or
 * attempted and failed) — walked in `result.files`' own deterministic (already sorted) order,
 * then each file's own `testCases` order, exactly like every other per-test-case listing in this
 * report, rather than relying on `cacheStatusByTestCaseId`'s own `Map` insertion order (an
 * incidental property of how `runEvaluation` happens to populate it, not a contract this function
 * should depend on). A test case absent from `cacheStatusByTestCaseId` was skipped (`skip`/`todo`/
 * `evidence-unavailable`) — never evaluable, so it is excluded here entirely; see
 * `AuditEvaluationTotals.skipped` for that count.
 */
function cacheStatusEntries(
  result: AuditResult,
  cacheStatusByTestCaseId: ReadonlyMap<TestCaseId, TestCaseCacheStatus>,
): readonly AuditReportCacheStatusEntry[] {
  const entries: AuditReportCacheStatusEntry[] = [];
  for (const file of result.files) {
    for (const testCase of file.testCases) {
      const status = cacheStatusByTestCaseId.get(testCase.id);
      if (status === undefined) continue;
      entries.push({ testCaseId: testCase.id, repositoryRelativePath: testCase.repositoryRelativePath, name: testCase.name, status });
    }
  }
  return entries;
}

/**
 * Builds the canonical report. Field order below is deliberate and load-bearing (see this
 * module's own doc on stable key order): `reportVersion`, `rootDir`, `reportingOnly`, `complete`
 * (+ `incompleteReason`), `versions`, `modelRequested`, `discovery`, `totals`, `latency`,
 * `cacheStatus`, `classifications`, `diagnostics`, `resume`.
 */
export function buildAuditReport(result: AuditResult, context: AuditReportContext): AuditReport {
  const evaluation = result.evaluation;
  const bundles = bundlesByTestCaseId(result);
  const cacheStatusByTestCaseId: ReadonlyMap<TestCaseId, TestCaseCacheStatus> = evaluation?.cacheStatusByTestCaseId ?? new Map();
  const latencyByTestCaseId: ReadonlyMap<TestCaseId, TestCaseLatency> = evaluation?.latencyByTestCaseId ?? new Map();
  const incompleteReason = incompleteReasonFor(result);

  const classifications: readonly AuditReportClassification[] = (evaluation?.classifications ?? []).map(
    (classification: ClassificationResult) => {
      const latency = latencyByTestCaseId.get(classification.testCaseId);
      return {
        ...classification,
        // Defensive fallback only: `cacheStatusByTestCaseId` and `classifications` are populated
        // together, entry for entry, by the same pass in `runEvaluation` — this can only be
        // reached by a hand-built `AuditEvaluationResult` fixture that skips that invariant.
        cache: (cacheStatusByTestCaseId.get(classification.testCaseId) ?? 'fresh') as AuditReportClassificationCacheStatus,
        ...(latency === undefined ? {} : { latency }),
        evidence: evidenceProvenance(bundles.get(classification.testCaseId)),
      };
    },
  );

  return {
    reportVersion: REPORT_VERSION,
    rootDir: result.rootDir,
    reportingOnly: true,
    complete: incompleteReason === undefined,
    ...(incompleteReason === undefined ? {} : { incompleteReason }),
    versions: {
      storeSchema: context.storeSchemaVersion,
      rubric: context.rubricVersion,
      policy: context.policyVersion,
    },
    modelRequested: context.modelRequested,
    discovery: {
      files: result.files.map((file) => ({
        path: file.discovered.repositoryRelativePath,
        framework: file.discovered.framework,
        testCaseCount: file.testCases.length,
        dynamicMetadataCount: file.dynamicMetadata.length,
        evidenceBundleCount: file.evidence.length,
      })),
      excluded: result.excluded.map((file) => ({ path: file.repositoryRelativePath, reason: file.reason })),
      totals: result.totals,
    },
    totals: evaluation?.totals ?? EMPTY_AUDIT_EVALUATION_TOTALS,
    latency: latencySummary(latencyByTestCaseId),
    cacheStatus: cacheStatusEntries(result, cacheStatusByTestCaseId),
    classifications,
    diagnostics: diagnosticsJson(result.diagnostics),
    ...(result.resume === undefined
      ? {}
      : { resume: { runId: result.resume.runId, outstanding: result.resume.outstanding, reused: result.resume.reused } }),
  };
}
