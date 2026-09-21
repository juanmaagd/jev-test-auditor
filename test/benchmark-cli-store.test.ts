import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBenchmarkCli } from '../src/cli/benchmark.js';
import { createSqliteAuditStore, resolveAuditStorePaths } from '../src/adapters/sqlite-audit-store.js';
import { createSqliteBenchmarkStore } from '../src/adapters/sqlite-benchmark-store.js';
import type { BenchmarkSamplePort, SampleResult } from '../src/application/benchmark-run.js';
import type { ClassificationResult } from '../src/domain/classification.js';
import type { CorpusCase } from '../src/domain/corpus.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

class RecordingIo {
  readonly lines: string[] = [];
  writeLine(message: string): void {
    this.lines.push(message);
  }
}

let corpusRoot: string;
let storeFile: string;

function classification(caseId: string, status: ClassificationResult['status']): ClassificationResult {
  return {
    testCaseId: `tc:${caseId}` as TestCaseId,
    repositoryRelativePath: 'test.ts',
    name: caseId,
    status,
    dimensions: [],
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

/** Writes one synthetic, deliberately-unrealizable corpus case (no registered oracle recipe — see `test/benchmark-cli.test.ts`'s own identical fixture) so proving is instant and free, leaving sampling as the only thing this suite needs to fake. */
async function writeSyntheticCase(caseId: string): Promise<void> {
  const caseDir = join(corpusRoot, caseId);
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(caseDir, 'case.json'), JSON.stringify({
    id: caseId,
    operators: ['remove-assertion'],
    operatorRole: 'descriptive',
    oracleKind: 'production-mutation',
    testEffect: 'irrelevant for this CLI-level test',
    productionEffect: 'irrelevant for this CLI-level test',
    expectedOutcome: 'expected-to-keep-passing',
    testFile: 'test.ts',
    productionFiles: ['lib.ts'],
  }), 'utf8');
  await writeFile(join(caseDir, 'test.ts'), "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });\n", 'utf8');
  await writeFile(join(caseDir, 'lib.ts'), 'export const unused = 1;\n', 'utf8');
}

beforeEach(async () => {
  corpusRoot = await mkdtemp(join(tmpdir(), 'jev-benchmark-cli-store-corpus-'));
  const storeRoot = await mkdtemp(join(tmpdir(), 'jev-benchmark-cli-store-db-'));
  storeFile = join(storeRoot, 'benchmark-store.sqlite3');
});

afterEach(async () => {
  await rm(corpusRoot, { recursive: true, force: true });
});

describe('runBenchmarkCli --store', () => {
  it('reports a usage error when --store is missing its value', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/--store requires a path/);
  });

  it('proves and samples every case, then persists a run under --store, using the injected sample port (no network, no API key needed)', async () => {
    await writeSyntheticCase('alpha');
    const io = new RecordingIo();

    const exitCode = await runBenchmarkCli(['--corpus', corpusRoot, '--store', storeFile], io, {
      createSamplePort: () => fakeSamplePort('misleading'),
    });

    expect(io.lines.some((line) => line.includes('SAMPLED') && line.includes('alpha') && line.includes('misleading'))).toBe(true);
    expect(io.lines.some((line) => line.includes(`persisted`) && line.includes(storeFile))).toBe(true);

    const store = await createSqliteBenchmarkStore({ databaseFile: storeFile });
    try {
      const runIdLine = io.lines.find((line) => line.includes('persisted'))!;
      const runId = /Run ([^ ]+) persisted/.exec(runIdLine)?.[1];
      expect(runId).toBeDefined();
      const loaded = await store.loadRun(runId!);
      expect(loaded).toHaveLength(1);
      expect(loaded![0]!.sample?.classification.status).toBe('misleading');
    } finally {
      await store.close();
    }
    // Unrealizable (no registered oracle recipe) -> unproven, so exit is 1 regardless of the P7-4
    // exit-code decision below: under --store, success now requires BOTH proof and sampling to
    // succeed for every case (see src/cli/benchmark.ts's own doc) — this case never proves, so it
    // was already going to fail either way. test/benchmark-cli-metrics.test.ts covers the case this
    // task's own report flagged as untested: every case proves but sampling fails.
    expect(exitCode).toBe(1);
  });

  it('never persists anything without --store, even though the default (no-flag) behavior is otherwise unchanged', async () => {
    await writeSyntheticCase('beta');
    const io = new RecordingIo();

    const exitCode = await runBenchmarkCli(['--corpus', corpusRoot], io);

    expect(io.lines.some((line) => line.includes('SAMPLED'))).toBe(false);
    expect(io.lines.at(-1)).toBe('0/1 case(s) proven.');
    expect(exitCode).toBe(1);
  });

  it('fails fast on a missing API key before sampling or persisting anything, when no sample port is injected', async () => {
    await writeSyntheticCase('gamma');
    const io = new RecordingIo();
    const originalKey = process.env['TYPESAFE_API_KEY'];
    delete process.env['TYPESAFE_API_KEY'];

    try {
      const exitCode = await runBenchmarkCli(['--corpus', corpusRoot, '--store', storeFile], io, {
        resolveApiKey: async () => ({ errorMessage: 'No TypeSafe API key is configured.' }),
      });

      expect(exitCode).toBe(1);
      expect(io.lines[0]).toContain('No TypeSafe API key is configured.');
      await expect(readFile(storeFile)).rejects.toThrow();
    } finally {
      if (originalKey !== undefined) process.env['TYPESAFE_API_KEY'] = originalKey;
    }
  });

  it('never touches the user\'s real audit store while sampling and persisting a benchmark run', async () => {
    await writeSyntheticCase('delta');
    const tempConfigHome = await mkdtemp(join(tmpdir(), 'jev-benchmark-cli-audit-untouched-'));
    const originalXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tempConfigHome;

    try {
      const auditPaths = resolveAuditStorePaths();
      const auditStore = await createSqliteAuditStore({ databaseFile: auditPaths.databaseFile });
      await auditStore.beginRun('/some/repo');
      await auditStore.close();
      const before = await readFile(auditPaths.databaseFile);

      const io = new RecordingIo();
      await runBenchmarkCli(['--corpus', corpusRoot, '--store', storeFile], io, { createSamplePort: () => fakeSamplePort() });

      const after = await readFile(auditPaths.databaseFile);
      expect(after.equals(before)).toBe(true);
    } finally {
      if (originalXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = originalXdg;
      await rm(tempConfigHome, { recursive: true, force: true });
    }
  });
});

