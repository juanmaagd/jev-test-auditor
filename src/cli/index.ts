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
                      shape, and no network call is made either way.
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

interface ParsedAuditOptions {
  readonly overrides: ConfigurationOverrides;
  readonly inspectPayloads: boolean;
}

function parseAuditOptions(args: readonly string[]): ParsedAuditOptions | { readonly error: string } | { readonly help: true } {
  const overrides: ConfigurationOverrides = {};
  let inspectPayloads = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') return { help: true };
    if (argument === '--inspect-payloads') {
      inspectPayloads = true;
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
  return { overrides, inspectPayloads };
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
