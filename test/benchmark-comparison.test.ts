import { describe, expect, it } from 'vitest';
import {
  compareBenchmarkRuns,
  isCaseCorrect,
} from '../src/domain/benchmark-comparison.js';
import type { BenchmarkCaseOutcome, BenchmarkSampleRecord } from '../src/domain/benchmark-store.js';
import type { ClassificationResult, OverallClassificationStatus } from '../src/domain/classification.js';
import type { CorpusOperatorRole } from '../src/domain/corpus.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

function classification(caseId: string, status: OverallClassificationStatus, policyVersion: number, rubricVersion: number, model = 'jev-1.13.0'): ClassificationResult {
  return {
    testCaseId: `tc:${caseId}` as TestCaseId,
    repositoryRelativePath: 'test.ts',
    name: caseId,
    status,
    dimensions: [],
    findings: [],
    policyVersion,
    rubricVersion,
    model: { requested: model, responded: model, matchesPin: true },
    usage: { inputTokens: 111, outputTokens: 22 },
  };
}

function sample(caseId: string, status: OverallClassificationStatus, policyVersion = 2, rubricVersion = 2, model = 'jev-1.13.0'): BenchmarkSampleRecord {
  return {
    classification: classification(caseId, status, policyVersion, rubricVersion, model),
    policyVersion,
    rubricVersion,
    model: { requested: model, responded: model, matchesPin: true },
    usage: { inputTokens: 111, outputTokens: 22 },
  };
}

interface CaseOverrides {
  readonly operatorRole?: CorpusOperatorRole;
  readonly fixtureHash?: string;
  readonly proofStatus?: BenchmarkCaseOutcome['proofStatus'];
  readonly sample?: BenchmarkSampleRecord;
  readonly operator?: BenchmarkCaseOutcome['operator'];
  readonly oracleKind?: BenchmarkCaseOutcome['oracleKind'];
  readonly expectedOutcome?: BenchmarkCaseOutcome['expectedOutcome'];
}

function outcome(caseId: string, overrides: CaseOverrides = {}): BenchmarkCaseOutcome {
  return {
    caseId,
    operator: overrides.operator ?? 'remove-assertion',
    operatorRole: overrides.operatorRole ?? 'descriptive',
    oracleKind: overrides.oracleKind ?? 'production-mutation',
    expectedOutcome: overrides.expectedOutcome ?? 'expected-to-fail',
    fixtureHash: overrides.fixtureHash ?? `hash-${caseId}`,
    proofStatus: overrides.proofStatus ?? { kind: 'proven' },
    oracleRuns: [],
    ...(overrides.sample === undefined ? {} : { sample: overrides.sample }),
  };
}

describe('isCaseCorrect', () => {
  it('a prescriptive (good-control) case is correct exactly when Jev calls it healthy', () => {
    expect(isCaseCorrect('prescriptive', 'healthy')).toBe(true);
    expect(isCaseCorrect('prescriptive', 'weak')).toBe(false);
    expect(isCaseCorrect('prescriptive', 'misleading')).toBe(false);
    expect(isCaseCorrect('prescriptive', 'needs-review')).toBe(false);
  });

  it('a descriptive (deliberately bad) case is correct exactly when Jev does NOT call it healthy', () => {
    expect(isCaseCorrect('descriptive', 'healthy')).toBe(false);
    expect(isCaseCorrect('descriptive', 'weak')).toBe(true);
    expect(isCaseCorrect('descriptive', 'misleading')).toBe(true);
    expect(isCaseCorrect('descriptive', 'needs-review')).toBe(true);
  });
});

