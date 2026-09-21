/**
 * Writes benchmark data as newline-delimited JSON (JSONL) to an explicit,
 * user-named path (task P7-4, `odd/tasks/phase-7-benchmarks.md`) — one JSON
 * object per line, so every record is independently parseable without
 * reading the whole file.
 *
 * Deliberately mirrors `src/adapters/html-report-writer.ts`'s own contract
 * (same `is-directory`/`parent-missing`/`write-error` failure vocabulary,
 * same silent-overwrite-of-a-regular-file convention, same "preflight before
 * doing the expensive work, re-check at write time" split) — this task's own
 * instruction is to gate JSONL export "mirroring how `--html` is gated," and
 * that mirror extends to how the file itself gets written, not only how the
 * CLI flag is parsed (`src/cli/benchmark.ts`).
 */
import { stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type BenchmarkJsonlPathProblemReason = 'is-directory' | 'parent-missing';

export interface BenchmarkJsonlPathProblem {
  readonly reason: BenchmarkJsonlPathProblemReason;
  readonly message: string;
}

export type BenchmarkJsonlWriteFailureReason = BenchmarkJsonlPathProblemReason | 'write-error';

export interface BenchmarkJsonlWriteSuccess {
  readonly written: true;
  readonly overwrote: boolean;
  readonly recordCount: number;
}

export interface BenchmarkJsonlWriteFailure {
  readonly written: false;
  readonly reason: BenchmarkJsonlWriteFailureReason;
  readonly message: string;
}

export type BenchmarkJsonlWriteResult = BenchmarkJsonlWriteSuccess | BenchmarkJsonlWriteFailure;

/** Read-only preflight — see `checkHtmlReportPath`'s own doc for why this exists separately from the write itself. */
export async function checkBenchmarkJsonlPath(path: string): Promise<BenchmarkJsonlPathProblem | undefined> {
  const targetStats = await stat(path).catch(() => undefined);
  if (targetStats?.isDirectory() === true) {
    return { reason: 'is-directory', message: `${path} is a directory.` };
  }

  const parent = dirname(path);
  const parentStats = await stat(parent).catch(() => undefined);
  if (parentStats === undefined || !parentStats.isDirectory()) {
    return { reason: 'parent-missing', message: `parent directory ${parent} does not exist.` };
  }

  return undefined;
}

/**
 * Writes one JSON line per entry in `records`, in order, overwriting an
 * existing regular file at `path` (see `writeHtmlReport`'s own doc for why).
 * Zero records still writes an empty file, never silently skipping the
 * write — `--jsonl <path>` asked for a file at this exact path.
 */
export async function writeBenchmarkJsonl(path: string, records: readonly unknown[]): Promise<BenchmarkJsonlWriteResult> {
  const problem = await checkBenchmarkJsonlPath(path);
  if (problem !== undefined) return { written: false, ...problem };

  const existedBefore = await stat(path).then((stats) => stats.isFile(), () => false);

  const contents = records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  try {
    await writeFile(path, contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { written: false, reason: 'write-error', message };
  }

  return { written: true, overwrote: existedBefore, recordCount: records.length };
}
