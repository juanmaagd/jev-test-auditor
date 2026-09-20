import { describe, expect, it } from 'vitest';
import {
  classifyTestCase,
  estimateDryRun,
  JEV_ESTIMATE_SNAPSHOT,
  JEV_VERIFIED_RATE_LIMITS,
  validateJevEstimateSnapshot,
  type DryRunFileInput,
  type JevEstimateSnapshot,
} from '../src/domain/estimate.js';
import { JEV_MODEL_ID } from '../src/domain/rubric.js';
import {
  buildEvidenceBundle,
  canonicalizeEvidenceBundle,
  DEFAULT_EVIDENCE_BUDGET,
  type EvidenceBundle,
} from '../src/domain/evidence.js';
import type { TestCase, TestCaseId, TestModifierKind } from '../src/domain/test-understanding.js';

const zeroSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };

function testCase(id: string, modifierKinds: readonly TestModifierKind[]): TestCase {
  return {
    id: id as TestCaseId,
    repositoryRelativePath: 'a.test.ts',
    kind: 'test',
    framework: 'vitest',
    name: id,
    structuralAncestry: [{ kind: 'test', name: id, ordinal: 0 }],
    source: `test('${id}', () => {});`,
    span: zeroSpan,
    modifiers: modifierKinds.map((kind) => ({ kind, span: zeroSpan })),
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
  };
}

/**
 * One fragment, 1-byte content, path `a.ts`, hash `h`. When `testCaseId` is
 * exactly `tc:v1:abc`, its canonical form (`canonicalizeEvidenceBundle`) is
 * exactly 477 UTF-8 bytes — hand-counted from the exact serialized string
 * (fixed key order from `canonicalizeEvidenceBundle`) and pinned by the
 * first assertion in the golden test below. Every arithmetic assertion in
 * that test is hand-derived from this one fixed byte count.
 */
function smallBundle(testCaseId: string): EvidenceBundle {
  return buildEvidenceBundle({
    testCaseId: testCaseId as TestCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [{
      kind: 'test',
      repositoryRelativePath: 'a.ts',
      span: zeroSpan,
      content: 'x',
      contentHash: 'h',
      selectionReason: 'test-body',
      truncation: { truncated: false, originalBytes: 1, includedBytes: 1 },
    }],
    denied: [],
    unresolved: [],
    omitted: [],
  });
}

describe('JEV_ESTIMATE_SNAPSHOT', () => {
  it('carries the verified Jev 1.13.0 pricing/overhead facts', () => {
    expect(JEV_ESTIMATE_SNAPSHOT).toEqual({
      version: 1,
      model: 'jev-1.13.0',
      asOf: '2026-09-19',
      usdPerMillionInputTokens: 0.042,
      outputTokensBilled: false,
      bytesPerToken: { min: 2.5, max: 4.5 },
      requestOverheadTokens: { min: 620, max: 2440 },
      maxFollowUpsPerTest: 1,
      requestTokenCeiling: 64_000,
    });
  });

  it('pins model to the exact JEV_MODEL_ID constant (identity, not a re-typed literal) so the estimator can never silently drift from the rubric pin', () => {
    expect(JEV_ESTIMATE_SNAPSHOT.model).toBe(JEV_MODEL_ID);
  });

  it('validates without throwing', () => {
    expect(() => validateJevEstimateSnapshot(JEV_ESTIMATE_SNAPSHOT)).not.toThrow();
  });
});

describe('JEV_VERIFIED_RATE_LIMITS', () => {
  it('carries the verified TypeSafe/Jev provider rate limits (2026-09-20, docs.typesafe.ai/models)', () => {
    expect(JEV_VERIFIED_RATE_LIMITS).toEqual({
      tokensPerSecond: 250_000,
      requestsPerMinute: 1_200,
    });
  });
});

