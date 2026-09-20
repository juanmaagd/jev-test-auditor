import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_POLICY_V1,
  classifyEvaluation,
  validateClassificationPolicy,
  type ClassificationPolicy,
  type ClassificationTestCaseIdentity,
  type DimensionJudgment,
} from '../src/domain/classification.js';
import { JEV_MODEL_ID, type Rubric, type RubricDimension, type RubricDimensionId, type RubricNoulQuestion, type RubricScoreQuestion } from '../src/domain/rubric.js';
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

/** Builds an evaluation over `RUBRIC_ONE`'s single `falsifiability` dimension and returns its judgment. */
function judgeOne(
  answers: Record<string, JevAnswer>,
  policy: ClassificationPolicy = CLASSIFICATION_POLICY_V1,
  evalOverrides: Partial<JevEvaluation> = {},
): DimensionJudgment {
  const result = classifyEvaluation({
    testCase: TEST_CASE,
    evaluation: evaluation(answers, evalOverrides),
    rubric: RUBRIC_ONE,
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
