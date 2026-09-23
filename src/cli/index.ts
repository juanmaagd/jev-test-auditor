#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getResolvedConfiguration } from '../application/configure.js';
import { computeDryRunCacheHits, runAudit } from '../application/audit.js';
import { discoverTestFiles } from '../adapters/repository-discovery.js';
import { readSourceFile } from '../adapters/source-reader.js';
import { extractTestCases } from '../adapters/test-extraction.js';
import { createJestFrameworkHintReader } from '../adapters/jest-project-config.js';
import { createAuditCacheKeyPort } from '../adapters/cache-key.js';
import { createAuditEvidencePort } from '../adapters/evidence-audit-port.js';
import { createJevEvaluationPort } from '../adapters/jev-evaluation-port.js';
import { createJevHttpGateway } from '../adapters/jev-http-gateway.js';
import {
  AUDIT_STORE_SCHEMA_VERSION,
  createSqliteAuditStore,
  openSqliteAuditStoreForLookup,
  resolveAuditStorePaths,
  type AuditStoreReadOnlyLookup,
} from '../adapters/sqlite-audit-store.js';
import { readApiKeyFromPrompt } from '../adapters/auth-prompt.js';
import { NO_KEY_USAGE_MESSAGE, resolveEvaluationApiKey } from './api-key.js';
import {
  deleteStoredCredentials,
  readStoredCredentials,
  resolveAuthStoragePaths,
  statStoredCredentialsFile,
  writeStoredCredentials,
} from '../adapters/auth-storage.js';
import {
  AuthCorruptCredentialsError,
  AuthInsecurePermissionsError,
  AuthPromptCancelledError,
  resolveApiKey,
  type StoredCredentials,
} from '../domain/auth.js';
import { canonicalizeEvidenceBundle } from '../domain/evidence.js';
import { estimateDryRun, JEV_ESTIMATE_SNAPSHOT, type DryRunCacheNotConsultedReason, type DryRunEstimate } from '../domain/estimate.js';
import { JevConfigurationError } from '../domain/jev-gateway.js';
import { JEV_MODEL_ID, RUBRIC_V2 } from '../domain/rubric.js';
import {
  AuditResumeLegacyRootDirError,
  AuditResumeRootDirMismatchError,
  AuditResumeRunNotFoundError,
  AuditResumeUnavailableError,
  AuditStoreCorruptError,
  AuditStoreSchemaVersionError,
  EMPTY_AUDIT_EVALUATION_TOTALS,
  type AuditCacheKeyPort,
  type AuditDiagnostic,
  type AuditEvaluationPort,
  type AuditPorts,
  type AuditProgressPort,
  type AuditRequest,
  type AuditResult,
  type AuditStorePort,
} from '../domain/audit.js';
import { CLASSIFICATION_POLICY_V2 } from '../domain/classification.js';
import type { ConfigurationOverrides } from '../domain/config.js';
import type { ExcludedTestFile } from '../domain/discovery.js';
import { buildAuditReport, type AuditReport, type AuditReportContext } from '../domain/report.js';
import { renderAuditReportHtml } from '../domain/html-report.js';
import { summarizeReport } from '../domain/report-overview.js';
import { REPORT_JSON_SCHEMA, validateAgainstSchema } from '../domain/report-schema.js';
import { createTerminalProgressReporter } from '../adapters/terminal-progress-reporter.js';
import { checkHtmlReportPath, writeHtmlReport } from '../adapters/html-report-writer.js';
import { openHtmlReportWithViewer, type OpenHtmlReportResult } from '../adapters/html-report-opener.js';
import {
  loadLatestPersistedReport,
  loadPersistedReportByRunId,
  persistAuditReport,
  type LoadPersistedReportResult,
} from '../adapters/persisted-report-store.js';

export interface CliIo {
  writeLine(message: string): void;
}

export interface CliDependencies {
  readonly audit?: (request: AuditRequest) => Promise<AuditResult>;
  /**
   * Test seam only: overrides how the `--evaluate` evaluation port is
   * constructed. Only consulted when `dependencies.audit` is not provided
   * (the real `runAudit` pipeline path) — production always uses the
   * default, which resolves an API key (`TYPESAFE_API_KEY`, else the
   * locally stored file — see `resolveEvaluationApiKey` below) and
   * constructs a real `createJevHttpGateway({ apiKey })` wrapped by
   * `createJevEvaluationPort`. A thrown `JevConfigurationError` here is
   * handled exactly like the production path: a usage error, exit 1, no
   * network ever attempted.
   */
  readonly createEvaluationPort?: () => AuditEvaluationPort | Promise<AuditEvaluationPort>;
  /**
   * Test seam only (Phase 5, task P5-1): overrides how the `--evaluate`
   * audit store is constructed. Only consulted when `dependencies.audit` is
   * not provided, and only when `--evaluate` was requested — production
   * always uses the default, which opens (creating if needed) a
   * `node:sqlite` database under `resolveAuditStorePaths()` (or
   * `configuration.store.databasePath`, when set). Built only after a
   * usable API key was already resolved, so a failed `--evaluate` (missing
   * key) never creates a database file. A thrown `AuditStoreSchemaVersionError`
   * or `AuditStoreCorruptError` here (P5-1 verifier finding C) is handled
   * exactly like the evaluation port's own `JevConfigurationError` above: a
   * named, readable message on `io`, exit code 1, no stack trace.
   */
  readonly createStorePort?: () => AuditStorePort | Promise<AuditStorePort>;
  /**
   * Test seam only (Phase 6, task P6-3): overrides how the `--evaluate` terminal-progress
   * reporter is constructed. Only consulted when `dependencies.audit` is not provided and a usable
   * evaluation port was already resolved — production always uses the default,
   * `createTerminalProgressReporter` (`src/adapters/terminal-progress-reporter.ts`) bound to
   * `process.stderr.write`/`process.stderr.isTTY`. Progress is never opt-out and carries no CLI
   * flag of its own (see this phase's own feature document): its non-TTY behavior — one clean,
   * newline-terminated line per terminal transition, always on stderr, never stdout — already
   * keeps a piped `--evaluate --json` consumer's stdout byte-clean without anything to disable.
   */
  readonly createProgressPort?: () => AuditProgressPort;
  /**
   * Test seam only (Phase 6, task P6-4): overrides how `--html <path> --open` launches the platform
   * viewer. Only consulted when `parsed.open` is `true` and the HTML report was just written
   * successfully. Production default is `openHtmlReportWithViewer` (`src/adapters/html-report-opener.ts`),
   * bound to the real `process.platform` and the real `node:child_process.spawn`. Always injected in
   * this project's own tests — never letting a real viewer launch mid-suite is the whole point of
   * this seam (see `test/cli.test.ts`).
   */
  readonly openHtmlReport?: (path: string) => Promise<OpenHtmlReportResult>;
  /**
   * Test seam only: overrides the invocation directory that `--html` paths resolve against,
   * including the default `report.html` used when `--html` is given without a path.
   * Production default is `process.cwd()`.
   */
  readonly cwd?: () => string;
  /**
   * Test seam only, consulted by `auth login`: overrides how the API key is
   * read from the terminal. Production default (`readApiKeyFromPrompt`)
   * reads `process.stdin`/`process.stdout` directly — hidden input on a
   * real TTY, one trimmed line otherwise.
   */
  readonly readApiKeyFromPrompt?: () => Promise<string>;
}

