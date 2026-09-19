#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getResolvedConfiguration } from '../application/configure.js';
import { runAudit } from '../application/audit.js';
import { discoverTestFiles } from '../adapters/repository-discovery.js';
import { readSourceFile } from '../adapters/source-reader.js';
import { extractTestCases } from '../adapters/test-extraction.js';
import { createAuditEvidencePort } from '../adapters/evidence-audit-port.js';
import { canonicalizeEvidenceBundle } from '../domain/evidence.js';
import { estimateDryRun, JEV_ESTIMATE_SNAPSHOT, type DryRunEstimate } from '../domain/estimate.js';
import type { AuditPorts, AuditRequest, AuditResult } from '../domain/audit.js';
import type { ConfigurationOverrides } from '../domain/config.js';

export interface CliIo {
  writeLine(message: string): void;
}

export interface CliDependencies {
  readonly audit?: (request: AuditRequest) => Promise<AuditResult>;
}

const HELP = `jev-test-auditor — inspect semantic test quality

Usage:
  jev-test-auditor audit [options]
  jev-test-auditor --help

Commands:
  audit       Discover and extract test understanding without executing project code

Options:
  --rootDir <path>   Audit a configured repository root
  --inspect-payloads Also print each test case's local evidence bundle, one JSON line per bundle,
                      after the summary line. This is the local evidence state selected on disk
                      (fragments, provenance, denials, truncation) — not the Jev wire request
                      shape, and no network call is made either way. Cannot be combined with
                      --dry-run.
  --dry-run          Print a no-network, no-write aggregate cost/call preview instead of the normal
                      summary: exact discovered/evaluable/skipped-by-reason counts, exact initial
                      Jev calls (one per evaluable test case) and evidence bytes, and clearly
                      labeled approximate input-token and USD ranges from a versioned local
                      pricing/overhead snapshot. Makes no network or provider calls, requires no
                      API key, and writes nothing to disk. Cannot be combined with
                      --inspect-payloads.
  --dry-run --json   Print the same dry-run preview as one machine-readable JSON line instead of
                      the human-readable text report. Requires --dry-run; --json alone is a usage
                      error.
  --help             Show this help message
`;

/**
 * Fresh per invocation (never a module-level singleton): `createAuditEvidencePort`
 * builds one memoizing source-read cache for the port it returns, and that cache
 * must live for exactly one audit run — reusing it across runs (e.g. repeated
 * `runCli` calls against different roots within the same process, as tests do)
 * would let content read for an earlier run leak into a later one.
 */
function createProductionPorts(): AuditPorts {
  return {
    discovery: { discover: discoverTestFiles },
    sourceReader: { read: readSourceFile },
    extractor: { extract: extractTestCases },
    evidence: createAuditEvidencePort(),
  };
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
    diagnostics: result.diagnostics.map((diagnostic) => ({
      ...(diagnostic.repositoryRelativePath === undefined ? {} : { path: diagnostic.repositoryRelativePath }),
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
    })),
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
    `Estimated input tokens (approximate): ${estimate.estimatedInputTokens.min} - ${estimate.estimatedInputTokens.max}`,
    `Estimated follow-up input tokens (approximate): ${estimate.estimatedFollowUpInputTokens.min} - ${estimate.estimatedFollowUpInputTokens.max}`,
    `Estimated cost in USD (approximate): ${estimate.estimatedUsd.min} - ${estimate.estimatedUsd.max}`,
    `Bundles over the ${estimate.requestTokenCeiling}-token request ceiling: ${estimate.bundlesOverCeiling}`,
    'No network calls were made; nothing was written to disk.',
  ].join('\n');
}

interface ParsedAuditOptions {
  readonly overrides: ConfigurationOverrides;
  readonly inspectPayloads: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
}

function parseAuditOptions(args: readonly string[]): ParsedAuditOptions | { readonly error: string } | { readonly help: true } {
  const overrides: ConfigurationOverrides = {};
  let inspectPayloads = false;
  let dryRun = false;
  let json = false;
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
    return { error: `Unknown option: ${argument ?? ''}` };
  }
  if (json && !dryRun) return { error: '--json requires --dry-run (audit --dry-run --json)' };
  if (dryRun && inspectPayloads) return { error: '--dry-run cannot be combined with --inspect-payloads' };
  return { overrides, inspectPayloads, dryRun, json };
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
  const result = dependencies.audit === undefined
    ? await runAudit(configuration, createProductionPorts())
    : await dependencies.audit(configuration);

  if (parsed.dryRun) {
    const estimate = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, result.files);
    io.writeLine(parsed.json ? dryRunJsonLine(result.rootDir, estimate) : dryRunTextReport(result.rootDir, estimate));
    return 0;
  }

  io.writeLine(summary(result));
  if (parsed.inspectPayloads) {
    for (const line of inspectPayloadLines(result)) io.writeLine(line);
  }
  return 0;
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
