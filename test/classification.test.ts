import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_POLICY_V1,
  CLASSIFICATION_POLICY_V2,
  CLASSIFICATION_POLICY_V3,
  classifyEvaluation,
  validateClassificationPolicy,
  type ClassificationPolicy,
  type ClassificationPolicyV2,
  type ClassificationTestCaseIdentity,
  type DimensionJudgment,
} from '../src/domain/classification.js';
import { JEV_MODEL_ID, RUBRIC_V2, type Rubric, type RubricDimension, type RubricDimensionId, type RubricNoulQuestion, type RubricScoreQuestion } from '../src/domain/rubric.js';
import type { JevAnswer, JevEvaluation, JevNoulAnswer, JevScoreAnswer } from '../src/domain/jev-gateway.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

// --- Fixtures ------------------------------------------------------------

function noulQuestion(id: string): RubricNoulQuestion {
  return { id, type: 'noul', instructions: 'Is there enough evidence?', criteria: { true: 'yes', false: 'no' } };
}

function scoreQuestion(id: string): RubricScoreQuestion {
  return {
    id,
    type: 'score',
    instructions: 'How good is it?',
    criteria: ['Misleading: bad.', 'Weak: meh.', 'Acceptable: fine.', 'Strong: great.'],
  };
}

function dim(id: RubricDimensionId, label: string): RubricDimension {
  return {
    id,
    label,
    applicability: noulQuestion(`${id}.applicable`),
    quality: scoreQuestion(`${id}.quality`),
  };
}

/** A one-dimension rubric, for isolated per-dimension judgment tests. */
const RUBRIC_ONE: Rubric = {
  version: 1,
  model: JEV_MODEL_ID,
  dimensions: [dim('falsifiability', 'Falsifiability')],
};

/** A two-dimension rubric, for overall-status tests that combine two dimensions. */
const RUBRIC_TWO: Rubric = {
  version: 1,
  model: JEV_MODEL_ID,
  dimensions: [dim('falsifiability', 'Falsifiability'), dim('behavioral-focus', 'Behavioral focus')],
};

/**
 * `RUBRIC_TWO`, pinned to `CLASSIFICATION_POLICY_V2.rubricVersion` (`2`) so
 * the "V2 overall status" tests below — which use `CLASSIFICATION_POLICY_V2`
 * directly, not through `judgeOne` — pass `classifyEvaluation`'s own
 * rubric/policy version-consistency guard. Same synthetic dimensions and
 * generic question text as `RUBRIC_TWO`; only `version` differs.
 */
const RUBRIC_TWO_V2: Rubric = { ...RUBRIC_TWO, version: CLASSIFICATION_POLICY_V2.rubricVersion };

const TEST_CASE: ClassificationTestCaseIdentity = {
  testCaseId: 'tc:v1:abc' as TestCaseId,
  repositoryRelativePath: 'a.test.ts',
  name: 'does the thing',
};

function noulAnswer(probability: number): JevNoulAnswer {
  return { type: 'noul', probability, raw: { type: 'noul', noul: probability } };
}