const HELP = `jta (jev-test-auditor) — inspect semantic test quality

Usage:
  jta audit [options]
  jta report [--last | --run <runId>] [--json | --html [path]] [--open] [--rootDir <path>]
  jta auth <login|status|logout>
  jta --help

Aliases:
  jev-test-auditor <command>

Commands:
  audit         Discover and extract test understanding without executing project code, then print
                a readable report: discovered/excluded files, evidence provenance, diagnostics, and
                the same no-network, no-write cost/call estimate --dry-run computes (discovered/
                evaluable/skipped test cases, exact initial Jev call count, cache status, and
                approximate input-token/USD ranges). See --json below to print the underlying
                discovery data as one JSON line instead. Every "audit --evaluate" run also persists
                its canonical report to <rootDir>/.jta/ — see "jta report" below.
  report        Read-only: prints or re-renders a run's canonical report already persisted to
                <rootDir>/.jta/ by a prior "audit --evaluate" run (see "Persisted run reports" in
                README.md) — no API key, no network, no audit store access, and it never runs a new
                evaluation. Selects WHICH run with --last (the default) or --run <runId>; selects the
                OUTPUT with --json (the exact stored JSON), --html [path] (renders the same
                fixed-size offline overview "audit --evaluate --html" does, at [path] or report.html
                in the current directory by default; --open opens it once written), or neither (a
                short human summary: run id and recorded time, the headline "needs a change" share
                and its denominator, and the worst folders by tests needing a change). --rootDir
                <path> reads <rootDir>/.jta/ instead of the current directory. Exits 1 with a clear
                message when no report has ever been persisted there yet (suggesting "jta audit
                --evaluate"), when --run names a run id that does not exist (listing the ids that
                do), or when the stored JSON is unreadable or fails the same schema
                "audit --evaluate --json" itself publishes.
  auth login    Store a TypeSafe API key locally for this tool. Reads from an interactive,
                no-echo prompt when stdin is a TTY; reads one trimmed line from stdin
                otherwise (so automation/CI can pipe a key in). NEVER accepts the key as a
                command-line argument — that would leak it into shell history and the
                process list.
  auth status   Report whether a TypeSafe API key is available, which source would win
                (environment or stored file), and the stored file's path and permissions.
                Never prints the key itself.
  auth logout   Delete the locally stored TypeSafe API key, if any, and report honestly
                whether one existed.

Options:
  --rootDir <path>   Audit a configured repository root
  --inspect-payloads Also print each test case's local evidence bundle, one JSON line per bundle,
                      after the summary line. This is the local evidence state selected on disk
                      (fragments, provenance, denials, truncation) — not the Jev wire request
                      shape, and no network call is made either way. Cannot be combined with
                      --dry-run or --evaluate.
  --dry-run          Print a no-network, no-write aggregate cost/call preview instead of the normal
                      summary: exact discovered/evaluable/skipped-by-reason counts, exact initial
                      Jev calls (one per evaluable test case not already served from the local
                      content-addressed cache), exact evidence bytes and exact real request bytes
                      (the actual state plus every rubric question, measured by building each real
                      request locally, never a guessed overhead), and clearly labeled approximate
                      input-token and USD ranges converted from those request bytes via a
                      versioned local pricing snapshot. The rubric's own questions dominate a
                      request's bytes (about 93% for the shipped rubric) — see "Rubric bytes per
                      request" in the output. If an audit store already exists at the default (or
                      configured) location and is at this build's current schema, it is opened
                      strictly read-only and consulted for cache hits, reported separately
                      (cacheHits) and excluded from the billable count and token/cost estimates.
                      Whether the cache was consulted at all is always disclosed explicitly
                      (cacheConsulted; in text, the existing "Cache hits" line itself); when it was
                      not, the reason is named too (cacheNotConsultedReason; in text, a
                      "Cache: not consulted (...)" line): no audit store exists yet (no-store), or
                      an existing store's schema predates this build and a dry run must never
                      migrate it (schema-outdated — run --evaluate to upgrade it). Makes no
                      network or provider calls, requires no API key, and writes nothing to disk —
                      not even to the audit store when one is consulted, which is never created,
                      migrated, or written to by --dry-run. Cannot be combined with
                      --inspect-payloads or --evaluate.
  --evaluate         Opt-in only: sends every evaluable test case's local evidence bundle to
                      TypeSafe's Jev model for real judgment (costs money; nothing is sent without
                      this flag). Requires a TypeSafe API key from the TYPESAFE_API_KEY
                      environment variable (checked first, so CI keeps injecting GitHub secrets)
                      or from 'jta auth login'; having neither is a usage error
                      (exit 1, no network attempted) that names both ways to provide one. Prints
                      a terminal evaluation summary (status counts, skipped-by-reason, failed,
                      total usage input tokens,
                      and the responded model id) instead of the normal summary. Reports per-item
                      progress as it happens on stderr, never stdout, with no flag to disable it —
                      see "Progress during a run" in README.md. Thresholds are
                      provisional and uncalibrated; see README.md. Cannot be combined with
                      --dry-run or --inspect-payloads.
  --evaluate --json  Print one deterministic canonical JSON line instead of the terminal evaluation
                      summary: per-test classification, per-dimension judgments, findings, model
                      requested/responded/matchesPin, usage, policy/rubric versions, and evidence
                      provenance counts. Requires --evaluate.
  --fresh            Bypasses the content-addressed judgment cache: every evaluable test case gets
                      a fresh TypeSafe request even when an unchanged one was already judged before,
                      and the new result is appended alongside the prior one rather than replacing
                      it (persistence is append-only; nothing already stored is ever mutated or
                      deleted). Without --fresh, an evaluation whose exact rubric version, model id,
                      classification policy version, test source, and evidence are unchanged from a
                      prior run is served from the local store at zero cost, reported as cached
                      rather than evaluated. Requires --evaluate.
  --resume <runId>   Continues a previously started run instead of starting a new one: reloads that
                      run's outstanding work items (anything that never reached completed/cached/
                      failed/skipped) and completes only those, leaving every already-terminal item
                      untouched and never re-dispatched. --rootDir is compared by repository
                      identity, not spelling: the same repository reached via a relative path, an
                      absolute path, a trailing slash, or a symlinked ancestor all resume the same
                      run. A run id that does not exist, one recorded against a genuinely different
                      repository, or one recorded before this version started persisting a
                      canonical --rootDir (cannot be safely resumed at all) is a usage error
                      (exit 1). A run that is already finished with nothing outstanding
                      is not an error: it is reported honestly as nothing to resume. --resume is
                      orthogonal to --fresh: --resume selects WHICH items run (only the outstanding
                      ones); --fresh selects whether the ones that DO run consult the cache first.
                      Combining them dispatches fresh requests only for the outstanding items;
                      already-terminal items are always reused as-is, cache or no cache. Caution: an
                      in-flight item that was interrupted mid-request may already have been billed
                      by the provider even though its result was never recorded — resuming
                      re-dispatches it, since there is no way to know whether the first attempt
                      completed, so a resumed run can cost slightly more than the work it appears to
                      redo. Requires --evaluate.
  --html [path]      Render the canonical report (the same data --evaluate --json prints) into one
                      self-contained offline HTML file at [path], or at report.html in the current
                      directory when no path is given: the JSON and every style and
                      script are embedded, with no CDN, no external stylesheet or font, and no
                      network access at render or view time. Evidence fragment source content is
                      never included — only provenance decisions and counts, exactly like the JSON
                      report. Without this flag, no HTML file is written (every --evaluate run still
                      persists its canonical report to <rootDir>/.jta/ regardless — see "jta report"
                      above and "Persisted run reports" in README.md). An existing regular file at
                      that path is overwritten; an existing directory there, or a path whose parent
                      directory does not exist, is a usage error (exit 1) before any evaluation
                      work is dispatched. Requires --evaluate. Cannot be combined with --dry-run or
                      --inspect-payloads. See "Self-contained HTML report" in README.md.
  --open             Opens the file --html [path] just wrote in the operating system's default
                      viewer (macOS: open; Linux: xdg-open; Windows: explorer.exe) once it has been
                      written successfully. Never opens anything else. A failure to launch a viewer
                      (e.g. no viewer installed, as in most CI environments) is reported on stderr
                      and never changes the exit status or affects the already-written file.
                      Requires --html.
  --dry-run --json   Print the same dry-run preview as one machine-readable JSON line instead of
                      the human-readable text report. Requires --dry-run.
  --json             Print the plain audit's underlying discovery data (rootDir, per-file framework/
                      test-case counts, exclusions, totals, diagnostics) as one deterministic JSON
                      line instead of the readable report above. No longer a usage error alone.
  --help             Show this help message
`;

/**
 * Fresh per invocation (never a module-level singleton): `createAuditEvidencePort`
 * builds one memoizing source-read cache for the port it returns, and that cache
 * must live for exactly one audit run — reusing it across runs (e.g. repeated
 * `runCli` calls against different roots within the same process, as tests do)
 * would let content read for an earlier run leak into a later one.
 */
/**
 * `evaluationPort` is `undefined` unless `--evaluate` was requested (see
 * `runCli`): the evaluation port is the entire opt-in gate documented on
 * `AuditEvaluationPort` in `src/domain/audit.ts`, and this function must
 * never construct one on its own, so an ordinary `audit` invocation never
 * touches `createJevHttpGateway`, an API key, or the network.
 *
 * `cacheKeyPort` (Phase 5, task P5-2) is always constructed together with
 * `storePort` — never independently — by `runCli`, so this function itself
 * never has to decide when caching is meaningful; it only wires whatever
 * it is given.
 */
function createProductionPorts(
  rootDir: string,
  evaluationPort?: AuditEvaluationPort,
  storePort?: AuditStorePort,
  cacheKeyPort?: AuditCacheKeyPort,
  progressPort?: AuditProgressPort,
): AuditPorts {
  return {
    discovery: { discover: discoverTestFiles },
    sourceReader: { read: readSourceFile },
    extractor: { extract: extractTestCases },
    evidence: createAuditEvidencePort(),
    // `odd/tasks/jest-ambient-globals.md`: fresh per invocation, exactly like
    // `createAuditEvidencePort()` above — its per-directory cache must live
    // for exactly one audit run, for the same reason (see this function's
    // own doc).
    jestFrameworkHint: { resolve: createJestFrameworkHintReader(rootDir) },
    ...(evaluationPort === undefined ? {} : { evaluation: evaluationPort }),
    ...(storePort === undefined ? {} : { store: storePort }),
    ...(cacheKeyPort === undefined ? {} : { cacheKey: cacheKeyPort }),
    ...(progressPort === undefined ? {} : { progress: progressPort }),
  };
}

/** Shared diagnostic-to-JSON mapping, reused by `summary` and `evaluateJsonLine` so the shape stays identical everywhere diagnostics are reported. */
function diagnosticsJson(diagnostics: readonly AuditDiagnostic[]): readonly Record<string, unknown>[] {
  return diagnostics.map((diagnostic) => ({
    ...(diagnostic.repositoryRelativePath === undefined ? {} : { path: diagnostic.repositoryRelativePath }),
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
  }));
}

