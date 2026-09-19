import { describe, expect, it } from 'vitest';
import {
  JEV_MODEL_ID,
  RUBRIC_DIMENSION_IDS,
  RUBRIC_QUALITY_LEVEL_COUNT,
  RUBRIC_QUALITY_LEVELS,
  RUBRIC_V1,
  validateRubric,
  type Rubric,
  type RubricDimension,
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
