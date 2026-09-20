import { describe, expect, it } from 'vitest';
import {
  JEV_MODEL_ID,
  RUBRIC_DIMENSION_IDS,
  RUBRIC_QUALITY_LEVEL_COUNT,
  RUBRIC_QUALITY_LEVELS,
  RUBRIC_V1,
  RUBRIC_V2,
  validateRubric,
  type Rubric,
  type RubricDimension,
  type RubricDimensionId,
  type RubricNoulQuestion,
  type RubricScoreQuestion,
} from '../src/domain/rubric.js';

function noulQuestion(overrides: Partial<RubricNoulQuestion> = {}): RubricNoulQuestion {
  return {
    id: 'falsifiability.applicable',
    type: 'noul',
    instructions: 'Is there enough evidence?',
    criteria: { true: 'Evidence is enough.', false: 'Evidence is not enough.' },
    ...overrides,
  };
}

function scoreQuestion(overrides: Partial<RubricScoreQuestion> = {}): RubricScoreQuestion {
  return {
    id: 'falsifiability.quality',
    type: 'score',
    instructions: 'How good is it?',
    criteria: ['Misleading: bad.', 'Weak: meh.', 'Acceptable: fine.', 'Strong: great.'],
    ...overrides,
  };
}

function dimension(overrides: Partial<RubricDimension> = {}): RubricDimension {
  return {
    id: 'falsifiability',
    label: 'Falsifiability',
    applicability: noulQuestion(),
    quality: scoreQuestion(),
    ...overrides,
  };
}

function validRubric(overrides: Partial<Rubric> = {}): Rubric {
  return {
    version: 1,
    model: JEV_MODEL_ID,
    dimensions: [dimension()],
    ...overrides,
  };
}

describe('RUBRIC_V1', () => {
  it('is versioned 1 and pins the exact Jev model id', () => {
    expect(RUBRIC_V1.version).toBe(1);
    expect(RUBRIC_V1.model).toBe('jev-1.13.0');
    expect(RUBRIC_V1.model).toBe(JEV_MODEL_ID);
  });

  it('defines exactly the seven PRD dimension ids, each once', () => {
    expect(RUBRIC_V1.dimensions.map((d) => d.id).sort()).toEqual([...RUBRIC_DIMENSION_IDS].sort());
    expect(RUBRIC_V1.dimensions).toHaveLength(7);
  });

  it('validates without throwing', () => {
    expect(() => validateRubric(RUBRIC_V1)).not.toThrow();
  });

  it('defines all 14 stable question ids, one applicable/quality pair per dimension', () => {
    const ids = RUBRIC_V1.dimensions.flatMap((d) => [d.applicability.id, d.quality.id]).sort();
    const expected = RUBRIC_DIMENSION_IDS
      .flatMap((id) => [`${id}.applicable`, `${id}.quality`])
      .sort();
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(14);
  });

  it('gives every dimension a non-empty label and correctly typed questions', () => {
    for (const d of RUBRIC_V1.dimensions) {
      expect(d.label.trim().length).toBeGreaterThan(0);
      expect(d.applicability.type).toBe('noul');
      expect(d.quality.type).toBe('score');
      expect(d.applicability.instructions.trim().length).toBeGreaterThan(0);
      expect(d.quality.instructions.trim().length).toBeGreaterThan(0);
    }
  });

  it('gives every quality question exactly four ordered levels, each prefixed with its level name', () => {
    for (const d of RUBRIC_V1.dimensions) {
      expect(d.quality.criteria).toHaveLength(RUBRIC_QUALITY_LEVEL_COUNT);
      d.quality.criteria.forEach((level, index) => {
        const levelName = RUBRIC_QUALITY_LEVELS[index] as string;
        expect(level.startsWith(levelName)).toBe(true);
        expect(level.trim().length).toBeGreaterThan(levelName.length);
      });
    }
  });

  it('tells every applicability question how to treat denied/unresolved/omitted/truncated evidence', () => {
    for (const d of RUBRIC_V1.dimensions) {
      expect(d.applicability.instructions).toMatch(/denied/);
      expect(d.applicability.instructions).toMatch(/unresolved/);
      expect(d.applicability.instructions).toMatch(/omitted/);
      expect(d.applicability.instructions).toMatch(/truncated/);
    }
  });

  it('gives every applicability question true/false criteria', () => {
    for (const d of RUBRIC_V1.dimensions) {
      expect(d.applicability.criteria?.true.trim().length).toBeGreaterThan(0);
      expect(d.applicability.criteria?.false.trim().length).toBeGreaterThan(0);
    }
  });

  it(
    'tells every quality question the same withheld-evidence rule, in its own wording, so a withheld or '
    + 'truncated fragment never by itself pushes the score toward a worse level',
    () => {
      for (const d of RUBRIC_V1.dimensions) {
        expect(d.quality.instructions).toMatch(/denied/);
        expect(d.quality.instructions).toMatch(/unresolved/);
        expect(d.quality.instructions).toMatch(/omitted/);
        expect(d.quality.instructions).toMatch(/truncated/);
        expect(d.quality.instructions).toMatch(/must never by itself push this score/);
      }
    },
  );

  it('gives quality questions a provenance variant distinct from the applicability one, not reused verbatim', () => {
    for (const d of RUBRIC_V1.dimensions) {
      // The applicability sentence's own opening clause never appears in the quality instructions...
      expect(d.quality.instructions).not.toContain(
        'The `fragments` field lists the evidence actually available for this judgment.',
      );
      // ...and the quality sentence's distinguishing clause never appears in the applicability instructions.
      expect(d.applicability.instructions).not.toContain('must never by itself push this score');
    }
  });
});