function summary(result: AuditResult): string {
  return JSON.stringify({
    reportingOnly: result.reportingOnly,
    rootDir: result.rootDir,
    files: result.files.map((file) => ({
      path: file.discovered.repositoryRelativePath,
      framework: file.discovered.framework,
      testCaseCount: file.testCases.length,
      dynamicMetadataCount: file.dynamicMetadata.length,
      evidenceBundleCount: file.evidence.length,
    })),
    excluded: result.excluded.map((file) => ({ path: file.repositoryRelativePath, reason: file.reason })),
    totals: result.totals,
    diagnostics: diagnosticsJson(result.diagnostics),
  });
}

/** One canonical bundle line per test case's evidence bundle, ordered by file path (already sorted in `result.files`) then test-case order (each file's `evidence` array mirrors its `testCases` order). */
function inspectPayloadLines(result: AuditResult): readonly string[] {
  return result.files.flatMap((file) => file.evidence.map((bundle) => canonicalizeEvidenceBundle(bundle)));
}

/**
 * One machine-readable `--dry-run --json` line. Field order is fixed
 * (object literal insertion order, which `JSON.stringify` preserves for
 * string keys) so identical inputs always produce byte-identical output.
 * `networkCalls`/`filesWritten` are always `0`: this report is built from
 * the same no-network, no-write audit pipeline as the normal summary (see
 * `runCli`), so they are exact disclosures, not placeholders.
 *
 * `cacheConsulted` (orchestrator decision, 2026-09-20) is always present,
 * spread in immediately after `initialCalls` — see
 * `DryRunEstimate.cacheConsulted`'s own doc. `cacheHits` (Phase 5, task
 * P5-5) follows it, present only when `estimate.cacheHits` is present at
 * all — i.e. only when `cacheConsulted` is `true` — omitted entirely (never
 * a literal `0`) otherwise. `cacheNotConsultedReason` follows in its place
 * instead, present only when `cacheConsulted` is `false` and a specific
 * reason is known. Every field from `initialCalls` onward previously kept a
 * cold dry run's JSON byte-for-byte identical to its shape before Phase 5,
 * task P5-5; this task's own deliberate change is `cacheConsulted` and
 * `cacheNotConsultedReason` becoming part of that shape — the existing
 * golden test was updated to match rather than loosened to a substring
 * match (see `test/cli.test.ts`).
 */
function dryRunJsonLine(rootDir: string, estimate: DryRunEstimate): string {
  return JSON.stringify({
    dryRun: true,
    reportingOnly: true,
    rootDir,
    model: estimate.model,
    snapshotVersion: estimate.snapshotVersion,
    asOf: estimate.asOf,
    discovered: estimate.discovered,
    evaluable: estimate.evaluable,
    skipped: estimate.skipped,
    initialCalls: estimate.initialCalls,
    cacheConsulted: estimate.cacheConsulted,
    ...(estimate.cacheHits === undefined ? {} : { cacheHits: estimate.cacheHits }),
    ...(estimate.cacheNotConsultedReason === undefined ? {} : { cacheNotConsultedReason: estimate.cacheNotConsultedReason }),
    followUpCalls: estimate.followUpCalls,
    evidenceBytes: estimate.evidenceBytes,
    requestBytes: estimate.requestBytes,
    rubricBytesPerRequest: estimate.rubricBytesPerRequest,
    estimatedInputTokens: estimate.estimatedInputTokens,
    estimatedFollowUpInputTokens: estimate.estimatedFollowUpInputTokens,
    estimatedUsd: estimate.estimatedUsd,
    bundlesOverCeiling: estimate.bundlesOverCeiling,
    requestTokenCeiling: estimate.requestTokenCeiling,
    networkCalls: 0,
    filesWritten: 0,
  });
}

/**
 * The human-readable "why the cache was not consulted" disclosure line
 * (orchestrator decision, 2026-09-20), or no line at all. An exhaustive
 * `switch` over {@link DryRunCacheNotConsultedReason} (plus `undefined`, for
 * a caller that reported "not consulted" without knowing why — the
 * `dependencies.audit` test seam's only path) — adding a new reason value
 * without adding its case here is a compile error, not a silently-missing
 * disclosure.
 */
function cacheNotConsultedLines(reason: DryRunCacheNotConsultedReason | undefined): readonly string[] {
  switch (reason) {
    case undefined:
      return [];
    case 'no-store':
      return ['Cache: not consulted (no audit store exists yet at the configured location).'];
    case 'schema-outdated':
      return ["Cache: not consulted (the audit store's schema predates this build and a dry run must not migrate it; run --evaluate to upgrade it)."];
  }
}

/**
 * Model + pricing-snapshot preamble (Phase 7): factored out of `dryRunTextReport` so the default
 * `audit` summary (`auditTextReport`) can fold in the exact same cost estimate without a second,
 * independently-worded copy. `dryRunTextReport`'s own output is unchanged by this extraction — see
 * that function's own doc.
 */
function costEstimatePreambleLines(estimate: DryRunEstimate): readonly string[] {
  return [
    `Model: ${estimate.model}`,
    `Pricing/overhead snapshot: v${estimate.snapshotVersion} (as of ${estimate.asOf})`,
  ];
}

/**
 * The exact-vs-approximate cost/call estimate body (Phase 7): every line `dryRunTextReport` has
 * always printed between its own `Root:` line and its closing "No network calls..." sentence,
 * factored out verbatim so `auditTextReport` (the default `audit` summary, which now folds in this
 * same `--dry-run` estimate — orchestrator scope change) never re-derives or re-words a single
 * figure. This is what guarantees the two reports can never drift on precision language (an exact
 * count phrased as exact, an approximate range phrased as approximate) for the figures they share.
 *
 * Every existing line's wording stays byte-for-byte unchanged from before this extraction (a cold
 * dry run's full text report before the cache-consultation disclosure existed had no cache-related
 * line at all, which the report now replaces with an explicit "not consulted" line — the one
 * intentional behavior change task P5-5 made to the text report, predating this extraction). A
 * "Cache hits" line is appended right after "Initial Jev calls" only when `estimate.cacheHits` is
 * present — the only disclosure printed when the cache WAS consulted. Otherwise,
 * `cacheNotConsultedLines` appends the "why not" line in that same position when a reason is known.
 */
function costEstimateBodyLines(estimate: DryRunEstimate): readonly string[] {
  const { skipped } = estimate;
  return [
    `Discovered test cases: ${estimate.discovered}`,
    `Evaluable: ${estimate.evaluable}`,
    `Skipped: ${skipped.total} (skip: ${skipped.byReason.skip}, todo: ${skipped.byReason.todo}, evidence-unavailable: ${skipped.byReason['evidence-unavailable']})`,
    `Initial Jev calls (one per evaluable test case, exact): ${estimate.initialCalls}`,
    ...(estimate.cacheHits === undefined ? [] : [`Cache hits (served from the local audit store, zero cost, exact): ${estimate.cacheHits}`]),
    ...cacheNotConsultedLines(estimate.cacheNotConsultedReason),
    `Follow-up calls (possible range, exact bound): ${estimate.followUpCalls.min} - ${estimate.followUpCalls.max}`,
    `Evidence bytes (canonical, evaluable bundles only, exact): ${estimate.evidenceBytes}`,
    `Request bytes (canonical, real state + rubric questions, evaluable requests only, exact): ${estimate.requestBytes}`,
    `Rubric bytes per request (fixed cost of this rubric's own questions, exact): ${estimate.rubricBytesPerRequest}`,
    `Estimated input tokens (approximate): ${estimate.estimatedInputTokens.min} - ${estimate.estimatedInputTokens.max}`,
    `Estimated follow-up input tokens (approximate): ${estimate.estimatedFollowUpInputTokens.min} - ${estimate.estimatedFollowUpInputTokens.max}`,
    `Estimated cost in USD (approximate): ${estimate.estimatedUsd.min} - ${estimate.estimatedUsd.max}`,
    `Bundles over the ${estimate.requestTokenCeiling}-token request ceiling: ${estimate.bundlesOverCeiling}`,
  ];
}

/**
 * Concise human-readable `--dry-run` text report, one `writeLine` call (embedded newlines),
 * mirroring `dryRunJsonLine`'s data. Output is byte-for-byte unchanged by the Phase 7 extraction of
 * `costEstimatePreambleLines`/`costEstimateBodyLines` above — this function reassembles the exact
 * same lines in the exact same order.
 */
function dryRunTextReport(rootDir: string, estimate: DryRunEstimate): string {
  return [
    'Dry-run cost and call estimate',
    ...costEstimatePreambleLines(estimate),
    `Root: ${rootDir}`,
    ...costEstimateBodyLines(estimate),
    'No network calls were made; nothing was written to disk.',
  ].join('\n');
}

const ZERO_EVALUATION_TOTALS = EMPTY_AUDIT_EVALUATION_TOTALS;

/**
 * The canonical JSON report's build-time context (Phase 6, task P6-2): the model/rubric/policy
 * this build actively evaluates with (matching `src/adapters/jev-evaluation-port.ts`'s own
 * `RUBRIC_V2`/`CLASSIFICATION_POLICY_V2` wiring) and this build's persistence schema version —
 * see `AuditReportContext`'s own doc (`src/domain/report.ts`) for why these are compile-time
 * constants passed in, never derived from `AuditResult` itself.
 */
const REPORT_CONTEXT: AuditReportContext = {
  modelRequested: JEV_MODEL_ID,
  rubricVersion: RUBRIC_V2.version,
  policyVersion: CLASSIFICATION_POLICY_V2.version,
  storeSchemaVersion: AUDIT_STORE_SCHEMA_VERSION,
};