describe('compareBenchmarkRuns: refusal on version mismatch', () => {
  it('refuses when the two runs used different policy versions', () => {
    const baseline = [outcome('a', { sample: sample('a', 'healthy', 2, 6) })];
    const candidate = [outcome('a', { sample: sample('a', 'healthy', 3, 6) })];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toBe('policy-version-mismatch');
      expect(result.detail).toContain('2');
      expect(result.detail).toContain('3');
    }
  });

  it('refuses when the two runs used different rubric versions', () => {
    const baseline = [outcome('a', { sample: sample('a', 'healthy', 2, 5) })];
    const candidate = [outcome('a', { sample: sample('a', 'healthy', 2, 6) })];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('rubric-version-mismatch');
  });

  it('refuses when a run has no successful sample to derive a version identity from at all', () => {
    const baseline: readonly BenchmarkCaseOutcome[] = [outcome('a')];
    const candidate = [outcome('a', { sample: sample('a', 'healthy') })];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('no-successful-samples-in-baseline');
  });

  it('refuses when one run\'s own samples carry more than one distinct (policyVersion, rubricVersion) pair', () => {
    const baseline = [
      outcome('a', { sample: sample('a', 'healthy', 2, 6) }),
      outcome('b', { sample: sample('b', 'weak', 3, 6) }),
    ];
    const candidate = [outcome('a', { sample: sample('a', 'healthy', 2, 6) })];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('mixed-versions-in-baseline');
  });

  it('does NOT refuse on a model mismatch — labelled instead (PRD: regressions between rubric OR MODEL versions)', () => {
    const baseline = [outcome('a', { operatorRole: 'prescriptive', sample: sample('a', 'healthy', 2, 6, 'jev-1.13.0') })];
    const candidate = [outcome('a', { operatorRole: 'prescriptive', sample: sample('a', 'healthy', 2, 6, 'jev-1.14.0') })];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('compared');
    if (result.kind === 'compared') {
      expect(result.modelMismatch).toBe(true);
      expect(result.baselineModel).toBe('jev-1.13.0');
      expect(result.candidateModel).toBe('jev-1.14.0');
    }
  });
});