// =============================================================================
// RUBRIC_V2 — task C-2 (odd/tasks/classification-calibration.md): rewrites
// only the `determinism-isolation`/`falsifiability` applicability questions.
// =============================================================================

const REWRITTEN_APPLICABILITY_DIMENSION_IDS: readonly RubricDimensionId[] = ['determinism-isolation', 'falsifiability'];

function rubricDimension(rubric: Rubric, id: RubricDimensionId): RubricDimension {
  const dimension = rubric.dimensions.find((candidate) => candidate.id === id);
  if (dimension === undefined) throw new Error(`expected dimension "${id}" in rubric version ${rubric.version}`);
  return dimension;
}

describe('RUBRIC_V2', () => {
  it('is versioned 2 and pins the exact Jev model id, same as V1', () => {
    expect(RUBRIC_V2.version).toBe(2);
    expect(RUBRIC_V2.model).toBe(JEV_MODEL_ID);
  });

  it('defines exactly the seven PRD dimension ids, each once', () => {
    expect(RUBRIC_V2.dimensions.map((d) => d.id).sort()).toEqual([...RUBRIC_DIMENSION_IDS].sort());
    expect(RUBRIC_V2.dimensions).toHaveLength(7);
  });

  it('validates without throwing', () => {
    expect(() => validateRubric(RUBRIC_V2)).not.toThrow();
  });

  it('defines all 14 stable question ids, identical to V1 (task C-2 never touches ids)', () => {
    const v1Ids = RUBRIC_V1.dimensions.flatMap((d) => [d.applicability.id, d.quality.id]).sort();
    const v2Ids = RUBRIC_V2.dimensions.flatMap((d) => [d.applicability.id, d.quality.id]).sort();
    expect(v2Ids).toEqual(v1Ids);
    expect(new Set(v2Ids).size).toBe(14);
  });

  it('keeps every label byte-identical to V1', () => {
    for (const id of RUBRIC_DIMENSION_IDS) {
      expect(rubricDimension(RUBRIC_V2, id).label).toBe(rubricDimension(RUBRIC_V1, id).label);
    }
  });

  it('keeps every quality question byte-identical to V1 (task C-2 never touches quality questions)', () => {
    for (const id of RUBRIC_DIMENSION_IDS) {
      expect(rubricDimension(RUBRIC_V2, id).quality).toEqual(rubricDimension(RUBRIC_V1, id).quality);
    }
  });

  it(
    "keeps the other five dimensions' applicability questions byte-identical to V1 — the regression guard that "
    + 'keeps this change scoped to exactly two dimensions',
    () => {
      const untouchedIds = RUBRIC_DIMENSION_IDS.filter((id) => !REWRITTEN_APPLICABILITY_DIMENSION_IDS.includes(id));
      expect(untouchedIds).toHaveLength(5);
      for (const id of untouchedIds) {
        expect(rubricDimension(RUBRIC_V2, id).applicability).toEqual(rubricDimension(RUBRIC_V1, id).applicability);
      }
    },
  );

  it('changes the applicability instructions and criteria for exactly determinism-isolation and falsifiability', () => {
    for (const id of REWRITTEN_APPLICABILITY_DIMENSION_IDS) {
      const v1 = rubricDimension(RUBRIC_V1, id).applicability;
      const v2 = rubricDimension(RUBRIC_V2, id).applicability;
      expect(v2.instructions).not.toBe(v1.instructions);
      expect(v2.criteria).not.toEqual(v1.criteria);
      // Ids never change — only instructions/criteria text does.
      expect(v2.id).toBe(v1.id);
    }
  });

  it('still appends the exact shared provenance-guidance suffix to the two rewritten applicability questions', () => {
    // PROVENANCE_GUIDANCE is not exported, so pull the exact suffix off an untouched V1 dimension's own
    // applicability instructions (any dimension works; behavioral-focus is arbitrary) and confirm both
    // rewritten V2 questions end with that same literal suffix, appended unchanged.
    const knownSuffix = rubricDimension(RUBRIC_V1, 'behavioral-focus').applicability.instructions
      .split(' The `fragments` field lists')[1];
    if (knownSuffix === undefined) throw new Error('expected the provenance-guidance sentence to be present');
    const suffix = ` The \`fragments\` field lists${knownSuffix}`;
    for (const id of REWRITTEN_APPLICABILITY_DIMENSION_IDS) {
      expect(rubricDimension(RUBRIC_V2, id).applicability.instructions.endsWith(suffix)).toBe(true);
    }
  });

  describe('determinism-isolation applicability (rewritten)', () => {
    const dimension = rubricDimension(RUBRIC_V2, 'determinism-isolation');

    it('tells the model that an absent hazard is itself evidence, not a reason to abstain', () => {
      expect(dimension.applicability.instructions).toMatch(/absence is itself evidence/);
      expect(dimension.applicability.instructions).toMatch(/not as a reason to abstain/);
    });

    it('keeps a concrete false criterion for a genuinely unshown test body', () => {
      const falseCriterion = dimension.applicability.criteria?.false;
      expect(falseCriterion).toBeDefined();
      expect(falseCriterion?.trim().length).toBeGreaterThan(0);
      expect(falseCriterion).toMatch(/own body is not shown/);
    });

    it('keeps a true criterion that does not require a hazard, or even a hook, to actually be present', () => {
      const trueCriterion = dimension.applicability.criteria?.true;
      expect(trueCriterion).toBeDefined();
      expect(trueCriterion).toMatch(/whether or not one is actually found there/);
    });
  });

  describe('falsifiability applicability (rewritten)', () => {
    const dimension = rubricDimension(RUBRIC_V2, 'falsifiability');

    it('tells the model that visible assertions and exercised behavior suffice without the full production path', () => {
      expect(dimension.applicability.instructions).toMatch(/even when the deeper implementation behind that call is not shown/);
    });

    it('keeps a concrete false criterion for genuinely unshown assertions/exercised behavior', () => {
      const falseCriterion = dimension.applicability.criteria?.false;
      expect(falseCriterion).toBeDefined();
      expect(falseCriterion?.trim().length).toBeGreaterThan(0);
      expect(falseCriterion).toMatch(/assertions, or the behavior they exercise, are not shown/);
    });

    it('keeps a true criterion that explicitly tolerates an unshown deeper implementation', () => {
      const trueCriterion = dimension.applicability.criteria?.true;
      expect(trueCriterion).toBeDefined();
      expect(trueCriterion).toMatch(/even when the deeper implementation behind that behavior is not shown/);
    });
  });

  it('gives every applicability question true/false criteria, same shape as V1', () => {
    for (const d of RUBRIC_V2.dimensions) {
      expect(d.applicability.criteria?.true.trim().length).toBeGreaterThan(0);
      expect(d.applicability.criteria?.false.trim().length).toBeGreaterThan(0);
    }
  });

  it('tells every applicability question how to treat denied/unresolved/omitted/truncated evidence, same as V1', () => {
    for (const d of RUBRIC_V2.dimensions) {
      expect(d.applicability.instructions).toMatch(/denied/);
      expect(d.applicability.instructions).toMatch(/unresolved/);
      expect(d.applicability.instructions).toMatch(/omitted/);
      expect(d.applicability.instructions).toMatch(/truncated/);
    }
  });
});

