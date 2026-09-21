#!/usr/bin/env node
/**
 * The explicit benchmark command (tasks P7-2 and P7-3,
 * `odd/tasks/phase-7-benchmarks.md`). Its own entry point, deliberately
 * never imported by `src/cli/index.ts` (the `audit` command) —
 * `test/benchmark-cli-boundary.test.ts` proves this by static import-graph
 * closure: nothing reachable from `src/cli/index.ts` ever reaches this file,
 * `src/adapters/oracle-runner.ts`, `src/adapters/sqlite-audit-store.ts`, or
 * `src/adapters/cache-key.ts`, while this file's own closure does reach the
 * oracle runner (a positive control, so the boundary test cannot pass merely
 * because the runner does not exist).
 *
 * A reader tells the two commands apart by which one they ran:
 * `jev-test-auditor audit` never executes anything; `node dist/cli/benchmark.js`
 * (no shipped `bin` entry yet — see task P7-2's own report) spawns real
 * vitest subprocesses against this repository's own Git-stored corpus, and,
 * with `--store`, also samples Jev's real verdict for each case.
 *
 * **Bare invocation is unchanged from task P7-2**: `node dist/cli/benchmark.js`
 * (no flags) proves every corpus case and prints a report — no sampling, no
 * network, no API key, no file written. `--store <path>` (this task, P7-3)
 * is the sole gate for BOTH sampling Jev's verdict and persisting a run —
 * mirroring how `--html` gates writing a report file in `src/cli/index.ts`:
 * nothing here writes, or calls the provider, without that explicit path.
 * `--baseline <runId> --candidate <runId>` (also this task) is a second,
 * read-only mode: compares two already-persisted runs from `--store` and
 * never proves or samples anything new.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCorpusFromDirectory } from '../adapters/corpus-store.js';
import { createOracleRunnerPort } from '../adapters/oracle-runner.js';
import { createBenchmarkSamplePort } from '../adapters/benchmark-sample-port.js';
import { createJevHttpGateway } from '../adapters/jev-http-gateway.js';
import { createSqliteBenchmarkStore } from '../adapters/sqlite-benchmark-store.js';
import { proveCorpus, type CaseProof } from '../application/benchmark.js';
import { runBenchmarkPass, type BenchmarkSamplePort, type SampleResult } from '../application/benchmark-run.js';
import { compareBenchmarkRuns } from '../domain/benchmark-comparison.js';
import type { BenchmarkStorePort } from '../domain/benchmark-store.js';
import { NO_KEY_USAGE_MESSAGE, resolveEvaluationApiKey } from './api-key.js';

export interface BenchmarkCliIo {
  writeLine(message: string): void;
}

type ParsedBenchmarkOptions =
  | { readonly mode: 'prove'; readonly corpusDir: string; readonly timeoutMs?: number; readonly store?: string }
  | { readonly mode: 'compare'; readonly store: string; readonly baseline: string; readonly candidate: string };

function requiresValue(args: readonly string[], index: number, flag: string, what: string): { readonly value: string } | { readonly error: string } {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return { error: `${flag} requires ${what}` };
  return { value };
}

function parseBenchmarkOptions(args: readonly string[]): ParsedBenchmarkOptions | { readonly error: string } {
  let corpusDir = 'test/fixtures/corpus/discrimination';
  let corpusDirGiven = false;
  let timeoutMs: number | undefined;
  let store: string | undefined;
  let baseline: string | undefined;
  let candidate: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--corpus') {
      const result = requiresValue(args, index, '--corpus', 'a path');
      if ('error' in result) return result;
      corpusDir = result.value;
      corpusDirGiven = true;
      index += 1;
      continue;
    }
    if (argument === '--timeout-ms') {
      const value = args[index + 1];
      const parsedNumber = value === undefined ? Number.NaN : Number(value);
      if (!Number.isFinite(parsedNumber) || parsedNumber <= 0) return { error: '--timeout-ms requires a positive number' };
      timeoutMs = parsedNumber;
      index += 1;
      continue;
    }
    if (argument === '--store') {
      const result = requiresValue(args, index, '--store', 'a path');
      if ('error' in result) return result;
      store = result.value;
      index += 1;
      continue;
    }
    if (argument === '--baseline') {
      const result = requiresValue(args, index, '--baseline', 'a run id');
      if ('error' in result) return result;
      baseline = result.value;
      index += 1;
      continue;
    }
    if (argument === '--candidate') {
      const result = requiresValue(args, index, '--candidate', 'a run id');
      if ('error' in result) return result;
      candidate = result.value;
      index += 1;
      continue;
    }
    return { error: `Unknown option: ${argument}` };
  }

  const hasBaseline = baseline !== undefined;
  const hasCandidate = candidate !== undefined;
  if (hasBaseline !== hasCandidate) {
    return { error: '--baseline and --candidate must be given together (benchmark --store <path> --baseline <runId> --candidate <runId>)' };
  }
  if (hasBaseline && hasCandidate) {
    if (store === undefined) return { error: '--baseline/--candidate require --store <path> naming which database to read the two runs from' };
    if (corpusDirGiven || timeoutMs !== undefined) {
      return { error: '--baseline/--candidate cannot be combined with --corpus or --timeout-ms (a comparison reads two already-persisted runs; it proves and samples nothing new)' };
    }
    return { mode: 'compare', store, baseline: baseline!, candidate: candidate! };
  }

  return { mode: 'prove', corpusDir, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(store === undefined ? {} : { store }) };
}

function reportLine(proof: CaseProof): string {
  if (proof.status.kind === 'proven') return `PROVEN    ${proof.caseId} (${proof.operator}, ${proof.oracleKind})`;
  return `UNPROVEN  ${proof.caseId} (${proof.operator}, ${proof.oracleKind}) — ${proof.status.reason}`;
}

function sampleLine(caseId: string, sampleResult: SampleResult): string {
  if (sampleResult.kind === 'sampled') return `SAMPLED   ${caseId}: ${sampleResult.classification.status}`;
  return `SAMPLE-FAILED ${caseId}: ${sampleResult.errorKind} — ${sampleResult.errorMessage}`;
}

export interface BenchmarkCliDependencies {
  /**
   * Test seam only (mirrors `src/cli/index.ts`'s own `CliDependencies.createEvaluationPort`):
   * overrides how the `--store` sampling port is constructed, so a test never needs a real API key
   * or network access. Production always uses the default: resolve an API key
   * (`resolveEvaluationApiKey`), then `createBenchmarkSamplePort(corpusDir, createJevHttpGateway({ apiKey }))`.
   */
  readonly createSamplePort?: (corpusDir: string) => BenchmarkSamplePort | Promise<BenchmarkSamplePort>;
  /** Test seam only: overrides how the `--store` benchmark database is opened. Production always uses `createSqliteBenchmarkStore({ databaseFile })`. */
  readonly createStorePort?: (databaseFile: string) => BenchmarkStorePort | Promise<BenchmarkStorePort>;
  /** Test seam only: overrides `resolveEvaluationApiKey`. */
  readonly resolveApiKey?: () => Promise<{ readonly apiKey: string } | { readonly errorMessage: string }>;
}