/**
 * `--evaluate --json`'s canonical machine shape (Phase 6, task P6-2): one versioned, self-describing
 * report built by the pure domain function `buildAuditReport` (`src/domain/report.ts`) — this
 * function's own job is only to supply the build-time context and serialize the result.
 * Evolves the pre-P6-2 ad-hoc envelope (which carried no version, no discovery block, no
 * incomplete-run visibility, no per-test cache status, and no latency) into that one canonical
 * shape, deliberately, as documented in this task's own report — see `docs/technical-design.md`'s
 * "Reports" section and `README.md`'s `audit --evaluate --json` entry for the delivered contract.
 */
function evaluateJsonLine(result: AuditResult): string {
  return JSON.stringify(buildAuditReport(result, REPORT_CONTEXT));
}

/**
 * Shared "Diagnostics: none" / "Diagnostics:\n  - code (path): message" block (Phase 7: extracted
 * so `evaluateTextReport` and the default `audit` summary, `auditTextReport`, never drift on how a
 * diagnostic renders in text). Output for `evaluateTextReport` is unchanged by this extraction.
 */
function diagnosticsTextLines(diagnostics: readonly AuditDiagnostic[]): readonly string[] {
  return diagnostics.length === 0
    ? ['Diagnostics: none']
    : [
      'Diagnostics:',
      ...diagnostics.map((diagnostic) => {
        const location = diagnostic.repositoryRelativePath === undefined ? '' : ` (${diagnostic.repositoryRelativePath})`;
        return `  - ${diagnostic.code}${location}: ${diagnostic.message}`;
      }),
    ];
}

/** Concise human-readable `--evaluate` text report, one `writeLine` call (embedded newlines), mirroring `evaluateJsonLine`'s data. Includes a `Diagnostics` block (never just a bare failed count) so an `evaluation-failed` diagnostic stays visible without needing `--json`. */
function evaluateTextReport(result: AuditResult): string {
  const totals = result.evaluation?.totals ?? ZERO_EVALUATION_TOTALS;
  const { statusCounts, skipped } = totals;
  return [
    'Jev evaluation summary',
    // Phase 5, task P5-4: present only for `--resume <runId>` with outstanding work — the
    // nothing-outstanding case never reaches this function (see `evaluateJsonLine`'s own comment).
    ...(result.resume === undefined ? [] : [`Resumed run ${result.resume.runId}: reused ${result.resume.reused} already-completed item(s), dispatched ${result.resume.outstanding} outstanding item(s).`]),
    `Model requested: ${JEV_MODEL_ID}`,
    `Model responded: ${totals.respondedModel ?? '(none — no evaluation succeeded)'}`,
    `Model mismatches: ${totals.modelMismatches}`,
    `Root: ${result.rootDir}`,
    `Evaluated: ${totals.evaluated}`,
    `Cached: ${totals.cached}`,
    `Healthy: ${statusCounts.healthy}, Weak: ${statusCounts.weak}, Misleading: ${statusCounts.misleading}, Needs review: ${statusCounts['needs-review']}`,
    `Skipped: ${skipped.total} (skip: ${skipped.byReason.skip}, todo: ${skipped.byReason.todo}, evidence-unavailable: ${skipped.byReason['evidence-unavailable']})`,
    `Failed: ${totals.failed}`,
    `Usage (total input tokens): ${totals.usage.inputTokens}`,
    ...diagnosticsTextLines(result.diagnostics),
    'Evidence for every evaluated test case was sent to TypeSafe; nothing else leaves this machine, and nothing is sent without --evaluate.',
  ].join('\n');
}

/**
 * Cap on how many discovered/excluded file lines `auditTextReport` prints before summarizing the
 * rest (Phase 7): a real repository can have hundreds of test files, and printing all of them by
 * default would bury the report's own totals and cost estimate under noise. Chosen as a plain
 * "fits on one screen" viewport size, not derived from anything else. Never silent —
 * `fileListTextLines` always says exactly how many entries were left out and names the one place to
 * see all of them (`audit --json`, which prints the complete, untruncated array — see `summary`).
 */
const TEXT_REPORT_FILE_LIST_LIMIT = 20;

/**
 * Renders one bounded, never-silent list section for `auditTextReport`'s "Discovered files"/
 * "Excluded files" blocks, in the same "label: none" / "label:\n  - ..." shape
 * `diagnosticsTextLines` already uses. Up to `TEXT_REPORT_FILE_LIST_LIMIT` `  - `-prefixed lines;
 * beyond that, one further line names exactly how many were left out and where to see them all.
 */
function fileListTextLines<T>(header: string, items: readonly T[], render: (item: T) => string): readonly string[] {
  if (items.length === 0) return [`${header}: none`];
  const shown = items.slice(0, TEXT_REPORT_FILE_LIST_LIMIT).map((item) => `  - ${render(item)}`);
  const remaining = items.length - TEXT_REPORT_FILE_LIST_LIMIT;
  return remaining <= 0
    ? [`${header}:`, ...shown]
    : [`${header}:`, ...shown, `  ... and ${remaining} more not shown (run \`audit --json\` to see the complete list).`];
}

/**
 * Exclusion reasons worth naming individually in `auditTextReport`'s "Excluded files:" section
 * (this task's own report, problem 1): a real audit against a NestJS backend produced 20+ lines all
 * reading `(reason: not-test-file)` — noise, not information, because that reason (and
 * `unsupported-extension`, its sibling for a file whose extension this tool never parses at all —
 * `.json`, `.md`, `.css`, and so on) fires once per ORDINARY file in the whole tree: every
 * production source file, config, doc, or asset lands in one of these two, so the bucket grows with
 * repository size and tells a reader nothing they could not already guess. The other five reasons
 * instead reflect a decision that could plausibly surprise someone looking for a specific test: a
 * configured `exclude` pattern actually matched something (worth double-checking the glob did what
 * was intended — `configured-exclude`; like `include` below, `ConfigurationOverrides.exclude` has no
 * CLI flag today, so this reason is reachable only by a direct caller of `resolveConfiguration`, not
 * through the shipped `audit` command); a default-excluded top-level path — `node_modules`,
 * `.git`, `dist`, `build`, `vendor`, `coverage`, `generated` (`default-exclude`) — one entry per
 * matched directory, since a match stops the walk before recursing into it (see
 * `src/adapters/repository-discovery.ts`'s `walk`), so this reason is never high-volume even though
 * it is always worth naming; a file classified end-to-end rather than unit/integration
 * (`e2e-v1`); and a symlink the walker refuses to follow, whether or not its target resolves
 * outside the audited root (`symlink`/`outside-root`).
 *
 * `not-test-file` gets special handling in `exclusionCarriesSignal`/`exclusionDisplayReason`: most
 * `not-test-file` exclusions are the ordinary "this is a production file" case, but the very same
 * reason also covers a file that matches this tool's own test-name convention and a supported
 * extension yet was left out by a configured, non-default `include` pattern (evidence:
 * `include-pattern` — see `src/adapters/repository-discovery.ts`) — "looks like a test but was not
 * treated as one," exactly the kind of surprise this section exists to surface, and one of this
 * task's own named examples. `ConfigurationOverrides.include` has no CLI flag today — `runCli`'s
 * argument parser never sets it (only `--rootDir`/`--root-dir`, `--resume`, and `--html` take a
 * value — `--open` is a bare boolean; see `parseAuditOptions` above), the same "no CLI flag reaches
 * this override" pattern
 * `ScheduleConfigurationOverrides`'s own doc describes (`src/domain/config.ts`) — so this specific
 * sub-case cannot occur through the shipped `audit` command yet. It is still handled correctly here
 * both because any other caller of `discoverTestFiles`'s underlying data can produce it, and because
 * folding it into the ordinary `not-test-file` count would misclassify the one outcome this section
 * is explicitly meant to catch.
 */
function exclusionCarriesSignal(file: ExcludedTestFile): boolean {
  switch (file.reason) {
    case 'not-test-file':
      return file.evidence.includes('include-pattern');
    case 'unsupported-extension':
      return false;
    case 'configured-exclude':
    case 'default-exclude':
    case 'e2e-v1':
    case 'symlink':
    case 'outside-root':
      return true;
  }
}

/**
 * The label both `excludedByReasonLines`'s counts and `auditTextReport`'s "Excluded files:" listing
 * render for one excluded file — identical to `file.reason` except for the `not-test-file` +
 * `include-pattern` sub-case (see `exclusionCarriesSignal`'s own doc), which gets its own
 * distinguishable label so its count and its individually-listed path are never silently folded into
 * the ordinary `not-test-file` bucket it is deliberately kept apart from.
 */
function exclusionDisplayReason(file: ExcludedTestFile): string {
  return file.reason === 'not-test-file' && file.evidence.includes('include-pattern')
    ? 'not-test-file (excluded by a configured include pattern)'
    : file.reason;
}

/**
 * "Excluded files by reason:" block (this task's own report, problem 1). One line per distinct
 * reason label actually present (`exclusionDisplayReason`), alphabetically sorted for determinism,
 * each with its exact count — never silent, mirroring `diagnosticsTextLines`'s own "none" fallback
 * when nothing was excluded at all. Every reason is counted here, signal or not, so a reader always
 * sees the true shape of what was left out; only reasons `exclusionCarriesSignal` calls boring are
 * withheld from the individual listing below. When at least one such collapsed reason is present,
 * one more line points at `audit --json` for the complete list, the same reachability guarantee
 * `fileListTextLines`'s own truncation note makes elsewhere in this report — omitted entirely when
 * every present reason already gets an individual line below, so it is never an unconditional,
 * redundant disclaimer.
 */
