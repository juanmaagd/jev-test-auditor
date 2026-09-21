import { describe, expect, it } from 'vitest';
import {
  computeBenchmarkMetricsReport,
  MIN_SAMPLE_FOR_RATE,
  OPERATOR_DIMENSION,
  type BenchmarkMetricsRun,
} from '../src/domain/benchmark-metrics.js';
import type { BenchmarkCaseOutcome, BenchmarkSampleRecord } from '../src/domain/benchmark-store.js';
import type {
  ClassificationLevel,
  ClassificationResult,
  DimensionJudgment,
  DimensionJudgmentStatus,
  OverallClassificationStatus,
} from '../src/domain/classification.js';
import type { CorpusOperatorId, CorpusOperatorRole } from '../src/domain/corpus.js';
import type { RubricDimensionId } from '../src/domain/rubric.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';
import { JEV_ESTIMATE_SNAPSHOT } from '../src/domain/jev-pricing.js';

/** A single dimension judgment, defaulting every optional field to something inert unless overridden. */
function judgment(dimensionId: RubricDimensionId, overrides: Partial<DimensionJudgment> = {}): DimensionJudgment {
  return {
    dimensionId,
    dimensionLabel: dimensionId,
    applicable: true,
    applicabilityProbability: 0.9,
    level: undefined,
    score: undefined,
    confidence: undefined,
    status: 'judged',
    reason: undefined,
    probabilities: undefined,
    deficientMass: undefined,
    acceptableMass: undefined,
    criticalMass: undefined,
    ...overrides,
  };
}

/** Builds a full seven-dimension judgment array, overriding exactly one dimension's judgment (the rest stay applicable/acceptable so they never accidentally contribute evidence to another dimension's counters). */
function dimensions(overrideId: RubricDimensionId, override: Partial<DimensionJudgment>): readonly DimensionJudgment[] {
  const allIds: readonly RubricDimensionId[] = [
    'assertion-strength',
    'behavioral-focus',
    'determinism-isolation',
    'diagnostic-quality',
    'falsifiability',
    'refactor-resistance',
    'test-double-quality',
  ];
  return allIds.map((id) => (id === overrideId ? judgment(id, override) : judgment(id, { level: 'acceptable', score: 2 })));
}

function classification(
  caseId: string,
  overrideId: RubricDimensionId,
  override: Partial<DimensionJudgment>,
  status: OverallClassificationStatus = 'weak',
): ClassificationResult {
  return {
    testCaseId: `tc:${caseId}` as TestCaseId,
    repositoryRelativePath: 'test.ts',
    name: caseId,
    status,
    dimensions: dimensions(overrideId, override),
    findings: [],
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 1000, outputTokens: 50 },
  };
}

function sample(
  caseId: string,
  overrideId: RubricDimensionId,
  override: Partial<DimensionJudgment>,
  options: { readonly inputTokens?: number; readonly latencyMs?: number } = {},
): BenchmarkSampleRecord {
  return {
    classification: {
      ...classification(caseId, overrideId, override),
      usage: { inputTokens: options.inputTokens ?? 1000, outputTokens: 50 },
    },
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: options.inputTokens ?? 1000, outputTokens: 50 },
    ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
  };
}

interface CaseOptions {
  readonly caseId: string;
  readonly operator: CorpusOperatorId;
  readonly operatorRole: CorpusOperatorRole;
  readonly level?: ClassificationLevel;
  readonly status?: DimensionJudgmentStatus;
  readonly deficientMass?: number;
  readonly proven?: boolean;
  readonly sampled?: boolean;
  readonly inputTokens?: number;
  readonly latencyMs?: number;
}

