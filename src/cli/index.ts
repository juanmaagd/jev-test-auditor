#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getResolvedConfiguration } from '../application/configure.js';
import { runAudit } from '../application/audit.js';
import { discoverTestFiles } from '../adapters/repository-discovery.js';
import { readSourceFile } from '../adapters/source-reader.js';
import { extractTestCases } from '../adapters/test-extraction.js';
import { createAuditCacheKeyPort } from '../adapters/cache-key.js';
import { createAuditEvidencePort } from '../adapters/evidence-audit-port.js';
import { createJevEvaluationPort } from '../adapters/jev-evaluation-port.js';
import { createJevHttpGateway } from '../adapters/jev-http-gateway.js';
import { createSqliteAuditStore, resolveAuditStorePaths } from '../adapters/sqlite-audit-store.js';
import { readApiKeyFromPrompt } from '../adapters/auth-prompt.js';
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
import { canonicalizeEvidenceBundle, type EvidenceBundle } from '../domain/evidence.js';
import { estimateDryRun, JEV_ESTIMATE_SNAPSHOT, type DryRunEstimate } from '../domain/estimate.js';
import { JevConfigurationError } from '../domain/jev-gateway.js';
import { JEV_MODEL_ID } from '../domain/rubric.js';
import {
  AuditResumeLegacyRootDirError,
  AuditResumeRootDirMismatchError,
  AuditResumeRunNotFoundError,
  AuditResumeUnavailableError,
  AuditStoreCorruptError,
  AuditStoreSchemaVersionError,
  type AuditCacheKeyPort,
  type AuditDiagnostic,
  type AuditEvaluationPort,
  type AuditPorts,
  type AuditRequest,
  type AuditResult,
  type AuditStorePort,
} from '../domain/audit.js';
import type { ClassificationResult } from '../domain/classification.js';
import type { ConfigurationOverrides } from '../domain/config.js';
import type { TestCaseId } from '../domain/test-understanding.js';

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
   * Test seam only, consulted by `auth login`: overrides how the API key is
   * read from the terminal. Production default (`readApiKeyFromPrompt`)
   * reads `process.stdin`/`process.stdout` directly — hidden input on a
   * real TTY, one trimmed line otherwise.
   */
  readonly readApiKeyFromPrompt?: () => Promise<string>;
}

const HELP = `jev-test-auditor — inspect semantic test quality

Usage:
  jev-test-auditor audit [options]
  jev-test-auditor auth <login|status|logout>
  jev-test-auditor --help

Commands:
  audit         Discover and extract test understanding without executing project code
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
                      Jev calls (one per evaluable test case), exact evidence bytes and exact real
                      request bytes (the actual state plus every rubric question, measured by
                      building each real request locally, never a guessed overhead), and clearly
                      labeled approximate input-token and USD ranges converted from those request
                      bytes via a versioned local pricing snapshot. The rubric's own questions
                      dominate a request's bytes (about 93% for the shipped rubric) — see
                      "Rubric bytes per request" in the output. Makes no network or provider calls,
                      requires no API key, and writes nothing to disk. Cannot be combined with
                      --inspect-payloads or --evaluate.
  --evaluate         Opt-in only: sends every evaluable test case's local evidence bundle to
                      TypeSafe's Jev model for real judgment (costs money; nothing is sent without
                      this flag). Requires a TypeSafe API key from the TYPESAFE_API_KEY
                      environment variable (checked first, so CI keeps injecting GitHub secrets)
                      or from 'jev-test-auditor auth login'; having neither is a usage error
                      (exit 1, no network attempted) that names both ways to provide one. Prints
                      a terminal evaluation summary (status counts, skipped-by-reason, failed,
                      total usage input tokens,
                      and the responded model id) instead of the normal summary. Thresholds are
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
  --dry-run --json   Print the same dry-run preview as one machine-readable JSON line instead of
                      the human-readable text report. Requires --dry-run.
  --json             Requires --dry-run or --evaluate; --json alone is a usage error.
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
function createProductionPorts(evaluationPort?: AuditEvaluationPort, storePort?: AuditStorePort, cacheKeyPort?: AuditCacheKeyPort): AuditPorts {
  return {
    discovery: { discover: discoverTestFiles },
    sourceReader: { read: readSourceFile },
    extractor: { extract: extractTestCases },
    evidence: createAuditEvidencePort(),
    ...(evaluationPort === undefined ? {} : { evaluation: evaluationPort }),
    ...(storePort === undefined ? {} : { store: storePort }),
    ...(cacheKeyPort === undefined ? {} : { cacheKey: cacheKeyPort }),
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

/** Concise human-readable `--dry-run` text report, one `writeLine` call (embedded newlines), mirroring `dryRunJsonLine`'s data. */
function dryRunTextReport(rootDir: string, estimate: DryRunEstimate): string {
  const { skipped } = estimate;
  return [
    'Dry-run cost and call estimate',
    `Model: ${estimate.model}`,
    `Pricing/overhead snapshot: v${estimate.snapshotVersion} (as of ${estimate.asOf})`,
    `Root: ${rootDir}`,
    `Discovered test cases: ${estimate.discovered}`,
    `Evaluable: ${estimate.evaluable}`,
    `Skipped: ${skipped.total} (skip: ${skipped.byReason.skip}, todo: ${skipped.byReason.todo}, evidence-unavailable: ${skipped.byReason['evidence-unavailable']})`,
    `Initial Jev calls (one per evaluable test case, exact): ${estimate.initialCalls}`,
    `Follow-up calls (possible range, exact bound): ${estimate.followUpCalls.min} - ${estimate.followUpCalls.max}`,
    `Evidence bytes (canonical, evaluable bundles only, exact): ${estimate.evidenceBytes}`,
    `Request bytes (canonical, real state + rubric questions, evaluable requests only, exact): ${estimate.requestBytes}`,
    `Rubric bytes per request (fixed cost of this rubric's own questions, exact): ${estimate.rubricBytesPerRequest}`,
    `Estimated input tokens (approximate): ${estimate.estimatedInputTokens.min} - ${estimate.estimatedInputTokens.max}`,
    `Estimated follow-up input tokens (approximate): ${estimate.estimatedFollowUpInputTokens.min} - ${estimate.estimatedFollowUpInputTokens.max}`,
    `Estimated cost in USD (approximate): ${estimate.estimatedUsd.min} - ${estimate.estimatedUsd.max}`,
    `Bundles over the ${estimate.requestTokenCeiling}-token request ceiling: ${estimate.bundlesOverCeiling}`,
    'No network calls were made; nothing was written to disk.',
  ].join('\n');
}