describe('validateJevEstimateSnapshot', () => {
  const valid = JEV_ESTIMATE_SNAPSHOT;

  it('accepts the shipped snapshot', () => {
    expect(() => validateJevEstimateSnapshot(valid)).not.toThrow();
  });

  it('rejects a non-positive version', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, version: 0 })).toThrow(RangeError);
  });

  it('rejects a non-integer version', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, version: 1.5 })).toThrow(RangeError);
  });

  it('rejects an empty model', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, model: '' })).toThrow(RangeError);
  });

  it('rejects a malformed asOf date', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, asOf: '2026/09/19' })).toThrow(RangeError);
  });

  it('rejects a non-positive price', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, usdPerMillionInputTokens: 0 })).toThrow(RangeError);
  });

  it('rejects a negative price', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, usdPerMillionInputTokens: -0.01 })).toThrow(RangeError);
  });

  it('rejects a non-boolean outputTokensBilled', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, outputTokensBilled: 'no' as unknown as boolean })).toThrow(RangeError);
  });

  it('rejects outputTokensBilled: true (fail-closed: this estimator has no output-token model yet, so it must never silently under-estimate)', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, outputTokensBilled: true })).toThrow(RangeError);
  });

  it('rejects a non-positive bytesPerToken.min', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, bytesPerToken: { min: 0, max: 4.5 } })).toThrow(RangeError);
  });

  it('rejects bytesPerToken.min exceeding bytesPerToken.max', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, bytesPerToken: { min: 5, max: 4.5 } })).toThrow(RangeError);
  });

  it('rejects a negative requestOverheadTokens.min', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, requestOverheadTokens: { min: -1, max: 100 } })).toThrow(RangeError);
  });

  it('rejects requestOverheadTokens.min exceeding requestOverheadTokens.max', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, requestOverheadTokens: { min: 500, max: 100 } })).toThrow(RangeError);
  });

  it('allows a zero requestOverheadTokens.min (no overhead floor is valid, if pessimistic)', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, requestOverheadTokens: { min: 0, max: 100 } })).not.toThrow();
  });

  it('rejects a negative maxFollowUpsPerTest', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, maxFollowUpsPerTest: -1 })).toThrow(RangeError);
  });

  it('rejects a non-integer maxFollowUpsPerTest', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, maxFollowUpsPerTest: 1.5 })).toThrow(RangeError);
  });

  it('rejects a non-positive requestTokenCeiling', () => {
    expect(() => validateJevEstimateSnapshot({ ...valid, requestTokenCeiling: 0 })).toThrow(RangeError);
  });
});

describe('classifyTestCase', () => {
  it('classifies a skip-modifier test as skipped/skip even when a bundle exists', () => {
    expect(classifyTestCase(testCase('tc:v1:a', ['skip']), smallBundle('tc:v1:a')))
      .toEqual({ status: 'skipped', reason: 'skip' });
  });

  it('classifies a todo-modifier test as skipped/todo', () => {
    expect(classifyTestCase(testCase('tc:v1:a', ['todo']), undefined))
      .toEqual({ status: 'skipped', reason: 'todo' });
  });

  it('classifies a test with no modifier and no built bundle as skipped/evidence-unavailable', () => {
    expect(classifyTestCase(testCase('tc:v1:a', []), undefined))
      .toEqual({ status: 'skipped', reason: 'evidence-unavailable' });
  });

  it('classifies a test with no modifier and a built bundle as evaluable', () => {
    expect(classifyTestCase(testCase('tc:v1:a', []), smallBundle('tc:v1:a')))
      .toEqual({ status: 'evaluable' });
  });

  it('treats a conditional skipIf modifier as evaluable (not a static skip) when a bundle exists', () => {
    expect(classifyTestCase(testCase('tc:v1:a', ['skipIf']), smallBundle('tc:v1:a')))
      .toEqual({ status: 'evaluable' });
  });

  it('treats a conditional runIf modifier as evaluable when a bundle exists', () => {
    expect(classifyTestCase(testCase('tc:v1:a', ['runIf']), smallBundle('tc:v1:a')))
      .toEqual({ status: 'evaluable' });
  });

  it('still reports evidence-unavailable for a skipIf test with no built bundle', () => {
    expect(classifyTestCase(testCase('tc:v1:a', ['skipIf']), undefined))
      .toEqual({ status: 'skipped', reason: 'evidence-unavailable' });
  });
});