function outcome(options: CaseOptions): BenchmarkCaseOutcome {
  const dimensionId = OPERATOR_DIMENSION[options.operator];
  const proofStatus: BenchmarkCaseOutcome['proofStatus'] = options.proven === false
    ? { kind: 'unproven', reason: `${options.caseId} was not proven` }
    : { kind: 'proven' };
  const override: Partial<DimensionJudgment> = {
    status: options.status ?? 'judged',
    level: options.level,
    score: options.level === undefined ? undefined : 1,
    ...(options.deficientMass === undefined ? {} : { deficientMass: options.deficientMass, acceptableMass: 1 - options.deficientMass, criticalMass: 0 }),
  };
  const hasSample = options.sampled !== false;
  return {
    caseId: options.caseId,
    operator: options.operator,
    operatorRole: options.operatorRole,
    oracleKind: 'production-mutation',
    expectedOutcome: options.operatorRole === 'descriptive' ? 'expected-to-keep-passing' : 'expected-to-fail',
    fixtureHash: `hash-${options.caseId}`,
    proofStatus,
    oracleRuns: [],
    ...(hasSample
      ? {
        sample: sample(options.caseId, dimensionId, override, {
          ...(options.inputTokens === undefined ? {} : { inputTokens: options.inputTokens }),
          ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
        }),
      }
      : { sampleFailure: { errorKind: 'evaluation-failed', errorMessage: `${options.caseId} sampling failed` } }),
  };
}

function run(runId: string, outcomes: readonly BenchmarkCaseOutcome[]): BenchmarkMetricsRun {
  return { runId, outcomes };
}

function dimensionReport(report: ReturnType<typeof computeBenchmarkMetricsReport>, dimensionId: RubricDimensionId) {
  const found = report.dimensions.find((d) => d.dimensionId === dimensionId);
  if (found === undefined) throw new Error(`no dimension report for ${dimensionId}`);
  return found;
}

describe('OPERATOR_DIMENSION', () => {
  it('maps every corpus operator to exactly one rubric dimension, closed vocabulary', () => {
    expect(OPERATOR_DIMENSION).toEqual({
      'remove-assertion': 'falsifiability',
      'weaken-expectation': 'assertion-strength',
      'add-shared-state': 'determinism-isolation',
      'mock-owned-logic': 'test-double-quality',
      'pin-implementation-detail': 'refactor-resistance',
      'introduce-uncontrolled-time': 'determinism-isolation',
    });
  });
});

describe('computeBenchmarkMetricsReport: precision, recall, false-positive rate stay independently distinguishable', () => {
  // 5 descriptive (ground truth deficient) cases: 3 correctly caught (misleading/weak -> TP), 2 missed (acceptable/strong -> FN).
  // 2 prescriptive (ground truth healthy) cases: 1 correctly cleared (TN), 1 false alarm (FP).
  // precision = TP/(TP+FP) = 3/4 = 0.75; recall = TP/(TP+FN) = 3/5 = 0.6; FPR = FP/(FP+TN) = 1/2 = 0.5.
  const outcomes = [
    outcome({ caseId: 'd1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' }),
    outcome({ caseId: 'd2', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'weak' }),
    outcome({ caseId: 'd3', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' }),
    outcome({ caseId: 'd4', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'acceptable' }),
    outcome({ caseId: 'd5', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'strong' }),
    outcome({ caseId: 'p1', operator: 'weaken-expectation', operatorRole: 'prescriptive', level: 'strong' }),
    outcome({ caseId: 'p2', operator: 'weaken-expectation', operatorRole: 'prescriptive', level: 'weak' }),
  ];
  const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);
  const assertionStrength = dimensionReport(report, 'assertion-strength');

  // Denominators (4, 5, 2) sit at or below MIN_SAMPLE_FOR_RATE (5) on purpose — this fixture's job
  // is proving the three VALUES are computed independently (never swapped), not exercising the
  // sufficiency threshold (covered separately below).
  it('computes precision = 0.75 (3/4), distinct from recall and FPR', () => {
    expect(assertionStrength.precision).toEqual({ kind: 'below-minimum-sample', numerator: 3, denominator: 4, value: 0.75, reason: undefined });
  });

  it('computes recall = 0.6 (3/5), distinct from precision and FPR', () => {
    expect(assertionStrength.recall).toEqual({ kind: 'computed', numerator: 3, denominator: 5, value: 0.6, reason: undefined });
  });

  it('computes false-positive rate = 0.5 (1/2), distinct from precision and recall', () => {
    expect(assertionStrength.falsePositiveRate).toEqual({ kind: 'below-minimum-sample', numerator: 1, denominator: 2, value: 0.5, reason: undefined });
  });

  it('reports 7 proven cases for this dimension', () => {
    expect(assertionStrength.provenCaseCount).toBe(7);
  });
});

describe('computeBenchmarkMetricsReport: dimension with no proven case at all reports plainly, never zero', () => {
  // behavioral-focus and diagnostic-quality have no operator mapped to them at all — structurally
  // always empty, regardless of corpus content. The fixture below DOES have cases for other
  // dimensions, so this is not a vacuous "every dimension is empty" test.
  const outcomes = [
    outcome({ caseId: 'a1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' }),
  ];
  const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);
  const behavioralFocus = dimensionReport(report, 'behavioral-focus');

  it('reports zero proven cases', () => {
    expect(behavioralFocus.provenCaseCount).toBe(0);
  });

  it('never reports a numeric rate for precision/recall/FPR — not-computable with no value, not 0', () => {
    for (const metric of [behavioralFocus.precision, behavioralFocus.recall, behavioralFocus.falsePositiveRate]) {
      expect(metric.kind).toBe('not-computable');
      expect(metric.value).toBeUndefined();
      expect(metric.reason).toBeDefined();
    }
  });

  it('never reports a numeric calibration/cost/latency — not-computable with no value, not 0', () => {
    for (const metric of [behavioralFocus.calibration, behavioralFocus.cost, behavioralFocus.latency]) {
      expect(metric.kind).toBe('not-computable');
      expect(metric.value).toBeUndefined();
    }
  });
});