const ZERO_EVALUATION_TOTALS: NonNullable<AuditResult['evaluation']>['totals'] = {
  evaluated: 0,
  cached: 0,
  failed: 0,
  skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
  usage: { inputTokens: 0, outputTokens: 0 },
  statusCounts: { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 },
  respondedModel: undefined,
  modelMismatches: 0,
};

/** Every evidence bundle across `result.files`, indexed by test case id, for attaching per-test provenance counts to a classification entry in the `--evaluate --json` report. */
function bundlesByTestCaseId(result: AuditResult): ReadonlyMap<TestCaseId, EvidenceBundle> {
  const map = new Map<TestCaseId, EvidenceBundle>();
  for (const file of result.files) {
    for (const bundle of file.evidence) map.set(bundle.testCaseId, bundle);
  }
  return map;
}

function evidenceProvenance(bundle: EvidenceBundle | undefined): {
  readonly fragments: number;
  readonly truncatedFragments: number;
  readonly denied: number;
  readonly unresolved: number;
  readonly omitted: number;
} {
  if (bundle === undefined) return { fragments: 0, truncatedFragments: 0, denied: 0, unresolved: 0, omitted: 0 };
  return {
    fragments: bundle.totals.fragments,
    truncatedFragments: bundle.totals.truncatedFragments,
    denied: bundle.denied.length,
    unresolved: bundle.unresolved.length,
    omitted: bundle.omitted.length,
  };
}

/**
 * One deterministic `--evaluate --json` line: field order is fixed (object
 * literal insertion order), and every per-test `ClassificationResult` is
 * embedded as-is (its own field order comes from `classifyEvaluation`) with
 * one added `evidence` provenance-counts field. `result.evaluation` is only
 * ever `undefined` here if a test harness injects `--evaluate` without also
 * providing an evaluation outcome — an honest, valid, all-zero report is
 * still produced rather than throwing.
 */
function evaluateJsonLine(result: AuditResult): string {
  const evaluation = result.evaluation;
  const bundles = bundlesByTestCaseId(result);
  const classifications = (evaluation?.classifications ?? []).map((classification: ClassificationResult) => ({
    ...classification,
    evidence: evidenceProvenance(bundles.get(classification.testCaseId)),
  }));
  return JSON.stringify({
    evaluate: true,
    reportingOnly: true,
    rootDir: result.rootDir,
    modelRequested: JEV_MODEL_ID,
    totals: evaluation?.totals ?? ZERO_EVALUATION_TOTALS,
    classifications,
    diagnostics: diagnosticsJson(result.diagnostics),
    // Phase 5, task P5-4: present only for `--resume <runId>` (never for an ordinary --evaluate
    // run), and only reaches here at all when there WAS outstanding work — the nothing-outstanding
    // case is reported separately by `runCli`, before this function is ever called.
    ...(result.resume === undefined ? {} : { resume: { runId: result.resume.runId, outstanding: result.resume.outstanding, reused: result.resume.reused } }),
  });
}