describe('validateRubric', () => {
  it('accepts a well-formed single-dimension rubric', () => {
    expect(() => validateRubric(validRubric())).not.toThrow();
  });

  it('rejects a non-positive version', () => {
    expect(() => validateRubric(validRubric({ version: 0 }))).toThrow(RangeError);
  });

  it('rejects a non-integer version', () => {
    expect(() => validateRubric(validRubric({ version: 1.5 }))).toThrow(RangeError);
  });

  it('rejects an unpinned model (e.g. a generic "jev-latest" alias)', () => {
    expect(() => validateRubric(validRubric({ model: 'jev-latest' }))).toThrow(RangeError);
  });

  it('rejects a rubric with zero dimensions', () => {
    expect(() => validateRubric(validRubric({ dimensions: [] }))).toThrow(RangeError);
  });

  it('rejects an unknown dimension id', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ id: 'not-a-real-dimension' as RubricDimension['id'] })],
    }))).toThrow(RangeError);
  });

  it('rejects a duplicate dimension id', () => {
    expect(() => validateRubric(validRubric({ dimensions: [dimension(), dimension()] }))).toThrow(RangeError);
  });

  it('rejects a duplicate question id across dimensions', () => {
    const first = dimension();
    const second = dimension({
      id: 'behavioral-focus',
      applicability: noulQuestion({ id: 'falsifiability.applicable' }), // reuses first dimension's id
      quality: scoreQuestion({ id: 'behavioral-focus.quality' }),
    });
    expect(() => validateRubric(validRubric({ dimensions: [first, second] }))).toThrow(RangeError);
  });

  it('rejects an applicability question id that does not match "<dimension-id>.applicable"', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ applicability: noulQuestion({ id: 'wrong-id' }) })],
    }))).toThrow(RangeError);
  });

  it('rejects a quality question id that does not match "<dimension-id>.quality"', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ quality: scoreQuestion({ id: 'wrong-id' }) })],
    }))).toThrow(RangeError);
  });

  it('rejects an applicability question with the wrong type', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ applicability: { ...noulQuestion(), type: 'score' as 'noul' } })],
    }))).toThrow(RangeError);
  });

  it('rejects empty applicability instructions', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ applicability: noulQuestion({ instructions: '   ' }) })],
    }))).toThrow(RangeError);
  });

  it('rejects empty quality instructions', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ quality: scoreQuestion({ instructions: '' }) })],
    }))).toThrow(RangeError);
  });

  it('rejects applicability criteria with an empty true/false description', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ applicability: noulQuestion({ criteria: { true: '', false: 'no' } }) })],
    }))).toThrow(RangeError);
  });

  it('rejects a quality question with three levels instead of four', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ quality: scoreQuestion({ criteria: ['a', 'b', 'c'] }) })],
    }))).toThrow(RangeError);
  });

  it('rejects a quality question with five levels instead of four', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ quality: scoreQuestion({ criteria: ['a', 'b', 'c', 'd', 'e'] }) })],
    }))).toThrow(RangeError);
  });

  it('rejects a quality question with an empty level description', () => {
    expect(() => validateRubric(validRubric({
      dimensions: [dimension({ quality: scoreQuestion({ criteria: ['a', '', 'c', 'd'] }) })],
    }))).toThrow(RangeError);
  });
});