describe('computeBenchmarkMetricsReport: precision/FPR require an actual negative-class case, not just enough samples', () => {
  // 6 descriptive-only cases, all correctly caught: recall clears the n>=5 threshold, but precision
  // and FPR must stay not-computable — there is no prescriptive (good-control) case for this
  // dimension in the corpus, so a naive TP/(TP+0) would silently report a misleading 1.00.
  const outcomes = Array.from({ length: 6 }, (_, index) =>
    outcome({ caseId: `neg-only-${index}`, operator: 'add-shared-state', operatorRole: 'descriptive', level: 'misleading' }));
  const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);
  const determinism = dimensionReport(report, 'determinism-isolation');

  it('recall computes normally (6/6, at/above minimum sample)', () => {
    expect(determinism.recall).toEqual({ kind: 'computed', numerator: 6, denominator: 6, value: 1, reason: undefined });
  });

  it('precision is not-computable: no prescriptive case exists for this dimension', () => {
    expect(determinism.precision.kind).toBe('not-computable');
    expect(determinism.precision.value).toBeUndefined();
    expect(determinism.precision.reason).toMatch(/prescriptive|negative|good.control/i);
  });

  it('false-positive rate is not-computable: no prescriptive case exists for this dimension', () => {
    expect(determinism.falsePositiveRate.kind).toBe('not-computable');
    expect(determinism.falsePositiveRate.value).toBeUndefined();
  });
});

describe('computeBenchmarkMetricsReport: below-minimum-sample never hides the raw count, only the decimal confidence', () => {
  const outcomes = [
    outcome({ caseId: 'lone', operator: 'pin-implementation-detail', operatorRole: 'descriptive', level: 'misleading' }),
  ];
  const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);
  const refactorResistance = dimensionReport(report, 'refactor-resistance');

  it('recall is below-minimum-sample at n=1, but the raw 1/1 fraction and value are still present', () => {
    expect(refactorResistance.recall).toEqual({ kind: 'below-minimum-sample', numerator: 1, denominator: 1, value: 1, reason: undefined });
  });

  it(`MIN_SAMPLE_FOR_RATE is ${MIN_SAMPLE_FOR_RATE}`, () => {
    expect(MIN_SAMPLE_FOR_RATE).toBe(5);
  });
});

describe('computeBenchmarkMetricsReport: only proven cases count', () => {
  const outcomes = [
    outcome({ caseId: 'proven-1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' }),
    outcome({ caseId: 'unproven-1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', proven: false }),
  ];
  const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);

  it('excludes the unproven case from the dimension proven count', () => {
    expect(dimensionReport(report, 'assertion-strength').provenCaseCount).toBe(1);
  });

  it('reports the unproven case separately, with its reason', () => {
    expect(report.unprovenCases).toEqual([{ caseId: 'unproven-1', reasons: ['unproven-1 was not proven'] }]);
  });
});

