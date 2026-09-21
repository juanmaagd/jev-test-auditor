import { describe, expect, it } from 'vitest';
import {
  completeReviewSession,
  prepareReviewSession,
  recordWorkerAssessment,
} from '../src/application/benchmark-review.js';
import type {
  BenchmarkCaseOutcome,
  BenchmarkReviewCaseRecord,
  BenchmarkReviewRunRecord,
  BenchmarkStorePort,
  RecordReviewCaseInput,
} from '../src/domain/benchmark-store.js';
import type { CorpusCase } from '../src/domain/corpus.js';
import type { FrozenWorkerAssessment } from '../src/domain/benchmark-review.js';
import type { ClassificationResult } from '../src/domain/classification.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

function mockClassification(caseId: string, status: 'healthy' | 'misleading'): ClassificationResult {
  return {
    testCaseId: `tc:${caseId}` as TestCaseId,
    repositoryRelativePath: 'test.ts',
    name: caseId,
    status,
    dimensions: [
      {
        dimensionId: 'falsifiability',
        dimensionLabel: 'falsifiability',
        applicable: true,
        applicabilityProbability: 0.9,
        level: status === 'healthy' ? 'acceptable' : 'misleading',
        score: status === 'healthy' ? 2 : 0,
        confidence: 0.9,
        status: 'judged',
        reason: undefined,
        probabilities: undefined,
        deficientMass: status === 'healthy' ? 0.1 : 0.9,
        acceptableMass: status === 'healthy' ? 0.9 : 0.1,
        criticalMass: 0.05,
      },
    ],
    findings: [],
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function mockCorpusCase(caseId: string): CorpusCase {
  return {
    id: caseId,
    operator: 'remove-assertion',
    operatorRole: 'descriptive',
    oracleKind: 'production-mutation',
    testEffect: 'synthetic',
    productionEffect: 'synthetic',
    expectedOutcome: 'expected-to-fail',
    baseTest: { path: 'test.ts', contents: '// base test content' },
    productionSources: [{ path: 'prod.ts', contents: '// prod content' }],
    proofStatus: 'unverified',
  };
}

function mockCaseOutcome(caseId: string, status: 'healthy' | 'misleading'): BenchmarkCaseOutcome {
  return {
    caseId,
    operator: 'remove-assertion',
    operatorRole: 'descriptive',
    oracleKind: 'production-mutation',
    expectedOutcome: 'expected-to-fail',
    fixtureHash: 'hash-123',
    proofStatus: { kind: 'proven' },
    oracleRuns: [],
    sample: {
      classification: mockClassification(caseId, status),
      policyVersion: 2,
      rubricVersion: 2,
      model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 100,
    },
  };
}

class FakeBenchmarkStore implements BenchmarkStorePort {
  readonly recordedCases: RecordReviewCaseInput[] = [];
  finishedReviewId?: string;

  constructor(
    readonly runs: Map<string, BenchmarkCaseOutcome[]>,
    readonly reviewRuns: Map<string, BenchmarkReviewRunRecord> = new Map(),
    readonly reviewCases: Map<string, BenchmarkReviewCaseRecord[]> = new Map(),
  ) {}

  async beginRun(): Promise<string> { return 'run-1'; }
  async recordCase(): Promise<void> {}
  async finishRun(): Promise<void> {}
  async loadRun(runId: string): Promise<BenchmarkCaseOutcome[] | undefined> {
    return this.runs.get(runId);
  }
  async beginReview(benchmarkRunId: string, selectionKind: BenchmarkReviewRunRecord['selectionKind']): Promise<string> {
    const id = 'rev-100';
    this.reviewRuns.set(id, {
      id,
      benchmarkRunId,
      selectionKind,
      startedAt: '2026-09-21T21:00:00.000Z',
    });
    return id;
  }
  async recordReviewCase(reviewRunId: string, input: RecordReviewCaseInput): Promise<void> {
    this.recordedCases.push(input);
    const list = this.reviewCases.get(reviewRunId) ?? [];
    list.push({
      id: list.length + 1,
      reviewRunId,
      caseId: input.frozenAssessment.caseId,
      inputPayloadHash: input.frozenAssessment.inputPayloadHash,
      frozenAt: input.frozenAssessment.frozenAt,
      workerRuntime: input.frozenAssessment.workerIdentity?.runtime ?? 'unknown',
      workerModel: input.frozenAssessment.workerIdentity?.model,
      assessment: input.frozenAssessment.assessment,
      comparison: input.comparison,
      recordedAt: '2026-09-21T21:05:00.000Z',
    });
    this.reviewCases.set(reviewRunId, list);
  }
  async finishReview(reviewRunId: string): Promise<void> {
    this.finishedReviewId = reviewRunId;
    const rev = this.reviewRuns.get(reviewRunId);
    if (rev) {
      this.reviewRuns.set(reviewRunId, { ...rev, finishedAt: '2026-09-21T21:10:00.000Z' });
    }
  }
  async loadReviewsForRun(benchmarkRunId: string): Promise<BenchmarkReviewRunRecord[]> {
    return Array.from(this.reviewRuns.values()).filter((r) => r.benchmarkRunId === benchmarkRunId);
  }
  async loadReview(reviewRunId: string): Promise<BenchmarkReviewRunRecord | undefined> {
    return this.reviewRuns.get(reviewRunId);
  }
  async loadReviewCases(reviewRunId: string): Promise<BenchmarkReviewCaseRecord[]> {
    return this.reviewCases.get(reviewRunId) ?? [];
  }
  async close(): Promise<void> {}
}

describe('benchmark review application service', () => {
  it('prepareReviewSession creates blind payloads and begins review', async () => {
    const case1 = mockCaseOutcome('case-1', 'healthy'); // descriptive flaw, Jev said healthy -> disagreement
    const runs = new Map([['run-1', [case1]]]);
    const store = new FakeBenchmarkStore(runs);
    const corpusCases = [mockCorpusCase('case-1')];

    const prepared = await prepareReviewSession(store, {
      benchmarkRunId: 'run-1',
      selection: { selectionKind: 'disagreements' },
      corpusCases,
    });

    expect(prepared.reviewRunId).toBe('rev-100');
    expect(prepared.benchmarkRunId).toBe('run-1');
    expect(prepared.payloads).toHaveLength(1);
    expect(prepared.payloads[0]?.caseId).toBe('case-1');
    expect(prepared.payloads[0]?.testSource).toContain('base test content');
    // Ensure payload is strictly blind
    expect((prepared.payloads[0] as unknown as Record<string, unknown>).sample).toBeUndefined();
    expect((prepared.payloads[0] as unknown as Record<string, unknown>).classification).toBeUndefined();
  });

  it('prepareReviewSession throws if benchmark run does not exist', async () => {
    const store = new FakeBenchmarkStore(new Map());
    await expect(
      prepareReviewSession(store, {
        benchmarkRunId: 'missing-run',
        selection: { selectionKind: 'all' },
        corpusCases: [],
      }),
    ).rejects.toThrow(/Benchmark run not found/i);
  });

  it('recordWorkerAssessment compares assessment and records to store', async () => {
    const outcome = mockCaseOutcome('case-1', 'healthy'); // Jev called descriptive flaw healthy (model error!)
    const store = new FakeBenchmarkStore(new Map([['run-1', [outcome]]]));

    const frozenAssessment: FrozenWorkerAssessment = {
      caseId: 'case-1',
      inputPayloadHash: 'hash-abc',
      frozenAt: '2026-09-21T21:00:00.000Z',
      assessment: {
        caseId: 'case-1',
        assessedDimensions: [
          {
            dimensionId: 'falsifiability',
            level: 'misleading',
            score: 0,
            confidence: 0.95,
            reasoning: 'assertion removed',
            evidenceCitations: [],
          },
        ],
        overallUncertainty: 0.05,
      },
    };

    const comparison = await recordWorkerAssessment(store, {
      reviewRunId: 'rev-100',
      frozenAssessment,
      outcome,
    });

    expect(comparison.agreement).toBe(false);
    expect(comparison.discrepancyKind).toBe('likely-model-error');
    expect(store.recordedCases).toHaveLength(1);
    expect(store.recordedCases[0]?.frozenAssessment.caseId).toBe('case-1');
  });

  it('completeReviewSession finalizes review and aggregates discrepancy metrics', async () => {
    const outcome = mockCaseOutcome('case-1', 'healthy');
    const store = new FakeBenchmarkStore(new Map([['run-1', [outcome]]]));
    const reviewId = await store.beginReview('run-1', 'all');

    const frozenAssessment: FrozenWorkerAssessment = {
      caseId: 'case-1',
      inputPayloadHash: 'hash-abc',
      frozenAt: '2026-09-21T21:00:00.000Z',
      assessment: {
        caseId: 'case-1',
        assessedDimensions: [
          {
            dimensionId: 'falsifiability',
            level: 'misleading',
            score: 0,
            confidence: 0.95,
            reasoning: 'assertion removed',
            evidenceCitations: [],
          },
        ],
        overallUncertainty: 0.05,
      },
    };

    await recordWorkerAssessment(store, {
      reviewRunId: reviewId,
      frozenAssessment,
      outcome,
    });

    const summary = await completeReviewSession(store, reviewId);

    expect(summary.reviewRun.id).toBe(reviewId);
    expect(summary.totalCasesReviewed).toBe(1);
    expect(summary.agreementCount).toBe(0);
    expect(summary.disagreementCount).toBe(1);
    expect(summary.discrepanciesByKind['likely-model-error']).toBe(1);
    expect(summary.discrepanciesByKind['rubric-ambiguity']).toBe(0);
    expect(store.finishedReviewId).toBe(reviewId);
  });
});
