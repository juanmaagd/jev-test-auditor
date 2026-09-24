/**
 * Replays the only oracle-labelled Jev samples recorded so far
 * (`test/fixtures/recorded/benchmark-oracle-samples-2026-09-21.json`: the five
 * P7-4 stability runs, 11 proven corpus cases x 5 repetitions) through the real
 * `classifyEvaluation`, offline. Ground truth is each case's operator role,
 * proven by executable oracle: a descriptive case is deliberately deficient on
 * its designated dimension, a prescriptive case is a good control.
 *
 * Preserves this evidence in the repository (task T4 of
 * `odd/tasks/policy-free-cache-and-calibration.md`) and pins what it shows: the
 * shipped policy agrees with the oracle on every sample. It also pins what it
 * cannot show: every designated dimension is decisive (at least 0.85 mass on one
 * side), so these samples say nothing about accuracy inside the boundary band.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_POLICY_V2,
  CLASSIFICATION_POLICY_V3,
  classifyEvaluation,
  type ClassificationPolicy,
  type ClassificationResult,
} from '../src/domain/classification.js';
import type { JevAnswer, JevEvaluation } from '../src/domain/jev-gateway.js';
import { RUBRIC_V2 } from '../src/domain/rubric.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

interface RecordedDimension {
  readonly dimensionId: string;
  readonly applicabilityProbability: number;
  readonly recordedStatus: string;
  readonly recordedLevel?: string;
  readonly score?: number;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

interface OracleSample {
  readonly run: number;
  readonly caseId: string;
  readonly operator: string;
  readonly operatorRole: 'descriptive' | 'prescriptive';
  readonly proofStatus: string;
  readonly designatedDimension: string;
  readonly truthDeficient: boolean;
  readonly policyVersion: number;
  readonly rubricVersion: number;
  readonly modelRequested: string;
  readonly modelResponded: string;
  readonly modelMatchesPin: boolean;
  readonly recordedStatus: ClassificationResult['status'];
  readonly dimensions: readonly RecordedDimension[];
}

const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/recorded/benchmark-oracle-samples-2026-09-21.json', import.meta.url)),
  'utf8',
)) as { readonly samples: readonly OracleSample[] };

const RUBRIC_BY_DIMENSION = new Map(RUBRIC_V2.dimensions.map((dimension) => [dimension.id as string, dimension]));
const LEGEND = { 0: 'Misleading', 1: 'Weak', 2: 'Acceptable', 3: 'Strong' };

function toEvaluation(sample: OracleSample): JevEvaluation {
  const answers: Record<string, JevAnswer> = {};
  for (const dimension of sample.dimensions) {
    const rubricDimension = RUBRIC_BY_DIMENSION.get(dimension.dimensionId);
    if (rubricDimension === undefined) throw new Error(`unknown dimension ${dimension.dimensionId}`);
    const noul = dimension.applicabilityProbability;
    answers[rubricDimension.applicability.id] = { type: 'noul', probability: noul, raw: { type: 'noul', noul } };
    if (dimension.probabilities !== undefined && dimension.score !== undefined && dimension.confidence !== undefined) {
      const raw = { type: 'score' as const, score: dimension.score, legend: LEGEND, probabilities: dimension.probabilities, confidence: dimension.confidence };
      answers[rubricDimension.quality.id] = { ...raw, raw };
    }
  }
  return {
    requestedModel: sample.modelRequested,
    respondedModel: sample.modelResponded,
    modelMatchesPin: sample.modelMatchesPin,
    answers,
    usage: { inputTokens: 0, outputTokens: 0 },
    attempts: 1,
  };
}

function classify(sample: OracleSample, policy: ClassificationPolicy): ClassificationResult {
  return classifyEvaluation({
    testCase: { testCaseId: `tc:oracle:${sample.caseId}` as TestCaseId, repositoryRelativePath: 'test.ts', name: sample.caseId },
    evaluation: toEvaluation(sample),
    rubric: RUBRIC_V2,
    policy,
  });
}

/** Deficient/acceptable side of the designated dimension, or its non-judged status. */
function designatedSide(sample: OracleSample, policy: ClassificationPolicy): string {
  const dimension = classify(sample, policy).dimensions.find((entry) => entry.dimensionId === sample.designatedDimension);
  if (dimension === undefined || dimension.status !== 'judged') return dimension?.status ?? 'missing';
  return dimension.level === 'misleading' || dimension.level === 'weak' ? 'deficient' : 'acceptable';
}

describe('oracle-labelled benchmark samples (P7-4 recording, 2026-09-21)', () => {
  it('holds 55 proven samples of 11 distinct cases (8 descriptive, 3 prescriptive), recorded under policy v2 and rubric v2', () => {
    expect(FIXTURE.samples).toHaveLength(55);
    expect(new Set(FIXTURE.samples.map((sample) => sample.caseId)).size).toBe(11);
    expect(FIXTURE.samples.every((sample) => sample.proofStatus === 'proven')).toBe(true);
    expect(new Set(FIXTURE.samples.filter((sample) => sample.truthDeficient).map((sample) => sample.caseId)).size).toBe(8);
    expect(new Set(FIXTURE.samples.filter((sample) => !sample.truthDeficient).map((sample) => sample.caseId)).size).toBe(3);
    expect(FIXTURE.samples.every((sample) => sample.policyVersion === 2 && sample.rubricVersion === 2)).toBe(true);
  });

  it('replaying under policy v2 reproduces every recorded overall status (the export lost nothing the policy reads)', () => {
    for (const sample of FIXTURE.samples) {
      expect(classify(sample, CLASSIFICATION_POLICY_V2).status, `${sample.caseId} run ${sample.run}`).toBe(sample.recordedStatus);
    }
  });

  it('under the shipped policy v3, the designated dimension agrees with the oracle on all 55 samples: 40/40 deficient, 15/15 acceptable, none left for review', () => {
    const tally = { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0, undecided: 0 };
    for (const sample of FIXTURE.samples) {
      const side = designatedSide(sample, CLASSIFICATION_POLICY_V3);
      if (side === 'deficient') tally[sample.truthDeficient ? 'truePositive' : 'falsePositive'] += 1;
      else if (side === 'acceptable') tally[sample.truthDeficient ? 'falseNegative' : 'trueNegative'] += 1;
      else tally.undecided += 1;
    }

    expect(tally).toEqual({ truePositive: 40, trueNegative: 15, falsePositive: 0, falseNegative: 0, undecided: 0 });
    expect(FIXTURE.samples.filter((sample) => classify(sample, CLASSIFICATION_POLICY_V3).status === 'needs-review')).toHaveLength(0);
  });

  it('cannot inform the boundary band: every designated dimension carries at least 0.85 of its mass on one side', () => {
    for (const sample of FIXTURE.samples) {
      const dimension = sample.dimensions.find((entry) => entry.dimensionId === sample.designatedDimension);
      const probabilities = dimension?.probabilities ?? {};
      const deficientMass = (probabilities['0'] ?? 0) + (probabilities['1'] ?? 0);
      expect(Math.max(deficientMass, 1 - deficientMass), `${sample.caseId} run ${sample.run}`).toBeGreaterThanOrEqual(0.85);
    }
  });
});
