import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { computeCacheKey, createAuditCacheKeyPort, type CacheKeyInput } from '../src/adapters/cache-key.js';
import { createAuditEvidencePort } from '../src/adapters/evidence-audit-port.js';
import { readSourceFile } from '../src/adapters/source-reader.js';
import { extractTestCases } from '../src/adapters/test-extraction.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle, type EvidenceFragment } from '../src/domain/evidence.js';
import { buildJevRequest, type JevRequest } from '../src/domain/jev-request.js';
import { JEV_MODEL_ID, RUBRIC_V1, RUBRIC_V2, type Rubric } from '../src/domain/rubric.js';
import type { TestCase, TestCaseId } from '../src/domain/test-understanding.js';

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

// Deliberately version 7 (not 1, 2, or anything else used elsewhere in this file) — see the
// P5-1 verifier's warning about symmetric fixture values: `rubricVersion` (7) must never collide
// with the frozen legacy policy slot (`2`) in `computeCacheKey`'s payload, so a swap between the
// two would turn a test RED instead of passing by accident.
const tinyRubric: Rubric = {
  version: 7,
  model: JEV_MODEL_ID,
  dimensions: [{
    id: 'falsifiability',
    label: 'Falsifiability',
    applicability: { id: 'falsifiability.applicable', type: 'noul', instructions: 'Q1?' },
    quality: { id: 'falsifiability.quality', type: 'score', instructions: 'Q2?', criteria: ['L0', 'L1', 'L2', 'L3'] },
  }],
};

const goldenTestCase = testCase();
const goldenBundle = bundle('tc:v1:golden');
const goldenRequest: JevRequest = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: tinyRubric });

function input(overrides: Partial<CacheKeyInput> = {}): CacheKeyInput {
  return {
    request: goldenRequest,
    fullTestSource: "test('adds numbers', () => {});\n",
    rubricVersion: 7,
    ...overrides,
  };
}

describe('computeCacheKey', () => {
  it('is deterministic: equal inputs always produce the same key', () => {
    expect(computeCacheKey(input())).toBe(computeCacheKey(input()));
  });

  // --- Required invalidation tests: each input gets its own test ---

  it('invalidates on a rubric version change alone, with the canonical request and full test source held byte-identical (kills a "drop rubricVersion from the payload" mutation — canonicalizeJevRequest never carries this numeric field on its own)', () => {
    const before = computeCacheKey(input({ rubricVersion: 7 }));
    const after = computeCacheKey(input({ rubricVersion: 8 }));

    expect(before).not.toBe(after);
  });

  it('is independent of the classification policy: the policy runs locally over stored raw answers, so the key is frozen at the exact formula every existing store was written with (golden, computed before the policy left the key)', () => {
    const key = computeCacheKey({ request: goldenRequest, fullTestSource: "test('adds numbers', () => {});\n", rubricVersion: 2 });

    expect(key).toBe('6e537acbc694e986a828b69336b3768b6f2c2ae1c7aadb9e08e77de91732822e');
  });

  it('invalidates on a model id change, through canonicalizeJevRequest\'s own `model` field — already covered by the canonical serialization, no separate hash input needed', () => {
    const requestA: JevRequest = { ...goldenRequest, model: 'jev-1.13.0' };
    const requestB: JevRequest = { ...goldenRequest, model: 'jev-9.9.9' };

    const before = computeCacheKey(input({ request: requestA }));
    const after = computeCacheKey(input({ request: requestB }));

    expect(before).not.toBe(after);
  });

  it('invalidates on any evidence fragment change, through canonicalizeJevRequest\'s own `state.fragments` — already covered by the canonical serialization, no separate hash input needed', () => {
    const bundleB = bundle('tc:v1:golden', { fragments: [fragment({ content: 'y' })] });
    const requestA = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: tinyRubric });
    const requestB = buildJevRequest({ testCase: goldenTestCase, bundle: bundleB, rubric: tinyRubric });

    const before = computeCacheKey(input({ request: requestA }));
    const after = computeCacheKey(input({ request: requestB }));

    expect(before).not.toBe(after);
  });

  it('invalidates on a full test source change, and normalizes line endings first (CRLF and LF of the identical content produce the identical key)', () => {
    const lf = computeCacheKey(input({ fullTestSource: 'line one\nline two\n' }));
    const crlf = computeCacheKey(input({ fullTestSource: 'line one\r\nline two\r\n' }));
    expect(lf).toBe(crlf);

    const changed = computeCacheKey(input({ fullTestSource: 'line one\nline THREE\n' }));
    expect(lf).not.toBe(changed);
  });

  // --- Documented scenario: the rubric v2 rewrite this task exists to guard against ---

  it('never serves a pre-v2 rubric judgment against post-v2 questions: RUBRIC_V1 and RUBRIC_V2 produce different keys for the identical test case and bundle, from the request bytes alone (rubricVersion held identical across both calls, isolating this from the "rubric version" invalidation test above — this one proves the question-wording difference alone already invalidates, via canonicalizeJevRequest, independent of the explicit numeric field)', () => {
    const requestV1 = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: RUBRIC_V1 });
    const requestV2 = buildJevRequest({ testCase: goldenTestCase, bundle: goldenBundle, rubric: RUBRIC_V2 });

    const keyV1 = computeCacheKey({ request: requestV1, fullTestSource: 'x', rubricVersion: 7 });
    const keyV2 = computeCacheKey({ request: requestV2, fullTestSource: 'x', rubricVersion: 7 });

    expect(keyV1).not.toBe(keyV2);
  });
});

// --- Required sixth test: key stability across rootDir ---

describe('createAuditCacheKeyPort', () => {
  const temporaryRoots: string[] = [];

  afterAll(async () => {
    await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
  });

  async function fixtureRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'jev-cache-key-'));
    temporaryRoots.push(root);
    const testFile = join(root, 'sample.test.ts');
    await mkdir(dirname(testFile), { recursive: true });
    await writeFile(testFile, "import { it, expect } from 'vitest';\n\nit('does a thing', () => {\n  expect(1).toBe(1);\n});\n");
    return root;
  }

  async function keyFor(root: string): Promise<string> {
    const sourceText = await readSourceFile({ rootDir: root, repositoryRelativePath: 'sample.test.ts' });
    const { testCases } = extractTestCases({ repositoryRelativePath: 'sample.test.ts', sourceText });
    const evidencePort = createAuditEvidencePort();
    const { bundles } = await evidencePort.build({
      rootDir: root,
      repositoryRelativePath: 'sample.test.ts',
      sourceText,
      testCases,
      budget: DEFAULT_EVIDENCE_BUDGET,
      deny: [],
    });
    const [testCaseOut] = testCases;
    const [bundleOut] = bundles;
    if (testCaseOut === undefined || bundleOut === undefined) throw new Error('expected exactly one test case and bundle');
    return createAuditCacheKeyPort().computeKey({ testCase: testCaseOut, bundle: bundleOut }, sourceText);
  }

  it('produces the same key for the same repository content regardless of which absolute rootDir it is audited from', async () => {
    const rootA = await fixtureRoot();
    const rootB = await fixtureRoot();
    expect(rootA).not.toBe(rootB);

    const keyA = await keyFor(rootA);
    const keyB = await keyFor(rootB);

    expect(keyA).toBe(keyB);
  });
});
