import { describe, expect, it } from 'vitest';
import type { BenchmarkCaseOutcome, BenchmarkFixtureFile, BenchmarkSampleRecord } from '../src/domain/benchmark-store.js';
import type { ClassificationResult } from '../src/domain/classification.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';
import {
  assertPayloadIsBlind,
  compareReviewAssessment,
  createBlindReviewPayload,
  freezeWorkerAssessment,
  selectBenchmarkReviewCases,
  type BlindReviewWorkerPayload,
  type BlindWorkerAssessment,
} from '../src/domain/benchmark-review.js';

function sampleClassification(caseId: string, level: 'misleading' | 'acceptable'): ClassificationResult {
  return {
    testCaseId: `tc:${caseId}` as TestCaseId,
    repositoryRelativePath: 'test.ts',
    name: caseId,
    status: level === 'misleading' ? 'misleading' : 'healthy',
    dimensions: [
      {
        dimensionId: 'falsifiability',
        dimensionLabel: 'falsifiability',
        applicable: true,
        applicabilityProbability: 0.9,
        level,
        score: level === 'misleading' ? 0 : 2,
        confidence: 0.9,
        status: 'judged',
        reason: undefined,
        probabilities: undefined,
        deficientMass: level === 'misleading' ? 0.9 : 0.1,
        acceptableMass: level === 'misleading' ? 0.1 : 0.9,
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

function sampleRecord(caseId: string, level: 'misleading' | 'acceptable'): BenchmarkSampleRecord {
  return {
    classification: sampleClassification(caseId, level),
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 120,
  };
}

function mockCaseOutcome(overrides: Partial<BenchmarkCaseOutcome> = {}): BenchmarkCaseOutcome {
  return {
    caseId: 'test-case-1',
    operator: 'remove-assertion',
    operatorRole: 'descriptive',
    oracleKind: 'production-mutation',
    expectedOutcome: 'expected-to-keep-passing',
    fixtureHash: 'hash-abc-123',
    proofStatus: { kind: 'proven' },
    oracleRuns: [
      {
        label: 'base-under-mutation',
        observation: { kind: 'passed' },
        contentHash: 'run-hash-1',
        mutatedFiles: ['tax.ts'],
      },
    ],
    sample: sampleRecord('test-case-1', 'acceptable'), // Jev mistakenly thought this defective test was acceptable!
    ...overrides,
  };
}

const mockFixtureFiles: readonly BenchmarkFixtureFile[] = [
  { path: 'test.ts', contents: 'it("checks tax", () => { expect(1).toBe(1); });' },
  { path: 'tax.ts', contents: 'export function computeTax(x: number) { return x * 0.1; }' },
];

describe('selectBenchmarkReviewCases', () => {
  it('selects all cases when selectionKind is "all"', () => {
    const outcomes = [
      mockCaseOutcome({ caseId: 'case-1' }),
      mockCaseOutcome({ caseId: 'case-2' }),
    ];

    const selected = selectBenchmarkReviewCases(outcomes, { selectionKind: 'all' });
    expect(selected.map((c) => c.caseId)).toEqual(['case-1', 'case-2']);
  });

  it('selects only disagreements where Jev diverged from ground truth', () => {
    // case-1 is descriptive (deliberately defective, ground truth: deficient), but Jev said acceptable -> disagreement
    const case1 = mockCaseOutcome({ caseId: 'case-1', operatorRole: 'descriptive', sample: sampleRecord('case-1', 'acceptable') });
    // case-2 is descriptive, and Jev said misleading -> agreement
    const case2 = mockCaseOutcome({ caseId: 'case-2', operatorRole: 'descriptive', sample: sampleRecord('case-2', 'misleading') });
    // case-3 is prescriptive (good test, ground truth: acceptable), but Jev said misleading -> disagreement
    const case3 = mockCaseOutcome({ caseId: 'case-3', operatorRole: 'prescriptive', sample: sampleRecord('case-3', 'misleading') });

    const selected = selectBenchmarkReviewCases([case1, case2, case3], { selectionKind: 'disagreements' });
    expect(selected.map((c) => c.caseId)).toEqual(['case-1', 'case-3']);
  });

  it('filters by dimension and applies limit', () => {
    const case1 = mockCaseOutcome({ caseId: 'case-1', operator: 'remove-assertion' }); // falsifiability
    const case2 = mockCaseOutcome({ caseId: 'case-2', operator: 'weaken-expectation' }); // assertion-strength
    const case3 = mockCaseOutcome({ caseId: 'case-3', operator: 'remove-assertion' }); // falsifiability

    const selected = selectBenchmarkReviewCases([case1, case2, case3], {
      selectionKind: 'all',
      dimension: 'falsifiability',
      limit: 1,
    });

    expect(selected.map((c) => c.caseId)).toEqual(['case-1']);
  });
});

describe('createBlindReviewPayload and assertPayloadIsBlind', () => {
  it('constructs a complete reviewer payload from fixture files and oracle proof without Jev data', () => {
    const outcome = mockCaseOutcome();
    const payload = createBlindReviewPayload(outcome, mockFixtureFiles);

    expect(payload.caseId).toBe('test-case-1');
    expect(payload.operator).toBe('remove-assertion');
    expect(payload.operatorRole).toBe('descriptive');
    expect(payload.expectedOutcome).toBe('expected-to-keep-passing');
    expect(payload.testSource).toContain('checks tax');
    expect(payload.productionSources).toEqual([
      { path: 'tax.ts', contents: 'export function computeTax(x: number) { return x * 0.1; }' },
    ]);
    expect(payload.oracleProof.status).toEqual({ kind: 'proven' });
    expect(payload.rubricCriteria.length).toBeGreaterThan(0);

    // Verifies the blindness invariant passes on a clean payload
    expect(() => assertPayloadIsBlind(payload)).not.toThrow();
  });

  it('assertPayloadIsBlind throws if any Jev-specific verdict fields are leaked into the payload', () => {
    const outcome = mockCaseOutcome();
    const payload = createBlindReviewPayload(outcome, mockFixtureFiles);

    // Contaminate the payload with Jev fields
    const contaminated = {
      ...payload,
      sample: outcome.sample,
      classification: outcome.sample?.classification,
    } as unknown as BlindReviewWorkerPayload;

    expect(() => assertPayloadIsBlind(contaminated)).toThrow(/blindness violation/i);
  });
});

describe('freezeWorkerAssessment', () => {
  it('freezes a blind worker assessment with input hash and timestamp', () => {
    const assessment: BlindWorkerAssessment = {
      caseId: 'test-case-1',
      assessedDimensions: [
        {
          dimensionId: 'falsifiability',
          level: 'misleading',
          score: 0,
          confidence: 0.95,
          reasoning: 'The test body contains a tautology and never executes computeTax.',
          evidenceCitations: ['expect(1).toBe(1)'],
        },
      ],
      overallUncertainty: 0.05,
      notes: 'Clear violation of falsifiability.',
    };

    const frozen = freezeWorkerAssessment({
      caseId: 'test-case-1',
      inputPayloadHash: 'sha256-payload-hash-xyz',
      frozenAt: '2026-09-21T21:00:00.000Z',
      workerIdentity: { runtime: 'antigravity-subagent', model: 'claude-3-7-sonnet' },
      assessment,
    });

    expect(frozen.caseId).toBe('test-case-1');
    expect(frozen.inputPayloadHash).toBe('sha256-payload-hash-xyz');
    expect(frozen.frozenAt).toBe('2026-09-21T21:00:00.000Z');
    expect(frozen.workerIdentity?.runtime).toBe('antigravity-subagent');
    expect(frozen.assessment.assessedDimensions[0]?.level).toBe('misleading');
  });
});

describe('compareReviewAssessment', () => {
  const oracleOutcome = {
    operatorRole: 'descriptive' as const, // Ground truth: deficient (flawed test)
    expectedOutcome: 'expected-to-keep-passing' as const,
    proofStatus: { kind: 'proven' as const },
  };

  it('identifies agreement when both Jev and the reviewer agree on the assessment', () => {
    // Jev correctly judged misleading
    const jevSample = sampleRecord('case-1', 'misleading');
    const frozen = freezeWorkerAssessment({
      caseId: 'case-1',
      inputPayloadHash: 'hash-1',
      frozenAt: '2026-09-21T21:00:00.000Z',
      assessment: {
        caseId: 'case-1',
        assessedDimensions: [
          { dimensionId: 'falsifiability', level: 'misleading', score: 0, confidence: 0.9, reasoning: 'flawed', evidenceCitations: [] },
        ],
        overallUncertainty: 0.1,
      },
    });

    const comparison = compareReviewAssessment(frozen, jevSample, oracleOutcome);
    expect(comparison.agreement).toBe(true);
    expect(comparison.discrepancyKind).toBeUndefined();
  });

  it('classifies as "likely-model-error" when Jev misclassified but the blind reviewer agreed with oracle ground truth', () => {
    // Jev said acceptable (wrong!), reviewer said misleading (matches oracle ground truth!)
    const jevSample = sampleRecord('case-1', 'acceptable');
    const frozen = freezeWorkerAssessment({
      caseId: 'case-1',
      inputPayloadHash: 'hash-1',
      frozenAt: '2026-09-21T21:00:00.000Z',
      assessment: {
        caseId: 'case-1',
        assessedDimensions: [
          { dimensionId: 'falsifiability', level: 'misleading', score: 0, confidence: 0.9, reasoning: 'never calls function', evidenceCitations: [] },
        ],
        overallUncertainty: 0.1,
      },
    });

    const comparison = compareReviewAssessment(frozen, jevSample, oracleOutcome);
    expect(comparison.agreement).toBe(false);
    expect(comparison.discrepancyKind).toBe('likely-model-error');
  });

  it('classifies as "unsupported-disagreement" when the blind reviewer contradicts the proven deterministic oracle', () => {
    // Ground truth is deficient (descriptive flaw). Jev correctly said misleading. Reviewer wrongly said acceptable!
    const jevSample = sampleRecord('case-1', 'misleading');
    const frozen = freezeWorkerAssessment({
      caseId: 'case-1',
      inputPayloadHash: 'hash-1',
      frozenAt: '2026-09-21T21:00:00.000Z',
      assessment: {
        caseId: 'case-1',
        assessedDimensions: [
          { dimensionId: 'falsifiability', level: 'acceptable', score: 2, confidence: 0.9, reasoning: 'looks fine to me', evidenceCitations: [] },
        ],
        overallUncertainty: 0.1,
      },
    });

    const comparison = compareReviewAssessment(frozen, jevSample, oracleOutcome);
    expect(comparison.agreement).toBe(false);
    expect(comparison.discrepancyKind).toBe('unsupported-disagreement');
  });

  it('classifies as "rubric-ambiguity" when there is a disagreement and the reviewer expressed high uncertainty', () => {
    const jevSample = sampleRecord('case-1', 'acceptable');
    const frozen = freezeWorkerAssessment({
      caseId: 'case-1',
      inputPayloadHash: 'hash-1',
      frozenAt: '2026-09-21T21:00:00.000Z',
      assessment: {
        caseId: 'case-1',
        assessedDimensions: [
          { dimensionId: 'falsifiability', level: 'misleading', score: 1, confidence: 0.4, reasoning: 'rubric wording is unclear on this criterion', evidenceCitations: [] },
        ],
        overallUncertainty: 0.6, // High uncertainty (> 0.5)
        notes: 'The rubric criterion does not specify whether implicit assertions count.',
      },
    });

    const comparison = compareReviewAssessment(frozen, jevSample, oracleOutcome);
    expect(comparison.agreement).toBe(false);
    expect(comparison.discrepancyKind).toBe('rubric-ambiguity');
  });

  it('classifies as "context-selection-error" when the reviewer explicitly reports missing production context', () => {
    const jevSample = sampleRecord('case-1', 'acceptable');
    const frozen = freezeWorkerAssessment({
      caseId: 'case-1',
      inputPayloadHash: 'hash-1',
      frozenAt: '2026-09-21T21:00:00.000Z',
      assessment: {
        caseId: 'case-1',
        assessedDimensions: [
          { dimensionId: 'falsifiability', level: 'misleading', score: 0, confidence: 0.8, reasoning: 'Missing import context', evidenceCitations: [] },
        ],
        overallUncertainty: 0.2,
        notes: 'Context selection error: helper dependency auth.ts was omitted from the bundle.',
      },
    });

    const comparison = compareReviewAssessment(frozen, jevSample, oracleOutcome);
    expect(comparison.agreement).toBe(false);
    expect(comparison.discrepancyKind).toBe('context-selection-error');
  });
});

describe('jev-benchmark-review skill specification', () => {
  it('has valid frontmatter and documents the four discrepancy kinds and blindness invariant', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const skillPath = join(process.cwd(), 'skills/jev-benchmark-review/SKILL.md');

    const content = await readFile(skillPath, 'utf-8');
    expect(content).toMatch(/^---\r?\nname:\s*jev-benchmark-review\r?\ndescription:/);
    expect(content).toContain('likely-model-error');
    expect(content).toContain('unsupported-disagreement');
    expect(content).toContain('rubric-ambiguity');
    expect(content).toContain('context-selection-error');
    expect(content).toContain('Strict blindness invariant');
  });
});
