import { describe, expect, it } from 'vitest';
import {
  assertJevRequestWithinBudget,
  buildJevRequest,
  buildJevState,
  canonicalizeJevRequest,
  checkJevRequestBudget,
  JEV_REQUEST_LIMITS,
  type JevRequest,
} from '../src/domain/jev-request.js';
import { JEV_MODEL_ID, RUBRIC_V1, RUBRIC_V2, type Rubric } from '../src/domain/rubric.js';
import {
  buildEvidenceBundle,
  DEFAULT_EVIDENCE_BUDGET,
  type EvidenceBundle,
  type EvidenceFragment,
} from '../src/domain/evidence.js';
import type { TestCase, TestCaseId, TestModifierKind } from '../src/domain/test-understanding.js';

const zeroSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc:v1:golden' as TestCaseId,
    repositoryRelativePath: 'a.test.ts',
    kind: 'test',
    framework: 'vitest',
    name: 'adds numbers',
    structuralAncestry: [{ kind: 'test', name: 'adds numbers', ordinal: 0 }],
    source: "test('adds numbers', () => {});",
    span: zeroSpan,
    modifiers: [],
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
    ...overrides,
  };
}

function fragment(overrides: Partial<EvidenceFragment> = {}): EvidenceFragment {
  return {
    kind: 'test',
    repositoryRelativePath: 'a.test.ts',
    span: zeroSpan,
    content: 'x',
    contentHash: 'h',
    selectionReason: 'test-body',
    truncation: { truncated: false, originalBytes: 1, includedBytes: 1 },
    ...overrides,
  };
}

function bundle(testCaseId: string, overrides: Partial<Parameters<typeof buildEvidenceBundle>[0]> = {}): EvidenceBundle {
  return buildEvidenceBundle({
    testCaseId: testCaseId as TestCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [fragment()],
    denied: [],
    unresolved: [],
    omitted: [],
    ...overrides,
  });
}

const goldenTestCase = testCase();
const goldenBundle = bundle('tc:v1:golden');

const tinyRubric: Rubric = {
  version: 1,
  model: JEV_MODEL_ID,
  dimensions: [{
    id: 'falsifiability',
    label: 'Falsifiability',
    applicability: { id: 'falsifiability.applicable', type: 'noul', instructions: 'Q1?' },
    quality: {
      id: 'falsifiability.quality',
      type: 'score',
      instructions: 'Q2?',
      criteria: ['L0', 'L1', 'L2', 'L3'],
    },
  }],
};

