import { describe, expect, it } from 'vitest';
import {
  buildEvidenceBundle,
  canonicalizeEvidenceBundle,
  DEFAULT_EVIDENCE_BUDGET,
  validateEvidenceBudget,
  type DeniedEvidence,
  type EvidenceBudget,
  type EvidenceBundle,
  type EvidenceBundleInput,
  type EvidenceFragment,
  type OmittedEvidence,
  type UnresolvedEvidence,
} from '../src/domain/evidence.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';
import { hashEvidenceBundle, hashEvidenceContent } from '../src/adapters/evidence-hash.js';

const testCaseId = 'tc:v1:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as TestCaseId;

function fragment(overrides: Partial<EvidenceFragment> = {}): EvidenceFragment {
  return {
    kind: 'test',
    repositoryRelativePath: 'src/math.test.ts',
    span: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
    content: 'expect(add(1, 2)).toBe(3);\n',
    contentHash: 'hash-test',
    selectionReason: 'test-body',
    // Content is 27 UTF-8 bytes; not truncated, so includedBytes === originalBytes.
    truncation: { truncated: false, originalBytes: 27, includedBytes: 27 },
    ...overrides,
  };
}

const helperFragment = fragment({
  kind: 'helper',
  repositoryRelativePath: 'src/helpers/math.ts',
  span: { start: { line: 4, column: 0 }, end: { line: 6, column: 1 } },
  content: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  contentHash: 'hash-helper',
  selectionReason: 'imported-binding-referenced',
  // Content is 70 UTF-8 bytes; originalBytes stands in for a larger untruncated candidate.
  truncation: { truncated: true, originalBytes: 400, includedBytes: 70 },
});

const productionFragment = fragment({
  kind: 'production-seam',
  repositoryRelativePath: 'src/math.ts',
  span: { start: { line: 1, column: 0 }, end: { line: 2, column: 1 } },
  content: 'export const PRECISION = 2;\n',
  contentHash: 'hash-production',
  selectionReason: 'hook-in-scope',
  // Content is 28 UTF-8 bytes.
  truncation: { truncated: false, originalBytes: 28, includedBytes: 28 },
});

const mockFragment = fragment({
  kind: 'mock-target',
  repositoryRelativePath: 'src/mocks/math.ts',
  span: { start: { line: 1, column: 0 }, end: { line: 1, column: 40 } },
  content: 'export const mockAdd = vi.fn();\n',
  contentHash: 'hash-mock',
  selectionReason: 'mock-target-module',
  symbol: 'mockAdd',
  // Content is 32 UTF-8 bytes.
  truncation: { truncated: false, originalBytes: 32, includedBytes: 32 },
});

const deniedEnv = { repositoryRelativePath: '.env', rule: 'deny-list:dotenv' };
const deniedSecret = { repositoryRelativePath: 'secrets/key.pem', rule: 'deny-list:pem' };

const unresolvedLodash: UnresolvedEvidence = { specifier: 'lodash', reason: 'bare-specifier' };
const unresolvedAlias: UnresolvedEvidence = { specifier: '@app/utils', reason: 'alias-specifier' };

const omittedHelper: OmittedEvidence = {
  repositoryRelativePath: 'src/helpers/big.ts',
  symbol: 'bigHelper',
  reason: 'bundle-budget-exhausted',
};
const omittedNoSymbol: OmittedEvidence = {
  repositoryRelativePath: 'src/lib/other.ts',
  reason: 'bundle-budget-exhausted',
};

function baseInput(overrides: Partial<EvidenceBundleInput> = {}): EvidenceBundleInput {
  return {
    testCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [fragment(), helperFragment, productionFragment, mockFragment],
    denied: [deniedEnv, deniedSecret],
    unresolved: [unresolvedLodash, unresolvedAlias],
    omitted: [omittedHelper, omittedNoSymbol],
    ...overrides,
  };
}

