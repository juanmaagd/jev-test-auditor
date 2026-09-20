import { describe, expect, it } from 'vitest';
import {
  classifyTestCase,
  estimateDryRun,
  estimateTokensFromBytes,
  JEV_ESTIMATE_SNAPSHOT,
  JEV_VERIFIED_RATE_LIMITS,
  validateJevEstimateSnapshot,
  type DryRunFileInput,
  type JevEstimateSnapshot,
} from '../src/domain/estimate.js';
import { JEV_MODEL_ID, RUBRIC_V1, RUBRIC_V2, type Rubric } from '../src/domain/rubric.js';
import {
  buildJevQuestions,
  buildJevRequest,
  canonicalizeJevRequest,
  canonicalizeJevRequestQuestions,
} from '../src/domain/jev-request.js';
import {
  buildEvidenceBundle,
  canonicalizeEvidenceBundle,
  DEFAULT_EVIDENCE_BUDGET,
  utf8ByteLength,
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

/**
 * Same shape as {@link smallBundle}, but with plain-ASCII (`x`) content of an
 * exact, caller-chosen byte length — used by the real-world calibration
 * regression test below to engineer an exact total canonical request byte
 * count across several test cases (a plain ASCII char never needs JSON
 * escaping, so each added character contributes exactly one more canonical
 * byte, verified against the real `buildJevRequest`/`canonicalizeJevRequest`
 * functions when the fixture was constructed).
 */
function contentLengthBundle(testCaseId: string, length: number): EvidenceBundle {
  return buildEvidenceBundle({
    testCaseId: testCaseId as TestCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [{
      kind: 'test',
      repositoryRelativePath: 'a.ts',
      span: zeroSpan,
      content: 'x'.repeat(length),
      contentHash: 'h',
      selectionReason: 'test-body',
      truncation: { truncated: false, originalBytes: length, includedBytes: length },
    }],
    denied: [],
    unresolved: [],
    omitted: [],
  });
}

describe('JEV_ESTIMATE_SNAPSHOT', () => {
  it(
    'carries the verified Jev 1.13.0 pricing facts, re-calibrated from one real 11-request run on 2026-09-20 '
    + '(4.458 measured bytes/token; requestOverheadTokens removed — overhead is now measured from the real '
    + "rubric-built request, never guessed)",
    () => {
      expect(JEV_ESTIMATE_SNAPSHOT).toEqual({
        version: 2,
        model: 'jev-1.13.0',
        asOf: '2026-09-20',
        usdPerMillionInputTokens: 0.042,
        outputTokensBilled: false,
        bytesPerToken: { min: 3.0, max: 4.8 },
        maxFollowUpsPerTest: 1,
        requestTokenCeiling: 64_000,
      });
    },
  );

  it(
    'keeps bytesPerToken.min deliberately conservative (3.0, below the single observed 4.458 sample) because '
    + 'the two bounds fail asymmetrically: a real ratio above max only overestimates cost (harmless), but a real '
    + 'ratio below min understates what the user is actually billed — the exact failure this correction exists '
    + 'to fix. Denser-than-English content (JSON-heavy fixtures, non-Latin/CJK source) can tokenize below the '
    + 'single English/TypeScript sample this snapshot was calibrated from, so min stays well below it rather '
    + 'than tight around it. Mutation guard: reverting min to the old 3.5 must fail this exact assertion.',
    () => {
      expect(JEV_ESTIMATE_SNAPSHOT.bytesPerToken.min).toBe(3.0);
      // A hypothetical denser-than-sample ratio (3.2 bytes/token) sits between the old 3.5
      // floor and the new 3.0 floor: the old bound would have missed it (understating tokens
      // for that content), the new one still brackets it.
      const denserThanSampleRatio = 3.2;
      expect(JEV_ESTIMATE_SNAPSHOT.bytesPerToken.min).toBeLessThanOrEqual(denserThanSampleRatio);
    },
  );

  it('never carries a requestOverheadTokens field (deleted: overhead is measured from the real request, not assumed)', () => {
    expect(Object.hasOwn(JEV_ESTIMATE_SNAPSHOT, 'requestOverheadTokens')).toBe(false);
  });

  it('pins model to the exact JEV_MODEL_ID constant (identity, not a re-typed literal) so the estimator can never silently drift from the rubric pin', () => {
    expect(JEV_ESTIMATE_SNAPSHOT.model).toBe(JEV_MODEL_ID);
  });

  it('validates without throwing', () => {
    expect(() => validateJevEstimateSnapshot(JEV_ESTIMATE_SNAPSHOT)).not.toThrow();
  });

  it('brackets the measured real-world ratio (320,360 canonical request bytes / 71,855 billed tokens = 4.458 bytes/token) with margin', () => {
    const observedBytesPerToken = 320_360 / 71_855;
    expect(observedBytesPerToken).toBeCloseTo(4.458, 3);
    expect(JEV_ESTIMATE_SNAPSHOT.bytesPerToken.min).toBeLessThanOrEqual(observedBytesPerToken);
    expect(JEV_ESTIMATE_SNAPSHOT.bytesPerToken.max).toBeGreaterThanOrEqual(observedBytesPerToken);
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
      snapshotVersion: 2,
      model: 'jev-1.13.0',
      asOf: '2026-09-20',
      discovered: 0,
      evaluable: 0,
      skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
      initialCalls: 0,
      followUpCalls: { min: 0, max: 0 },
      evidenceBytes: 0,
      requestBytes: 0,
      // Rubric-only, computed from the default RUBRIC_V2 (task C-2) regardless of how many (if
      // any) test cases were discovered — see the dedicated golden test below.
      rubricBytesPerRequest: 27_701,
      estimatedInputTokens: { min: 0, max: 0 },
      estimatedFollowUpInputTokens: { min: 0, max: 0 },
      estimatedUsd: { min: 0, max: 0 },
      bundlesOverCeiling: 0,
      requestTokenCeiling: 64_000,
    });
  });

  it("pins RUBRIC_V1's own canonical questions-map size at 26,979 bytes (~93% of the real ~29,124-byte average request — see docs/technical-design.md)", () => {
    expect(utf8ByteLength(canonicalizeJevRequestQuestions(buildJevQuestions(RUBRIC_V1)))).toBe(26_979);
  });

  it("pins RUBRIC_V2's own canonical questions-map size at 27,701 bytes (task C-2's rewritten determinism-isolation/falsifiability applicability questions add 722 bytes over RUBRIC_V1)", () => {
    expect(utf8ByteLength(canonicalizeJevRequestQuestions(buildJevQuestions(RUBRIC_V2)))).toBe(27_701);
  });

  it('throws RangeError for an invalid snapshot before touching the files', () => {
    expect(() => estimateDryRun({ ...JEV_ESTIMATE_SNAPSHOT, requestTokenCeiling: 0 }, [])).toThrow(RangeError);
  });

  it(
    'computes the exact golden preview for one evaluable test plus one skip, one todo, and one missing-bundle test, '
    + 'measuring the real RUBRIC_V2 request instead of guessing an overhead',
    () => {
      // Hand arithmetic:
      //   evidenceBytes (bundle-only, unaffected by the rubric) = 477
      //   requestBytes: the exact canonical `buildJevRequest`+`canonicalizeJevRequest` bytes for this test
      //     case's bundle against the default RUBRIC_V2 (task C-2) — pinned below by cross-checking against
      //     those same real functions, not hand-derived, since the exact figure depends on the full
      //     14-question rubric text (see `rubricBytesPerRequest`'s own golden test above for that fixed
      //     27,701-byte contribution).
      //   tokensMin = floor(requestBytes / bytesPerToken.max) = floor(28068 / 4.8) = 5847
      //   tokensMax = ceil(requestBytes / bytesPerToken.min) = ceil(28068 / 3.0) = 9356
      //   followUpCalls = { min: 0, max: 1 * maxFollowUpsPerTest(1) = 1 }
      //   followUpTokensMax = initialTokensMax(9356) * maxFollowUpsPerTest(1) = 9356
      //   usdMin = 5847 * 0.042 / 1e6 = 0.000245574
      //   usdMax = (9356 + 9356) * 0.042 / 1e6 = 0.000785904
      //   bundlesOverCeiling: 9356 <= 64000 -> 0
      const bundle = smallBundle('tc:v1:abc');
      expect(Buffer.byteLength(canonicalizeEvidenceBundle(bundle), 'utf8')).toBe(477);
      const goldenRequestBytes = utf8ByteLength(
        canonicalizeJevRequest(buildJevRequest({ testCase: testCase('tc:v1:abc', []), bundle, rubric: RUBRIC_V2 })),
      );
      expect(goldenRequestBytes).toBe(28_068);

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
        snapshotVersion: 2,
        model: 'jev-1.13.0',
        asOf: '2026-09-20',
        discovered: 4,
        evaluable: 1,
        skipped: { total: 3, byReason: { skip: 1, todo: 1, 'evidence-unavailable': 1 } },
        initialCalls: 1,
        followUpCalls: { min: 0, max: 1 },
        evidenceBytes: 477,
        requestBytes: goldenRequestBytes,
        rubricBytesPerRequest: 27_701,
        estimatedInputTokens: { min: 5847, max: 9356 },
        estimatedFollowUpInputTokens: { min: 0, max: 9356 },
        estimatedUsd: { min: 0.000245574, max: 0.000785904 },
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

  it("excludes a skipped test case's bundle from evidenceBytes/requestBytes/tokens even when one was built", () => {
    // Production always builds evidence for every discovered test case regardless of
    // modifiers (see `src/application/audit.ts`), so a skip/todo test WITH a bundle is
    // the normal case, not an edge case — its bytes/tokens must never be counted. This
    // also guards the request-bytes path specifically: a skipped test case must never
    // contribute a second real request's worth of bytes just because it has a bundle
    // (mutation probe: "count skipped tests" toward requestBytes must fail this test).
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:abc', []), testCase('tc:v1:skip-with-bundle', ['skip'])],
      evidence: [smallBundle('tc:v1:abc'), smallBundle('tc:v1:skip-with-bundle')],
    }];

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);

    expect(result.evaluable).toBe(1);
    expect(result.skipped.byReason.skip).toBe(1);
    expect(result.evidenceBytes).toBe(477);
    expect(result.requestBytes).toBe(28_068);
    expect(result.estimatedInputTokens).toEqual({ min: 5847, max: 9356 });
  });

  it('measures requestBytes as the exact sum of the real canonical buildJevRequest bytes for every evaluable test case (not evidence bytes)', () => {
    const bundleA = smallBundle('tc:v1:file-a-1');
    const bundleB = smallBundle('tc:v1:file-b-1');
    const files: readonly DryRunFileInput[] = [
      { testCases: [testCase('tc:v1:file-a-1', [])], evidence: [bundleA] },
      { testCases: [testCase('tc:v1:file-b-1', [])], evidence: [bundleB] },
    ];

    const expectedRequestBytes = [
      { id: 'tc:v1:file-a-1', bundle: bundleA },
      { id: 'tc:v1:file-b-1', bundle: bundleB },
    ].reduce((total, { id, bundle }) => {
      const request = buildJevRequest({ testCase: testCase(id, []), bundle, rubric: RUBRIC_V2 });
      return total + utf8ByteLength(canonicalizeJevRequest(request));
    }, 0);

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);

    expect(result.requestBytes).toBe(expectedRequestBytes);
    // The two identically-shaped bundles under distinct ids produce the same request byte
    // count each, so requestBytes must be well above evidenceBytes-only accounting once the
    // rubric's own ~27KB contribution is included per request.
    expect(result.requestBytes).toBeGreaterThan(result.evidenceBytes * 10);
  });

  it('injects a custom rubric instead of always defaulting to RUBRIC_V2, changing requestBytes/rubricBytesPerRequest accordingly', () => {
    const tinyRubric: Rubric = {
      version: 1,
      model: JEV_MODEL_ID,
      dimensions: [{
        id: 'falsifiability',
        label: 'Falsifiability',
        applicability: { id: 'falsifiability.applicable', type: 'noul', instructions: 'Q1?' },
        quality: { id: 'falsifiability.quality', type: 'score', instructions: 'Q2?', criteria: ['L0', 'L1', 'L2', 'L3'] },
      }],
    };
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:abc', [])],
      evidence: [smallBundle('tc:v1:abc')],
    }];

    const defaultResult = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);
    const tinyResult = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files, tinyRubric);

    expect(tinyResult.rubricBytesPerRequest).toBeLessThan(defaultResult.rubricBytesPerRequest);
    expect(tinyResult.requestBytes).toBeLessThan(defaultResult.requestBytes);
    expect(tinyResult.evidenceBytes).toBe(defaultResult.evidenceBytes);
  });

  it('throws RangeError for an invalid injected rubric before touching the files, even with zero evaluable test cases', () => {
    const invalidRubric: Rubric = { version: 1, model: 'jev-latest', dimensions: [] };

    expect(() => estimateDryRun(JEV_ESTIMATE_SNAPSHOT, [], invalidRubric)).toThrow(RangeError);
  });

  it(
    'contains the real measured 71,855 billed tokens within the estimated range built from 320,360 measured '
    + 'canonical request bytes across 11 evaluable test cases (the exact totals from the first real Jev run, '
    + '2026-09-20) — and shows the old evidence-bytes-plus-guessed-overhead model would have MISSED it',
    () => {
      // Eleven fixed-width test-case ids so every request's non-content byte overhead is
      // identical, letting plain ASCII content-length padding control each request's exact
      // byte count with no escaping side effects (verified: +1 content char == +1 byte).
      // Content lengths were solved so the 11 requests' real `canonicalizeJevRequest` bytes
      // sum to exactly 320,360 — the measured total for the first real 11-request Jev run
      // (see the correction's "Why", 2026-09-20). Ten requests carry 1,754 padding bytes,
      // one carries 1,761, absorbing the remainder so the sum lands exactly on 320,360.
      const contentLengths = [1754, 1754, 1754, 1754, 1754, 1754, 1754, 1754, 1754, 1754, 1761];
      expect(contentLengths).toHaveLength(11);

      const files: readonly DryRunFileInput[] = contentLengths.map((length, index) => {
        const id = `tc:v1:reqbytes-${String(index).padStart(2, '0')}`;
        return { testCases: [testCase(id, [])], evidence: [contentLengthBundle(id, length)] };
      });

      // The real first Jev run this reproduces (2026-09-20) was made under RUBRIC_V1 — the rubric
      // shipped at the time — so `RUBRIC_V1` is passed explicitly here regardless of what
      // `estimateDryRun`'s own default rubric is today (RUBRIC_V2, as of task C-2). This test is
      // about reproducing that historical measurement exactly, not about previewing today's default.
      const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files, RUBRIC_V1);

      expect(result.evaluable).toBe(11);
      expect(result.requestBytes).toBe(320_360);
      expect(result.estimatedInputTokens.min).toBeLessThanOrEqual(71_855);
      expect(result.estimatedInputTokens.max).toBeGreaterThanOrEqual(71_855);

      // Regression: reconstruct what the OLD (pre-fix) evidence-bytes-plus-guessed-overhead
      // model would have reported for this exact fixture — it must NOT contain 71,855, the
      // same failure the real run exposed (measured old estimate there: 12,747-37,523 vs the
      // 71,855 actual). `estimateTokensFromBytes` is still the same pure conversion function;
      // only the old snapshot's bytesPerToken/requestOverheadTokens values (now deleted from
      // the shipped snapshot) are reconstructed here, deliberately, to prove the regression.
      const oldBytesPerToken = { min: 2.5, max: 4.5 };
      const oldRequestOverheadTokens = { min: 620, max: 2440 };
      const oldRange = estimateTokensFromBytes(result.evidenceBytes, oldBytesPerToken);
      const oldMin = oldRange.min + result.evaluable * oldRequestOverheadTokens.min;
      const oldMax = oldRange.max + result.evaluable * oldRequestOverheadTokens.max;
      const oldRangeContains71855 = oldMin <= 71_855 && 71_855 <= oldMax;

      expect(oldRangeContains71855).toBe(false);
      expect(oldMax).toBeLessThan(71_855);
    },
  );

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

