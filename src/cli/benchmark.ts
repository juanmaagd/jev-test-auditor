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
 *
 * **`--metrics <runId>[,<runId>...]` (task P7-4)** is a third, read-only
 * mode: loads one or more already-persisted runs from `--store` and prints
 * the per-dimension report (`src/domain/benchmark-metrics.ts`) — precision,
 * recall, false-positive rate, needs-review routing, probability
 * calibration, run-to-run stability, cost, and latency, one figure per
 * rubric dimension, counting only proven cases. Pass more than one run id to
 * pool their samples (tighter estimates) and to compute run-to-run
 * stability, which needs at least two runs of the same corpus to mean
 * anything. `--jsonl <path>` (also this task) may be combined with
 * `--metrics` to additionally export every loaded case outcome as
 * newline-delimited JSON, one record per line — mirroring how `--html`
 * gates writing a report file in `src/cli/index.ts`: nothing is written
 * without that explicit path.
 *
 * **`--store` mode's exit code (task P7-4 decision, closing the open
 * question P7-3's own report returned): `0` now requires every case to be
 * BOTH proven AND successfully sampled, not proof alone.** P7-3 disclosed a
 * real run where all 11 cases proved but every sample failed on a transient
 * provider `503`, and still exited `0` — a run that failed at its own stated
 * purpose (sampling Jev's verdict) reporting success. Bare (no-`--store`)
 * invocation is UNCHANGED: it never samples anything, so its exit code stays
 * proof-outcome-only, exactly as P7-2 shipped it.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCorpusFromDirectory } from '../adapters/corpus-store.js';
import { createOracleRunnerPort } from '../adapters/oracle-runner.js';
import { createBenchmarkSamplePort } from '../adapters/benchmark-sample-port.js';
import { checkBenchmarkJsonlPath, writeBenchmarkJsonl } from '../adapters/benchmark-jsonl-writer.js';
import { createJevHttpGateway } from '../adapters/jev-http-gateway.js';
import { createSqliteBenchmarkStore } from '../adapters/sqlite-benchmark-store.js';
import { proveCorpus, type CaseProof } from '../application/benchmark.js';
import { runBenchmarkPass, type BenchmarkSamplePort, type SampleResult } from '../application/benchmark-run.js';
import { compareBenchmarkRuns } from '../domain/benchmark-comparison.js';
import { computeBenchmarkMetricsReport, MIN_SAMPLE_FOR_RATE, OPERATOR_DIMENSION, type BenchmarkMetricsDimensionReport, type BenchmarkMetricsReport, type RateMetric, type SampledMetric } from '../domain/benchmark-metrics.js';
import type { BenchmarkCaseOutcome, BenchmarkStorePort } from '../domain/benchmark-store.js';
import { NO_KEY_USAGE_MESSAGE, resolveEvaluationApiKey } from './api-key.js';

export interface BenchmarkCliIo {
  writeLine(message: string): void;
}

type ParsedBenchmarkOptions =
  | { readonly mode: 'prove'; readonly corpusDir: string; readonly timeoutMs?: number; readonly store?: string }
  | { readonly mode: 'compare'; readonly store: string; readonly baseline: string; readonly candidate: string }
  | { readonly mode: 'metrics'; readonly store: string; readonly runIds: readonly string[]; readonly jsonl?: string };

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
  let metricsRunIds: readonly string[] | undefined;
  let jsonl: string | undefined;

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
    if (argument === '--metrics') {
      const result = requiresValue(args, index, '--metrics', 'one or more comma-separated run ids');
      if ('error' in result) return result;
      const runIds = result.value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (runIds.length === 0) return { error: '--metrics requires at least one run id' };
      metricsRunIds = runIds;
      index += 1;
      continue;
    }
    if (argument === '--jsonl') {
      const result = requiresValue(args, index, '--jsonl', 'a path');
      if ('error' in result) return result;
      jsonl = result.value;
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

  if (jsonl !== undefined && metricsRunIds === undefined) {
    return { error: '--jsonl requires --metrics <runId>[,<runId>...] (a comparison/prove run has no loaded run set to export; benchmark --store <path> --metrics <runId> --jsonl <path>)' };
  }

  if (metricsRunIds !== undefined) {
    if (store === undefined) return { error: '--metrics requires --store <path> naming which database to read the run(s) from' };
    if (corpusDirGiven || timeoutMs !== undefined || hasBaseline || hasCandidate) {
      return { error: '--metrics cannot be combined with --corpus, --timeout-ms, --baseline, or --candidate (it reads already-persisted runs; it proves and samples nothing new)' };
    }
    return { mode: 'metrics', store, runIds: metricsRunIds, ...(jsonl === undefined ? {} : { jsonl }) };
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
    // Task P7-4 decision (see this file's own doc): under --store, success requires every case to
    // be BOTH proven AND successfully sampled — a run that proves everything but samples nothing
    // (P7-3's own disclosed transient-503 run) must not exit 0.
    const sampled = pass.cases.filter((entry) => entry.sampleResult.kind === 'sampled').length;
    return proven === pass.cases.length && sampled === pass.cases.length ? 0 : 1;
  } finally {
    await store.close();
  }
}

function formatRate(metric: RateMetric): string {
  const fraction = `${metric.numerator}/${metric.denominator}`;
  if (metric.kind === 'not-computable') return `not computable (${metric.reason})`;
  if (metric.kind === 'below-minimum-sample') return `${fraction} (indicative only — below minimum sample of ${MIN_SAMPLE_FOR_RATE})`;
  return `${fraction} (${(metric.value! * 100).toFixed(1)}%)`;
}