/** Concise human-readable `--evaluate` text report, one `writeLine` call (embedded newlines), mirroring `evaluateJsonLine`'s data. Includes a `Diagnostics` block (never just a bare failed count) so an `evaluation-failed` diagnostic stays visible without needing `--json`. */
function evaluateTextReport(result: AuditResult): string {
  const totals = result.evaluation?.totals ?? ZERO_EVALUATION_TOTALS;
  const { statusCounts, skipped } = totals;
  const diagnosticsLines = result.diagnostics.length === 0
    ? ['Diagnostics: none']
    : [
      'Diagnostics:',
      ...result.diagnostics.map((diagnostic) => {
        const location = diagnostic.repositoryRelativePath === undefined ? '' : ` (${diagnostic.repositoryRelativePath})`;
        return `  - ${diagnostic.code}${location}: ${diagnostic.message}`;
      }),
    ];
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
    ...diagnosticsLines,
    'Evidence for every evaluated test case was sent to TypeSafe; nothing else leaves this machine, and nothing is sent without --evaluate.',
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
}

function parseAuditOptions(args: readonly string[]): ParsedAuditOptions | { readonly error: string } | { readonly help: true } {
  const overrides: ConfigurationOverrides = {};
  let inspectPayloads = false;
  let dryRun = false;
  let evaluate = false;
  let fresh = false;
  let json = false;
  let resume: string | undefined;
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
    return { error: `Unknown option: ${argument ?? ''}` };
  }
  if (json && !dryRun && !evaluate) return { error: '--json requires --dry-run or --evaluate (audit --dry-run --json / audit --evaluate --json)' };
  if (dryRun && inspectPayloads) return { error: '--dry-run cannot be combined with --inspect-payloads' };
  if (dryRun && evaluate) return { error: '--dry-run cannot be combined with --evaluate' };
  if (evaluate && inspectPayloads) return { error: '--evaluate cannot be combined with --inspect-payloads' };
  if (fresh && !evaluate) return { error: '--fresh requires --evaluate (audit --evaluate --fresh)' };
  if (resume !== undefined && !evaluate) return { error: '--resume requires --evaluate (audit --evaluate --resume <runId>)' };
  return { overrides, inspectPayloads, dryRun, evaluate, fresh, json, ...(resume === undefined ? {} : { resume }) };
}

const NO_KEY_USAGE_MESSAGE = 'No TypeSafe API key is configured. Provide one with `jev-test-auditor auth login`, or set the TYPESAFE_API_KEY environment variable.';

/**
 * Resolves the API key `--evaluate` should use: `TYPESAFE_API_KEY` first
 * (checked without ever touching the stored file, so CI's env-only setup
 * never pays for or risks a stored-file read), else the locally stored
 * file. A storage-side problem (insecure permissions, corrupt file) is
 * itself reported as the usage error rather than silently treated as "no
 * key" — a stray unusable stored file is a real, actionable problem, not
 * nothing.
 */
async function resolveEvaluationApiKey(): Promise<{ readonly apiKey: string } | { readonly errorMessage: string }> {
  const environmentApiKey = process.env['TYPESAFE_API_KEY']?.trim() ?? '';
  if (environmentApiKey.length > 0) return { apiKey: environmentApiKey };

  const paths = resolveAuthStoragePaths();
  try {
    const stored = await readStoredCredentials(paths);
    const resolution = resolveApiKey({ environmentApiKey: undefined, stored });
    return resolution === undefined ? { errorMessage: NO_KEY_USAGE_MESSAGE } : { apiKey: resolution.apiKey };
  } catch (error) {
    if (error instanceof AuthInsecurePermissionsError || error instanceof AuthCorruptCredentialsError) {
      return { errorMessage: error.message };
    }
    throw error;
  }
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
    io.writeLine('Usage: jev-test-auditor auth <login|status|logout>');
    return 1;
  }
  if (subcommand === 'login') {
    if (args.length > 1) {
      io.writeLine(
        'auth login does not accept the API key as an argument (it would be saved in shell history and visible in '
        + 'the process list). Run `jev-test-auditor auth login` with no arguments and enter the key at the prompt, '
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

  try {
    let result: AuditResult;
    try {
      result = dependencies.audit === undefined
        ? await runAudit(
          configuration,
          createProductionPorts(evaluationPort, storePort, cacheKeyPort),
          { fresh: parsed.fresh, ...(parsed.resume === undefined ? {} : { resume: parsed.resume }) },
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
      const estimate = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, result.files);
      io.writeLine(parsed.json ? dryRunJsonLine(result.rootDir, estimate) : dryRunTextReport(result.rootDir, estimate));
      return 0;
    }

    if (parsed.evaluate) {
      io.writeLine(parsed.json ? evaluateJsonLine(result) : evaluateTextReport(result));
      return 0;
    }

    io.writeLine(summary(result));
    if (parsed.inspectPayloads) {
      for (const line of inspectPayloadLines(result)) io.writeLine(line);
    }
    return 0;
  } finally {
    if (storePort !== undefined) await storePort.close();
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