function scoreAnswer(score: number, confidence: number): JevScoreAnswer {
  const legend = { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' };
  const probabilities = { '0': 0.25, '1': 0.25, '2': 0.25, '3': 0.25 };
  return {
    type: 'score',
    score,
    legend,
    probabilities,
    confidence,
    raw: { type: 'score', score, legend, probabilities, confidence },
  };
}

/**
 * Like {@link scoreAnswer}, but with an explicit, arbitrary `probabilities`
 * map — used by every `CLASSIFICATION_POLICY_V2` (boundary-mass) test,
 * since `scoreAnswer`'s fixed even split (`0.25` each) never decisively
 * clears `sideMin` on either side. `confidence` defaults to `0` to make the
 * point, throughout the V2 test suite, that confidence is no longer a gate:
 * a V2 verdict must not depend on it.
 */
function scoreAnswerWithProbabilities(
  score: number,
  probabilities: Readonly<Record<string, number>>,
  confidence = 0,
): JevScoreAnswer {
  const legend = { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' };
  return {
    type: 'score',
    score,
    legend,
    probabilities,
    confidence,
    raw: { type: 'score', score, legend, probabilities, confidence },
  };
}

function evaluation(answers: Record<string, JevAnswer>, overrides: Partial<JevEvaluation> = {}): JevEvaluation {
  return {
    requestedModel: JEV_MODEL_ID,
    respondedModel: JEV_MODEL_ID,
    modelMatchesPin: true,
    answers,
    usage: { inputTokens: 1000, outputTokens: 0 },
    attempts: 1,
    ...overrides,
  };
}

/**
 * Builds an evaluation over `RUBRIC_ONE`'s single `falsifiability` dimension
 * and returns its judgment. `RUBRIC_ONE`'s `version` is overridden to match
 * `policy.rubricVersion` for this call only: `RUBRIC_ONE` is a synthetic,
 * generic-text fixture unrelated to the real `RUBRIC_V1`/`RUBRIC_V2` wording
 * either policy version was actually calibrated against, so pinning its
 * `version` field to whichever policy is under test exercises that policy's
 * real judging logic without also having to duplicate the fixture per
 * policy version.
 */
function judgeOne(
  answers: Record<string, JevAnswer>,
  policy: ClassificationPolicy = CLASSIFICATION_POLICY_V1,
  evalOverrides: Partial<JevEvaluation> = {},
): DimensionJudgment {
  const result = classifyEvaluation({
    testCase: TEST_CASE,
    evaluation: evaluation(answers, evalOverrides),
    rubric: { ...RUBRIC_ONE, version: policy.rubricVersion },
    policy,
  });
  const judgment = result.dimensions[0];
  if (judgment === undefined) throw new Error('expected exactly one dimension judgment');
  return judgment;
}

const FULLY_APPLICABLE_STRONG = {
  'falsifiability.applicable': noulAnswer(0.9),
  'falsifiability.quality': scoreAnswer(3, 0.9),
};

// --- CLASSIFICATION_POLICY_V1 ---------------------------------------------

describe('CLASSIFICATION_POLICY_V1', () => {
  it('is versioned 1, tied to rubric version 1, and validates without throwing', () => {
    expect(CLASSIFICATION_POLICY_V1.version).toBe(1);
    expect(CLASSIFICATION_POLICY_V1.rubricVersion).toBe(1);
    expect(() => validateClassificationPolicy(CLASSIFICATION_POLICY_V1)).not.toThrow();
  });

  it('sets the provisional applicability and confidence thresholds from the feature decisions', () => {
    expect(CLASSIFICATION_POLICY_V1.applicabilityMin).toBe(0.5);
    expect(CLASSIFICATION_POLICY_V1.confidenceMin).toBe(0.6);
  });

  it('pins the critical level to "misleading"', () => {
    expect(CLASSIFICATION_POLICY_V1.criticalLevel).toBe('misleading');
  });
});

describe('validateClassificationPolicy', () => {
  const valid = CLASSIFICATION_POLICY_V1;

  it('accepts the shipped policy', () => {
    expect(() => validateClassificationPolicy(valid)).not.toThrow();
  });

  it('rejects a non-positive version', () => {
    expect(() => validateClassificationPolicy({ ...valid, version: 0 })).toThrow(RangeError);
  });

  it('rejects a non-integer version', () => {
    expect(() => validateClassificationPolicy({ ...valid, version: 1.5 })).toThrow(RangeError);
  });

  it('rejects a non-positive rubricVersion', () => {
    expect(() => validateClassificationPolicy({ ...valid, rubricVersion: 0 })).toThrow(RangeError);
  });

  it('rejects an applicabilityMin below 0', () => {
    expect(() => validateClassificationPolicy({ ...valid, applicabilityMin: -0.01 })).toThrow(RangeError);
  });

  it('rejects an applicabilityMin above 1', () => {
    expect(() => validateClassificationPolicy({ ...valid, applicabilityMin: 1.01 })).toThrow(RangeError);
  });

  it('accepts applicabilityMin at the 0 and 1 boundaries', () => {
    expect(() => validateClassificationPolicy({ ...valid, applicabilityMin: 0 })).not.toThrow();
    expect(() => validateClassificationPolicy({ ...valid, applicabilityMin: 1 })).not.toThrow();
  });

  it('rejects a confidenceMin below 0', () => {
    expect(() => validateClassificationPolicy({ ...valid, confidenceMin: -0.01 })).toThrow(RangeError);
  });

  it('rejects a confidenceMin above 1', () => {
    expect(() => validateClassificationPolicy({ ...valid, confidenceMin: 1.01 })).toThrow(RangeError);
  });

  it('rejects level cut points that are not strictly ascending (equal values)', () => {
    expect(() => validateClassificationPolicy({ ...valid, levelCutPoints: [1, 1, 3] })).toThrow(RangeError);
  });

  it('rejects level cut points that are not strictly ascending (descending)', () => {
    expect(() => validateClassificationPolicy({ ...valid, levelCutPoints: [2, 1, 3] })).toThrow(RangeError);
  });

  it('rejects a non-finite level cut point', () => {
    expect(() => validateClassificationPolicy({ ...valid, levelCutPoints: [1, Number.NaN, 3] })).toThrow(RangeError);
    expect(() => validateClassificationPolicy({ ...valid, levelCutPoints: [1, 2, Number.POSITIVE_INFINITY] })).toThrow(RangeError);
  });

  it('rejects an unknown critical level', () => {
    expect(() => validateClassificationPolicy({ ...valid, criticalLevel: 'terrible' as ClassificationPolicy['criticalLevel'] })).toThrow(RangeError);
  });
});

// --- Per-dimension judgment -------------------------------------------------

describe('classifyEvaluation — per-dimension judgment', () => {
  it('judges a fully applicable, high-confidence, strong-scoring dimension', () => {
    const judgment = judgeOne(FULLY_APPLICABLE_STRONG);
    expect(judgment).toEqual({
      dimensionId: 'falsifiability',
      dimensionLabel: 'Falsifiability',
      applicable: true,
      applicabilityProbability: 0.9,
      level: 'strong',
      score: 3,
      confidence: 0.9,
      status: 'judged',
      reason: undefined,
    });
  });

  describe('applicability threshold boundary (applicabilityMin = 0.5)', () => {
    it('is not-applicable just below the threshold', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': noulAnswer(0.499),
        'falsifiability.quality': scoreAnswer(3, 0.9),
      });
      expect(judgment.status).toBe('not-applicable');
      expect(judgment.applicable).toBe(false);
      expect(judgment.applicabilityProbability).toBe(0.499);
      expect(judgment.level).toBeUndefined();
      expect(judgment.score).toBeUndefined();
      expect(judgment.confidence).toBeUndefined();
    });

    it('is applicable exactly at the threshold', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': noulAnswer(0.5),
        'falsifiability.quality': scoreAnswer(3, 0.9),
      });
      expect(judgment.status).toBe('judged');
      expect(judgment.applicable).toBe(true);
    });

    it('is applicable just above the threshold', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': noulAnswer(0.501),
        'falsifiability.quality': scoreAnswer(3, 0.9),
      });
      expect(judgment.applicable).toBe(true);
    });
  });

  describe('confidence threshold boundary (confidenceMin = 0.6)', () => {
    it('needs review just below the threshold, recording the score without a level', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(3, 0.599),
      });
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('low-confidence');
      expect(judgment.applicable).toBe(true);
      expect(judgment.score).toBe(3);
      expect(judgment.confidence).toBe(0.599);
      expect(judgment.level).toBeUndefined();
    });

    it('is judged exactly at the threshold', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(3, 0.6),
      });
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('strong');
    });

    it('is judged just above the threshold', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(3, 0.601),
      });
      expect(judgment.status).toBe('judged');
    });
  });

  describe('level cut points (levelCutPoints = [1, 2, 3])', () => {
    const cases: readonly [number, string][] = [
      [0, 'misleading'],
      [0.999, 'misleading'],
      [1, 'weak'],
      [1.001, 'weak'],
      [1.999, 'weak'],
      [2, 'acceptable'],
      [2.001, 'acceptable'],
      [2.999, 'acceptable'],
      [3, 'strong'],
      [3.5, 'strong'],
    ];

    for (const [score, expectedLevel] of cases) {
      it(`maps score ${score} to level "${expectedLevel}"`, () => {
        const judgment = judgeOne({
          'falsifiability.applicable': noulAnswer(0.9),
          'falsifiability.quality': scoreAnswer(score, 0.9),
        });
        expect(judgment.status).toBe('judged');
        expect(judgment.level).toBe(expectedLevel);
      });
    }
  });

  describe('missing or malformed answers', () => {
    it('needs review when the applicability answer is missing entirely', () => {
      const judgment = judgeOne({
        'falsifiability.quality': scoreAnswer(3, 0.9),
      });
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
      expect(judgment.applicabilityProbability).toBeUndefined();
      expect(judgment.level).toBeUndefined();
    });

    it('needs review when the applicability answer has the wrong shape (a score answer under the applicable id)', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': scoreAnswer(3, 0.9) as unknown as JevAnswer,
        'falsifiability.quality': scoreAnswer(3, 0.9),
      });
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
    });

    it('needs review when the quality answer is missing entirely, never inventing a level', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': noulAnswer(0.9),
      });
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
      expect(judgment.applicabilityProbability).toBe(0.9);
      expect(judgment.applicable).toBe(true);
      expect(judgment.level).toBeUndefined();
      expect(judgment.score).toBeUndefined();
    });

    it('needs review when the quality answer has the wrong shape (a noul answer under the quality id)', () => {
      const judgment = judgeOne({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': noulAnswer(0.9) as unknown as JevAnswer,
      });
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
      expect(judgment.level).toBeUndefined();
    });
  });
});