describe('buildJevState', () => {
  it('projects test identity, dropping the ancestry disambiguation ordinal', () => {
    const state = buildJevState(goldenTestCase, goldenBundle);

    expect(state).toEqual({
      testCaseId: 'tc:v1:golden',
      name: 'adds numbers',
      structuralAncestry: [{ kind: 'test', name: 'adds numbers' }],
      framework: 'vitest',
      repositoryRelativePath: 'a.test.ts',
      modifiers: [],
      fragments: [{
        kind: 'test',
        path: 'a.test.ts',
        selectionReason: 'test-body',
        truncated: false,
        content: 'x',
      }],
      denied: [],
      unresolved: [],
      omitted: [],
    });
  });

  it('projects modifiers as a sorted list of their kinds', () => {
    const withModifiers = testCase({
      modifiers: (['skip', 'concurrent'] as TestModifierKind[]).map((kind) => ({ kind, span: zeroSpan })),
    });

    expect(buildJevState(withModifiers, goldenBundle).modifiers).toEqual(['concurrent', 'skip']);
  });

  it('includes a fragment symbol when present', () => {
    const withSymbol = bundle('tc:v1:golden', { fragments: [fragment({ symbol: 'add' })] });

    expect(buildJevState(goldenTestCase, withSymbol).fragments[0]).toEqual({
      kind: 'test',
      path: 'a.test.ts',
      symbol: 'add',
      selectionReason: 'test-body',
      truncated: false,
      content: 'x',
    });
  });

  it('excludes contentHash, span, and byte counts from every fragment', () => {
    const state = buildJevState(goldenTestCase, goldenBundle);
    const keys = Object.keys(state.fragments[0] as object);

    expect(keys).not.toContain('contentHash');
    expect(keys).not.toContain('span');
    expect(keys).not.toContain('originalBytes');
    expect(keys).not.toContain('includedBytes');
    expect(keys).not.toContain('truncation');
  });

  it('carries denied, unresolved, and omitted provenance through to the state', () => {
    const full = bundle('tc:v1:golden', {
      denied: [{ repositoryRelativePath: '.env', rule: 'deny-list:dotenv' }],
      unresolved: [{ specifier: 'lodash', reason: 'bare-specifier' }],
      omitted: [{ repositoryRelativePath: 'src/big.ts', symbol: 'big', reason: 'bundle-budget-exhausted' }],
    });

    const state = buildJevState(goldenTestCase, full);

    expect(state.denied).toEqual([{ path: '.env', rule: 'deny-list:dotenv' }]);
    expect(state.unresolved).toEqual([{ specifier: 'lodash', reason: 'bare-specifier' }]);
    expect(state.omitted).toEqual([{ path: 'src/big.ts', symbol: 'big', reason: 'bundle-budget-exhausted' }]);
  });

  it('throws RangeError when the test case id does not match the bundle', () => {
    const mismatched = bundle('tc:v1:other');

    expect(() => buildJevState(goldenTestCase, mismatched)).toThrow(RangeError);
  });

  it('orders fragments deterministically regardless of input order', () => {
    const helper = fragment({
      kind: 'helper',
      repositoryRelativePath: 'b.ts',
      content: 'y',
      contentHash: 'h2',
      selectionReason: 'imported-binding-referenced',
      truncation: { truncated: false, originalBytes: 1, includedBytes: 1 },
    });
    const forward = bundle('tc:v1:golden', { fragments: [fragment(), helper] });
    const backward = bundle('tc:v1:golden', { fragments: [helper, fragment()] });

    expect(buildJevState(goldenTestCase, forward)).toEqual(buildJevState(goldenTestCase, backward));
  });
});

describe('buildJevRequest', () => {
  it('composes the model and every rubric question for the tiny fixture rubric', () => {
    const request = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: tinyRubric });

    expect(request.model).toBe('jev-1.13.0');
    expect(request.questions).toEqual({
      'falsifiability.applicable': { type: 'noul', instructions: 'Q1?' },
      'falsifiability.quality': { type: 'score', instructions: 'Q2?', criteria: ['L0', 'L1', 'L2', 'L3'] },
    });
  });

  it('composes all 14 questions from RUBRIC_V1, one applicable/quality pair per dimension', () => {
    const request = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: RUBRIC_V1 });

    expect(Object.keys(request.questions)).toHaveLength(14);
    for (const dimension of RUBRIC_V1.dimensions) {
      expect(request.questions[dimension.applicability.id]).toEqual({
        type: 'noul',
        instructions: dimension.applicability.instructions,
        criteria: dimension.applicability.criteria,
      });
      expect(request.questions[dimension.quality.id]).toEqual({
        type: 'score',
        instructions: dimension.quality.instructions,
        criteria: dimension.quality.criteria,
      });
    }
    expect(request.model).toBe('jev-1.13.0');
  });

  it('rejects an invalid rubric before composing anything', () => {
    const invalid: Rubric = { ...tinyRubric, model: 'jev-latest' };

    expect(() => buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: invalid })).toThrow(RangeError);
  });

  it('produces an already-canonical object: plain JSON.stringify matches canonicalizeJevRequest', () => {
    const request = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: tinyRubric });

    expect(JSON.stringify(request)).toBe(canonicalizeJevRequest(request));
  });
});