function excludedByReasonLines(excluded: readonly ExcludedTestFile[]): readonly string[] {
  if (excluded.length === 0) return ['Excluded files by reason: none'];
  const counts = new Map<string, number>();
  for (const file of excluded) {
    const label = exclusionDisplayReason(file);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = [...counts.keys()].sort();
  const anyCollapsed = excluded.some((file) => !exclusionCarriesSignal(file));
  return [
    'Excluded files by reason:',
    ...labels.map((label) => `  - ${label}: ${counts.get(label) ?? 0}`),
    ...(anyCollapsed
      ? ['  (only reasons that could mean an expected test was skipped over are listed individually below; run `audit --json` for the complete list, including the reasons collapsed here.)']
      : []),
  ];
}

/**
 * The default `audit` (no `--dry-run`/`--evaluate`/`--json`/`--inspect-payloads`) readable summary
 * (Phase 7, orchestrator scope change on top of the original readable-default-summary task): a
 * report for the human running it, combining what plain discovery already found (files,
 * exclusions, evidence provenance, diagnostics — the same data `summary`'s JSON exposes) with the
 * exact same no-network, no-write cost/call estimate `--dry-run` computes (`estimateDryRun`, reused
 * verbatim via `costEstimatePreambleLines`/`costEstimateBodyLines` — never a second,
 * independently-worded estimator) and the exact same read-only cache consultation `--dry-run`
 * already performs (`openSqliteAuditStoreForLookup`, wired in `runCli`; a plain `audit` still
 * creates no database file or config directory — that read-only open never does either).
 *
 * Ordering (deliberate, not incidental — reworked by this task's own report, problem 2, on top of
 * the original readable-default-summary ordering):
 * 1. `Root` immediately after the title, so a reader always knows which repository this describes.
 * 2. What this run found and what it would cost, together: the file/exclusion/dynamic-metadata/
 *    unsupported-framework totals, immediately followed by the cost estimate (`Model`/pricing
 *    preamble, then `Discovered test cases`/`Evaluable`/`Skipped`/calls/cost). A reader gets the
 *    run's whole shape — what exists, what it would take to evaluate it — before any deeper detail.
 *    `Test cases` is deliberately omitted from the totals above: the cost estimate already reports
 *    the identical count as `Discovered test cases`, and printing the same number twice under two
 *    different labels would be redundant rather than informative — the same reasoning this task's
 *    own report applies to `Evidence bundles` below.
 * 3. The evidence-provenance detail behind those numbers: fragments/truncated/omitted/denied/
 *    unresolved. `Evidence bundles` is deliberately dropped rather than moved here: in the common
 *    case one evidence bundle is built per discovered test case (see
 *    `src/adapters/evidence-audit-port.ts`), so it is the exact same figure as `Discovered test
 *    cases` above under a different name — the literal case this task's report calls out. The rare
 *    case where they diverge (a per-test-case `evidence-selection-failed` build failure) is not
 *    silently lost: it already surfaces, more specifically, as an `evidence-unavailable` entry in
 *    the `Skipped` breakdown above and as its own named diagnostic below — strictly more informative
 *    than the bare count ever was. `Evidence bytes`/`Request bytes`/`Rubric bytes per request` stay
 *    inside the cost estimate block (tier 2): they are cost-estimation inputs, not evidence-quality
 *    outcomes, and that block is shared verbatim with `dryRunTextReport`/`costEstimateBodyLines`,
 *    whose own output this task must not change a single byte of.
 * 4. Per-item listings, grouped **found** (`Discovered files`) -> **skipped** (`Excluded files by
 *    reason:` counts, then `Excluded files:` individually for the reasons `exclusionCarriesSignal`
 *    calls worth a closer look — see that function's own doc for the full split and why it replaces
 *    the flat, unfiltered list this section used to print). This is where a list can run long, so it
 *    lives below the totals/estimate a reader wants first, truncated (`fileListTextLines`) rather
 *    than silently unbounded.
 * 5. Diagnostics — its own final tier, both the `Diagnostics (total)` count and the full
 *    `Diagnostics:` block, moved down from beside the totals in tier 2 to sit directly beside the
 *    list it summarizes: "what it found" (tier 2) is about the repository's shape, "what went
 *    wrong" (tier 5) is a different question, asked last, right before the closing guarantee.
 * 6. The same reporting-only guarantee sentence `--dry-run` closes with — equally true here: this
 *    command makes no network call and writes nothing to disk either.
 */
function auditTextReport(result: AuditResult, estimate: DryRunEstimate): string {
  const { totals } = result;
  return [
    'Audit summary (reporting-only)',
    `Root: ${result.rootDir}`,
    `Files discovered: ${totals.files}`,
    `Files excluded: ${totals.excluded}`,
    `Dynamic metadata entries: ${totals.dynamicMetadata}`,
    `Unsupported framework files: ${totals.unsupportedFrameworkFiles}`,
    ...costEstimatePreambleLines(estimate),
    ...costEstimateBodyLines(estimate),
    `Evidence fragments: ${totals.evidenceFragments} (${totals.evidenceTruncatedFragments} truncated)`,
    `Evidence omitted: ${totals.evidenceOmitted}`,
    `Evidence denied: ${totals.evidenceDenied}`,
    `Evidence unresolved: ${totals.evidenceUnresolved}`,
    ...fileListTextLines('Discovered files', result.files, (file) => {
      const dynamicSuffix = file.dynamicMetadata.length > 0 ? `, ${file.dynamicMetadata.length} dynamic metadata` : '';
      return `${file.discovered.repositoryRelativePath} [${file.discovered.framework}] — ${file.testCases.length} test case(s), ${file.evidence.length} evidence bundle(s)${dynamicSuffix}`;
    }),
    ...excludedByReasonLines(result.excluded),
    ...fileListTextLines(
      'Excluded files',
      result.excluded.filter(exclusionCarriesSignal),
      (file) => `${file.repositoryRelativePath} (reason: ${exclusionDisplayReason(file)})`,
    ),
    `Diagnostics (total): ${totals.diagnostics}`,
    ...diagnosticsTextLines(result.diagnostics),
    'No network calls were made; nothing was written to disk.',
  ].join('\n');
}

interface ParsedAuditOptions {
  readonly overrides: ConfigurationOverrides;
  readonly inspectPayloads: boolean;
  readonly dryRun: boolean;
  readonly evaluate: boolean;
  readonly fresh: boolean;
  readonly json: boolean;
  /** `--resume <runId>` (Phase 5, task P5-4), parsed like `--rootDir` — consumes the next argument. `undefined` unless given. */
  readonly resume?: string;
  /**
   * `--html [path]` (Phase 6, task P6-4): consumes the next argument unless it is missing or another
   * option, in which case it defaults to `DEFAULT_HTML_REPORT_FILENAME` in the invocation directory.
   * `undefined` unless given.
   */
  readonly html?: string;
  /** `--open` (Phase 6, task P6-4): requires `html` to be set — enforced below, never independently meaningful. */
  readonly open: boolean;
}

/** File name `--html` writes into the invocation directory when given without a path. */
const DEFAULT_HTML_REPORT_FILENAME = 'report.html';

function parseAuditOptions(args: readonly string[]): ParsedAuditOptions | { readonly error: string } | { readonly help: true } {
  const overrides: ConfigurationOverrides = {};
  let inspectPayloads = false;
  let dryRun = false;
  let evaluate = false;
  let fresh = false;
  let json = false;
  let resume: string | undefined;
  let html: string | undefined;
  let open = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') return { help: true };
    if (argument === '--inspect-payloads') {
      inspectPayloads = true;
      continue;
    }
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--evaluate') {
      evaluate = true;
      continue;
    }
    if (argument === '--fresh') {
      fresh = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--rootDir' || argument === '--root-dir') {
      const rootDir = args[index + 1];
      if (rootDir === undefined || rootDir.startsWith('--')) return { error: `${argument} requires a path` };
      overrides.rootDir = rootDir;
      index += 1;
      continue;
    }
    if (argument === '--resume') {
      const runId = args[index + 1];
      if (runId === undefined || runId.startsWith('--')) return { error: '--resume requires a run id' };
      resume = runId;
      index += 1;
      continue;
    }
    if (argument === '--html') {
      const path = args[index + 1];
      if (path === undefined || path.startsWith('--')) {
        html = DEFAULT_HTML_REPORT_FILENAME;
        continue;
      }
      html = path;
      index += 1;
      continue;
    }
    if (argument === '--open') {
      open = true;
      continue;
    }
    return { error: `Unknown option: ${argument ?? ''}` };
  }
  // Phase 7 (orchestrator scope change): `--json` alone is no longer a usage error — a plain
  // `audit --json` now prints the same discovery JSON the default human-readable report is built
  // from (see `auditTextReport`/`runCli`). `--dry-run --json` and `--evaluate --json` are unchanged.
  if (dryRun && inspectPayloads) return { error: '--dry-run cannot be combined with --inspect-payloads' };
  if (dryRun && evaluate) return { error: '--dry-run cannot be combined with --evaluate' };
  if (evaluate && inspectPayloads) return { error: '--evaluate cannot be combined with --inspect-payloads' };
  if (fresh && !evaluate) return { error: '--fresh requires --evaluate (audit --evaluate --fresh)' };
  if (resume !== undefined && !evaluate) return { error: '--resume requires --evaluate (audit --evaluate --resume <runId>)' };
  if (html !== undefined && dryRun) return { error: '--html cannot be combined with --dry-run' };
  if (html !== undefined && inspectPayloads) return { error: '--html cannot be combined with --inspect-payloads' };
  if (html !== undefined && !evaluate) return { error: '--html requires --evaluate (audit --evaluate --html [path])' };
  if (open && html === undefined) return { error: '--open requires --html (audit --evaluate --html [path] --open)' };
  return {
    overrides,
    inspectPayloads,
    dryRun,
    evaluate,
    fresh,
    json,
    ...(resume === undefined ? {} : { resume }),
    ...(html === undefined ? {} : { html }),
    open,
  };
}