// --- Overall classification -------------------------------------------------

describe('classifyEvaluation — overall status', () => {
  it('is misleading when any applicable judged dimension is at the critical level', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(0, 0.9), // misleading
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(3, 0.9), // strong
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('misleading');
  });

  it('a strong dimension can never offset a critical one in the other dimension', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(3, 0.9), // strong
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(0, 0.9), // misleading
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('misleading');
  });

  it('is weak when an applicable judged dimension is weak and none is critical', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(1, 0.9), // weak
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(3, 0.9), // strong
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('weak');
  });

  it('is healthy when every applicable dimension is acceptable or strong', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(2, 0.9), // acceptable
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(3, 0.9), // strong
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('healthy');
  });

  it('excludes a not-applicable dimension from the verdict entirely, so the rest can still be healthy', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.1), // not applicable
        'falsifiability.quality': scoreAnswer(0, 0.9), // would be misleading if it counted
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(3, 0.9), // strong
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('healthy');
    expect(result.dimensions.find((d) => d.dimensionId === 'falsifiability')?.status).toBe('not-applicable');
  });

  it('is needs-review when no dimension is applicable', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.1),
        'falsifiability.quality': scoreAnswer(3, 0.9),
        'behavioral-focus.applicable': noulAnswer(0.2),
        'behavioral-focus.quality': scoreAnswer(3, 0.9),
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('needs-review');
  });

  it('is needs-review when an applicable dimension needs review, even if the other is strong', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(3, 0.1), // low confidence
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(3, 0.9),
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('needs-review');
  });

  it('is needs-review on a missing answer, even if every other dimension is strong', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(3, 0.9),
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('needs-review');
    expect(result.dimensions.find((d) => d.dimensionId === 'falsifiability')?.reason).toBe('missing-answer');
  });

  it('is needs-review when the model does not match the pin, regardless of otherwise-healthy scores', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(3, 0.9),
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(3, 0.9),
      }, { modelMatchesPin: false, respondedModel: 'jev-1.12.0' }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.status).toBe('needs-review');
  });

  it('records policy/rubric versions and the model/usage summary', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(FULLY_APPLICABLE_STRONG, { usage: { inputTokens: 555, outputTokens: 0 } }),
      rubric: RUBRIC_ONE,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.policyVersion).toBe(1);
    expect(result.rubricVersion).toBe(1);
    expect(result.model).toEqual({ requested: JEV_MODEL_ID, responded: JEV_MODEL_ID, matchesPin: true });
    expect(result.usage).toEqual({ inputTokens: 555, outputTokens: 0 });
  });
});

