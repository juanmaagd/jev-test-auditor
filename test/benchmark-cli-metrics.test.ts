import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBenchmarkCli } from '../src/cli/benchmark.js';
import type { BenchmarkSamplePort, SampleResult } from '../src/application/benchmark-run.js';
import type { ClassificationResult, DimensionJudgment } from '../src/domain/classification.js';
import type { CorpusCase } from '../src/domain/corpus.js';
import { RUBRIC_DIMENSION_IDS } from '../src/domain/rubric.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

class RecordingIo {
  readonly lines: string[] = [];
  writeLine(message: string): void {
    this.lines.push(message);
  }
}

const REAL_CORPUS_DIR = 'test/fixtures/corpus/discrimination';

let storeFile: string;
let jsonlPath: string;
let workDir: string;

/**
 * Every one of the seven rubric dimensions judged `acceptable` with a validated `deficientMass` —
 * not the earlier empty `dimensions: []` — so this fixture's own calibration figures actually
 * compute (below-minimum-sample, never not-computable) at the CLI level too, letting
 * `test/benchmark-cli-metrics.test.ts`'s own assertions on `formatSampled`'s "distinct case(s)"
 * vs. "sample(s)" labels (the independent-samples fix) exercise a real, non-degenerate value.
 */
function allDimensionJudgments(): readonly DimensionJudgment[] {
  return RUBRIC_DIMENSION_IDS.map((dimensionId) => ({
    dimensionId,
    dimensionLabel: dimensionId,
    applicable: true,
    applicabilityProbability: 0.9,
    level: 'acceptable',
    score: 2,
    confidence: 0.9,
    status: 'judged',
    reason: undefined,
    probabilities: undefined,
    deficientMass: 0.1,
    acceptableMass: 0.9,
    criticalMass: 0.05,
  }));
}

function classification(caseId: string, status: ClassificationResult['status']): ClassificationResult {
  return {
    testCaseId: `tc:${caseId}` as TestCaseId,
    repositoryRelativePath: 'test.ts',
    name: caseId,
    status,
    dimensions: allDimensionJudgments(),
    findings: [],
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 9, outputTokens: 4 },
  };
}

function fakeSamplePort(status: ClassificationResult['status'] = 'healthy'): BenchmarkSamplePort {
  return {
    async sample(corpusCase: CorpusCase): Promise<SampleResult> {
      return { kind: 'sampled', classification: classification(corpusCase.id, status), usage: { inputTokens: 9, outputTokens: 4 } };
    },
  };
}

function alwaysFailingSamplePort(): BenchmarkSamplePort {
  return {
    async sample(): Promise<SampleResult> {
      return { kind: 'failed', errorKind: 'evaluation-failed', errorMessage: 'provider unreachable' };
    },
  };
}

async function runProveAndExtractRunId(io: RecordingIo, samplePort: BenchmarkSamplePort): Promise<string> {
  const exitCode = await runBenchmarkCli(['--corpus', REAL_CORPUS_DIR, '--store', storeFile], io, {
    createSamplePort: () => samplePort,
  });
  expect(exitCode).toBe(0);
  const runIdLine = io.lines.find((line) => line.includes('persisted'))!;
  const runId = /Run ([^ ]+) persisted/.exec(runIdLine)?.[1];
  expect(runId).toBeDefined();
  return runId!;
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'jev-benchmark-cli-metrics-'));
  storeFile = join(workDir, 'benchmark-store.sqlite3');
  jsonlPath = join(workDir, 'export.jsonl');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('runBenchmarkCli --metrics: usage errors', () => {
  it('reports a usage error when --metrics is missing its value', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--metrics'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/--metrics requires/);
  });

  it('reports a usage error when --metrics is given without --store', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--metrics', 'run-1'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/--metrics.*--store/i);
  });

  it('reports a usage error when --metrics is combined with --corpus', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--metrics', 'run-1', '--corpus', REAL_CORPUS_DIR], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/--metrics/);
  });

  it('reports a usage error when --metrics is combined with --baseline/--candidate', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--metrics', 'run-1', '--baseline', 'run-1', '--candidate', 'run-2'], io);
    expect(exitCode).toBe(1);
  });

  it('reports a usage error when --jsonl is given without --metrics', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--jsonl', jsonlPath], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/--jsonl.*--metrics/i);
  });

  it('reports which run id is missing when a named run was never recorded', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--metrics', 'no-such-run'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/no-such-run/);
  });
});