/** Builds a raw `EvidenceBundle` directly, bypassing `buildEvidenceBundle`'s own normalization. */
function rawBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    version: 1,
    testCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [],
    denied: [],
    unresolved: [],
    omitted: [],
    totals: { fragments: 0, includedBytes: 0, truncatedFragments: 0 },
    ...overrides,
  };
}

describe('evidence bundle canonicalization', () => {
  it('orders fragments, denied, unresolved, and omitted entries independent of input order', () => {
    const ordered = buildEvidenceBundle(baseInput());
    const shuffled = buildEvidenceBundle(baseInput({
      fragments: [mockFragment, fragment(), productionFragment, helperFragment],
      denied: [deniedSecret, deniedEnv],
      unresolved: [unresolvedAlias, unresolvedLodash],
      omitted: [omittedNoSymbol, omittedHelper],
    }));

    expect(canonicalizeEvidenceBundle(shuffled)).toBe(canonicalizeEvidenceBundle(ordered));
  });

  it('sorts fragments by kind in test, helper, production-seam, mock-target order', () => {
    const bundle = buildEvidenceBundle(baseInput({
      fragments: [mockFragment, productionFragment, helperFragment, fragment()],
    }));

    const parsed = JSON.parse(canonicalizeEvidenceBundle(bundle)) as { fragments: Array<{ kind: string }> };

    expect(parsed.fragments.map((entry) => entry.kind)).toEqual([
      'test',
      'helper',
      'production-seam',
      'mock-target',
    ]);
  });

  it('sorts denied and unresolved entries lexically by their identifying field', () => {
    const bundle = buildEvidenceBundle(baseInput());
    const parsed = JSON.parse(canonicalizeEvidenceBundle(bundle)) as {
      denied: Array<{ repositoryRelativePath: string }>;
      unresolved: Array<{ specifier: string }>;
    };

    expect(parsed.denied.map((entry) => entry.repositoryRelativePath)).toEqual(['.env', 'secrets/key.pem']);
    expect(parsed.unresolved.map((entry) => entry.specifier)).toEqual(['@app/utils', 'lodash']);
  });

  it('sorts omitted entries by repository-relative path, then symbol, then reason', () => {
    const bundle = buildEvidenceBundle(baseInput({ omitted: [omittedNoSymbol, omittedHelper] }));
    const parsed = JSON.parse(canonicalizeEvidenceBundle(bundle)) as {
      omitted: Array<{ repositoryRelativePath: string; symbol: string | null; reason: string }>;
    };

    expect(parsed.omitted).toEqual([
      { repositoryRelativePath: 'src/helpers/big.ts', symbol: 'bigHelper', reason: 'bundle-budget-exhausted' },
      { repositoryRelativePath: 'src/lib/other.ts', symbol: null, reason: 'bundle-budget-exhausted' },
    ]);
  });

  it('produces byte-identical serialization for structurally equal inputs', () => {
    const first = buildEvidenceBundle(baseInput());
    const second = buildEvidenceBundle(baseInput({
      fragments: [fragment(), { ...helperFragment }, { ...productionFragment }, { ...mockFragment }],
      denied: [{ ...deniedEnv }, { ...deniedSecret }],
      unresolved: [{ ...unresolvedLodash }, { ...unresolvedAlias }],
    }));

    expect(canonicalizeEvidenceBundle(second)).toBe(canonicalizeEvidenceBundle(first));
  });

  it('normalizes Windows-style separators the same as POSIX ones', () => {
    const posix = buildEvidenceBundle(baseInput({ fragments: [fragment()], denied: [], unresolved: [] }));
    const windows = buildEvidenceBundle(baseInput({
      fragments: [fragment({ repositoryRelativePath: 'src\\math.test.ts' })],
      denied: [],
      unresolved: [],
    }));

    expect(canonicalizeEvidenceBundle(windows)).toBe(canonicalizeEvidenceBundle(posix));
  });

  it.each([
    ['a fragment path', {
      fragments: [fragment({ repositoryRelativePath: '../outside.test.ts' })],
      denied: [],
      unresolved: [],
    }],
    ['a denied path', {
      fragments: [],
      denied: [{ repositoryRelativePath: 'suite/../../outside.env', rule: 'deny-list:dotenv' }],
      unresolved: [],
    }],
  ] as const)('rejects an evidence bundle that escapes the repository root via %s', (_label, overrides) => {
    expect(() => buildEvidenceBundle(baseInput(overrides as Partial<EvidenceBundleInput>))).toThrow(/repository-relative/u);
  });

  it('normalizes fragment paths before sorting, so equivalent bundles canonicalize identically regardless of spelling or order', () => {
    // Raw path deliberately sorts AFTER 'src/b.ts' lexically ('z' > 's'), but its
    // normalized form 'src/a.ts' must sort BEFORE it. If sorting happens before
    // normalization, these two logically-equal bundles serialize differently.
    const fragmentASpelledOddly = fragment({ repositoryRelativePath: 'zzz/../src/a.ts', contentHash: 'hash-a' });
    const fragmentBClean = fragment({ repositoryRelativePath: 'src/b.ts', contentHash: 'hash-b' });
    const fragmentAClean = fragment({ repositoryRelativePath: 'src/a.ts', contentHash: 'hash-a' });
    const fragmentBCleanAgain = fragment({ repositoryRelativePath: 'src/b.ts', contentHash: 'hash-b' });

    const spelledDifferently = rawBundle({ fragments: [fragmentASpelledOddly, fragmentBClean] });
    const alreadyNormalizedAndReversed = rawBundle({ fragments: [fragmentBCleanAgain, fragmentAClean] });

    expect(canonicalizeEvidenceBundle(spelledDifferently)).toBe(canonicalizeEvidenceBundle(alreadyNormalizedAndReversed));
  });

  it('normalizes denied paths before sorting, so equivalent bundles canonicalize identically regardless of spelling or order', () => {
    const deniedASpelledOddly: DeniedEvidence = { repositoryRelativePath: 'zzz/../secrets/a.env', rule: 'deny-list:dotenv' };
    const deniedBClean: DeniedEvidence = { repositoryRelativePath: 'secrets/b.env', rule: 'deny-list:dotenv' };
    const deniedAClean: DeniedEvidence = { repositoryRelativePath: 'secrets/a.env', rule: 'deny-list:dotenv' };
    const deniedBCleanAgain: DeniedEvidence = { repositoryRelativePath: 'secrets/b.env', rule: 'deny-list:dotenv' };

    const spelledDifferently = rawBundle({ denied: [deniedASpelledOddly, deniedBClean] });
    const alreadyNormalizedAndReversed = rawBundle({ denied: [deniedBCleanAgain, deniedAClean] });

    expect(canonicalizeEvidenceBundle(spelledDifferently)).toBe(canonicalizeEvidenceBundle(alreadyNormalizedAndReversed));
  });

  it('normalizes omitted paths before sorting, so equivalent bundles canonicalize identically regardless of spelling or order', () => {
    const omittedASpelledOddly: OmittedEvidence = { repositoryRelativePath: 'zzz/../src/a.ts', reason: 'bundle-budget-exhausted' };
    const omittedBClean: OmittedEvidence = { repositoryRelativePath: 'src/b.ts', reason: 'bundle-budget-exhausted' };
    const omittedAClean: OmittedEvidence = { repositoryRelativePath: 'src/a.ts', reason: 'bundle-budget-exhausted' };
    const omittedBCleanAgain: OmittedEvidence = { repositoryRelativePath: 'src/b.ts', reason: 'bundle-budget-exhausted' };

    const spelledDifferently = rawBundle({ omitted: [omittedASpelledOddly, omittedBClean] });
    const alreadyNormalizedAndReversed = rawBundle({ omitted: [omittedBCleanAgain, omittedAClean] });

    expect(canonicalizeEvidenceBundle(spelledDifferently)).toBe(canonicalizeEvidenceBundle(alreadyNormalizedAndReversed));
  });

  it('rejects an omitted entry whose path escapes the repository root', () => {
    expect(() => buildEvidenceBundle(baseInput({
      fragments: [],
      denied: [],
      unresolved: [],
      omitted: [{ repositoryRelativePath: '../outside.ts', reason: 'bundle-budget-exhausted' }],
    }))).toThrow(/repository-relative/u);
  });
});