describe('canonicalizeJevRequest', () => {
  it(
    'produces the exact golden canonical request for the tiny fixture',
    () => {
      // Hand-derived structure (fixed key order from `canonicalizeJevRequest`):
      //   {"state":{"testCaseId":"tc:v1:golden","name":"adds numbers",
      //     "structuralAncestry":[{"kind":"test","name":"adds numbers"}],
      //     "framework":"vitest","repositoryRelativePath":"a.test.ts","modifiers":[],
      //     "fragments":[{"kind":"test","path":"a.test.ts","selectionReason":"test-body",
      //       "truncated":false,"content":"x"}],
      //     "denied":[],"unresolved":[],"omitted":[]},
      //   "model":"jev-1.13.0",
      //   "questions":{"falsifiability.applicable":{"type":"noul","instructions":"Q1?"},
      //     "falsifiability.quality":{"type":"score","instructions":"Q2?","criteria":["L0","L1","L2","L3"]}}}
      // No `symbol` key anywhere (the fixture fragment carries none) — confirming the
      // canonicalizer omits an absent optional field rather than emitting `null` for it,
      // unlike `canonicalizeEvidenceBundle`'s hash-input form. Byte length verified below
      // via `Buffer.byteLength` against this exact literal, the same technique
      // `test/estimate.test.ts` uses for its own golden.
      const golden =
        '{"state":{"testCaseId":"tc:v1:golden","name":"adds numbers","structuralAncestry":[{"kind":"test",'
        + '"name":"adds numbers"}],"framework":"vitest","repositoryRelativePath":"a.test.ts","modifiers":[],'
        + '"fragments":[{"kind":"test","path":"a.test.ts","selectionReason":"test-body","truncated":false,'
        + '"content":"x"}],"denied":[],"unresolved":[],"omitted":[]},"model":"jev-1.13.0",'
        + '"questions":{"falsifiability.applicable":{"type":"noul","instructions":"Q1?"},'
        + '"falsifiability.quality":{"type":"score","instructions":"Q2?","criteria":["L0","L1","L2","L3"]}}}';

      const request = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: tinyRubric });
      const canonical = canonicalizeJevRequest(request);

      expect(canonical).toBe(golden);
      expect(Buffer.byteLength(canonical, 'utf8')).toBe(543);
      expect(JSON.parse(canonical)).toEqual(JSON.parse(golden));
    },
  );

  it('starts with the provider contract key order: state, then model, then questions', () => {
    const request = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: tinyRubric });

    expect(canonicalizeJevRequest(request).startsWith('{"state":')).toBe(true);
    expect(Object.keys(JSON.parse(canonicalizeJevRequest(request)) as object)).toEqual(['state', 'model', 'questions']);
  });

  it('is deterministic regardless of fragment/denied/unresolved/omitted insertion order', () => {
    const helper = fragment({
      kind: 'helper',
      repositoryRelativePath: 'b.ts',
      content: 'y',
      contentHash: 'h2',
      selectionReason: 'imported-binding-referenced',
      truncation: { truncated: false, originalBytes: 1, includedBytes: 1 },
    });
    const denied = [
      { repositoryRelativePath: '.env', rule: 'deny-list:dotenv' },
      { repositoryRelativePath: 'secrets/key.pem', rule: 'deny-list:pem' },
    ];

    const forward = buildJevRequest({
      testCase: goldenTestCase,
      bundle: bundle('tc:v1:golden', { fragments: [fragment(), helper], denied }),
      rubric: tinyRubric,
    });
    const backward = buildJevRequest({
      testCase: goldenTestCase,
      bundle: bundle('tc:v1:golden', { fragments: [helper, fragment()], denied: [...denied].reverse() }),
      rubric: tinyRubric,
    });

    expect(canonicalizeJevRequest(forward)).toBe(canonicalizeJevRequest(backward));
  });

  it('is deterministic regardless of question insertion order', () => {
    const reorderedRubric: Rubric = {
      ...RUBRIC_V1,
      dimensions: [...RUBRIC_V1.dimensions].reverse(),
    };

    const inOrder = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: RUBRIC_V1 });
    const reordered = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: reorderedRubric });

    expect(canonicalizeJevRequest(inOrder)).toBe(canonicalizeJevRequest(reordered));
  });
});