// --- Input validation --------------------------------------------------------

describe('classifyEvaluation — input validation', () => {
  it('throws RangeError for an invalid policy before doing anything else', () => {
    expect(() => classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(FULLY_APPLICABLE_STRONG),
      rubric: RUBRIC_ONE,
      policy: { ...CLASSIFICATION_POLICY_V1, confidenceMin: 2 },
    })).toThrow(RangeError);
  });

  it('throws RangeError for an invalid rubric', () => {
    expect(() => classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(FULLY_APPLICABLE_STRONG),
      rubric: { ...RUBRIC_ONE, model: 'jev-latest' },
      policy: CLASSIFICATION_POLICY_V1,
    })).toThrow(RangeError);
  });

  it('throws RangeError when the rubric version does not match the policy rubricVersion', () => {
    expect(() => classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(FULLY_APPLICABLE_STRONG),
      rubric: { ...RUBRIC_ONE, version: 2 },
      policy: CLASSIFICATION_POLICY_V1,
    })).toThrow(RangeError);
  });
});

// --- Findings ---------------------------------------------------------------

describe('classifyEvaluation — findings', () => {
  it('produces one finding for a misleading dimension, carrying full identifiers and judgment detail', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(0, 0.9),
      }),
      rubric: RUBRIC_ONE,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.findings).toEqual([{
      testCaseId: TEST_CASE.testCaseId,
      repositoryRelativePath: TEST_CASE.repositoryRelativePath,
      name: TEST_CASE.name,
      dimensionId: 'falsifiability',
      dimensionLabel: 'Falsifiability',
      level: 'misleading',
      score: 0,
      confidence: 0.9,
      applicabilityProbability: 0.9,
      status: 'judged',
      reason: undefined,
    }]);
  });

  it('produces one finding for a weak dimension', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(1, 0.9),
      }),
      rubric: RUBRIC_ONE,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('weak');
  });

  it('produces no finding for an acceptable or strong dimension', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(FULLY_APPLICABLE_STRONG),
      rubric: RUBRIC_ONE,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.findings).toEqual([]);
  });

  it('produces no finding for a not-applicable dimension', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.1),
        'falsifiability.quality': scoreAnswer(0, 0.9),
      }),
      rubric: RUBRIC_ONE,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.findings).toEqual([]);
  });

  it('produces a finding for a needs-review dimension, with an undefined level', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(3, 0.1),
      }),
      rubric: RUBRIC_ONE,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ status: 'needs-review', reason: 'low-confidence', level: undefined });
  });

  it('orders findings by dimension id', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswer(0, 0.9), // misleading, id "falsifiability"
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswer(1, 0.9), // weak, id "behavioral-focus"
      }),
      rubric: RUBRIC_TWO,
      policy: CLASSIFICATION_POLICY_V1,
    });
    expect(result.findings.map((f) => f.dimensionId)).toEqual(['behavioral-focus', 'falsifiability']);
  });
});

// --- Determinism -------------------------------------------------------------