/**
 * Phase 5, task P5-5: feeding per-test-case cache-hit lookups into
 * `estimateDryRun` so `initialCalls`/estimated tokens/estimated cost count
 * only billable requests, and cache hits are reported separately. The
 * fourth parameter is plain data (`ReadonlySet<TestCaseId>`) — this stays a
 * pure domain function, no I/O, no port; the application/CLI layer performs
 * the real store lookups and hands the resulting set of hit ids in.
 *
 * Every fixture below deliberately gives its evaluable test cases distinct,
 * non-symmetric content lengths and picks a hit count that differs from
 * both `evaluable` and `billable` (this phase's own carried-forward
 * warning: a fixture where two of these numbers coincide lets a swapped
 * field pass unnoticed).
 */
describe('estimateDryRun cache-aware billing (Phase 5, task P5-5)', () => {
  it('with no cache-hit set supplied, omits cacheHits entirely and initialCalls/tokens/cost still cover every evaluable test case (unchanged from before this task)', () => {
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:abc', [])],
      evidence: [smallBundle('tc:v1:abc')],
    }];

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files);

    expect('cacheHits' in result).toBe(false);
    expect(result.initialCalls).toBe(1);
    expect(result.estimatedInputTokens).toEqual({ min: 5847, max: 9356 });
  });

  it('an explicitly empty cache-hit set means "consulted, zero hits": cacheHits is 0 (present), distinct from an omitted/not-consulted field', () => {
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:abc', [])],
      evidence: [smallBundle('tc:v1:abc')],
    }];

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files, RUBRIC_V2, new Set());

    expect('cacheHits' in result).toBe(true);
    expect(result.cacheHits).toBe(0);
    expect(result.initialCalls).toBe(1);
  });

  it(
    'excludes cache-hit test cases from initialCalls/followUpCalls/estimated tokens/estimated cost, while '
    + 'evaluable/evidenceBytes/requestBytes/rubricBytesPerRequest/bundlesOverCeiling still cover every evaluable test case',
    () => {
      // Three evaluable test cases with deliberately different content lengths (never identical),
      // plus one skipped test: evaluable(3) != billable(2) != cacheHits(1), and the hit is the
      // MIDDLE test case, not the first or last, so a first-only/off-by-one bug cannot pass by luck.
      const bundleA = contentLengthBundle('tc:v1:cache-a', 10);
      const bundleB = contentLengthBundle('tc:v1:cache-b', 50);
      const bundleC = contentLengthBundle('tc:v1:cache-c', 200);
      const files: readonly DryRunFileInput[] = [{
        testCases: [
          testCase('tc:v1:cache-a', []),
          testCase('tc:v1:cache-b', []),
          testCase('tc:v1:cache-c', []),
          testCase('tc:v1:cache-skip', ['skip']),
        ],
        evidence: [bundleA, bundleB, bundleC],
      }];
      const cacheHitTestCaseIds = new Set<TestCaseId>(['tc:v1:cache-b' as TestCaseId]);

      const billableResult = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files, RUBRIC_V2, cacheHitTestCaseIds);
      const fullResult = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files); // no cache: every evaluable is billable

      // Independently compute what only the two NOT-hit test cases (a, c) should contribute,
      // using the real functions directly rather than trusting estimateDryRun's own math — a
      // mutation that sums the wrong subset must disagree with this.
      const expectedBillableTokens = [
        { id: 'tc:v1:cache-a', bundle: bundleA },
        { id: 'tc:v1:cache-c', bundle: bundleC },
      ].reduce((totals, { id, bundle }) => {
        const request = buildJevRequest({ testCase: testCase(id, []), bundle, rubric: RUBRIC_V2 });
        const bytes = utf8ByteLength(canonicalizeJevRequest(request));
        const { min, max } = estimateTokensFromBytes(bytes, JEV_ESTIMATE_SNAPSHOT.bytesPerToken);
        return { min: totals.min + min, max: totals.max + max };
      }, { min: 0, max: 0 });
      const expectedUsdMin = Math.round(((expectedBillableTokens.min * JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens) / 1_000_000) * 1_000_000_000) / 1_000_000_000;
      const expectedUsdMax = Math.round((((expectedBillableTokens.max * 2) * JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens) / 1_000_000) * 1_000_000_000) / 1_000_000_000;

      expect(billableResult.evaluable).toBe(3);
      expect(billableResult.cacheHits).toBe(1);
      expect(billableResult.initialCalls).toBe(2);
      expect(billableResult.followUpCalls).toEqual({ min: 0, max: 2 });
      expect(billableResult.estimatedInputTokens).toEqual(expectedBillableTokens);
      expect(billableResult.estimatedFollowUpInputTokens).toEqual({ min: 0, max: expectedBillableTokens.max });
      expect(billableResult.estimatedUsd).toEqual({ min: expectedUsdMin, max: expectedUsdMax });

      // Byte/ceiling diagnostics stay scoped to every evaluable test case, cache or no cache — the
      // task names only initialCalls/tokens/cost as billable-only.
      expect(billableResult.discovered).toBe(fullResult.discovered);
      expect(billableResult.skipped).toEqual(fullResult.skipped);
      expect(billableResult.evidenceBytes).toBe(fullResult.evidenceBytes);
      expect(billableResult.requestBytes).toBe(fullResult.requestBytes);
      expect(billableResult.rubricBytesPerRequest).toBe(fullResult.rubricBytesPerRequest);
      expect(billableResult.bundlesOverCeiling).toBe(fullResult.bundlesOverCeiling);
    },
  );

  it('matches cache hits across multiple files by test case id, never by array position', () => {
    const bundleA = contentLengthBundle('tc:v1:file-a', 20);
    const bundleB = contentLengthBundle('tc:v1:file-b', 80);
    const files: readonly DryRunFileInput[] = [
      { testCases: [testCase('tc:v1:file-a', [])], evidence: [bundleA] },
      { testCases: [testCase('tc:v1:file-b', [])], evidence: [bundleB] },
    ];
    const cacheHitTestCaseIds = new Set<TestCaseId>(['tc:v1:file-b' as TestCaseId]);

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files, RUBRIC_V2, cacheHitTestCaseIds);

    expect(result.evaluable).toBe(2);
    expect(result.cacheHits).toBe(1);
    expect(result.initialCalls).toBe(1);
  });

  it('a cache-hit id with no matching evaluable test case is simply ignored — never a negative count, never a throw', () => {
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:abc', [])],
      evidence: [smallBundle('tc:v1:abc')],
    }];
    const cacheHitTestCaseIds = new Set<TestCaseId>(['tc:v1:does-not-exist' as TestCaseId]);

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files, RUBRIC_V2, cacheHitTestCaseIds);

    expect(result.cacheHits).toBe(0);
    expect(result.initialCalls).toBe(1);
  });

  it('places cacheHits immediately after initialCalls in key order when present (stable machine-readable shape for --dry-run --json)', () => {
    const files: readonly DryRunFileInput[] = [{
      testCases: [testCase('tc:v1:abc', [])],
      evidence: [smallBundle('tc:v1:abc')],
    }];

    const result = estimateDryRun(JEV_ESTIMATE_SNAPSHOT, files, RUBRIC_V2, new Set());

    const keys = Object.keys(result);
    expect(keys.indexOf('cacheHits')).toBe(keys.indexOf('initialCalls') + 1);
  });
});