describe('estimateDryRun', () => {
  it('returns an all-zero preview for a repository with no discovered test cases', () => {
    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, []);

    expect(result).toEqual({
      snapshotVersion: 1,
      model: 'jev-1.13.0',
      asOf: '2026-09-19',
      discovered: 0,
      evaluable: 0,
      skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
      initialCalls: 0,
      followUpCalls: { min: 0, max: 0 },
      evidenceBytes: 0,
      estimatedInputTokens: { min: 0, max: 0 },
      estimatedFollowUpInputTokens: { min: 0, max: 0 },
      estimatedUsd: { min: 0, max: 0 },
      bundlesOverCeiling: 0,
      requestTokenCeiling: 64_000,
    });
  });

  it('throws RangeError for an invalid snapshot before touching the files', () => {
    expect(() => estimateDryRun({ ...JEV_ESTIMATE_SNAPSHOT, requestTokenCeiling: 0 }, [])).toThrow(RangeError);
  });

  it(
    'computes the exact golden preview for one evaluable test plus one skip, one todo, and one missing-bundle test',
    () => {
      // Hand arithmetic (see class doc on `smallBundle` for the byte count):
      //   bytes = 477
      //   perBundleMin = floor(477 / bytesPerToken.max) = floor(477 / 4.5) = floor(106.0) = 106
      //   perBundleMax = ceil(477 / bytesPerToken.min) = ceil(477 / 2.5) = ceil(190.8) = 191
      //   initialTokensMin = 106 + 1 * requestOverheadTokens.min(620) = 726
      //   initialTokensMax = 191 + 1 * requestOverheadTokens.max(2440) = 2631
      //   followUpCalls = { min: 0, max: 1 * maxFollowUpsPerTest(1) = 1 }
      //   followUpTokensMax = initialTokensMax(2631) * maxFollowUpsPerTest(1) = 2631
      //   usdMin = 726 * 0.042 / 1e6 = 30.492 / 1e6 = 0.000030492
      //   usdMax = (2631 + 2631) * 0.042 / 1e6 = 5262 * 0.042 / 1e6 = 221.004 / 1e6 = 0.000221004
      //   bundlesOverCeiling: 191 + 2440 = 2631 <= 64000 -> 0
      const bundle = smallBundle('tc:v1:abc');
      expect(Buffer.byteLength(canonicalizeEvidenceBundle(bundle), 'utf8')).toBe(477);

      const files: readonly DryRunFileInput[] = [{
        testCases: [
          testCase('tc:v1:abc', []),
          testCase('tc:v1:skip-1', ['skip']),
          testCase('tc:v1:todo-1', ['todo']),
          testCase('tc:v1:missing-1', []),
        ],
        evidence: [bundle],
      }];

      const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);

      expect(result).toEqual({
        snapshotVersion: 1,
        model: 'jev-1.13.0',
        asOf: '2026-09-19',
        discovered: 4,
        evaluable: 1,
        skipped: { total: 3, byReason: { skip: 1, todo: 1, 'evidence-unavailable': 1 } },
        initialCalls: 1,
        followUpCalls: { min: 0, max: 1 },
        evidenceBytes: 477,
        estimatedInputTokens: { min: 726, max: 2631 },
        estimatedFollowUpInputTokens: { min: 0, max: 2631 },
        estimatedUsd: { min: 0.000030492, max: 0.000221004 },
        bundlesOverCeiling: 0,
        requestTokenCeiling: 64_000,
      });
    },
  );

  it('is deterministic: repeated calls with the same input produce byte-identical JSON', () => {
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:a', [])],
      evidence: [smallBundle('tc:v1:a')],
    }];

    const first = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);
    const second = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('counts an evaluable bundle whose worst-case tokens exceed a tight requestTokenCeiling', () => {
    const tight: JevEstimateSnapshot = { ...JEV_ESTIMATE_SNAPSHOT, requestTokenCeiling: 100 };
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:a', [])],
      evidence: [smallBundle('tc:v1:a')],
    }];

    const result = estimateDryRun(tight, files);

    expect(result.bundlesOverCeiling).toBe(1);
  });

  it('never flags bundlesOverCeiling under the shipped default snapshot (current budgets stay well under the ceiling)', () => {
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:a', [])],
      evidence: [smallBundle('tc:v1:a')],
    }];

    expect(estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files).bundlesOverCeiling).toBe(0);
  });

  it("excludes a skipped test case's bundle from evidenceBytes/tokens even when one was built", () => {
    // Production always builds evidence for every discovered test case regardless of
    // modifiers (see `src/application/audit.ts`), so a skip/todo test WITH a bundle is
    // the normal case, not an edge case — its bytes/tokens must never be counted.
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:abc', []), testCase('tc:v1:skip-with-bundle', ['skip'])],
      evidence: [smallBundle('tc:v1:abc'), smallBundle('tc:v1:skip-with-bundle')],
    }];

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);

    expect(result.evaluable).toBe(1);
    expect(result.skipped.byReason.skip).toBe(1);
    expect(result.evidenceBytes).toBe(477);
    expect(result.estimatedInputTokens).toEqual({ min: 726, max: 2631 });
  });

  it('sums discovered/evaluable/skipped counts across multiple files', () => {
    const bundleA = smallBundle('tc:v1:file-a-1');
    const bundleB = smallBundle('tc:v1:file-b-1');
    const files: readonly DryRunFileInput[] = [
      { testCases: [testCase('tc:v1:file-a-1', []), testCase('tc:v1:file-a-2', ['skip'])], evidence: [bundleA] },
      { testCases: [testCase('tc:v1:file-b-1', [])], evidence: [bundleB] },
    ];

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);

    expect(result.discovered).toBe(3);
    expect(result.evaluable).toBe(2);
    expect(result.skipped).toEqual({ total: 1, byReason: { skip: 1, todo: 0, 'evidence-unavailable': 0 } });
    expect(result.initialCalls).toBe(2);
  });
});