describe('computeBenchmarkMetricsReport: a proven case whose sampling failed is counted, never treated as a judgment', () => {
  const outcomes = [
    outcome({ caseId: 'sample-failed', operator: 'weaken-expectation', operatorRole: 'descriptive', sampled: false }),
  ];
  const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);

  it('the case is still proven (oracle succeeded) but excluded from every dimension metric', () => {
    expect(dimensionReport(report, 'assertion-strength').recall.kind).toBe('not-computable');
  });

  it('reports it separately as not-sampled with its failure reason', () => {
    expect(report.notSampledCases).toEqual([{ caseId: 'sample-failed', reasons: ['sample-failed sampling failed'] }]);
  });
});

describe('computeBenchmarkMetricsReport: needs-review routing pools every dimension judgment across all proven+sampled cases, not only the designated one', () => {
  // Every sampled case carries a judgment for all 7 dimensions. behavioral-focus is never a
  // *designated* dimension for any operator, but it still receives a routing judgment from every
  // case here — so its routing denominator (3) can exceed its (zero) provenCaseCount.
  const outcomes = [
    outcome({ caseId: 'r1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' }),
    outcome({ caseId: 'r2', operator: 'mock-owned-logic', operatorRole: 'descriptive', level: 'misleading' }),
    outcome({ caseId: 'r3', operator: 'remove-assertion', operatorRole: 'descriptive', level: 'misleading' }),
  ];
  // Force one case's behavioral-focus judgment into needs-review, independent of its designated dimension.
  const outcomesWithRouting = outcomes.map((entry, index) => {
    if (index !== 0 || entry.sample === undefined) return entry;
    const withNeedsReview: DimensionJudgment[] = entry.sample.classification.dimensions.map((dimensionJudgment) =>
      (dimensionJudgment.dimensionId === 'behavioral-focus'
        ? { ...dimensionJudgment, status: 'needs-review' as const, level: undefined, reason: 'boundary-straddle' as const }
        : dimensionJudgment));
    return {
      ...entry,
      sample: { ...entry.sample, classification: { ...entry.sample.classification, dimensions: withNeedsReview } },
    };
  });
  const report = computeBenchmarkMetricsReport([run('run-1', outcomesWithRouting)]);
  const behavioralFocus = dimensionReport(report, 'behavioral-focus');

  it('behavioral-focus has zero designated proven cases, yet a routing denominator from other cases\' judgments', () => {
    expect(behavioralFocus.provenCaseCount).toBe(0);
    expect(behavioralFocus.needsReviewRouting).toEqual({ kind: 'below-minimum-sample', numerator: 1, denominator: 3, value: 1 / 3, reason: undefined });
  });
});

describe('computeBenchmarkMetricsReport: probability calibration (Brier score) uses deficientMass against ground truth, including needs-review', () => {
  // Ground truth deficient (descriptive) with deficientMass 0.9 -> squared error (0.9-1)^2 = 0.01.
  // Ground truth healthy (prescriptive) with deficientMass 0.2 -> squared error (0.2-0)^2 = 0.04.
  // A needs-review (boundary-straddle) judgment still carries a validated deficientMass and must
  // still count: ground truth deficient with deficientMass 0.5 -> squared error (0.5-1)^2 = 0.25.
  // mean = (0.01 + 0.04 + 0.25) / 3 = 0.10.
  const outcomes = [
    outcome({ caseId: 'c1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', deficientMass: 0.9 }),
    outcome({ caseId: 'c2', operator: 'weaken-expectation', operatorRole: 'prescriptive', level: 'strong', deficientMass: 0.2 }),
    outcome({
      caseId: 'c3', operator: 'weaken-expectation', operatorRole: 'descriptive', status: 'needs-review', deficientMass: 0.5,
    }),
  ];
  const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);
  const assertionStrength = dimensionReport(report, 'assertion-strength');

  it('computes the mean Brier score across all three, needs-review included', () => {
    expect(assertionStrength.calibration.kind).toBe('below-minimum-sample');
    expect(assertionStrength.calibration.sampleCount).toBe(3);
    expect(assertionStrength.calibration.value).toBeCloseTo(0.1, 10);
  });
});