describe('classifyEvaluation — determinism', () => {
  it('produces byte-identical canonical JSON regardless of rubric dimension order or answer insertion order', () => {
    const rubricForward: Rubric = RUBRIC_TWO;
    const rubricReversed: Rubric = { ...RUBRIC_TWO, dimensions: [...RUBRIC_TWO.dimensions].reverse() };

    const answersForward = {
      'falsifiability.applicable': noulAnswer(0.9),
      'falsifiability.quality': scoreAnswer(0, 0.9),
      'behavioral-focus.applicable': noulAnswer(0.9),
      'behavioral-focus.quality': scoreAnswer(1, 0.9),
    };
    // Same logical answers, different insertion order.
    const answersShuffled = {
      'behavioral-focus.quality': scoreAnswer(1, 0.9),
      'falsifiability.quality': scoreAnswer(0, 0.9),
      'behavioral-focus.applicable': noulAnswer(0.9),
      'falsifiability.applicable': noulAnswer(0.9),
    };

    const first = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(answersForward),
      rubric: rubricForward,
      policy: CLASSIFICATION_POLICY_V1,
    });
    const second = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(answersShuffled),
      rubric: rubricReversed,
      policy: CLASSIFICATION_POLICY_V1,
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.dimensions.map((d) => d.dimensionId)).toEqual(['behavioral-focus', 'falsifiability']);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const input = {
      testCase: TEST_CASE,
      evaluation: evaluation(FULLY_APPLICABLE_STRONG),
      rubric: RUBRIC_ONE,
      policy: CLASSIFICATION_POLICY_V1,
    };
    expect(JSON.stringify(classifyEvaluation(input))).toBe(JSON.stringify(classifyEvaluation(input)));
  });
});

// =============================================================================
// CLASSIFICATION_POLICY_V2 — boundary-mass policy (task C-1,
// odd/tasks/classification-calibration.md). Replaces V1's confidence gate;
// see judgeOne's `policy` parameter — every test below passes
// CLASSIFICATION_POLICY_V2 explicitly.
// =============================================================================

describe('CLASSIFICATION_POLICY_V2', () => {
  it('is versioned 2, tied to the shipped rubric version (RUBRIC_V2, task C-2), and validates without throwing', () => {
    expect(CLASSIFICATION_POLICY_V2.version).toBe(2);
    expect(CLASSIFICATION_POLICY_V2.rubricVersion).toBe(2);
    expect(CLASSIFICATION_POLICY_V2.rubricVersion).toBe(RUBRIC_V2.version);
    expect(() => validateClassificationPolicy(CLASSIFICATION_POLICY_V2)).not.toThrow();
  });

  it('sets the provisional sideMin and criticalMin thresholds from the recorded discrimination fixture', () => {
    expect(CLASSIFICATION_POLICY_V2.sideMin).toBe(0.65);
    expect(CLASSIFICATION_POLICY_V2.criticalMin).toBe(0.5);
  });

  it('keeps the same applicabilityMin and criticalLevel as V1 (task C-1 does not change applicability)', () => {
    expect(CLASSIFICATION_POLICY_V2.applicabilityMin).toBe(CLASSIFICATION_POLICY_V1.applicabilityMin);
    expect(CLASSIFICATION_POLICY_V2.criticalLevel).toBe('misleading');
  });
});

describe('validateClassificationPolicy — CLASSIFICATION_POLICY_V2 shape', () => {
  const validV2 = CLASSIFICATION_POLICY_V2;

  it('accepts the shipped V2 policy', () => {
    expect(() => validateClassificationPolicy(validV2)).not.toThrow();
  });

  it('rejects sideMin exactly at 0.5 (deficient and acceptable masses could both clear it)', () => {
    expect(() => validateClassificationPolicy({ ...validV2, sideMin: 0.5 })).toThrow(RangeError);
  });

  it('rejects sideMin below 0.5', () => {
    expect(() => validateClassificationPolicy({ ...validV2, sideMin: 0.4 })).toThrow(RangeError);
  });

  it('rejects sideMin above 1', () => {
    expect(() => validateClassificationPolicy({ ...validV2, sideMin: 1.01 })).toThrow(RangeError);
  });

  it('accepts sideMin just above 0.5 and at 1', () => {
    expect(() => validateClassificationPolicy({ ...validV2, sideMin: 0.500001 })).not.toThrow();
    expect(() => validateClassificationPolicy({ ...validV2, sideMin: 1 })).not.toThrow();
  });

  it('rejects a criticalMin below 0', () => {
    expect(() => validateClassificationPolicy({ ...validV2, criticalMin: -0.01 })).toThrow(RangeError);
  });

  it('rejects a criticalMin above 1', () => {
    expect(() => validateClassificationPolicy({ ...validV2, criticalMin: 1.01 })).toThrow(RangeError);
  });

  it('accepts criticalMin at the 0 and 1 boundaries', () => {
    expect(() => validateClassificationPolicy({ ...validV2, criticalMin: 0 })).not.toThrow();
    expect(() => validateClassificationPolicy({ ...validV2, criticalMin: 1 })).not.toThrow();
  });

  it('still rejects a non-positive version, an invalid applicabilityMin, and a bad levelCutPoints/criticalLevel (shared validation)', () => {
    expect(() => validateClassificationPolicy({ ...validV2, version: 0 })).toThrow(RangeError);
    expect(() => validateClassificationPolicy({ ...validV2, applicabilityMin: 1.5 })).toThrow(RangeError);
    expect(() => validateClassificationPolicy({ ...validV2, levelCutPoints: [2, 1, 3] })).toThrow(RangeError);
    expect(() => validateClassificationPolicy({ ...validV2, criticalLevel: 'terrible' as ClassificationPolicyV2['criticalLevel'] })).toThrow(RangeError);
  });
});

