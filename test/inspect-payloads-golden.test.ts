import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';
import {
  canonicalizeEvidenceBundle,
  DEFAULT_EVIDENCE_BUDGET,
  extractTestCases,
  readSourceFile,
  resolveEvidenceFiles,
  selectEvidence,
} from '../src/index.js';

/**
 * Exact golden test for `--inspect-payloads` (P3-4).
 *
 * Two independent checks, both mandatory:
 *
 * 1. A *literal* golden: `EXPECTED_CANONICAL_BUNDLE_LINE` below is a
 *    hard-coded, frozen JSON string — spans, content, byte counts, SHA-256
 *    content hashes, `testCaseId`, denied/unresolved/omitted, all literal.
 *    A regression that changes what `resolveEvidenceFiles`/`selectEvidence`
 *    produce (wrong probing order, wrong selection-reason text, wrong span,
 *    wrong hash, ...) changes the CLI's real output but NOT this frozen
 *    string, so the comparison below actually catches it. This is the one
 *    that matters for "exact payload golden test" in the strict sense: nothing
 *    computed by the code under test appears on the expected side.
 *
 *    `EXPECTED_CANONICAL_BUNDLE_LINE` was derived once by running the built
 *    CLI (`node dist/cli/index.js audit --rootDir <fixture> --inspect-payloads`)
 *    against exactly the fixture below, then every field was independently
 *    hand/tool-verified before freezing it (not merely re-derived by other
 *    project code): each fragment's `content` against the fixture files read
 *    with `cat -n`; each `contentHash` against `printf '%s' "<content>" |
 *    shasum -a 256`; each `originalBytes`/`includedBytes` against `printf
 *    '%s' "<content>" | wc -c`; each `span` by counting the fixture files'
 *    lines/columns by hand; `testCaseId` by re-implementing
 *    `createTestCaseId`'s documented algorithm (sha256 of the test source,
 *    then sha256 of the canonical identity JSON, prefixed `tc:v1:`) from
 *    scratch in a throwaway script and confirming the hash matches; `denied`
 *    against `DEFAULT_EVIDENCE_DENY_PATTERNS`; `unresolved` by checking both
 *    `left-pad` and `vitest` are genuinely non-aliased, non-relative
 *    specifiers; `budget` against `DEFAULT_EVIDENCE_BUDGET`.
 *
 * 2. A *derived* comparison (kept from the original test): the expected
 *    bundle is also computed by calling `resolveEvidenceFiles`/
 *    `selectEvidence`/`canonicalizeEvidenceBundle` directly against the same
 *    fixture — the same already-tested P3-1..P3-3 building blocks the CLI
 *    itself calls — and compared against the CLI's actual output. This is
 *    NOT a substitute for (1): a regression inside those shared building
 *    blocks would move both sides together and this check alone would stay
 *    green. Its value is narrower and different: it verifies P3-4's own
 *    scope, the CLI's configuration -> application -> evidence-port wiring,
 *    independently of (1)'s frozen literal.
 */

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-inspect-payloads-golden-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

function captureOutput(): { readonly io: CliIo; readonly lines: string[] } {
  const lines: string[] = [];
  return { io: { writeLine: (line) => lines.push(line) }, lines };
}

/**
 * Frozen literal golden for the fixture in the test below. `String.raw` is
 * used so the `\n` sequences inside the JSON `content` fields stay literal
 * two-character backslash-n escapes (matching the CLI's actual single-line
 * stdout), not real newline characters. See the manual-verification note in
 * the file header.
 */