describe('checkJevRequestBudget / assertJevRequestWithinBudget', () => {
  const request: JevRequest = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: tinyRubric });

  it('reports within-budget for a tiny request under the shipped default limits', () => {
    const check = checkJevRequestBudget(request);

    expect(check.withinTotal).toBe(true);
    expect(check.withinStatePlusLongestQuestion).toBe(true);
    expect(check.estimatedTotalTokens).toBeGreaterThan(0);
    expect(check.estimatedStatePlusLongestQuestionTokens).toBeGreaterThan(0);
    expect(() => assertJevRequestWithinBudget(check)).not.toThrow();
  });

  it('reports over-budget against a tight total-token ceiling override', () => {
    const check = checkJevRequestBudget(request, { ...JEV_REQUEST_LIMITS, totalTokenCeiling: 10 });

    expect(check.withinTotal).toBe(false);
    expect(() => assertJevRequestWithinBudget(check)).toThrow(RangeError);
  });

  it('reports over-budget against a tight state-plus-longest-question ceiling override, independent of the total', () => {
    const check = checkJevRequestBudget(request, {
      ...JEV_REQUEST_LIMITS,
      statePlusLongestQuestionTokenCeiling: 5,
    });

    expect(check.withinTotal).toBe(true);
    expect(check.withinStatePlusLongestQuestion).toBe(false);
    expect(() => assertJevRequestWithinBudget(check)).toThrow(RangeError);
  });

  it('fits the shipped RUBRIC_V1 request within both default limits at the maximum evidence bundle size', () => {
    // Four fragments, each at the per-fragment budget ceiling (4,096 bytes), summing to
    // exactly the per-bundle budget ceiling (16,384 bytes) — the largest bundle
    // `buildEvidenceBundle` allows under `DEFAULT_EVIDENCE_BUDGET`. Proves the real
    // 14-question rubric composed over a maximally-sized bundle still fits under the
    // verified provider ceilings (64k total / 32k state+longest-question).
    const maxFragmentContent = 'x'.repeat(DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes);
    const maxFragment = (kind: EvidenceFragment['kind'], path: string): EvidenceFragment => fragment({
      kind,
      repositoryRelativePath: path,
      content: maxFragmentContent,
      truncation: {
        truncated: false,
        originalBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes,
        includedBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes,
      },
    });
    const maxBundle = bundle('tc:v1:golden', {
      fragments: [
        maxFragment('test', 'a.test.ts'),
        maxFragment('helper', 'b.ts'),
        maxFragment('production-seam', 'c.ts'),
        maxFragment('mock-target', 'd.ts'),
      ],
    });
    expect(maxBundle.totals.includedBytes).toBe(DEFAULT_EVIDENCE_BUDGET.maxBundleBytes);

    const maxRequest = buildJevRequest({ testCase: goldenTestCase, bundle: maxBundle, rubric: RUBRIC_V1 });
    const check = checkJevRequestBudget(maxRequest);

    expect(check.withinTotal).toBe(true);
    expect(check.withinStatePlusLongestQuestion).toBe(true);
  });

  it('fits the shipped RUBRIC_V2 request within both default limits at the maximum evidence bundle size (task C-2)', () => {
    // Same maximal bundle as the RUBRIC_V1 case above, against the rubric task C-2 actually ships
    // (src/adapters/jev-evaluation-port.ts): proves the rewritten determinism-isolation/falsifiability
    // applicability questions did not push a real, maximally-sized request over either provider ceiling.
    const maxFragmentContent = 'x'.repeat(DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes);
    const maxFragment = (kind: EvidenceFragment['kind'], path: string): EvidenceFragment => fragment({
      kind,
      repositoryRelativePath: path,
      content: maxFragmentContent,
      truncation: {
        truncated: false,
        originalBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes,
        includedBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes,
      },
    });
    const maxBundle = bundle('tc:v1:golden', {
      fragments: [
        maxFragment('test', 'a.test.ts'),
        maxFragment('helper', 'b.ts'),
        maxFragment('production-seam', 'c.ts'),
        maxFragment('mock-target', 'd.ts'),
      ],
    });
    expect(maxBundle.totals.includedBytes).toBe(DEFAULT_EVIDENCE_BUDGET.maxBundleBytes);

    const maxRequest = buildJevRequest({ testCase: goldenTestCase, bundle: maxBundle, rubric: RUBRIC_V2 });
    const check = checkJevRequestBudget(maxRequest);

    expect(check.withinTotal).toBe(true);
    expect(check.withinStatePlusLongestQuestion).toBe(true);
  });
});