// --- CLASSIFICATION_POLICY_V3 (asymmetric boundary-mass gate) ---------------

describe('CLASSIFICATION_POLICY_V3', () => {
  it('is versioned 3, pinned to RUBRIC_V2, and validates', () => {
    expect(CLASSIFICATION_POLICY_V3.version).toBe(3);
    expect(CLASSIFICATION_POLICY_V3.rubricVersion).toBe(RUBRIC_V2.version);
    expect(() => validateClassificationPolicy(CLASSIFICATION_POLICY_V3)).not.toThrow();
  });

  it('lowers only the acceptable side to 0.575 and keeps the deficient side and criticalMin at V2\'s values', () => {
    expect(CLASSIFICATION_POLICY_V3).toMatchObject({ acceptableSideMin: 0.575, deficientSideMin: 0.65, criticalMin: 0.5, applicabilityMin: 0.5 });
    expect(CLASSIFICATION_POLICY_V3.deficientSideMin).toBe(CLASSIFICATION_POLICY_V2.sideMin);
  });

  it('rejects either side threshold at or below 0.5, or above 1', () => {
    for (const field of ['acceptableSideMin', 'deficientSideMin'] as const) {
      expect(() => validateClassificationPolicy({ ...CLASSIFICATION_POLICY_V3, [field]: 0.5 })).toThrow(RangeError);
      expect(() => validateClassificationPolicy({ ...CLASSIFICATION_POLICY_V3, [field]: 1.01 })).toThrow(RangeError);
      expect(() => validateClassificationPolicy({ ...CLASSIFICATION_POLICY_V3, [field]: 0.500001 })).not.toThrow();
    }
  });
});

describe('classifyEvaluation — V3 per-dimension judgment (acceptableSideMin 0.575, deficientSideMin 0.65)', () => {
  function judgeV3(probabilities: Readonly<Record<string, number>>): DimensionJudgment {
    return judgeOne({ 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(1.5, probabilities) }, CLASSIFICATION_POLICY_V3);
  }

  it('is acceptable exactly at acceptableSideMin (acceptableMass 0.575)', () => {
    const judgment = judgeV3({ '0': 0.2, '1': 0.225, '2': 0.5, '3': 0.075 });
    expect(judgment.status).toBe('judged');
    expect(judgment.level).toBe('acceptable');
  });

  it('needs review just below acceptableSideMin (acceptableMass 0.57)', () => {
    const judgment = judgeV3({ '0': 0.2, '1': 0.23, '2': 0.5, '3': 0.07 });
    expect(judgment.status).toBe('needs-review');
    expect(judgment.reason).toBe('boundary-straddle');
  });

  it('keeps the deficient side at 0.65: deficientMass 0.60 still needs review (the side the blind review did not support lowering)', () => {
    const judgment = judgeV3({ '0': 0.2, '1': 0.4, '2': 0.3, '3': 0.1 });
    expect(judgment.status).toBe('needs-review');
    expect(judgment.reason).toBe('boundary-straddle');
  });

  it('is deficient exactly at deficientSideMin (deficientMass 0.65), weak below criticalMin', () => {
    const judgment = judgeV3({ '0': 0.3, '1': 0.35, '2': 0.2, '3': 0.15 });
    expect(judgment.status).toBe('judged');
    expect(judgment.level).toBe('weak');
  });
});

// --- V2 per-dimension judgment (boundary-mass gate) -------------------------