// `NO_KEY_USAGE_MESSAGE`/`resolveEvaluationApiKey` moved to `./api-key.js` (Phase 7, task P7-3):
// shared verbatim with `src/cli/benchmark.ts`'s own `--store` sampling — see that module's own doc
// for why it lives outside this file specifically.

/**
 * `jta report` (feature "persisted-run-reports", `odd/tasks/persisted-run-reports.md`, task T2):
 * a read-only command over what task T1 already persisted to `<rootDir>/.jta/` — never re-evaluates,
 * never touches an API key, the network, or the audit store. `--last` (the default) and `--run
 * <runId>` select WHICH run; `--json`/`--html [path]` select the output shape, defaulting to a short
 * human summary when neither is given.
 */
interface ParsedReportOptions {
  readonly rootDir?: string;
  /** The specific run id to load; absent means `--last` (the default either way). */
  readonly run?: string;
  readonly json: boolean;
  readonly html?: string;
  readonly open: boolean;
}

function parseReportOptions(args: readonly string[]): ParsedReportOptions | { readonly error: string } | { readonly help: true } {
  let rootDir: string | undefined;
  let run: string | undefined;
  let last = false;
  let json = false;
  let html: string | undefined;
  let open = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') return { help: true };
    if (argument === '--last') {
      last = true;
      continue;
    }
    if (argument === '--run') {
      const runId = args[index + 1];
      if (runId === undefined || runId.startsWith('--')) return { error: '--run requires a run id' };
      run = runId;
      index += 1;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--html') {
      const path = args[index + 1];
      if (path === undefined || path.startsWith('--')) {
        html = DEFAULT_HTML_REPORT_FILENAME;
        continue;
      }
      html = path;
      index += 1;
      continue;
    }
    if (argument === '--open') {
      open = true;
      continue;
    }
    if (argument === '--rootDir' || argument === '--root-dir') {
      const dir = args[index + 1];
      if (dir === undefined || dir.startsWith('--')) return { error: `${argument} requires a path` };
      rootDir = dir;
      index += 1;
      continue;
    }
    return { error: `Unknown option: ${argument ?? ''}` };
  }
  if (last && run !== undefined) return { error: '--last cannot be combined with --run (report --last | --run <runId>)' };
  if (json && html !== undefined) return { error: '--json cannot be combined with --html (report --json | --html [path])' };
  if (open && html === undefined) return { error: '--open requires --html (report --html [path] --open)' };
  return {
    ...(rootDir === undefined ? {} : { rootDir }),
    ...(run === undefined ? {} : { run }),
    json,
    ...(html === undefined ? {} : { html }),
    open,
  };
}

/**
 * Short human-readable default (`jta report`, neither `--json` nor `--html`): the run's own identity
 * and recorded time, the headline "needs a change" share and its denominator, a separate "needs
 * review" share over the same denominator (never folded into "needs a change" — `needs-review` means
 * the model was uncertain, not that the test is broken), both reusing `summarizeReport` (the same
 * aggregation the HTML overview renders from — `src/domain/report-overview.ts`), and up to 5 worst
 * folders by tests needing a change (from the same `folderHeatmap` the overview's own heatmap section
 * renders, excluding its trailing merged `'Other'` row here — a folder-by-folder top list, not that
 * section's full capped grid).
 */
function reportSummaryText(report: AuditReport, recordedAt: Date): string {
  const overview = summarizeReport(report);
  const { needsChange, needsReview } = overview;
  const needsChangeLine = needsChange.judgedTotal === 0
    ? 'Needs a change: n/a (no judged test cases)'
    : `Needs a change: ${needsChange.count}/${needsChange.judgedTotal} (${(needsChange.share * 100).toFixed(1)}%)`;
  const needsReviewLine = needsReview.judgedTotal === 0
    ? 'Needs review (uncertain): n/a (no judged test cases)'
    : `Needs review (uncertain): ${needsReview.count}/${needsReview.judgedTotal} (${(needsReview.share * 100).toFixed(1)}%)`;
  const topFolders = overview.folderHeatmap.rows
    .filter((row) => !row.isOther && row.needsChangeCount > 0)
    .slice(0, 5)
    .map((row) => `  - ${row.folder}: ${row.needsChangeCount}/${row.judgedTotal} need a change`);

  return [
    `Run ${report.runId ?? '(unknown run id)'} — recorded ${recordedAt.toISOString()}`,
    `Root: ${report.rootDir}`,
    needsChangeLine,
    needsReviewLine,
    ...(topFolders.length === 0 ? [] : ['Top folders needing a change:', ...topFolders]),
  ].join('\n');
}

/** One line naming every currently persisted run id, or that none exist — the "unknown run id" error's own detail. */
function availableRunIdsLine(availableRunIds: readonly string[]): string {
  return availableRunIds.length === 0 ? 'No other persisted run ids are available.' : `Available run ids: ${availableRunIds.join(', ')}`;
}