describe('runBenchmarkCli --metrics: real per-dimension report over the real corpus', () => {
  it('reports every rubric dimension, including one that is structurally always empty', async () => {
    const io = new RecordingIo();
    const runId = await runProveAndExtractRunId(io, fakeSamplePort('healthy'));

    const metricsIo = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--metrics', runId], metricsIo);

    expect(exitCode).toBe(0);
    const output = metricsIo.lines.join('\n');
    for (const dimensionId of [
      'assertion-strength', 'behavioral-focus', 'determinism-isolation', 'diagnostic-quality',
      'falsifiability', 'refactor-resistance', 'test-double-quality',
    ]) {
      expect(output).toContain(dimensionId);
    }
    // behavioral-focus has no operator mapped to it at all — must read plainly, never as a zero rate.
    expect(output).toMatch(/behavioral-focus[\s\S]*?no proven case|behavioral-focus[\s\S]*?not computable/i);
    // Independent-samples fix: the CLI must print BOTH the distinct-case count and the underlying
    // sample count together (never only one), and must label calibration's `n` as distinct cases
    // versus cost/latency's samples — so a reader can never confuse the two counts.
    expect(output).toMatch(/\d+ distinct case\(s\), from \d+ sample\(s\)/);
    expect(output).toMatch(/n=\d+ distinct cases?\b/);
    expect(output).toMatch(/n=\d+ samples?\b/);
  }, 60_000);

  it('exports one JSONL line per recorded case outcome when --jsonl is given, and nothing without it', async () => {
    const io = new RecordingIo();
    const runId = await runProveAndExtractRunId(io, fakeSamplePort('healthy'));

    const metricsIo = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--metrics', runId, '--jsonl', jsonlPath], metricsIo);
    expect(exitCode).toBe(0);

    const contents = await readFile(jsonlPath, 'utf8');
    const lines = contents.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(14);
    const validDimensionIds = new Set([
      'assertion-strength', 'behavioral-focus', 'determinism-isolation', 'diagnostic-quality',
      'falsifiability', 'refactor-resistance', 'test-double-quality',
    ]);
    for (const line of lines) {
      const record = JSON.parse(line) as { readonly runId: string; readonly caseId: string; readonly dimension: string; readonly operator: string };
      expect(record.runId).toBe(runId);
      expect(typeof record.caseId).toBe('string');
      // `dimension` must be the RUBRIC dimension this case's operator maps to, never the raw
      // operator id itself (a real, caught-before-reporting bug: they are disjoint vocabularies).
      expect(validDimensionIds.has(record.dimension)).toBe(true);
      expect(record.dimension).not.toBe(record.operator);
    }
  }, 60_000);

  it('pools two runs when given comma-separated run ids', async () => {
    const io1 = new RecordingIo();
    const runIdOne = await runProveAndExtractRunId(io1, fakeSamplePort('healthy'));
    const io2 = new RecordingIo();
    const runIdTwo = await runProveAndExtractRunId(io2, fakeSamplePort('healthy'));

    const metricsIo = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--metrics', `${runIdOne},${runIdTwo}`], metricsIo);
    expect(exitCode).toBe(0);
    expect(metricsIo.lines.join('\n')).toMatch(/2 run/i);
  }, 90_000);
});

describe('runBenchmarkCli --store: exit code reflects sampling, not proof alone (closes the P7-3 open question)', () => {
  it('exits 1 when every case proves but every sample fails', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--corpus', REAL_CORPUS_DIR, '--store', storeFile], io, {
      createSamplePort: () => alwaysFailingSamplePort(),
    });

    expect(io.lines).toContain('14/14 case(s) proven.');
    expect(exitCode).toBe(1);
  }, 60_000);

  it('still exits 0 when every case proves and every sample succeeds', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--corpus', REAL_CORPUS_DIR, '--store', storeFile], io, {
      createSamplePort: () => fakeSamplePort('healthy'),
    });

    expect(io.lines).toContain('14/14 case(s) proven.');
    expect(exitCode).toBe(0);
  }, 60_000);
});