describe('classifyEvaluation — V2 per-dimension judgment (boundary-mass policy, sideMin=0.65, criticalMin=0.5)', () => {
  describe('deficient side', () => {
    it('is deficient exactly at sideMin (deficientMass 0.65), reported weak when criticalMass < criticalMin', () => {
      // deficientMass = 0.3 + 0.35 = 0.65 exactly; criticalMass = 0.3 < 0.5.
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(0.8, { '0': 0.3, '1': 0.35, '2': 0.2, '3': 0.15 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('weak');
      expect(judgment.deficientMass).toBeCloseTo(0.65, 10);
      expect(judgment.criticalMass).toBeCloseTo(0.3, 10);
    });

    it('needs review (boundary-straddle) just below sideMin (deficientMass 0.64)', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(1, { '0': 0.3, '1': 0.34, '2': 0.2, '3': 0.16 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('boundary-straddle');
      expect(judgment.level).toBeUndefined();
    });

    it('is misleading when criticalMass clears criticalMin exactly (0.5)', () => {
      // deficientMass = 0.5 + 0.2 = 0.7 (clears sideMin); criticalMass = 0.5 exactly.
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(0.5, { '0': 0.5, '1': 0.2, '2': 0.2, '3': 0.1 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('misleading');
    });

    it('is weak when criticalMass is just below criticalMin (0.499)', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(0.5, { '0': 0.499, '1': 0.201, '2': 0.2, '3': 0.1 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('weak');
    });

    it('is misleading for an all-mass-on-misleading distribution', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(0, { '0': 1, '1': 0, '2': 0, '3': 0 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('misleading');
      expect(judgment.deficientMass).toBe(1);
      expect(judgment.criticalMass).toBe(1);
    });

    it('a decisively deficient distribution that is not decisively critical is weak, never misleading (real recorded datum)', () => {
      // "exposes the checkout helper" / assertion-strength: {0.01, 0.99, 0, 0} — deficientMass 1.0, criticalMass 0.01.
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(0.99, { '0': 0.01, '1': 0.99, '2': 0, '3': 0 }, 0.98) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('weak');
    });
  });

  describe('acceptable side', () => {
    it('is acceptable exactly at sideMin (acceptableMass 0.65)', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(2.2, { '0': 0.2, '1': 0.15, '2': 0.5, '3': 0.15 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('acceptable');
      expect(judgment.acceptableMass).toBeCloseTo(0.65, 10);
    });

    it('needs review (boundary-straddle) just below sideMin on the acceptable side too (acceptableMass 0.64)', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(2, { '0': 0.2, '1': 0.16, '2': 0.5, '3': 0.14 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('boundary-straddle');
    });

    it('is strong for an all-mass-on-strong distribution', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0, '3': 1 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('strong');
      expect(judgment.acceptableMass).toBe(1);
    });

    it('clamps a decisively-acceptable dimension to "acceptable" even when its nominal score would fall in the "weak" score band', () => {
      // acceptableMass = 0.7 (>= sideMin); score = 0*0.3 + 2*0.7 = 1.4, which levelForScore([1,2,3]) reads as "weak".
      // The mass says acceptable, so the report must say "acceptable", never "weak" and never needs-review.
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(1.4, { '0': 0.3, '1': 0, '2': 0.7, '3': 0 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('acceptable');
    });

    it('reports "acceptable" vs. "strong" from the score cut points once the dimension is on the acceptable side', () => {
      const acceptable = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(2.5, { '0': 0, '1': 0, '2': 0.9, '3': 0.1 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(acceptable.level).toBe('acceptable');

      const strong = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0.1, '3': 0.9 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(strong.level).toBe('strong');
    });
  });

  describe('bimodal / straddling distributions', () => {
    it('a high criticalMass alone never produces misleading when deficientMass does not clear sideMin (real recorded datum)', () => {
      // "applies the discount" / behavioral-focus: {0.5, 0.01, 0.12, 0.37} — criticalMass 0.5 clears criticalMin,
      // but deficientMass is only 0.51 and acceptableMass only 0.49: neither clears sideMin (0.65).
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(1.34, { '0': 0.5, '1': 0.01, '2': 0.12, '3': 0.37 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('boundary-straddle');
      expect(judgment.level).toBeUndefined();
    });
  });

  describe('distribution validation', () => {
    it('needs review (missing-answer) when probabilities sum well outside tolerance', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(1, { '0': 0.5, '1': 0.5, '2': 0.5, '3': 0.5 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
      expect(judgment.probabilities).toBeUndefined();
      expect(judgment.deficientMass).toBeUndefined();
    });

    it('accepts a distribution summing to 1.02 (within the documented 0.02 rounding tolerance)', () => {
      // Sum is 1.02 (0.01+0.01+0.5+0.5); acceptableMass 1.0 decisively clears sideMin, isolating the
      // assertion to the sum-tolerance check rather than also depending on the mass thresholds.
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(3, { '0': 0.01, '1': 0.01, '2': 0.5, '3': 0.5 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
    });

    it('rejects a distribution summing to 1.03 (just outside the documented 0.02 rounding tolerance)', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(0, { '0': 0.3, '1': 0.3, '2': 0.3, '3': 0.13 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
    });

    it('needs review (missing-answer) when a level key is missing entirely, never defaulting it to 0', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(1, { '0': 0.5, '1': 0.5, '2': 0.5 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
    });

    it('needs review (missing-answer) when a probability is negative', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(1, { '0': -0.1, '1': 0.6, '2': 0.3, '3': 0.2 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
    });

    it('needs review (missing-answer) when a probability is non-finite (NaN)', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(1, { '0': Number.NaN, '1': 0.6, '2': 0.3, '3': 0.1 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
    });
  });

  describe('confidence is no longer a gate', () => {
    it('judges a decisively-acceptable dimension even at confidence 0', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0.1, '3': 0.9 }, 0) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('judged');
      expect(judgment.level).toBe('strong');
      expect(judgment.confidence).toBe(0);
    });

    it('still records score and confidence on the judgment for transparency', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(2.9, { '0': 0, '1': 0, '2': 0.1, '3': 0.9 }, 0.42) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.score).toBe(2.9);
      expect(judgment.confidence).toBe(0.42);
    });
  });

  describe('applicability gate is unchanged (task C-1 does not touch it)', () => {
    it('is not-applicable just below applicabilityMin, regardless of a decisive quality distribution', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.499), 'falsifiability.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0, '3': 1 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('not-applicable');
      expect(judgment.probabilities).toBeUndefined();
    });
  });

  describe('missing or malformed answers (same shape as V1)', () => {
    it('needs review when the applicability answer is missing entirely', () => {
      const judgment = judgeOne(
        { 'falsifiability.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0, '3': 1 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
    });

    it('needs review when the quality answer is missing entirely, never inventing a level or masses', () => {
      const judgment = judgeOne({ 'falsifiability.applicable': noulAnswer(0.9) }, CLASSIFICATION_POLICY_V2);
      expect(judgment.status).toBe('needs-review');
      expect(judgment.reason).toBe('missing-answer');
      expect(judgment.probabilities).toBeUndefined();
    });
  });

  describe('probabilities exposed in the report', () => {
    it('exposes the canonical {0,1,2,3} probabilities object, in level order, on a judged dimension', () => {
      const judgment = judgeOne(
        { 'falsifiability.applicable': noulAnswer(0.9), 'falsifiability.quality': scoreAnswerWithProbabilities(2.9, { '3': 0.9, '0': 0, '2': 0.1, '1': 0 }) },
        CLASSIFICATION_POLICY_V2,
      );
      expect(judgment.probabilities).toEqual({ '0': 0, '1': 0, '2': 0.1, '3': 0.9 });
      expect(Object.keys(judgment.probabilities ?? {})).toEqual(['0', '1', '2', '3']);
    });
  });
});

// --- V2 overall status (non-compensatory rule holds under the new gate) ----

describe('classifyEvaluation — V2 overall status', () => {
  it('is misleading when any applicable judged dimension is at the critical level', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswerWithProbabilities(0, { '0': 1, '1': 0, '2': 0, '3': 0 }), // misleading
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0, '3': 1 }), // strong
      }),
      rubric: RUBRIC_TWO_V2,
      policy: CLASSIFICATION_POLICY_V2,
    });
    expect(result.status).toBe('misleading');
  });

  it('a strong dimension can never offset a critical one in the other dimension (non-compensatory rule)', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0, '3': 1 }), // strong
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswerWithProbabilities(0, { '0': 1, '1': 0, '2': 0, '3': 0 }), // misleading
      }),
      rubric: RUBRIC_TWO_V2,
      policy: CLASSIFICATION_POLICY_V2,
    });
    expect(result.status).toBe('misleading');
  });

  it('is healthy when every applicable dimension is decisively acceptable or strong', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswerWithProbabilities(2.5, { '0': 0, '1': 0, '2': 0.9, '3': 0.1 }), // acceptable
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0, '3': 1 }), // strong
      }),
      rubric: RUBRIC_TWO_V2,
      policy: CLASSIFICATION_POLICY_V2,
    });
    expect(result.status).toBe('healthy');
  });

  it('is needs-review when a straddling dimension keeps the verdict from resolving, even if the other dimension is strong', () => {
    const result = classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation({
        'falsifiability.applicable': noulAnswer(0.9),
        'falsifiability.quality': scoreAnswerWithProbabilities(1.34, { '0': 0.5, '1': 0.01, '2': 0.12, '3': 0.37 }), // straddle
        'behavioral-focus.applicable': noulAnswer(0.9),
        'behavioral-focus.quality': scoreAnswerWithProbabilities(3, { '0': 0, '1': 0, '2': 0, '3': 1 }), // strong
      }),
      rubric: RUBRIC_TWO_V2,
      policy: CLASSIFICATION_POLICY_V2,
    });
    expect(result.status).toBe('needs-review');
  });
});

// --- V2 input validation -----------------------------------------------------

describe('classifyEvaluation — V2 input validation', () => {
  it('throws RangeError for an invalid V2 policy before doing anything else', () => {
    expect(() => classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(FULLY_APPLICABLE_STRONG),
      rubric: RUBRIC_ONE,
      policy: { ...CLASSIFICATION_POLICY_V2, sideMin: 0.5 },
    })).toThrow(RangeError);
  });

  it('throws RangeError when the rubric version does not match the V2 policy rubricVersion', () => {
    expect(() => classifyEvaluation({
      testCase: TEST_CASE,
      evaluation: evaluation(FULLY_APPLICABLE_STRONG),
      rubric: { ...RUBRIC_ONE, version: 1 },
      policy: CLASSIFICATION_POLICY_V2,
    })).toThrow(RangeError);
  });
});
