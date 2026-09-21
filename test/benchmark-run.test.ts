import { describe, expect, it, vi } from 'vitest';
import { runBenchmarkPass, type BenchmarkSamplePort, type SampleResult } from '../src/application/benchmark-run.js';
import type { OracleObservationPort } from '../src/application/benchmark.js';
import type { CorpusCase } from '../src/domain/corpus.js';
import type {
  BenchmarkCaseRecordInput,
  BenchmarkStorePort,
} from '../src/domain/benchmark-store.js';
import type { ClassificationResult } from '../src/domain/classification.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

/** A corpus case whose id is deliberately NOT registered in `src/domain/oracle.ts`'s `CASE_ORACLE_RECIPES` — `buildOraclePlan` reports it `'unrealizable'` immediately, calling the observe port zero times. Keeps this suite focused on `runBenchmarkPass`'s own orchestration, independent of P7-2's oracle mechanics (already covered by `test/oracle.test.ts`/`test/benchmark.test.ts`). */
function syntheticCase(id: string): CorpusCase {
  return {
    id,
    operator: 'remove-assertion',
    operatorRole: 'descriptive',
    oracleKind: 'production-mutation',
    testEffect: 'synthetic',
    productionEffect: 'synthetic',
    expectedOutcome: 'expected-to-fail',
    baseTest: { path: 'test.ts', contents: `// ${id} base test` },
    productionSources: [{ path: 'prod.ts', contents: `// ${id} production source` }],
    proofStatus: 'unverified',
  };
}

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
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/** Throws if ever called — every case in this suite is deliberately unrealizable (see `syntheticCase`), so `proveCase` must never reach the observe port. */
const neverObserve: OracleObservationPort = {
  observe: vi.fn(async () => {
    throw new Error('observe should never be called for a deliberately unrealizable synthetic case');
  }),
};

class FakeStore implements BenchmarkStorePort {
  readonly begun: string[] = [];
  readonly recorded: { readonly runId: string; readonly input: BenchmarkCaseRecordInput }[] = [];
  readonly finished: string[] = [];
  private nextRunId = 0;

  async beginRun(corpusDir: string): Promise<string> {
    this.begun.push(corpusDir);
    this.nextRunId += 1;
    return `run-${this.nextRunId}`;
  }

  async recordCase(runId: string, input: BenchmarkCaseRecordInput): Promise<void> {
    this.recorded.push({ runId, input });
  }

  async finishRun(runId: string): Promise<void> {
    this.finished.push(runId);
  }

  async loadRun(): Promise<undefined> {
    return undefined;
  }

  async beginReview(): Promise<string> {
    return 'fake-review-id';
  }

  async recordReviewCase(): Promise<void> {}

  async finishReview(): Promise<void> {}

  async loadReviewsForRun(): Promise<[]> {
    return [];
  }

  async loadReview(): Promise<undefined> {
    return undefined;
  }

  async loadReviewCases(): Promise<[]> {
    return [];
  }

  async close(): Promise<void> {}
}

describe('runBenchmarkPass', () => {
  it('samples every case, in order, without a store', async () => {
    const cases = [syntheticCase('one'), syntheticCase('two')];
    const sampleCalls: string[] = [];
    const sample: BenchmarkSamplePort = {
      async sample(corpusCase): Promise<SampleResult> {
        sampleCalls.push(corpusCase.id);
        return { kind: 'sampled', classification: classification(corpusCase.id, 'healthy'), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const result = await runBenchmarkPass(cases, 'test/fixtures/corpus/discrimination', { observe: neverObserve, sample });

    expect(sampleCalls).toEqual(['one', 'two']);
    expect(result.runId).toBeUndefined();
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]!.sampleResult.kind).toBe('sampled');
  });

  it('with a store: begins a run, records each case combining its oracle proof and sample under one fixture identity, and finishes the run', async () => {
    const cases = [syntheticCase('alpha')];
    const sample: BenchmarkSamplePort = {
      async sample(corpusCase): Promise<SampleResult> {
        return { kind: 'sampled', classification: classification(corpusCase.id, 'misleading'), usage: { inputTokens: 7, outputTokens: 3 }, latencyMs: 456 };
      },
    };
    const store = new FakeStore();

    const result = await runBenchmarkPass(cases, 'test/fixtures/corpus/discrimination', { observe: neverObserve, sample, store });

    expect(store.begun).toEqual(['test/fixtures/corpus/discrimination']);
    expect(result.runId).toBe('run-1');
    expect(store.recorded).toHaveLength(1);
    const { runId, input } = store.recorded[0]!;
    expect(runId).toBe('run-1');
    expect(input.caseId).toBe('alpha');
    expect(input.operatorRole).toBe('descriptive');
    expect(input.fixtureFiles).toEqual([
      { path: 'prod.ts', contents: '// alpha production source' },
      { path: 'test.ts', contents: '// alpha base test' },
    ]);
    // Unrealizable (no registered oracle recipe): proven never held, and the reason is visible.
    expect(input.proofStatus.kind).toBe('unproven');
    expect(input.oracleRuns).toEqual([]);
    expect(input.sample).toBeDefined();
    expect(input.sample?.classification.status).toBe('misleading');
    expect(input.sample?.latencyMs).toBe(456);
    expect(input.sampleFailure).toBeUndefined();
    expect(store.finished).toEqual(['run-1']);
  });

  it('records a sampleFailure (never a fabricated sample) when sampling itself fails for a case', async () => {
    const cases = [syntheticCase('beta')];
    const sample: BenchmarkSamplePort = {
      async sample(): Promise<SampleResult> {
        return { kind: 'failed', errorKind: 'evaluation-failed', errorMessage: 'boom' };
      },
    };
    const store = new FakeStore();

    await runBenchmarkPass(cases, 'test/fixtures/corpus/discrimination', { observe: neverObserve, sample, store });

    const { input } = store.recorded[0]!;
    expect(input.sample).toBeUndefined();
    expect(input.sampleFailure).toEqual({ errorKind: 'evaluation-failed', errorMessage: 'boom' });
  });

  it('never persists anything when no store is given, even though sampling still runs (network cost happens, storage does not)', async () => {
    const cases = [syntheticCase('gamma')];
    let sampleCalled = false;
    const sample: BenchmarkSamplePort = {
      async sample(): Promise<SampleResult> {
        sampleCalled = true;
        return { kind: 'sampled', classification: classification('gamma', 'healthy'), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const result = await runBenchmarkPass(cases, 'test/fixtures/corpus/discrimination', { observe: neverObserve, sample });

    expect(sampleCalled).toBe(true);
    expect(result.runId).toBeUndefined();
  });
});