/**
 * `counterNoun` names what `metric.sampleCount` actually counts — `'distinct case'` for
 * calibration (this fix's own collapse — see `src/domain/benchmark-metrics.ts`'s "Independent
 * samples" doc section), `'sample'` for cost/latency (deliberately still per-repetition). Printing
 * the noun alongside the count is what keeps a reader from mistaking one dimension's calibration
 * `n` for its cost/latency `n` — they now count different things.
 */
function formatSampled(metric: SampledMetric, unit: (value: number) => string, counterNoun: string): string {
  const countLabel = `n=${metric.sampleCount} ${counterNoun}${metric.sampleCount === 1 ? '' : 's'}`;
  if (metric.kind === 'not-computable') return `not computable (${metric.reason})`;
  if (metric.kind === 'below-minimum-sample') return `${unit(metric.value!)} (${countLabel}, indicative only — below minimum sample of ${MIN_SAMPLE_FOR_RATE})`;
  return `${unit(metric.value!)} (${countLabel})`;
}

function printDimensionReport(dimension: BenchmarkMetricsDimensionReport, io: BenchmarkCliIo): void {
  io.writeLine(`-- ${dimension.dimensionId} --`);
  if (dimension.provenCaseCount === 0) {
    io.writeLine('  no proven case in the corpus targets this dimension via its declared operator.');
  } else {
    // Distinct cases vs. samples, always printed together: precision/recall/false-positive-rate/
    // needs-review-routing/calibration below are computed over the FIRST number (distinct proven
    // cases, one observation per case via majority vote or mean — see this module's own
    // "Independent samples" doc section), never the second (raw repeated measurements).
    io.writeLine(`  proven cases designated to this dimension: ${dimension.provenCaseCount} distinct case(s), from ${dimension.designatedSampleCount} sample(s) across the given run(s)`);
  }
  io.writeLine(`  precision:            ${formatRate(dimension.precision)}`);
  io.writeLine(`  recall:               ${formatRate(dimension.recall)}`);
  io.writeLine(`  false-positive rate:  ${formatRate(dimension.falsePositiveRate)}`);
  io.writeLine(`  needs-review routing: ${formatRate(dimension.needsReviewRouting)}`);
  io.writeLine(`  calibration (Brier):  ${formatSampled(dimension.calibration, (value) => value.toFixed(4), 'distinct case')}`);
  io.writeLine(`  cost:                 ${formatSampled(dimension.cost, (value) => `$${value.toFixed(6)}`, 'sample')}`);
  io.writeLine(`  latency:              ${formatSampled(dimension.latency, (value) => `${value.toFixed(0)}ms`, 'sample')}`);
  io.writeLine(`  run-to-run stability: ${formatRate(dimension.stability)}`);
  if (dimension.splitVerdictCases.length > 0) {
    io.writeLine(`  split-verdict cases (repetitions disagreed with no majority — excluded, never guessed at): ${dimension.splitVerdictCases.length}`);
    for (const entry of dimension.splitVerdictCases) io.writeLine(`    ${entry.caseId}: ${entry.reasons.join('; ')}`);
  }
}

function printMetricsReport(report: BenchmarkMetricsReport, io: BenchmarkCliIo): void {
  io.writeLine(`${report.runsConsidered} run(s) considered; ${report.provenCaseCount} distinct proven case(s).`);
  if (report.unprovenCases.length > 0) {
    io.writeLine(`Unproven (excluded from every metric): ${report.unprovenCases.length}`);
    for (const entry of report.unprovenCases) io.writeLine(`  ${entry.caseId}: ${entry.reasons.join('; ')}`);
  }
  if (report.notSampledCases.length > 0) {
    io.writeLine(`Proven but not sampled (excluded from every metric): ${report.notSampledCases.length}`);
    for (const entry of report.notSampledCases) io.writeLine(`  ${entry.caseId}: ${entry.reasons.join('; ')}`);
  }
  for (const dimension of report.dimensions) printDimensionReport(dimension, io);
}

async function runMetrics(
  parsed: Extract<ParsedBenchmarkOptions, { readonly mode: 'metrics' }>,
  io: BenchmarkCliIo,
  dependencies: BenchmarkCliDependencies,
): Promise<number> {
  if (parsed.jsonl !== undefined) {
    const problem = await checkBenchmarkJsonlPath(parsed.jsonl);
    if (problem !== undefined) {
      io.writeLine(`--jsonl ${parsed.jsonl}: ${problem.message}`);
      return 1;
    }
  }

  const store = await (dependencies.createStorePort?.(parsed.store) ?? createSqliteBenchmarkStore({ databaseFile: parsed.store }));
  try {
    const runs: { readonly runId: string; readonly outcomes: readonly BenchmarkCaseOutcome[] }[] = [];
    for (const runId of parsed.runIds) {
      const outcomes = await store.loadRun(runId);
      if (outcomes === undefined) {
        io.writeLine(`No run recorded under id "${runId}" (--metrics) in ${parsed.store}.`);
        return 1;
      }
      runs.push({ runId, outcomes });
    }

    const report = computeBenchmarkMetricsReport(runs);
    printMetricsReport(report, io);

    if (parsed.jsonl !== undefined) {
      const records = runs.flatMap(({ runId, outcomes }) => outcomes.map((outcome) => ({ runId, dimension: OPERATOR_DIMENSION[outcome.operator], ...outcome })));
      const result = await writeBenchmarkJsonl(parsed.jsonl, records);
      if (!result.written) {
        io.writeLine(`Failed to write --jsonl ${parsed.jsonl}: ${result.message}`);
        return 1;
      }
      io.writeLine(`Exported ${result.recordCount} record(s) to ${parsed.jsonl}.`);
    }

    return 0;
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
  if (parsed.mode === 'metrics') return runMetrics(parsed, io, dependencies);
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
