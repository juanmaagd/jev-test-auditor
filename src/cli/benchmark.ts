#!/usr/bin/env node
/**
 * The explicit benchmark command (task P7-2, `odd/tasks/phase-7-benchmarks.md`).
 * Its own entry point, deliberately never imported by `src/cli/index.ts` (the
 * `audit` command) — `test/benchmark-cli-boundary.test.ts` proves this by
 * static import-graph closure: nothing reachable from `src/cli/index.ts`
 * ever reaches this file or `src/adapters/oracle-runner.ts`, while this
 * file's own closure does reach the runner (a positive control, so the
 * boundary test cannot pass merely because the runner does not exist).
 *
 * A reader tells the two commands apart by which one they ran:
 * `jev-test-auditor audit` never executes anything; `node dist/cli/benchmark.js`
 * (no shipped `bin` entry yet — see this task's own report) spawns real
 * vitest subprocesses against this repository's own Git-stored corpus.
 *
 * Deliberately minimal for P7-2: proves every corpus case under `--corpus`
 * (default `test/fixtures/corpus/discrimination`) and prints one line per
 * case plus a summary. No persistence (P7-3), no JSONL export or
 * per-dimension metrics (P7-4) — both out of this task's authorized scope.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCorpusFromDirectory } from '../adapters/corpus-store.js';
import { createOracleRunnerPort } from '../adapters/oracle-runner.js';
import { proveCorpus, type CaseProof } from '../application/benchmark.js';

export interface BenchmarkCliIo {
  writeLine(message: string): void;
}

interface ParsedBenchmarkOptions {
  readonly corpusDir: string;
  readonly timeoutMs?: number;
}

function parseBenchmarkOptions(args: readonly string[]): ParsedBenchmarkOptions | { readonly error: string } {
  let corpusDir = 'test/fixtures/corpus/discrimination';
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--corpus') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--corpus requires a path' };
      corpusDir = value;
      index += 1;
      continue;
    }
    if (argument === '--timeout-ms') {
      const value = args[index + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return { error: '--timeout-ms requires a positive number' };
      timeoutMs = parsed;
      index += 1;
      continue;
    }
    return { error: `Unknown option: ${argument}` };
  }
  return { corpusDir, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function reportLine(proof: CaseProof): string {
  if (proof.status.kind === 'proven') return `PROVEN    ${proof.caseId} (${proof.operator}, ${proof.oracleKind})`;
  return `UNPROVEN  ${proof.caseId} (${proof.operator}, ${proof.oracleKind}) — ${proof.status.reason}`;
}

/**
 * Runs the oracle proof battery over one corpus directory and prints a
 * report. This is the ONLY function in this repository's CLI surface that
 * ever reaches `src/adapters/oracle-runner.ts`.
 */
export async function runBenchmarkCli(args: readonly string[], io: BenchmarkCliIo): Promise<number> {
  const parsed = parseBenchmarkOptions(args);
  if ('error' in parsed) {
    io.writeLine(parsed.error);
    return 1;
  }

  const cases = await loadCorpusFromDirectory(parsed.corpusDir);
  const port = createOracleRunnerPort();
  const proofs = await proveCorpus(cases, { observe: port, ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }) });

  for (const proof of proofs) io.writeLine(reportLine(proof));

  const proven = proofs.filter((proof) => proof.status.kind === 'proven').length;
  io.writeLine(`${proven}/${proofs.length} case(s) proven.`);
  return proven === proofs.length ? 0 : 1;
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