describe('computeBenchmarkMetricsReport: cost and latency are computed from real usage/pricing, not estimated', () => {
  const outcomes = [
    outcome({ caseId: 'cost-1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', inputTokens: 2_000_000, latencyMs: 1000 }),
    outcome({ caseId: 'cost-2', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', inputTokens: 4_000_000, latencyMs: 3000 }),
  ];
  const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);
  const assertionStrength = dimensionReport(report, 'assertion-strength');

  it('computes mean cost in USD from JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens, never a hardcoded number', () => {
    const expectedMean = ((2_000_000 * JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens) / 1_000_000
      + (4_000_000 * JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens) / 1_000_000) / 2;
    expect(assertionStrength.cost.value).toBeCloseTo(expectedMean, 10);
  });

  it('computes mean latency in ms', () => {
    expect(assertionStrength.latency.value).toBe(2000);
  });

  it('excludes samples with no recorded latency from the latency sample count', () => {
    const withOneMissingLatency = [
      outcome({ caseId: 'lat-1', operator: 'mock-owned-logic', operatorRole: 'descriptive', level: 'misleading', latencyMs: 500 }),
      outcome({ caseId: 'lat-2', operator: 'mock-owned-logic', operatorRole: 'descriptive', level: 'misleading' }),
    ];
    const testDouble = dimensionReport(computeBenchmarkMetricsReport([run('run-1', withOneMissingLatency)]), 'test-double-quality');
    expect(testDouble.latency.sampleCount).toBe(1);
    expect(testDouble.latency.value).toBe(500);
  });
});

describe('computeBenchmarkMetricsReport: run-to-run stability requires at least two runs, and a varying fixture proves it is not trivially 1.0', () => {
  it('a single run reports stability as not-computable', () => {
    const outcomes = [outcome({ caseId: 's1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' })];
    const report = computeBenchmarkMetricsReport([run('run-1', outcomes)]);
    expect(dimensionReport(report, 'assertion-strength').stability).toEqual({ kind: 'not-computable', numerator: 0, denominator: 0, value: undefined, reason: expect.stringMatching(/two runs/i) });
  });

  it('two disagreeing runs report stability below 1.0 — a fixture that agreed by construction would prove nothing', () => {
    const runOne = [outcome({ caseId: 's1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' })];
    const runTwo = [outcome({ caseId: 's1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'acceptable' })];
    const report = computeBenchmarkMetricsReport([run('run-1', runOne), run('run-2', runTwo)]);
    const stability = dimensionReport(report, 'assertion-strength').stability;
    expect(stability.kind).toBe('below-minimum-sample');
    expect(stability.numerator).toBe(0);
    expect(stability.denominator).toBe(1);
    expect(stability.value).toBe(0);
  });

  it('two agreeing runs on one case, plus a third disagreeing repeat, pool pairwise agreement across all case pairs', () => {
    // case 'agree': same level in all 3 runs -> pairs (1,2)/(1,3)/(2,3) all agree -> 3/3.
    // case 'flip': run-3 disagrees with runs 1 and 2 -> only pair (1,2) agrees -> 1/3.
    // pooled: (3+1) agreeing / (3+3) total = 4/6.
    const level = (value: ClassificationLevel) => value;
    const runs = [
      run('run-1', [
        outcome({ caseId: 'agree', operator: 'weaken-expectation', operatorRole: 'descriptive', level: level('misleading') }),
        outcome({ caseId: 'flip', operator: 'weaken-expectation', operatorRole: 'descriptive', level: level('misleading') }),
      ]),
      run('run-2', [
        outcome({ caseId: 'agree', operator: 'weaken-expectation', operatorRole: 'descriptive', level: level('misleading') }),
        outcome({ caseId: 'flip', operator: 'weaken-expectation', operatorRole: 'descriptive', level: level('misleading') }),
      ]),
      run('run-3', [
        outcome({ caseId: 'agree', operator: 'weaken-expectation', operatorRole: 'descriptive', level: level('misleading') }),
        outcome({ caseId: 'flip', operator: 'weaken-expectation', operatorRole: 'descriptive', level: level('acceptable') }),
      ]),
    ];
    const report = computeBenchmarkMetricsReport(runs);
    const stability = dimensionReport(report, 'assertion-strength').stability;
    expect(stability).toEqual({ kind: 'computed', numerator: 4, denominator: 6, value: 4 / 6, reason: undefined });
  });
});

describe('computeBenchmarkMetricsReport: accuracy metrics count DISTINCT PROVEN CASES, never samples (independent-samples fix)', () => {
  it('one case sampled identically across 5 runs reports recall 1/1 (below-minimum-sample) — never the old 5/5 (computed): the exact defect this fix closes', () => {
    // Same case, same (unanimous) verdict, in all five repetitions — one observation measured
    // five times, not five independent observations. Before this fix this reported
    // `5/5 (100.0%)`, clearing MIN_SAMPLE_FOR_RATE on a denominator that was never five distinct
    // cases.
    const runs = Array.from({ length: 5 }, (_, index) =>
      run(`run-${index + 1}`, [
        outcome({ caseId: 'lone-case', operator: 'pin-implementation-detail', operatorRole: 'descriptive', level: 'misleading' }),
      ]));
    const report = computeBenchmarkMetricsReport(runs);
    const refactorResistance = dimensionReport(report, 'refactor-resistance');

    expect(refactorResistance.provenCaseCount).toBe(1);
    expect(refactorResistance.designatedSampleCount).toBe(5);
    expect(refactorResistance.recall).toEqual({ kind: 'below-minimum-sample', numerator: 1, denominator: 1, value: 1, reason: undefined });
  });

  it('a fixture with 5 total samples but only 2 distinct cases was `computed` under sample-counting and MUST transition to below-minimum-sample under case-counting', () => {
    // 5 samples total (2 + 2 + 1), matching the old MIN_SAMPLE_FOR_RATE=5 threshold on SAMPLES —
    // but only 2 distinct cases. Asserts the actual transition (computed -> below-minimum-sample),
    // not merely a passing number that could be vacuously true either way.
    const runs = [
      run('run-1', [
        outcome({ caseId: 'case-a', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' }),
        outcome({ caseId: 'case-b', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'weak' }),
      ]),
      run('run-2', [
        outcome({ caseId: 'case-a', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' }),
        outcome({ caseId: 'case-b', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'weak' }),
      ]),
      run('run-3', [
        outcome({ caseId: 'case-a', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' }),
      ]),
    ];
    const report = computeBenchmarkMetricsReport(runs);
    const assertionStrength = dimensionReport(report, 'assertion-strength');

    expect(assertionStrength.designatedSampleCount).toBe(5);
    expect(assertionStrength.provenCaseCount).toBe(2);
    expect(assertionStrength.recall.denominator).toBe(2);
    expect(assertionStrength.recall.kind).toBe('below-minimum-sample');
  });
});

describe('computeBenchmarkMetricsReport: disagreeing repetitions collapse to ONE observation per case by majority vote; an exact tie is excluded and disclosed, never guessed at', () => {
  it('a case judged deficient in 3 runs and healthy in 2 collapses to ONE deficient observation (majority), not double-counted per run', () => {
    const levels: readonly ClassificationLevel[] = ['misleading', 'misleading', 'misleading', 'acceptable', 'acceptable'];
    const runs = levels.map((level, index) =>
      run(`run-${index + 1}`, [
        outcome({ caseId: 'flaky', operator: 'weaken-expectation', operatorRole: 'descriptive', level }),
      ]));
    const report = computeBenchmarkMetricsReport(runs);
    const assertionStrength = dimensionReport(report, 'assertion-strength');

    expect(assertionStrength.recall).toEqual({ kind: 'below-minimum-sample', numerator: 1, denominator: 1, value: 1, reason: undefined });
    expect(assertionStrength.splitVerdictCases).toEqual([]);
  });

  it('an exact tie (2 deficient vs 2 healthy repetitions) is excluded from the confusion matrix and reported as a split verdict, never guessed at', () => {
    const levels: readonly ClassificationLevel[] = ['misleading', 'misleading', 'acceptable', 'acceptable'];
    const runs = levels.map((level, index) =>
      run(`run-${index + 1}`, [
        outcome({ caseId: 'tied', operator: 'weaken-expectation', operatorRole: 'descriptive', level }),
      ]));
    const report = computeBenchmarkMetricsReport(runs);
    const assertionStrength = dimensionReport(report, 'assertion-strength');

    expect(assertionStrength.recall).toEqual({ kind: 'not-computable', numerator: 0, denominator: 0, value: undefined, reason: expect.stringMatching(/descriptive/i) });
    expect(assertionStrength.splitVerdictCases).toHaveLength(1);
    expect(assertionStrength.splitVerdictCases[0]!.caseId).toBe('tied');
    expect(assertionStrength.splitVerdictCases[0]!.reasons[0]).toMatch(/tied|no majority/i);
  });
});

describe('computeBenchmarkMetricsReport: calibration collapses repeated probability estimates to ONE mean-mass observation per case', () => {
  it('computes the Brier score from the MEAN deficientMass across repetitions, not the mean of per-repetition Brier scores', () => {
    // Ground truth deficient (descriptive). Two repetitions of the SAME case: deficientMass 0.9
    // and 0.5. Mean mass = 0.7 -> Brier = (0.7-1)^2 = 0.09.
    // If Brier were instead averaged PER SAMPLE (the old, now-wrong behavior):
    // (0.9-1)^2=0.01, (0.5-1)^2=0.25 -> mean = 0.13 -- a DIFFERENT number, proving the two
    // collapse rules are not interchangeable.
    const runs = [
      run('run-1', [outcome({ caseId: 'c1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', deficientMass: 0.9 })]),
      run('run-2', [outcome({ caseId: 'c1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', deficientMass: 0.5 })]),
    ];
    const report = computeBenchmarkMetricsReport(runs);
    const assertionStrength = dimensionReport(report, 'assertion-strength');

    expect(assertionStrength.calibration.sampleCount).toBe(1);
    expect(assertionStrength.calibration.value).toBeCloseTo(0.09, 10);
  });
});

describe('computeBenchmarkMetricsReport: cost and latency stay computed over SAMPLES, never collapsed by case — repetition is genuinely the measurement there', () => {
  it('one case sampled 3 times with distinct cost/latency reports sampleCount 3 for both, never 1 (the metrics this fix must NOT touch)', () => {
    const runs = [
      run('run-1', [outcome({ caseId: 'c1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', inputTokens: 1_000_000, latencyMs: 100 })]),
      run('run-2', [outcome({ caseId: 'c1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', inputTokens: 2_000_000, latencyMs: 200 })]),
      run('run-3', [outcome({ caseId: 'c1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading', inputTokens: 3_000_000, latencyMs: 300 })]),
    ];
    const report = computeBenchmarkMetricsReport(runs);
    const assertionStrength = dimensionReport(report, 'assertion-strength');

    expect(assertionStrength.cost.sampleCount).toBe(3);
    expect(assertionStrength.latency.sampleCount).toBe(3);
    expect(assertionStrength.latency.value).toBe(200);
  });
});

describe('computeBenchmarkMetricsReport: needs-review routing also collapses to one observation per case', () => {
  it('a case that needs-reviews on a dimension in 3 of 5 runs routes as needs-review ONCE for that dimension (majority), not 3/5', () => {
    const needsReviewFlags: readonly boolean[] = [true, true, true, false, false];
    const runs = needsReviewFlags.map((needsReview, index) => {
      const base = outcome({ caseId: 'r1', operator: 'weaken-expectation', operatorRole: 'descriptive', level: 'misleading' });
      if (!needsReview || base.sample === undefined) return run(`run-${index + 1}`, [base]);
      const withNeedsReview: DimensionJudgment[] = base.sample.classification.dimensions.map((dimensionJudgment) =>
        (dimensionJudgment.dimensionId === 'behavioral-focus'
          ? { ...dimensionJudgment, status: 'needs-review' as const, level: undefined, reason: 'boundary-straddle' as const }
          : dimensionJudgment));
      return run(`run-${index + 1}`, [{
        ...base,
        sample: { ...base.sample, classification: { ...base.sample.classification, dimensions: withNeedsReview } },
      }]);
    });
    const report = computeBenchmarkMetricsReport(runs);
    const behavioralFocus = dimensionReport(report, 'behavioral-focus');

    expect(behavioralFocus.needsReviewRouting).toEqual({ kind: 'below-minimum-sample', numerator: 1, denominator: 1, value: 1, reason: undefined });
  });
});