describe('evidence content and bundle hashing', () => {
  it('hashes newline-normalized content the same across CRLF and LF', () => {
    const crlf = hashEvidenceContent('line one\r\nline two\r\n');
    const lf = hashEvidenceContent('line one\nline two\n');

    expect(crlf).toBe(lf);
  });

  it('changes the content hash when content changes', () => {
    expect(hashEvidenceContent('a')).not.toBe(hashEvidenceContent('b'));
  });

  it('hashes bundles stably across CRLF/LF fragment content differences', () => {
    // Both normalize to the same 18-byte LF content, so includedBytes is 18 either way.
    const lfBundle = buildEvidenceBundle(baseInput({
      fragments: [fragment({
        content: 'line one\nline two\n',
        truncation: { truncated: false, originalBytes: 18, includedBytes: 18 },
      })],
      denied: [],
      unresolved: [],
    }));
    const crlfBundle = buildEvidenceBundle(baseInput({
      fragments: [fragment({
        content: 'line one\r\nline two\r\n',
        truncation: { truncated: false, originalBytes: 18, includedBytes: 18 },
      })],
      denied: [],
      unresolved: [],
    }));

    expect(hashEvidenceBundle(crlfBundle)).toBe(hashEvidenceBundle(lfBundle));
  });

  it('changes the bundle hash when fragment content changes', () => {
    const first = buildEvidenceBundle(baseInput({ fragments: [fragment()], denied: [], unresolved: [] }));
    const second = buildEvidenceBundle(baseInput({
      fragments: [fragment({ content: 'expect(add(2, 2)).toBe(4);\n' })],
      denied: [],
      unresolved: [],
    }));

    expect(hashEvidenceBundle(second)).not.toBe(hashEvidenceBundle(first));
  });
});