describe('runBenchmarkCli --baseline/--candidate (compare)', () => {
  it('reports a usage error when only one of --baseline/--candidate is given', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--baseline', 'run-1'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/--baseline and --candidate must be given together/);
  });

  it('reports a usage error when --baseline/--candidate are given without --store', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--baseline', 'run-1', '--candidate', 'run-2'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/require --store/);
  });

  it('reports a usage error when --corpus is combined with --baseline/--candidate', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--baseline', 'run-1', '--candidate', 'run-2', '--corpus', corpusRoot], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/cannot be combined/);
  });

  it('reports which run id is missing when a named run was never recorded', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--baseline', 'missing-run', '--candidate', 'also-missing'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toContain('missing-run');
  });

  it('compares two persisted runs and prints agreements/disagreements/regressions/excluded', async () => {
    const store = await createSqliteBenchmarkStore({ databaseFile: storeFile });
    const baselineRunId = await store.beginRun('corpus');
    await store.recordCase(baselineRunId, {
      caseId: 'x',
      operator: 'remove-assertion',
      operatorRole: 'prescriptive',
      oracleKind: 'production-mutation',
      expectedOutcome: 'expected-to-fail',
      fixtureFiles: [{ path: 'test.ts', contents: 'same' }],
      proofStatus: { kind: 'proven' },
      oracleRuns: [],
      sample: {
        classification: classification('x', 'healthy'),
        policyVersion: 2,
        rubricVersion: 2,
        model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    await store.finishRun(baselineRunId);
    const candidateRunId = await store.beginRun('corpus');
    await store.recordCase(candidateRunId, {
      caseId: 'x',
      operator: 'remove-assertion',
      operatorRole: 'prescriptive',
      oracleKind: 'production-mutation',
      expectedOutcome: 'expected-to-fail',
      fixtureFiles: [{ path: 'test.ts', contents: 'same' }],
      proofStatus: { kind: 'proven' },
      oracleRuns: [],
      sample: {
        classification: classification('x', 'weak'),
        policyVersion: 2,
        rubricVersion: 2,
        model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    await store.finishRun(candidateRunId);
    await store.close();

    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--baseline', baselineRunId, '--candidate', candidateRunId], io);

    expect(exitCode).toBe(0);
    expect(io.lines.some((line) => line.startsWith('Regressions: 1'))).toBe(true);
    expect(io.lines.some((line) => line.includes('x: healthy -> weak'))).toBe(true);
  });

  it('reports a refused comparison (version mismatch) instead of silently comparing', async () => {
    const store = await createSqliteBenchmarkStore({ databaseFile: storeFile });
    const baselineRunId = await store.beginRun('corpus');
    await store.recordCase(baselineRunId, {
      caseId: 'x',
      operator: 'remove-assertion',
      operatorRole: 'prescriptive',
      oracleKind: 'production-mutation',
      expectedOutcome: 'expected-to-fail',
      fixtureFiles: [{ path: 'test.ts', contents: 'same' }],
      proofStatus: { kind: 'proven' },
      oracleRuns: [],
      sample: {
        classification: classification('x', 'healthy'),
        policyVersion: 2,
        rubricVersion: 2,
        model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    await store.finishRun(baselineRunId);
    const candidateRunId = await store.beginRun('corpus');
    await store.recordCase(candidateRunId, {
      caseId: 'x',
      operator: 'remove-assertion',
      operatorRole: 'prescriptive',
      oracleKind: 'production-mutation',
      expectedOutcome: 'expected-to-fail',
      fixtureFiles: [{ path: 'test.ts', contents: 'same' }],
      proofStatus: { kind: 'proven' },
      oracleRuns: [],
      sample: {
        classification: classification('x', 'healthy'),
        policyVersion: 3,
        rubricVersion: 2,
        model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    await store.finishRun(candidateRunId);
    await store.close();

    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--store', storeFile, '--baseline', baselineRunId, '--candidate', candidateRunId], io);

    expect(exitCode).toBe(1);
    expect(io.lines[0]).toContain('refused');
    expect(io.lines[0]).toContain('policy-version-mismatch');
  });
});