async function runCompare(
  parsed: Extract<ParsedBenchmarkOptions, { readonly mode: 'compare' }>,
  io: BenchmarkCliIo,
  dependencies: BenchmarkCliDependencies,
): Promise<number> {
  const store = await (dependencies.createStorePort?.(parsed.store) ?? createSqliteBenchmarkStore({ databaseFile: parsed.store }));
  try {
    const baselineOutcomes = await store.loadRun(parsed.baseline);
    if (baselineOutcomes === undefined) {
      io.writeLine(`No run recorded under id "${parsed.baseline}" (--baseline) in ${parsed.store}.`);
      return 1;
    }
    const candidateOutcomes = await store.loadRun(parsed.candidate);
    if (candidateOutcomes === undefined) {
      io.writeLine(`No run recorded under id "${parsed.candidate}" (--candidate) in ${parsed.store}.`);
      return 1;
    }

    const result = compareBenchmarkRuns(baselineOutcomes, candidateOutcomes);
    if (result.kind === 'refused') {
      io.writeLine(`Comparison refused (${result.reason}): ${result.detail}`);
      return 1;
    }

    io.writeLine(`Baseline ${parsed.baseline}: policy v${result.baselineVersions.policyVersion}, rubric v${result.baselineVersions.rubricVersion}, model ${result.baselineModel}`);
    io.writeLine(`Candidate ${parsed.candidate}: policy v${result.candidateVersions.policyVersion}, rubric v${result.candidateVersions.rubricVersion}, model ${result.candidateModel}`);
    if (result.modelMismatch) io.writeLine('Model mismatch between baseline and candidate runs (labelled, not refused — see docs/technical-design.md).');
    io.writeLine(`Agreements: ${result.agreements.length}`);
    io.writeLine(`Disagreements: ${result.disagreements.length}`);
    for (const entry of result.disagreements) io.writeLine(`  ${entry.caseId}: ${entry.baselineStatus} -> ${entry.candidateStatus}`);
    io.writeLine(`Regressions: ${result.regressions.length}`);
    for (const entry of result.regressions) io.writeLine(`  ${entry.caseId}: ${entry.baselineStatus} -> ${entry.candidateStatus}`);
    io.writeLine(`Excluded: ${result.excluded.length}`);
    for (const entry of result.excluded) io.writeLine(`  ${entry.caseId}: ${entry.reason}`);
    return 0;
  } finally {
    await store.close();
  }
}