describe('evidence budget validation', () => {
  it('accepts the default evidence budget', () => {
    expect(() => validateEvidenceBudget(DEFAULT_EVIDENCE_BUDGET)).not.toThrow();
    expect(DEFAULT_EVIDENCE_BUDGET).toEqual({ maxFragmentBytes: 4096, maxBundleBytes: 16384 });
  });

  it.each([
    ['zero maxFragmentBytes', { maxFragmentBytes: 0, maxBundleBytes: 16384 }],
    ['negative maxFragmentBytes', { maxFragmentBytes: -1, maxBundleBytes: 16384 }],
    ['non-integer maxFragmentBytes', { maxFragmentBytes: 10.5, maxBundleBytes: 16384 }],
    ['zero maxBundleBytes', { maxFragmentBytes: 4096, maxBundleBytes: 0 }],
    ['non-integer maxBundleBytes', { maxFragmentBytes: 4096, maxBundleBytes: 100.1 }],
    ['maxFragmentBytes greater than maxBundleBytes', { maxFragmentBytes: 8192, maxBundleBytes: 4096 }],
  ] as const)('rejects an evidence budget with %s', (_label, budget: EvidenceBudget) => {
    expect(() => validateEvidenceBudget(budget)).toThrow(RangeError);
  });

  it('rejects a fragment that exceeds the per-fragment budget', () => {
    const oversizedContent = 'x'.repeat(5000);
    const oversized = fragment({
      content: oversizedContent,
      truncation: { truncated: false, originalBytes: 5000, includedBytes: 5000 },
    });

    expect(() => buildEvidenceBundle(baseInput({ fragments: [oversized], denied: [], unresolved: [] })))
      .toThrow(/per-fragment budget/u);
  });

  it('rejects fragments whose combined bytes exceed the bundle budget', () => {
    const tightBudget: EvidenceBudget = { maxFragmentBytes: 100, maxBundleBytes: 150 };
    const hundredByteContent = `${'x'.repeat(99)}\n`;
    const fragments = [
      fragment({
        content: hundredByteContent,
        truncation: { truncated: false, originalBytes: 100, includedBytes: 100 },
      }),
      helperFragment,
    ];

    expect(() => buildEvidenceBundle({ testCaseId, budget: tightBudget, fragments, denied: [], unresolved: [], omitted: [] }))
      .toThrow(/bundle budget/u);
  });
});