describe('compareBenchmarkRuns: per-case buckets', () => {
  it('buckets a genuine agreement, a non-regressing disagreement, and a regression individually — never collapsed into one count', () => {
    const baseline = [
      // agreement: identical status both runs
      outcome('agrees', { operatorRole: 'descriptive', sample: sample('agrees', 'misleading') }),
      // disagreement, but still correct both times (descriptive: weak -> misleading, neither is "healthy")
      outcome('disagrees', { operatorRole: 'descriptive', sample: sample('disagrees', 'weak') }),
      // regression: a known-good prescriptive control correctly healthy in baseline...
      outcome('regresses', { operatorRole: 'prescriptive', expectedOutcome: 'expected-to-fail', sample: sample('regresses', 'healthy') }),
    ];
    const candidate = [
      outcome('agrees', { operatorRole: 'descriptive', sample: sample('agrees', 'misleading') }),
      outcome('disagrees', { operatorRole: 'descriptive', sample: sample('disagrees', 'misleading') }),
      // ...but incorrectly demoted to weak in the candidate run: correct -> incorrect is exactly a regression.
      outcome('regresses', { operatorRole: 'prescriptive', expectedOutcome: 'expected-to-fail', sample: sample('regresses', 'weak') }),
    ];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error('expected a comparison');
    expect(result.agreements.map((entry) => entry.caseId)).toEqual(['agrees']);
    expect(result.disagreements.map((entry) => entry.caseId)).toEqual(['disagrees']);
    expect(result.regressions.map((entry) => entry.caseId)).toEqual(['regresses']);
    expect(result.regressions[0]).toEqual({ caseId: 'regresses', baselineStatus: 'healthy', candidateStatus: 'weak' });
  });

  it('excludes a case unproven in either run from every bucket, visibly, rather than averaging it in', () => {
    const baseline = [
      outcome('unproven-baseline', { proofStatus: { kind: 'unproven', reason: 'baseline-failed: x' }, sample: sample('unproven-baseline', 'healthy') }),
      outcome('unproven-candidate', { sample: sample('unproven-candidate', 'healthy') }),
    ];
    const candidate = [
      outcome('unproven-baseline', { sample: sample('unproven-baseline', 'weak') }),
      outcome('unproven-candidate', { proofStatus: { kind: 'unproven', reason: 'baseline-failed: y' }, sample: sample('unproven-candidate', 'weak') }),
    ];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error('expected a comparison');
    expect(result.agreements).toEqual([]);
    expect(result.disagreements).toEqual([]);
    expect(result.regressions).toEqual([]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        { caseId: 'unproven-baseline', reason: 'unproven-in-baseline' },
        { caseId: 'unproven-candidate', reason: 'unproven-in-candidate' },
      ]),
    );
  });

  it('excludes a case not sampled (in either run) rather than treating an absent sample as agreement', () => {
    // Each run also carries one genuinely sampled case ("anchor") so the run itself still has a
    // valid version identity to derive — otherwise a whole run with zero samples would (correctly)
    // be refused before per-case bucketing is ever reached; see the refusal tests above.
    const baseline = [
      outcome('anchor', { sample: sample('anchor', 'healthy') }),
      outcome('no-sample-baseline'),
    ];
    const candidate = [
      outcome('anchor', { sample: sample('anchor', 'healthy') }),
      outcome('no-sample-baseline', { sample: sample('no-sample-baseline', 'healthy') }),
    ];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error('expected a comparison');
    expect(result.excluded).toEqual([{ caseId: 'no-sample-baseline', reason: 'not-sampled-in-baseline' }]);
  });

  it('excludes a case whose fixture bytes changed between the two runs, rather than comparing two different fixtures under one id', () => {
    const baseline = [outcome('drifted', { fixtureHash: 'hash-v1', sample: sample('drifted', 'healthy') })];
    const candidate = [outcome('drifted', { fixtureHash: 'hash-v2', sample: sample('drifted', 'healthy') })];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error('expected a comparison');
    expect(result.excluded).toEqual([{ caseId: 'drifted', reason: 'fixture-changed' }]);
  });

  it('excludes a case whose declared operatorRole changed between runs even when its fixture bytes are unchanged (declaration drift)', () => {
    const baseline = [outcome('redeclared', { operatorRole: 'descriptive', sample: sample('redeclared', 'weak') })];
    const candidate = [outcome('redeclared', { operatorRole: 'prescriptive', sample: sample('redeclared', 'weak') })];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error('expected a comparison');
    expect(result.excluded).toEqual([{ caseId: 'redeclared', reason: 'fixture-changed' }]);
  });

  it('excludes a case present in only one run, naming which side it is missing from', () => {
    const baseline = [
      outcome('both', { sample: sample('both', 'healthy') }),
      outcome('only-baseline', { sample: sample('only-baseline', 'healthy') }),
    ];
    const candidate = [
      outcome('both', { sample: sample('both', 'healthy') }),
      outcome('only-candidate', { sample: sample('only-candidate', 'healthy') }),
    ];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error('expected a comparison');
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        { caseId: 'only-baseline', reason: 'missing-in-candidate' },
        { caseId: 'only-candidate', reason: 'missing-in-baseline' },
      ]),
    );
    expect(result.agreements.map((entry) => entry.caseId)).toEqual(['both']);
  });

  it('sorts every bucket by caseId, independent of input order, for deterministic output', () => {
    const baseline = [
      outcome('zeta', { operatorRole: 'descriptive', sample: sample('zeta', 'weak') }),
      outcome('alpha', { operatorRole: 'descriptive', sample: sample('alpha', 'weak') }),
    ];
    const candidate = [
      outcome('zeta', { operatorRole: 'descriptive', sample: sample('zeta', 'weak') }),
      outcome('alpha', { operatorRole: 'descriptive', sample: sample('alpha', 'weak') }),
    ];

    const result = compareBenchmarkRuns(baseline, candidate);

    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error('expected a comparison');
    expect(result.agreements.map((entry) => entry.caseId)).toEqual(['alpha', 'zeta']);
  });
});