const EXPECTED_CANONICAL_BUNDLE_LINE = String.raw`{"version":1,"testCaseId":"tc:v1:c2addfe99fcba9d95d72aa0df29c53b3a0dd1c7e5391333d6ffb4b64082deee7","budget":{"maxFragmentBytes":4096,"maxBundleBytes":16384},"totals":{"fragments":3,"includedBytes":214,"truncatedFragments":0},"fragments":[{"kind":"test","repositoryRelativePath":"math.test.ts","span":{"start":{"line":4,"column":1},"end":{"line":6,"column":3}},"symbol":null,"contentHash":"1472dba36d7bb892f37f0cfd0f16f464ddd3af21ed43c4aff87d4e054d1b4b6d","content":"test('adds numbers', () => {\n  expect(helperAdd(1, 2)).toBe(3);\n})","selectionReason":"test-body","truncation":{"truncated":false,"originalBytes":66,"includedBytes":66}},{"kind":"helper","repositoryRelativePath":"helper.ts","span":{"start":{"line":5,"column":1},"end":{"line":7,"column":2}},"symbol":"helperAdd","contentHash":"adc73fe980f5378874714770c9011b9e07213bb58069f1d5d9b8a1519e6d534d","content":"export function helperAdd(a: number, b: number): number {\n  return add(a, b);\n}","selectionReason":"imported-binding-referenced","truncation":{"truncated":false,"originalBytes":79,"includedBytes":79}},{"kind":"production-seam","repositoryRelativePath":"math.ts","span":{"start":{"line":1,"column":1},"end":{"line":3,"column":2}},"symbol":"add","contentHash":"445deb8dc986398848dfa385a0b10fbe695498df465f07744a111048c67e3462","content":"export function add(a: number, b: number): number {\n  return a + b;\n}","selectionReason":"imported-binding-referenced","truncation":{"truncated":false,"originalBytes":69,"includedBytes":69}}],"denied":[{"repositoryRelativePath":".env","rule":"deny-list:.env*"}],"unresolved":[{"specifier":"left-pad","reason":"bare-specifier"},{"specifier":"vitest","reason":"bare-specifier"}],"omitted":[]}`;

describe('--inspect-payloads exact golden output', () => {
  it('prints the summary line, then exactly one canonical bundle line matching an independently computed bundle, for a fixture with a helper, a resolved production module, a denied .env import, and a bare import', async () => {
    const root = await fixture({
      'math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'helper.ts': "import { add } from './math.js';\nimport './.env';\nimport 'left-pad';\n\nexport function helperAdd(a: number, b: number): number {\n  return add(a, b);\n}\n",
      '.env': 'SECRET=must-not-be-read\n',
      'math.test.ts': "import { expect, test } from 'vitest';\nimport { helperAdd } from './helper.js';\n\ntest('adds numbers', () => {\n  expect(helperAdd(1, 2)).toBe(3);\n});\n",
    });

    const output = captureOutput();
    const exitCode = await runCli(['audit', '--rootDir', root, '--inspect-payloads'], output.io);
    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(2);

    // (1) The mandatory literal golden: exact string equality against a frozen,
    // manually-verified constant. See the file header for how it was derived
    // and verified, and the class comment above for why this check specifically
    // (unlike the derived one below) is immune to a regression inside the
    // resolution/selection modules themselves.
    expect(output.lines[1]).toBe(EXPECTED_CANONICAL_BUNDLE_LINE);

    const summary = JSON.parse(output.lines[0] ?? '') as {
      readonly totals: {
        readonly evidenceBundles: number;
        readonly evidenceDenied: number;
        readonly evidenceUnresolved: number;
      };
    };
    expect(summary.totals.evidenceBundles).toBe(1);
    expect(summary.totals.evidenceDenied).toBe(1);
    // Two: the test file's own bare `'vitest'` import (hop 1) plus the helper's bare `'left-pad'` import (hop 2).
    expect(summary.totals.evidenceUnresolved).toBe(2);

    const testFileSource = await readSourceFile({ rootDir: root, repositoryRelativePath: 'math.test.ts' });
    const { testCases } = extractTestCases({ repositoryRelativePath: 'math.test.ts', sourceText: testFileSource });
    expect(testCases).toHaveLength(1);
    const testCase = testCases[0];
    if (testCase === undefined) throw new Error('expected exactly one extracted test case');

    const resolution = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: testCase.imports,
    });
    const expectedBundle = await selectEvidence({
      rootDir: root,
      testCase,
      testFileSource,
      resolution,
      budget: DEFAULT_EVIDENCE_BUDGET,
    });

    // (2) The derived comparison, kept alongside (1): verifies P3-4's own
    // wiring scope, independently of the frozen literal above.
    expect(output.lines[1]).toBe(canonicalizeEvidenceBundle(expectedBundle));

    // Sanity: the golden bundle actually exercises every fixture element the
    // test name promises, so this stays a meaningful regression check.
    expect(expectedBundle.fragments.map((fragment) => fragment.kind).sort()).toEqual(['helper', 'production-seam', 'test']);
    expect(expectedBundle.denied).toEqual([{ repositoryRelativePath: '.env', rule: 'deny-list:.env*' }]);
    expect(expectedBundle.unresolved).toEqual([
      { specifier: 'left-pad', reason: 'bare-specifier' },
      { specifier: 'vitest', reason: 'bare-specifier' },
    ]);
  });
});