async function runReportCommand(args: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const parsed = parseReportOptions(args);
  if ('help' in parsed) {
    io.writeLine(HELP);
    return 0;
  }
  if ('error' in parsed) {
    io.writeLine(parsed.error);
    return 1;
  }

  const cwd = dependencies.cwd?.() ?? process.cwd();
  const rootDir = parsed.rootDir === undefined ? cwd : resolve(cwd, parsed.rootDir);

  const loadResult: LoadPersistedReportResult = parsed.run === undefined
    ? await loadLatestPersistedReport(rootDir)
    : await loadPersistedReportByRunId(rootDir, parsed.run);

  if (!loadResult.found) {
    if (loadResult.reason === 'no-reports') {
      io.writeLine(`No persisted run reports found under ${join(rootDir, '.jta')}. Run "jta audit --evaluate" first.`);
      return 1;
    }
    io.writeLine(`Unknown run id "${parsed.run ?? ''}". ${availableRunIdsLine(loadResult.availableRunIds)}`);
    return 1;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(loadResult.raw);
  } catch (error) {
    io.writeLine(`Unable to read the persisted report: invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
    return 1;
  }

  const validation = validateAgainstSchema(REPORT_JSON_SCHEMA, parsedJson);
  if (!validation.valid) {
    io.writeLine(`Unable to read the persisted report: it does not match the expected report schema (${validation.errors.join('; ')}).`);
    return 1;
  }
  const report = parsedJson as AuditReport;

  if (parsed.html !== undefined) {
    const htmlPath = resolve(cwd, parsed.html);
    const problem = await checkHtmlReportPath(htmlPath);
    if (problem !== undefined) {
      io.writeLine(`Unable to write the HTML report: ${problem.message}`);
      return 1;
    }
    const html = renderAuditReportHtml(report);
    const writeResult = await writeHtmlReport(htmlPath, html);
    if (!writeResult.written) {
      io.writeLine(`Unable to write the HTML report: ${writeResult.message}`);
      return 1;
    }
    process.stderr.write(`HTML report written to ${htmlPath}${writeResult.overwrote ? ' (overwriting an existing file)' : ''}.\n`);

    if (parsed.open) {
      const openReport = dependencies.openHtmlReport ?? ((path: string) => openHtmlReportWithViewer(path));
      const openResult = await openReport(htmlPath);
      if (!openResult.opened) {
        process.stderr.write(`Unable to open the HTML report automatically: ${openResult.reason}. The report remains at ${htmlPath}.\n`);
      }
    }
    return 0;
  }

  if (parsed.json) {
    io.writeLine(loadResult.raw);
    return 0;
  }

  io.writeLine(reportSummaryText(report, loadResult.recordedAt));
  return 0;
}

async function runAuthLogin(io: CliIo, dependencies: CliDependencies): Promise<number> {
  io.writeLine('Enter your TypeSafe API key. Input is hidden on an interactive terminal; otherwise one line is read from stdin.');

  const readKey = dependencies.readApiKeyFromPrompt ?? (() => readApiKeyFromPrompt());
  let rawKey: string;
  try {
    rawKey = await readKey();
  } catch (error) {
    if (error instanceof AuthPromptCancelledError) {
      io.writeLine(error.message);
      return 1;
    }
    throw error;
  }

  const apiKey = rawKey.trim();
  if (apiKey.length === 0) {
    io.writeLine('No API key was entered. Nothing was stored.');
    return 1;
  }

  const paths = resolveAuthStoragePaths();
  await writeStoredCredentials(paths, apiKey);
  io.writeLine(`TypeSafe API key stored at ${paths.credentialsFile}.`);
  return 0;
}

/**
 * Never reads the stored file's content when an environment key is already
 * present: `status` only needs to know a key is *available*, and skipping
 * the read keeps a plaintext key out of memory whenever it does not
 * matter. The file's existence and permission bits are still always
 * reported (via `statStoredCredentialsFile`, which never reads content)
 * regardless of which source would actually be used.
 */
async function runAuthStatus(io: CliIo): Promise<number> {
  const paths = resolveAuthStoragePaths();
  const fileStatus = await statStoredCredentialsFile(paths);
  const environmentApiKey = process.env['TYPESAFE_API_KEY']?.trim() ?? '';

  let stored: StoredCredentials | undefined;
  let storedProblem: 'insecure-permissions' | 'corrupt' | undefined;
  if (environmentApiKey.length === 0) {
    try {
      stored = await readStoredCredentials(paths);
    } catch (error) {
      if (error instanceof AuthInsecurePermissionsError) storedProblem = 'insecure-permissions';
      else if (error instanceof AuthCorruptCredentialsError) storedProblem = 'corrupt';
      else throw error;
    }
  }

  const resolution = resolveApiKey({ environmentApiKey: environmentApiKey.length > 0 ? environmentApiKey : undefined, stored });
  const lines = [
    resolution === undefined
      ? 'TypeSafe API key: not configured'
      : `TypeSafe API key: configured (source: ${resolution.source})`,
  ];

  if (!fileStatus.permissionsEnforced) {
    lines.push(
      fileStatus.exists
        ? `Stored credentials file: ${paths.credentialsFile} (exists; note: file permissions are not enforced by this tool on Windows)`
        : `Stored credentials file: ${paths.credentialsFile} (does not exist)`,
    );
  } else if (!fileStatus.exists) {
    lines.push(`Stored credentials file: ${paths.credentialsFile} (does not exist)`);
  } else if (storedProblem === 'insecure-permissions' || fileStatus.ownerOnly === false) {
    lines.push(
      `Stored credentials file: ${paths.credentialsFile} (exists; insecure permissions — fix with \`chmod 600 ${paths.credentialsFile}\`, or run \`auth login\` again to recreate it)`,
    );
  } else if (storedProblem === 'corrupt') {
    lines.push(`Stored credentials file: ${paths.credentialsFile} (exists; corrupt or unrecognized format — run \`auth login\` again to overwrite it)`);
  } else {
    lines.push(`Stored credentials file: ${paths.credentialsFile} (exists; owner-only permissions: yes)`);
  }

  if (resolution === undefined) lines.push(NO_KEY_USAGE_MESSAGE);
  io.writeLine(lines.join('\n'));
  return 0;
}

async function runAuthLogout(io: CliIo): Promise<number> {
  const paths = resolveAuthStoragePaths();
  const existed = await deleteStoredCredentials(paths);
  io.writeLine(
    existed
      ? `Stored TypeSafe API key deleted from ${paths.credentialsFile}.`
      : `No stored TypeSafe API key was found at ${paths.credentialsFile}; nothing to delete.`,
  );
  return 0;
}

async function runAuthCommand(args: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const subcommand = args[0];
  if (subcommand === undefined) {
    io.writeLine('Usage: jta auth <login|status|logout>');
    return 1;
  }
  if (subcommand === 'login') {
    if (args.length > 1) {
      io.writeLine(
        'auth login does not accept the API key as an argument (it would be saved in shell history and visible in '
        + 'the process list). Run `jta auth login` with no arguments and enter the key at the prompt, '
        + 'or pipe it on stdin.',
      );
      return 1;
    }
    return runAuthLogin(io, dependencies);
  }
  if (subcommand === 'status') return runAuthStatus(io);
  if (subcommand === 'logout') return runAuthLogout(io);
  io.writeLine(`Unknown auth command: ${subcommand}`);
  return 1;
}

export async function runCli(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  if (args.includes('--help') || args.length === 0) {
    io.writeLine(HELP);
    return 0;
  }

  if (args[0] === 'auth') {
    return runAuthCommand(args.slice(1), io, dependencies);
  }

  if (args[0] === 'report') {
    return runReportCommand(args.slice(1), io, dependencies);
  }

  if (args[0] !== 'audit') {
    io.writeLine(`Unknown command: ${args[0] ?? ''}`);
    return 1;
  }

  const parsed = parseAuditOptions(args.slice(1));
  if ('help' in parsed) {
    io.writeLine(HELP);
    return 0;
  }
  if ('error' in parsed) {
    io.writeLine(parsed.error);
    return 1;
  }

  const htmlPath = parsed.html === undefined ? undefined : resolve(dependencies.cwd?.() ?? process.cwd(), parsed.html);

  // Phase 6, task P6-4: preflight `--html <path>` BEFORE any (potentially expensive, real-money)
  // evaluation work is dispatched — a bad path (an existing directory, a missing parent) costs
  // nothing this way, exactly like the API-key/store checks below fail fast before spending.
  // `writeHtmlReport` re-checks the same two conditions at write time regardless (the unavoidable
  // TOCTOU race between this preflight and the real write), so this is a UX improvement, never the
  // only guarantee — see `src/adapters/html-report-writer.ts`'s own doc.
  if (htmlPath !== undefined) {
    const problem = await checkHtmlReportPath(htmlPath);
    if (problem !== undefined) {
      io.writeLine(`Unable to write the HTML report: ${problem.message}`);
      return 1;
    }
  }

  const configuration = getResolvedConfiguration(parsed.overrides);

  let evaluationPort: AuditEvaluationPort | undefined;
  if (parsed.evaluate && dependencies.audit === undefined) {
    const buildEvaluationPort = dependencies.createEvaluationPort
      ?? (async (): Promise<AuditEvaluationPort> => {
        const resolved = await resolveEvaluationApiKey();
        if ('errorMessage' in resolved) throw new JevConfigurationError(resolved.errorMessage);
        return createJevEvaluationPort(createJevHttpGateway({ apiKey: resolved.apiKey }));
      });
    try {
      evaluationPort = await buildEvaluationPort();
    } catch (error) {
      if (error instanceof JevConfigurationError) {
        io.writeLine(`--evaluate requires a TypeSafe API key: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  // Phase 5, task P5-1: the store is opt-in exactly like the evaluation port above, and is only
  // ever built AFTER a usable API key already resolved (evaluationPort !== undefined) — so a
  // failed `--evaluate` (missing/invalid key, handled above) never creates a database file.
  let storePort: AuditStorePort | undefined;
  if (parsed.evaluate && dependencies.audit === undefined && evaluationPort !== undefined) {
    const buildStorePort = dependencies.createStorePort
      ?? ((): Promise<AuditStorePort> => createSqliteAuditStore({
        databaseFile: configuration.store.databasePath ?? resolveAuditStorePaths().databaseFile,
      }));
    try {
      storePort = await buildStorePort();
    } catch (error) {
      if (error instanceof AuditStoreSchemaVersionError || error instanceof AuditStoreCorruptError) {
        io.writeLine(`Unable to open the audit store: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  // Phase 5, task P5-2: the cache-key port is always constructed together with a successfully
  // opened store — never independently of it, since a lookup needs somewhere to look things up in
  // — and never fails on its own (no I/O, no state; see `createAuditCacheKeyPort`'s own doc).
  const cacheKeyPort: AuditCacheKeyPort | undefined = storePort === undefined ? undefined : createAuditCacheKeyPort();

  // Phase 6, task P6-3: the progress port is opt-in exactly like the evaluation port above, and —
  // deliberately unlike the store — never depends on whether a store was actually built: progress
  // describes what this run is doing, not what gets persisted (see `AuditProgressPort`'s own doc,
  // `src/domain/audit.ts`). Gated on `evaluationPort !== undefined` only so nothing is constructed
  // for a `--evaluate` invocation that already failed to resolve an API key above. Never fails on
  // its own (no I/O, no state at construction time — `createTerminalProgressReporter` only closes
  // over a `write` function and a boolean).
  let progressPort: AuditProgressPort | undefined;
  if (parsed.evaluate && dependencies.audit === undefined && evaluationPort !== undefined) {
    const buildProgressPort = dependencies.createProgressPort
      ?? ((): AuditProgressPort => createTerminalProgressReporter({
        write: (chunk) => { process.stderr.write(chunk); },
        isTTY: process.stderr.isTTY === true,
      }));
    progressPort = buildProgressPort();
  }

  // Phase 5, task P5-5: `--dry-run` may READ an existing audit store to report cache hits, but
  // must never create, migrate, or write to one — `openSqliteAuditStoreForLookup` itself is the
  // one place that guarantee lives (see its own doc). Gated exactly like `--evaluate`'s own store
  // above (never for the `dependencies.audit` test seam, which supplies its own `AuditResult` with
  // no `sourceTextByPath` of its own to consult), and only for `--dry-run` itself — an ordinary
  // `--evaluate` run never opens a second, read-only connection alongside its own writable one. A
  // schema-incompatible or corrupt store surfaces the identical named, visible failure `--evaluate`
  // already reports (readable message, exit 1, no stack trace) — see that function's own doc for
  // why: a subsequent real `--evaluate` against the same file would refuse too.
  //
  // Orchestrator decision, 2026-09-20: `openSqliteAuditStoreForLookup`'s result also names WHY the
  // cache was not consulted when it was not (`AuditStoreLookupResult`'s `reason`, an
  // `estimateDryRun`-matching `DryRunCacheNotConsultedReason`) — threaded straight through to
  // `estimateDryRun` below with no re-derivation, so the CLI is never a second place that could
  // disagree with the adapter about why. Left `undefined` for the `dependencies.audit` test seam,
  // which never attempts to open a store at all and therefore has no reason to report.
  // Phase 7 (orchestrator scope change): the plain default `audit` report now folds in the exact
  // same cost/call estimate `--dry-run` computes, through the exact same read-only cache
  // consultation below — so this gate broadens from "`--dry-run` only" to "`--dry-run` OR the plain
  // default report" (i.e. neither `--evaluate` nor `--inspect-payloads` nor `--json`, which stay
  // pure discovery-only surfaces and never need this estimate at all). `--dry-run --json` still
  // needs it (this predicate is `true` for it via the `parsed.dryRun` arm), unchanged from before.
  const wantsCostEstimate = parsed.dryRun || (!parsed.evaluate && !parsed.inspectPayloads && !parsed.json);
  let dryRunLookup: AuditStoreReadOnlyLookup | undefined;
  let dryRunCacheNotConsultedReason: DryRunCacheNotConsultedReason | undefined;
  if (wantsCostEstimate && dependencies.audit === undefined) {
    try {
      const lookupResult = await openSqliteAuditStoreForLookup({
        databaseFile: configuration.store.databasePath ?? resolveAuditStorePaths().databaseFile,
      });
      if (lookupResult.available) {
        dryRunLookup = lookupResult.lookup;
      } else {
        dryRunCacheNotConsultedReason = lookupResult.reason;
      }
    } catch (error) {
      if (error instanceof AuditStoreSchemaVersionError || error instanceof AuditStoreCorruptError) {
        io.writeLine(`Unable to open the audit store: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  try {
    let result: AuditResult;
    try {
      result = dependencies.audit === undefined
        ? await runAudit(
          configuration,
          createProductionPorts(configuration.rootDir, evaluationPort, storePort, cacheKeyPort, progressPort),
          {
            fresh: parsed.fresh,
            ...(parsed.resume === undefined ? {} : { resume: parsed.resume }),
            ...(dryRunLookup === undefined ? {} : { retainSourceText: true }),
          },
        )
        : await dependencies.audit(configuration);
    } catch (error) {
      // Phase 5, task P5-4 (plus the rootDir-identity defect fix, 2026-09-20): `--resume
      // <runId>`'s own named, visible preflight failures — a run id that does not exist, one
      // recorded against a different --rootDir, one recorded before this fix started persisting a
      // canonical rootDir, or (defensively) resume requested with no store at all — follow the
      // exact same convention as every other `runAudit` usage error above: a readable message on
      // `io`, exit code 1, no stack trace. "Already finished, nothing outstanding" is NOT an error
      // and never reaches this catch — `runAudit` reports it via `result.resume.nothingOutstanding`
      // instead (handled below).
      if (
        error instanceof AuditResumeRunNotFoundError
        || error instanceof AuditResumeRootDirMismatchError
        || error instanceof AuditResumeLegacyRootDirError
        || error instanceof AuditResumeUnavailableError
      ) {
        io.writeLine(error.message);
        return 1;
      }
      throw error;
    }

    if (result.resume?.nothingOutstanding === true) {
      io.writeLine(`Nothing to resume: run ${result.resume.runId} has no outstanding work items.`);
      return 0;
    }

    if (parsed.dryRun) {
      // Phase 5, task P5-5: when an existing store was actually opened above, compute each
      // evaluable test case's real cache key and look it up — the exact same two calls a real
      // dispatch would make (`AuditCacheKeyPort.computeKey` then `AuditStorePort.lookup`) — so
      // this dry run's billable count agrees with what a subsequent real `--evaluate` run over the
      // same fixture and store actually dispatches, by construction. With no store to consult
      // (the common case: none exists yet), `cacheHitTestCaseIds` stays `undefined` and
      // `estimateDryRun` reports every evaluable test case as billable, exactly as it always did —
      // see that function's own doc for why the underlying numbers stay byte-identical to before
      // this task. `dryRunCacheNotConsultedReason` (orchestrator decision, 2026-09-20) is passed
      // alongside it — `estimateDryRun` itself only ever reflects it when the cache was NOT
      // consulted, so passing it unconditionally here is safe.
      const cacheHitTestCaseIds = dryRunLookup === undefined
        ? undefined
        : await computeDryRunCacheHits(result.files, result.sourceTextByPath ?? new Map(), createAuditCacheKeyPort(), dryRunLookup.lookup);
      const estimate = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, result.files, RUBRIC_V2, cacheHitTestCaseIds, dryRunCacheNotConsultedReason);
      io.writeLine(parsed.json ? dryRunJsonLine(result.rootDir, estimate) : dryRunTextReport(result.rootDir, estimate));
      return 0;
    }

    if (parsed.evaluate) {
      const reportJson = evaluateJsonLine(result);
      io.writeLine(parsed.json ? reportJson : evaluateTextReport(result));

      // Persisted run reports (feature "persisted-run-reports", `odd/tasks/persisted-run-reports.md`,
      // task T1): every `--evaluate` run writes the exact same canonical JSON `--evaluate --json`
      // would print — `reportJson` above, never re-derived — to `<rootDir>/.jta/reports/<runId>.json`
      // and `<rootDir>/.jta/latest.json`, regardless of whether `--json`/`--html` were also given (see
      // `src/adapters/persisted-report-store.ts`'s own doc for the layout, self-ignoring `.gitignore`,
      // and retention). `result.runId` is absent only when this run never had a store attached at all
      // (never true for production `--evaluate` wiring, which always constructs one before reaching
      // here — see the store-construction block above; only reachable via the `dependencies.audit`
      // test seam) — persistence is silently skipped then, since there is no run identity to name a
      // file after. A write failure is never fatal to the audit itself: one stderr line, the exit code
      // and stdout both stay exactly as they already were.
      if (result.runId !== undefined) {
        const persistResult = await persistAuditReport(result.rootDir, result.runId, reportJson);
        if (!persistResult.persisted) {
          process.stderr.write(`Unable to persist the run report to .jta/: ${persistResult.reason}\n`);
        }
      }

      // Phase 6, task P6-4. Deliberately unreached when `result.resume?.nothingOutstanding` was
      // `true` above (no report exists to render in that case — see this task's own decision,
      // documented in README.md's "Self-contained HTML report" section): nothing is written then,
      // exactly like `--json` prints no report either. `report`/`html` are computed fresh here
      // (never reused from `evaluateJsonLine` above) — `buildAuditReport` is pure and cheap, and
      // keeping this block self-contained is worth the one extra call.
      if (htmlPath !== undefined) {
        const report = buildAuditReport(result, REPORT_CONTEXT);
        const html = renderAuditReportHtml(report);
        const writeResult = await writeHtmlReport(htmlPath, html);
        if (!writeResult.written) {
          io.writeLine(`Unable to write the HTML report: ${writeResult.message}`);
          return 1;
        }
        // Visible, never silent (this task's own scope: "make each visible and named") — but on
        // stderr, never stdout, exactly like progress (P6-3): `--evaluate --json`'s stdout stays
        // byte-clean regardless of whether --html was also given.
        process.stderr.write(
          `HTML report written to ${htmlPath}${writeResult.overwrote ? ' (overwriting an existing file)' : ''}.\n`,
        );

        if (parsed.open) {
          const openReport = dependencies.openHtmlReport ?? ((path: string) => openHtmlReportWithViewer(path));
          const openResult = await openReport(htmlPath);
          if (!openResult.opened) {
            // Never fatal, never changes the exit status, never loses the already-written file —
            // see `src/adapters/html-report-opener.ts`'s own doc for why a CI environment with no
            // viewer installed is the expected common case here, not an error.
            process.stderr.write(`Unable to open the HTML report automatically: ${openResult.reason}. The report remains at ${htmlPath}.\n`);
          }
        }
      }

      return 0;
    }

    // Phase 7 (orchestrator scope change): the plain default report — reached only when none of
    // `--dry-run`/`--evaluate`/`--inspect-payloads`/`--json` was given (each of those already
    // returned above, or is excluded from `wantsCostEstimate`; see that flag's own doc). Computes
    // the cost estimate exactly like `--dry-run` does just above (same cache-hit lookup, same
    // `estimateDryRun` call) and renders it merged with discovery via `auditTextReport`.
    if (wantsCostEstimate) {
      const cacheHitTestCaseIds = dryRunLookup === undefined
        ? undefined
        : await computeDryRunCacheHits(result.files, result.sourceTextByPath ?? new Map(), createAuditCacheKeyPort(), dryRunLookup.lookup);
      const estimate = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, result.files, RUBRIC_V2, cacheHitTestCaseIds, dryRunCacheNotConsultedReason);
      io.writeLine(auditTextReport(result, estimate));
      return 0;
    }

    // Reached only by `--json` (bare) and `--inspect-payloads` (with or without `--json`, a no-op
    // combination — see this task's own decision record): both print the unchanged discovery JSON;
    // `--inspect-payloads` additionally appends one canonical evidence-bundle line per bundle.
    io.writeLine(summary(result));
    if (parsed.inspectPayloads) {
      for (const line of inspectPayloadLines(result)) io.writeLine(line);
    }
    return 0;
  } finally {
    if (storePort !== undefined) await storePort.close();
    if (dryRunLookup !== undefined) await dryRunLookup.close();
  }
}

function isInvokedAsPackageEntry(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;

  try {
    return realpathSync(invokedPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isInvokedAsPackageEntry()) {
  void runCli(process.argv.slice(2), { writeLine: console.log }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