describe('evidence fragment byte accounting', () => {
  it('rejects a fragment whose includedBytes does not match the UTF-8 byte length of its normalized content', () => {
    const mismatched = fragment({ truncation: { truncated: false, originalBytes: 999, includedBytes: 999 } });

    expect(() => buildEvidenceBundle(baseInput({ fragments: [mismatched], denied: [], unresolved: [] })))
      .toThrow(/byte length/u);
  });

  it('measures included bytes as UTF-8 bytes, not UTF-16 string length, for multibyte content', () => {
    const multibyteContent = 'café ☕ 测试\n';
    // multibyteContent.length (UTF-16 code units) is 10; its real UTF-8 byte length is 17.
    expect(multibyteContent.length).toBe(10);

    const usingStringLength = fragment({
      content: multibyteContent,
      truncation: { truncated: false, originalBytes: multibyteContent.length, includedBytes: multibyteContent.length },
    });
    const usingUtf8ByteLength = fragment({
      content: multibyteContent,
      truncation: { truncated: false, originalBytes: 17, includedBytes: 17 },
    });

    expect(() => buildEvidenceBundle(baseInput({ fragments: [usingStringLength], denied: [], unresolved: [] })))
      .toThrow(/byte length/u);
    expect(() => buildEvidenceBundle(baseInput({ fragments: [usingUtf8ByteLength], denied: [], unresolved: [] })))
      .not.toThrow();
  });

  it.each([
    ['truncated is true but includedBytes equals originalBytes', {
      truncated: true, originalBytes: 27, includedBytes: 27,
    }],
    ['truncated is false but includedBytes is less than originalBytes', {
      truncated: false, originalBytes: 100, includedBytes: 27,
    }],
  ] as const)('rejects a fragment whose truncated flag is inconsistent with its byte counts: %s', (_label, truncation) => {
    const inconsistent = fragment({ truncation });

    expect(() => buildEvidenceBundle(baseInput({ fragments: [inconsistent], denied: [], unresolved: [] })))
      .toThrow(/truncated/iu);
  });
});

describe('evidence bundle totals', () => {
  it('computes fragment count, included bytes, and truncated fragment count', () => {
    const bundle = buildEvidenceBundle(baseInput());

    expect(bundle.totals).toEqual({
      fragments: 4,
      includedBytes: 27 + 70 + 28 + 32,
      truncatedFragments: 1,
    });
  });
});

describe('evidence public surface', () => {
  it('exposes evidence bundle building, canonicalization, and hashing from the package entry point', async () => {
    const publicApi = await import('../src/index.js');

    const bundle = publicApi.buildEvidenceBundle(baseInput({ fragments: [fragment()], denied: [], unresolved: [] }));

    expect(publicApi.canonicalizeEvidenceBundle(bundle)).toBe(canonicalizeEvidenceBundle(bundle));
    expect(publicApi.hashEvidenceBundle(bundle)).toBe(hashEvidenceBundle(bundle));
    expect(publicApi.DEFAULT_EVIDENCE_BUDGET).toEqual(DEFAULT_EVIDENCE_BUDGET);
  });
});