async function runProve(
  parsed: Extract<ParsedBenchmarkOptions, { readonly mode: 'prove' }>,
  io: BenchmarkCliIo,
  dependencies: BenchmarkCliDependencies,
): Promise<number> {
  const cases = await loadCorpusFromDirectory(parsed.corpusDir);
  const observePort = createOracleRunnerPort();

  if (parsed.store === undefined) {
    // Unchanged from task P7-2: no sampling, no store, no network, no file written.
    const proofs = await proveCorpus(cases, { observe: observePort, ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }) });
    for (const proof of proofs) io.writeLine(reportLine(proof));
    const proven = proofs.filter((proof) => proof.status.kind === 'proven').length;
    io.writeLine(`${proven}/${proofs.length} case(s) proven.`);
    return proven === proofs.length ? 0 : 1;
  }

  // Fail fast: resolve the API key BEFORE constructing anything that could spend money or write a
  // file, exactly like `audit --evaluate` (`src/cli/index.ts`) never opens its store on a failed
  // key resolution either.
  const resolveApiKey = dependencies.resolveApiKey ?? resolveEvaluationApiKey;
  const samplePortOverride = dependencies.createSamplePort;
  let samplePort: BenchmarkSamplePort;
  if (samplePortOverride !== undefined) {
    samplePort = await samplePortOverride(parsed.corpusDir);
  } else {
    const keyResolution = await resolveApiKey();
    if ('errorMessage' in keyResolution) {
      io.writeLine(keyResolution.errorMessage);
      return 1;
    }
    samplePort = createBenchmarkSamplePort(parsed.corpusDir, createJevHttpGateway({ apiKey: keyResolution.apiKey }));
  }

  const store = await (dependencies.createStorePort?.(parsed.store) ?? createSqliteBenchmarkStore({ databaseFile: parsed.store }));
  try {
    const pass = await runBenchmarkPass(cases, parsed.corpusDir, {
      observe: observePort,
      sample: samplePort,
      store,
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    });

    for (const entry of pass.cases) {
      io.writeLine(reportLine(entry.proof));
      io.writeLine(sampleLine(entry.proof.caseId, entry.sampleResult));
    }
    const proven = pass.cases.filter((entry) => entry.proof.status.kind === 'proven').length;
    io.writeLine(`${proven}/${pass.cases.length} case(s) proven.`);
    if (pass.runId !== undefined) io.writeLine(`Run ${pass.runId} persisted to ${parsed.store}.`);
    return proven === pass.cases.length ? 0 : 1;
  } finally {
    await store.close();
  }
}

/**
 * Runs the oracle proof battery (and, with `--store`, Jev sampling and
 * persistence) over one corpus directory, or compares two previously
 * persisted runs (`--baseline`/`--candidate`). This is the ONLY function in
 * this repository's CLI surface that ever reaches
 * `src/adapters/oracle-runner.ts` or `src/adapters/benchmark-sample-port.ts`.
 */
export async function runBenchmarkCli(
  args: readonly string[],
  io: BenchmarkCliIo,
  dependencies: BenchmarkCliDependencies = {},
): Promise<number> {
  const parsed = parseBenchmarkOptions(args);
  if ('error' in parsed) {
    io.writeLine(parsed.error);
    return 1;
  }
  if (parsed.mode === 'compare') return runCompare(parsed, io, dependencies);
  return runProve(parsed, io, dependencies);
}

/**
 * Compares real, symlink-resolved filesystem paths rather than the raw
 * strings — mirrors `src/cli/index.ts`'s own `isInvokedAsPackageEntry`
 * exactly, for the same reason: `import.meta.url` is percent-encoded and
 * `process.argv[1]` is not, so a plain string/URL comparison silently never
 * matches for any install path containing a space.
 */
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
  void runBenchmarkCli(process.argv.slice(2), { writeLine: (message) => { process.stdout.write(`${message}\n`); } }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

// Re-exported so a caller importing only this module can still name the shared usage message
// (kept identical to `audit --evaluate`'s own — see `./api-key.js`).
export { NO_KEY_USAGE_MESSAGE };
