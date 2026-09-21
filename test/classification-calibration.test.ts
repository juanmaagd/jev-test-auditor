/**
 * Phase 9 calibration tests: verifies the calibrated boundary-mass classification policy
 * against mathematical and behavioral edge cases across all seven rubric dimensions.
 *
 * Checks:
 * 1. Exact boundary behavior for sideMin (0.65) and criticalMin (0.50).
 * 2. Inviolable non-compensatory verdict composition: a single misleading dimension forces
 *    the verdict to misleading regardless of 6 strong dimensions.
 * 3. Legitimate needs-review routing on boundary straddles (mass < 0.65 on both sides).
 * 4. Stability of calibrated policy version pinning against RUBRIC_V2.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_POLICY_V2,
  classifyEvaluation,
} from '../src/domain/classification.js';
import { RUBRIC_V2, type Rubric } from '../src/domain/rubric.js';
import type { JevAnswer, JevEvaluation, JevNoulAnswer, JevScoreAnswer } from '../src/domain/jev-gateway.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

function noulAnswer(probability: number): JevNoulAnswer {
  return { type: 'noul', probability, raw: { type: 'noul', noul: probability } };
}

function scoreAnswer(probabilities: Record<'0' | '1' | '2' | '3', number>, score?: number): JevScoreAnswer {
  const legend = { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' };
  const computedScore = score ?? (
    probabilities['0'] * 0 +
    probabilities['1'] * 1 +
    probabilities['2'] * 2 +
    probabilities['3'] * 3
  );
  return {
    type: 'score',
    score: computedScore,
    legend,
    probabilities,
    confidence: 0.9,
    raw: { type: 'score', score: computedScore, legend, probabilities, confidence: 0.9 },
  };
}

const SINGLE_DIMENSION_RUBRIC: Rubric = {
  version: 2,
  model: 'jev-1.13.0',
  dimensions: [RUBRIC_V2.dimensions.find((d) => d.id === 'falsifiability')!],
};

function judgeFalsifiability(probabilities: Record<'0' | '1' | '2' | '3', number>, score?: number) {
  const result = classifyEvaluation({
    testCase: {
      testCaseId: 'tc:calibration-test' as TestCaseId,
      repositoryRelativePath: 'cart.test.ts',
      name: 'calibration boundary test',
    },
    evaluation: {
      requestedModel: 'jev-1.13.0',
      respondedModel: 'jev-1.13.0',
      modelMatchesPin: true,
      answers: {
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(probabilities, score),
      },
      usage: { inputTokens: 10, outputTokens: 5 },
      attempts: 1,
    },
    rubric: SINGLE_DIMENSION_RUBRIC,
    policy: CLASSIFICATION_POLICY_V2,
  });
  return result.dimensions[0]!;
}

describe('calibrated policy V2 boundary verification', () => {
  it('sideMin boundary: exactly 0.65 on deficient side is judged deficient', () => {
    // Deficient mass = 0.40 + 0.25 = 0.65 (clears sideMin >= 0.65)
    // Critical mass (level 0) = 0.40 (< criticalMin 0.50) -> level: 'weak'
    const judgment = judgeFalsifiability({ '0': 0.40, '1': 0.25, '2': 0.20, '3': 0.15 });

    expect(judgment.status).toBe('judged');
    expect(judgment.level).toBe('weak');
    expect(judgment.deficientMass).toBeCloseTo(0.65, 5);
  });

  it('sideMin boundary: 0.64 on deficient side straddles the boundary and yields needs-review', () => {
    // Deficient mass = 0.64 (< 0.65), acceptable mass = 0.36 (< 0.65) -> boundary-straddle
    const judgment = judgeFalsifiability({ '0': 0.34, '1': 0.30, '2': 0.20, '3': 0.16 });

    expect(judgment.status).toBe('needs-review');
    expect(judgment.reason).toBe('boundary-straddle');
    expect(judgment.level).toBeUndefined();
  });

  it('criticalMin boundary: exactly 0.50 on level 0 triggers misleading', () => {
    // Deficient mass = 0.50 + 0.30 = 0.80 (clears sideMin)
    // Critical mass (level 0) = 0.50 (clears criticalMin >= 0.50) -> level: 'misleading'
    const judgment = judgeFalsifiability({ '0': 0.50, '1': 0.30, '2': 0.10, '3': 0.10 });

    expect(judgment.status).toBe('judged');
    expect(judgment.level).toBe('misleading');
    expect(judgment.criticalMass).toBeCloseTo(0.50, 5);
  });

  it('criticalMin boundary: 0.49 on level 0 stays weak, avoiding unproven critical accusations', () => {
    // Deficient mass = 0.49 + 0.31 = 0.80 (clears sideMin)
    // Critical mass (level 0) = 0.49 (< criticalMin 0.50) -> level: 'weak'
    const judgment = judgeFalsifiability({ '0': 0.49, '1': 0.31, '2': 0.10, '3': 0.10 });

    expect(judgment.status).toBe('judged');
    expect(judgment.level).toBe('weak');
    expect(judgment.criticalMass).toBeCloseTo(0.49, 5);
  });

  it('acceptable side: mass >= 0.65 with score >= 3 yields strong, otherwise acceptable', () => {
    // Acceptable mass = 0.10 + 0.80 = 0.90, score = 2.7 (< 3) -> acceptable
    const j1 = judgeFalsifiability({ '0': 0, '1': 0.10, '2': 0.10, '3': 0.80 }, 2.7);
    expect(j1.status).toBe('judged');
    expect(j1.level).toBe('acceptable');

    // Score = 3.0 (>= 3) -> strong
    const j2 = judgeFalsifiability({ '0': 0, '1': 0, '2': 0, '3': 1.0 }, 3.0);
    expect(j2.status).toBe('judged');
    expect(j2.level).toBe('strong');
  });

  it('inviolable non-compensatory composition: 6 strong dimensions cannot cancel 1 misleading failure', () => {
    const answers: Record<string, JevAnswer> = {};

    for (const dim of RUBRIC_V2.dimensions) {
      answers[`${dim.id}.applicable`] = noulAnswer(0.95);

      if (dim.id === 'falsifiability') {
        // Critical failure on falsifiability
        answers[`${dim.id}.quality`] = scoreAnswer({ '0': 0.90, '1': 0.05, '2': 0.03, '3': 0.02 });
      } else {
        // Strong on all other 6 dimensions
        answers[`${dim.id}.quality`] = scoreAnswer({ '0': 0, '1': 0, '2': 0.05, '3': 0.95 }, 2.95);
      }
    }

    const evaluation: JevEvaluation = {
      requestedModel: 'jev-1.13.0',
      respondedModel: 'jev-1.13.0',
      modelMatchesPin: true,
      answers,
      usage: { inputTokens: 100, outputTokens: 50 },
      attempts: 1,
    };

    const result = classifyEvaluation({
      testCase: {
        testCaseId: 'tc:non-compensatory-check' as TestCaseId,
        repositoryRelativePath: 'cart.test.ts',
        name: 'test with one fatal flaw',
      },
      evaluation,
      rubric: RUBRIC_V2,
      policy: CLASSIFICATION_POLICY_V2,
    });

    expect(result.status).toBe('misleading');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.dimensionId).toBe('falsifiability');
    expect(result.findings[0]?.level).toBe('misleading');
  });
});
