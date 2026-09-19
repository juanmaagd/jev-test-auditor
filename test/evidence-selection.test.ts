import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalizeEvidenceBundle,
  DEFAULT_EVIDENCE_BUDGET,
  extractTestCases,
  hashEvidenceContent,
  readSourceFile,
  resolveEvidenceFiles,
  selectEvidence,
  type EvidenceBudget,
  type EvidenceBundle,
  type EvidenceFragment,
  type EvidenceResolutionResult,
  type EvidenceSelectionRequest,
  type SourceSpan,
  type TestCase,
} from '../src/index.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-evidence-selection-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

/**
 * Strips a common leading indentation from a multi-line template literal so
 * fixture source files are written flush-left (predictable byte counts,
 * predictable spans), while this test file itself stays nicely indented.
 */
function dedent(text: string): string {
  const lines = text.replace(/^\n/u, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  const indents = lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return `${lines.map((line) => line.slice(indent)).join('\n')}\n`;
}

interface SelectionRun {
  readonly bundle: EvidenceBundle;
  readonly testCase: TestCase;
  readonly resolution: EvidenceResolutionResult;
  readonly testFileSource: string;
}

async function runSelection(
  root: string,
  testFilePath: string,
  options: {
    readonly budget?: EvidenceBudget;
    readonly readSource?: EvidenceSelectionRequest['readSource'];
    readonly testCaseIndex?: number;
  } = {},
): Promise<SelectionRun> {
  const testFileSource = await readSourceFile({ rootDir: root, repositoryRelativePath: testFilePath });
  const extraction = extractTestCases({ repositoryRelativePath: testFilePath, sourceText: testFileSource });
  const testCase = extraction.testCases[options.testCaseIndex ?? 0];
  if (testCase === undefined) throw new Error(`No test case extracted from ${testFilePath}`);
  const resolution = await resolveEvidenceFiles({ rootDir: root, testFilePath, imports: testCase.imports });
  const bundle = await selectEvidence({
    rootDir: root,
    testCase,
    testFileSource,
    resolution,
    budget: options.budget ?? DEFAULT_EVIDENCE_BUDGET,
    ...(options.readSource === undefined ? {} : { readSource: options.readSource }),
  });
  return { bundle, testCase, resolution, testFileSource };
}

function fragmentAt(bundle: EvidenceBundle, path: string): EvidenceFragment | undefined {
  return bundle.fragments.find((fragment) => fragment.repositoryRelativePath === path);
}

function fragmentsAt(bundle: EvidenceBundle, path: string): EvidenceFragment[] {
  return bundle.fragments.filter((fragment) => fragment.repositoryRelativePath === path);
}

describe('import binding kinds', () => {
  it("selects a named import binding's declaration", async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { add } from './math.js';

        it('adds', () => {
          expect(add(1, 2)).toBe(3);
        });
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    const fragment = fragmentAt(bundle, 'src/math.ts');
    expect(fragment).toMatchObject({
      kind: 'production-seam',
      selectionReason: 'imported-binding-referenced',
      symbol: 'add',
    });
    expect(fragment?.content).toContain('function add');
  });

  it('selects an aliased named import binding\'s declaration (import { a as b })', async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { add as sum } from './math.js';

        it('adds', () => {
          expect(sum(1, 2)).toBe(3);
        });
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    expect(fragmentAt(bundle, 'src/math.ts')).toMatchObject({ symbol: 'add', kind: 'production-seam' });
  });

  it('selects the export default declaration for a default import binding', async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import add from './math.js';

        it('adds', () => {
          expect(add(1, 2)).toBe(3);
        });
      `),
      'src/math.ts': dedent(`
        export default function add(a: number, b: number): number {
          return a + b;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    const fragment = fragmentAt(bundle, 'src/math.ts');
    expect(fragment).toMatchObject({ symbol: 'add', kind: 'production-seam' });
    expect(fragment?.content).toContain('export default function add');
  });

  it('selects only the member declaration referenced through a namespace import (ns.member)', async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import * as math from './math.js';

        it('adds', () => {
          expect(math.add(1, 2)).toBe(3);
        });
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
        export function subtract(a: number, b: number): number {
          return a - b;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    const fragments = fragmentsAt(bundle, 'src/math.ts');
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ symbol: 'add' });
    expect(fragments[0]?.content).not.toContain('subtract');
  });

  it('selects nothing for a bare namespace reference with no member access', async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import * as math from './math.js';

        it('has a namespace object', () => {
          expect(typeof math).toBe('object');
        });
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    expect(fragmentsAt(bundle, 'src/math.ts')).toEqual([]);
  });

  it("selects a declaration bound through const { a } = require(...)", async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect } from 'vitest';
        const { add } = require('./math.js');

        it('adds', () => {
          expect(add(1, 2)).toBe(3);
        });
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    expect(fragmentAt(bundle, 'src/math.ts')).toMatchObject({ symbol: 'add' });
  });

  it('selects a member declaration referenced through const math = require(...)', async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect } from 'vitest';
        const math = require('./math.js');

        it('adds', () => {
          expect(math.add(1, 2)).toBe(3);
        });
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    expect(fragmentAt(bundle, 'src/math.ts')).toMatchObject({ symbol: 'add' });
  });

  it('omits an import that is never referenced in the test body or hooks', async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { add } from './math.js';
        import { unused } from './unused.js';

        it('adds', () => {
          expect(add(1, 2)).toBe(3);
        });
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `),
      'src/unused.ts': dedent(`
        export function unused(): void {}
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    expect(fragmentAt(bundle, 'src/math.ts')).toBeDefined();
    expect(fragmentAt(bundle, 'src/unused.ts')).toBeUndefined();
  });
});

describe('hooks in scope', () => {
  it('includes an enclosing beforeEach hook as a test-kind, hook-in-scope fragment', async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect, beforeEach } from 'vitest';

        let value = 0;

        beforeEach(() => {
          value = 1;
        });

        it('reads the seeded value', () => {
          expect(value).toBe(1);
        });
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    const hookFragments = bundle.fragments.filter((fragment) => fragment.selectionReason === 'hook-in-scope');
    expect(hookFragments).toHaveLength(1);
    expect(hookFragments[0]).toMatchObject({ kind: 'test', repositoryRelativePath: 'src/math.test.ts' });
    expect(hookFragments[0]?.content).toContain('value = 1');

    const testFragments = bundle.fragments.filter((fragment) => fragment.selectionReason === 'test-body');
    expect(testFragments).toHaveLength(1);
    expect(testFragments[0]).toMatchObject({ kind: 'test', repositoryRelativePath: 'src/math.test.ts' });
  });

  it('resolves an import only referenced from inside a hook body, not the test body', async () => {
    const root = await fixture({
      'src/math.test.ts': dedent(`
        import { it, expect, beforeEach } from 'vitest';
        import { setupEnv } from './setup.js';

        beforeEach(() => {
          setupEnv();
        });

        it('is ready', () => {
          expect(true).toBe(true);
        });
      `),
      'src/setup.ts': dedent(`
        export function setupEnv(): void {}
      `),
    });

    const { bundle } = await runSelection(root, 'src/math.test.ts');

    expect(fragmentAt(bundle, 'src/setup.ts')).toMatchObject({ symbol: 'setupEnv' });
  });
});

describe('mock targets', () => {
  it('marks the mocked module declaration as mock-target when imported and mocked with the same specifier', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, vi } from 'vitest';
        import { doWork } from './worker.js';

        vi.mock('./worker.js');

        it('calls the worker', () => {
          expect(doWork()).toBeDefined();
        });
      `),
      'src/worker.ts': dedent(`
        export function doWork(): string {
          return 'done';
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    expect(fragmentAt(bundle, 'src/worker.ts')).toMatchObject({
      kind: 'mock-target',
      selectionReason: 'mock-target-module',
      symbol: 'doWork',
    });
  });

  it('matches a mocked module by resolved path, not raw specifier text', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, vi } from 'vitest';
        import { doWork } from './worker.js';

        vi.mock('./worker');

        it('calls the worker', () => {
          expect(doWork()).toBeDefined();
        });
      `),
      'src/worker.ts': dedent(`
        export function doWork(): string {
          return 'done';
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    expect(fragmentAt(bundle, 'src/worker.ts')).toMatchObject({ kind: 'mock-target' });
  });

  it('does not mark an import as mock-target when a different module is mocked', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, vi } from 'vitest';
        import { doWork } from './worker.js';

        vi.mock('./other.js');

        it('calls the worker', () => {
          expect(doWork()).toBeDefined();
        });
      `),
      'src/worker.ts': dedent(`
        export function doWork(): string {
          return 'done';
        }
      `),
      'src/other.ts': dedent(`
        export function otherFn(): void {}
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    expect(fragmentAt(bundle, 'src/worker.ts')).toMatchObject({
      kind: 'production-seam',
      selectionReason: 'imported-binding-referenced',
    });
  });
});

describe('helper hop', () => {
  it('selects a production declaration referenced from within a selected helper fragment (hop 2)', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, beforeEach } from 'vitest';
        import { setupEnv } from './helpers/setup.helper.js';

        beforeEach(() => {
          setupEnv();
        });

        it('is configured', () => {
          expect(true).toBe(true);
        });
      `),
      'src/helpers/setup.helper.ts': dedent(`
        import { configure } from '../config.js';

        export function setupEnv(): void {
          configure();
        }
      `),
      'src/config.ts': dedent(`
        export function configure(): void {}
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    expect(fragmentAt(bundle, 'src/helpers/setup.helper.ts')).toMatchObject({ kind: 'helper', symbol: 'setupEnv' });
    expect(fragmentAt(bundle, 'src/config.ts')).toMatchObject({
      kind: 'production-seam',
      symbol: 'configure',
      selectionReason: 'imported-binding-referenced',
    });
  });

  it('never expands a hop-2 fragment further (hop cap)', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, beforeEach } from 'vitest';
        import { setupEnv } from './helpers/setup.helper.js';

        beforeEach(() => {
          setupEnv();
        });

        it('is configured', () => {
          expect(true).toBe(true);
        });
      `),
      'src/helpers/setup.helper.ts': dedent(`
        import { configure } from './deep.helper.js';

        export function setupEnv(): void {
          configure();
        }
      `),
      'src/helpers/deep.helper.ts': dedent(`
        import { deepest } from '../deepest.js';

        export function configure(): void {
          deepest();
        }
      `),
      'src/deepest.ts': dedent(`
        export function deepest(): void {}
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    expect(fragmentAt(bundle, 'src/helpers/deep.helper.ts')).toMatchObject({ symbol: 'configure' });
    expect(fragmentAt(bundle, 'src/deepest.ts')).toBeUndefined();
  });

  it('resolves a hop-2 reference to a file already resolved at hop 1 under a different specifier spelling', async () => {
    // src/math.ts is imported directly by the test file (hop 1, specifier './math.js') AND,
    // separately, by the helper (which would be hop 2, specifier '../math.js'). P3-2 records
    // only the hop-1 entry for a file reached both ways, so the hop-2 lookup for `subtract`
    // cannot find it by an exact (importedFrom, specifier) match and must fall back lexically.
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, beforeEach } from 'vitest';
        import { setupEnv } from './helpers/setup.helper.js';
        import { add } from './math.js';

        beforeEach(() => {
          setupEnv();
        });

        it('adds', () => {
          expect(add(1, 2)).toBe(3);
        });
      `),
      'src/helpers/setup.helper.ts': dedent(`
        import { subtract } from '../math.js';

        export function setupEnv(): void {
          subtract(1, 1);
        }
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
        export function subtract(a: number, b: number): number {
          return a - b;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    const mathFragments = fragmentsAt(bundle, 'src/math.ts');
    expect(mathFragments.map((fragment) => fragment.symbol).sort()).toEqual(['add', 'subtract']);
    const subtractFragment = mathFragments.find((fragment) => fragment.symbol === 'subtract');
    expect(subtractFragment).toMatchObject({ kind: 'production-seam', selectionReason: 'imported-binding-referenced' });
  });

  it('marks a hop-2 fragment as mock-target when its module is mocked from the test file', async () => {
    // vi.mock('./worker.js') is written relative to the TEST file, while worker.ts is only ever
    // reached through the helper's own relative import ('../worker.js') — same file, different
    // specifier spellings and different importers, so this only matches through the lexical
    // fallback in both the mock-key computation and the hop-2 declaration lookup.
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, vi, beforeEach } from 'vitest';
        import { setupEnv } from './helpers/setup.helper.js';

        vi.mock('./worker.js');

        beforeEach(() => {
          setupEnv();
        });

        it('is configured', () => {
          expect(true).toBe(true);
        });
      `),
      'src/helpers/setup.helper.ts': dedent(`
        import { doWork } from '../worker.js';

        export function setupEnv(): void {
          doWork();
        }
      `),
      'src/worker.ts': dedent(`
        export function doWork(): string {
          return 'done';
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    expect(fragmentAt(bundle, 'src/worker.ts')).toMatchObject({
      kind: 'mock-target',
      selectionReason: 'mock-target-module',
      symbol: 'doWork',
    });
  });
});

describe('lexical fallback ambiguity', () => {
  it('selects nothing (never the wrong file) when the lexical fallback matches more than one already-resolved file', async () => {
    // src/x.ts and src/x/index.ts are two DIFFERENT real files that both key to 'src/x' once
    // extension/index differences are ignored. Both are independently, exactly resolved via
    // the test file's own './x.js' and './x/index.js' imports. The helper's own '../x' import
    // resolves (deterministically, via P3-2's own extension-before-index probing) to the exact
    // same 'src/x.ts' path already claimed at hop 1, so P3-2's dedupe-by-path drops that hop-2
    // candidate entirely — leaving no exact (importedFrom, specifier) entry for the helper's
    // reference to fall back from. The lexical fallback then has two equally-plausible matches
    // and must refuse to pick one, rather than silently attaching the wrong file's declaration.
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, beforeEach } from 'vitest';
        import { setupEnv } from './helpers/setup.helper.js';
        import { a } from './x.js';
        import { b } from './x/index.js';

        beforeEach(() => {
          setupEnv();
        });

        it('uses things', () => {
          expect(a() + b()).toBeGreaterThan(0);
        });
      `),
      'src/helpers/setup.helper.ts': dedent(`
        import { shared } from '../x';

        export function setupEnv(): void {
          shared();
        }
      `),
      'src/x.ts': dedent(`
        export function a(): number {
          return 1;
        }
        export function shared(): void {
          /* from x.ts */
        }
      `),
      'src/x/index.ts': dedent(`
        export function b(): number {
          return 2;
        }
        export function shared(): void {
          /* from x/index.ts */
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    // The unambiguous, exactly-specified imports still resolve normally.
    expect(fragmentAt(bundle, 'src/x.ts')).toMatchObject({ symbol: 'a' });
    expect(fragmentAt(bundle, 'src/x/index.ts')).toMatchObject({ symbol: 'b' });

    // The ambiguous '../x' reference to `shared` selects nothing — never a guess.
    const sharedFragments = bundle.fragments.filter((fragment) => fragment.symbol === 'shared');
    expect(sharedFragments).toEqual([]);
  });

  it('does not mark either colliding file as mock-target when the mock specifier ambiguously matches both', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, vi } from 'vitest';
        import { a } from './x.js';
        import { b } from './x/index.js';

        vi.mock('./x');

        it('uses both', () => {
          expect(a() + b()).toBeGreaterThan(0);
        });
      `),
      'src/x.ts': dedent(`
        export function a(): number {
          return 1;
        }
      `),
      'src/x/index.ts': dedent(`
        export function b(): number {
          return 2;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/feature.test.ts');

    expect(fragmentAt(bundle, 'src/x.ts')).toMatchObject({ kind: 'production-seam', symbol: 'a' });
    expect(fragmentAt(bundle, 'src/x/index.ts')).toMatchObject({ kind: 'production-seam', symbol: 'b' });
  });
});

describe('re-exports', () => {
  it('selects the re-export statement itself and does not follow it to the underlying module', async () => {
    const root = await fixture({
      'src/thing.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { helperFn } from './helpers/reexport.helper.js';

        it('does something', () => {
          expect(helperFn()).toBe(true);
        });
      `),
      'src/helpers/reexport.helper.ts': dedent(`
        export { helperFn } from './actual.helper.js';
      `),
      'src/helpers/actual.helper.ts': dedent(`
        export function helperFn(): boolean {
          return true;
        }
      `),
    });

    const { bundle } = await runSelection(root, 'src/thing.test.ts');

    const fragment = fragmentAt(bundle, 'src/helpers/reexport.helper.ts');
    expect(fragment).toMatchObject({ kind: 'helper', symbol: 'helperFn' });
    expect(fragment?.content.trim()).toBe("export { helperFn } from './actual.helper.js';");
    expect(fragmentAt(bundle, 'src/helpers/actual.helper.ts')).toBeUndefined();
  });

  it('selects the local declaration for a local re-export (export { x })', async () => {
    const root = await fixture({
      'src/thing.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { helperFn } from './helpers/local-reexport.helper.js';

        it('does something', () => {
          expect(helperFn()).toBe(true);
        });
      `),
      'src/helpers/local-reexport.helper.ts': dedent(`
        function helperFn(): boolean {
          return true;
        }

        export { helperFn };
      `),
    });

    const { bundle } = await runSelection(root, 'src/thing.test.ts');

    const fragment = fragmentAt(bundle, 'src/helpers/local-reexport.helper.ts');
    expect(fragment?.content.trim()).toBe('function helperFn(): boolean {\n  return true;\n}');
  });
});

describe('missing exports', () => {
  it('selects nothing when the imported name has no matching export', async () => {
    const root = await fixture({
      'src/thing.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { missingFn } from './helpers/empty.helper.js';

        it('does nothing useful', () => {
          expect(missingFn).toBeUndefined();
        });
      `),
      'src/helpers/empty.helper.ts': dedent(`
        export const somethingElse = 1;
      `),
    });

    const { bundle } = await runSelection(root, 'src/thing.test.ts');

    expect(fragmentAt(bundle, 'src/helpers/empty.helper.ts')).toBeUndefined();
  });
});

describe('per-fragment truncation', () => {
  it('truncates an oversized fragment at the last full line that fits, never splitting a multibyte character', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { greet } from './greet.js';

        it('greets', () => {
          expect(greet()).toBeDefined();
        });
      `),
      'src/greet.ts': dedent(`
        export function greet(): string {
          const message = 'héllo wörld 测试 emoji 🎉 more padding text';
          return message;
        }
      `),
    });

    const natural = await runSelection(root, 'src/feature.test.ts');
    const naturalFragment = fragmentAt(natural.bundle, 'src/greet.ts');
    if (naturalFragment === undefined) throw new Error('expected a src/greet.ts fragment in the natural bundle');

    const lines = naturalFragment.content.split('\n');
    const firstLine = lines[0] ?? '';
    const secondLine = lines[1] ?? '';
    const firstTwoLinesBytes = new TextEncoder().encode(`${firstLine}\n${secondLine}\n`).length;

    const tightBudget: EvidenceBudget = {
      maxFragmentBytes: firstTwoLinesBytes,
      maxBundleBytes: DEFAULT_EVIDENCE_BUDGET.maxBundleBytes,
    };
    const { bundle } = await runSelection(root, 'src/feature.test.ts', { budget: tightBudget });
    const fragment = fragmentAt(bundle, 'src/greet.ts');
    if (fragment === undefined) throw new Error('expected a truncated src/greet.ts fragment');

    expect(fragment.content).toBe(`${firstLine}\n${secondLine}\n`);
    expect(fragment.content).not.toContain('�');
    expect(fragment.truncation).toEqual({
      truncated: true,
      originalBytes: new TextEncoder().encode(naturalFragment.content).length,
      includedBytes: firstTwoLinesBytes,
    });
  });
});

describe('bundle budget exhaustion', () => {
  it('truncates the fragment that first exceeds the remaining bundle budget and omits everything after it', async () => {
    const root = await fixture({
      'src/three.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { a } from './a.js';
        import { b } from './b.js';
        import { c } from './c.js';

        it('uses three', () => {
          expect(a() + b() + c()).toBeGreaterThan(0);
        });
      `),
      'src/a.ts': dedent(`
        export function a(): number {
          return 1;
        }
      `),
      'src/b.ts': dedent(`
        export function b(): number {
          return 2;
        }
      `),
      'src/c.ts': dedent(`
        export function c(): number {
          return 3;
        }
      `),
    });

    const natural = await runSelection(root, 'src/three.test.ts');
    const testFragment = natural.bundle.fragments.find((fragment) => fragment.selectionReason === 'test-body');
    const fragmentA = fragmentAt(natural.bundle, 'src/a.ts');
    const fragmentB = fragmentAt(natural.bundle, 'src/b.ts');
    if (testFragment === undefined || fragmentA === undefined || fragmentB === undefined) {
      throw new Error('expected test, a, and b fragments in the natural bundle');
    }

    const bFirstLine = fragmentB.content.split('\n')[0] ?? '';
    const bFirstLineBytes = new TextEncoder().encode(`${bFirstLine}\n`).length;
    const tightMaxBundleBytes = testFragment.truncation.includedBytes + fragmentA.truncation.includedBytes + bFirstLineBytes;

    const { bundle } = await runSelection(root, 'src/three.test.ts', {
      budget: { maxFragmentBytes: tightMaxBundleBytes, maxBundleBytes: tightMaxBundleBytes },
    });

    expect(fragmentAt(bundle, 'src/a.ts')).toMatchObject({ truncation: { truncated: false } });

    const truncatedB = fragmentAt(bundle, 'src/b.ts');
    expect(truncatedB?.content).toBe(`${bFirstLine}\n`);
    expect(truncatedB?.truncation.truncated).toBe(true);

    expect(fragmentAt(bundle, 'src/c.ts')).toBeUndefined();
    expect(bundle.omitted).toEqual([
      { repositoryRelativePath: 'src/c.ts', symbol: 'c', reason: 'bundle-budget-exhausted' },
    ]);
  });

  it('fills hop-1 fragments before hop-2 fragments when the bundle budget is tight', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect, beforeEach } from 'vitest';
        import { setupEnv } from './helpers/setup.helper.js';

        beforeEach(() => {
          setupEnv();
        });

        it('is configured', () => {
          expect(true).toBe(true);
        });
      `),
      'src/helpers/setup.helper.ts': dedent(`
        import { configure } from '../config.js';

        export function setupEnv(): void {
          configure();
        }
      `),
      'src/config.ts': dedent(`
        export function configure(): void {}
      `),
    });

    const natural = await runSelection(root, 'src/feature.test.ts');
    const testFragment = natural.bundle.fragments.find((fragment) => fragment.selectionReason === 'test-body');
    const hookFragment = natural.bundle.fragments.find((fragment) => fragment.selectionReason === 'hook-in-scope');
    const setupFragment = fragmentAt(natural.bundle, 'src/helpers/setup.helper.ts');
    if (testFragment === undefined || hookFragment === undefined || setupFragment === undefined) {
      throw new Error('expected test, hook, and setupEnv fragments in the natural bundle');
    }

    // Exactly enough room for test + hook + the hop-1 helper (setupEnv), and nothing left for
    // the hop-2 production seam (configure) — hop-1 must win the remaining budget over hop-2.
    const tightMaxBundleBytes = testFragment.truncation.includedBytes
      + hookFragment.truncation.includedBytes
      + setupFragment.truncation.includedBytes;

    const { bundle } = await runSelection(root, 'src/feature.test.ts', {
      budget: { maxFragmentBytes: tightMaxBundleBytes, maxBundleBytes: tightMaxBundleBytes },
    });

    expect(fragmentAt(bundle, 'src/helpers/setup.helper.ts')).toMatchObject({ truncation: { truncated: false } });
    expect(fragmentAt(bundle, 'src/config.ts')).toBeUndefined();
    expect(bundle.omitted).toEqual([
      { repositoryRelativePath: 'src/config.ts', symbol: 'configure', reason: 'bundle-budget-exhausted' },
    ]);
  });
});

describe('determinism', () => {
  it('produces the same canonical bundle regardless of resolution.files/denied/unresolved order', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import { add } from './math.js';
        import 'lodash';
        import './secrets/leak.js';

        it('adds', () => {
          expect(add(1, 2)).toBe(3);
        });
      `),
      'src/math.ts': dedent(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `),
      'src/secrets/leak.ts': "throw new Error('must not execute');\n",
    });

    const { testCase, resolution, testFileSource } = await runSelection(root, 'src/feature.test.ts');
    const shuffledResolution: EvidenceResolutionResult = {
      files: [...resolution.files].reverse(),
      denied: [...resolution.denied].reverse(),
      unresolved: [...resolution.unresolved].reverse(),
    };

    const bundleA = await selectEvidence({
      rootDir: root, testCase, testFileSource, resolution, budget: DEFAULT_EVIDENCE_BUDGET,
    });
    const bundleB = await selectEvidence({
      rootDir: root, testCase, testFileSource, resolution: shuffledResolution, budget: DEFAULT_EVIDENCE_BUDGET,
    });

    expect(canonicalizeEvidenceBundle(bundleB)).toBe(canonicalizeEvidenceBundle(bundleA));
  });
});

describe('denied and unresolved provenance', () => {
  it('carries resolution.denied and resolution.unresolved into the bundle unchanged', async () => {
    const root = await fixture({
      'src/feature.test.ts': dedent(`
        import { it, expect } from 'vitest';
        import 'lodash';
        import './secrets/leak.js';

        it('does nothing dangerous', () => {
          expect(true).toBe(true);
        });
      `),
      'src/secrets/leak.ts': "throw new Error('must not execute');\n",
    });

    const { bundle, resolution } = await runSelection(root, 'src/feature.test.ts');

    expect(bundle.denied).toEqual(resolution.denied);
    expect(bundle.unresolved).toEqual(resolution.unresolved);
    expect(bundle.denied).toEqual([{ repositoryRelativePath: 'src/secrets/leak.ts', rule: 'deny-list:**/secrets/**' }]);
    expect(bundle.unresolved).toEqual(expect.arrayContaining([{ specifier: 'lodash', reason: 'bare-specifier' }]));
  });
});

describe('golden canonical bundle', () => {
  it('produces the exact expected canonical bundle for a small test + hook + hop-1 + hop-2 fixture', async () => {
    const testFile = dedent(`
      import { it, expect, beforeEach } from 'vitest';
      import { add } from './math.js';
      import { setupEnv } from './helpers/setup.helper.js';

      beforeEach(() => {
        setupEnv();
      });

      it('adds numbers', () => {
        expect(add(1, 2)).toBe(3);
      });
    `);
    const mathFile = dedent(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    const setupHelperFile = dedent(`
      import { configure } from '../config.js';

      export function setupEnv(): void {
        configure();
      }
    `);
    const configFile = dedent(`
      export function configure(): void {}
    `);

    const root = await fixture({
      'src/math.test.ts': testFile,
      'src/math.ts': mathFile,
      'src/helpers/setup.helper.ts': setupHelperFile,
      'src/config.ts': configFile,
    });

    const { bundle, testCase } = await runSelection(root, 'src/math.test.ts');

    function spanOf(source: string, needle: string): SourceSpan {
      const index = source.indexOf(needle);
      if (index === -1) throw new Error(`needle not found in golden fixture source: ${needle}`);
      const before = source.slice(0, index);
      const upToEnd = source.slice(0, index + needle.length);
      const startLine = before.split('\n').length;
      const startColumn = index - before.lastIndexOf('\n');
      const endLine = upToEnd.split('\n').length;
      const endColumn = (index + needle.length) - upToEnd.lastIndexOf('\n');
      return { start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn } };
    }

    // A CallExpression's own text stops after its closing `)` — the statement's
    // trailing `;` belongs to the enclosing ExpressionStatement, not the call.
    const testContent = "it('adds numbers', () => {\n  expect(add(1, 2)).toBe(3);\n})";
    const hookContent = 'beforeEach(() => {\n  setupEnv();\n})';
    const addContent = 'export function add(a: number, b: number): number {\n  return a + b;\n}';
    const setupContent = 'export function setupEnv(): void {\n  configure();\n}';
    const configureContent = 'export function configure(): void {}';

    const expectedBundle = {
      version: 1,
      testCaseId: testCase.id,
      budget: { maxFragmentBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes, maxBundleBytes: DEFAULT_EVIDENCE_BUDGET.maxBundleBytes },
      totals: {
        fragments: 5,
        includedBytes: [testContent, hookContent, addContent, setupContent, configureContent]
          .reduce((sum, content) => sum + new TextEncoder().encode(content).length, 0),
        truncatedFragments: 0,
      },
      fragments: [
        {
          kind: 'test',
          repositoryRelativePath: 'src/math.test.ts',
          span: spanOf(testFile, testContent),
          symbol: null,
          contentHash: hashEvidenceContent(testContent),
          content: testContent,
          selectionReason: 'test-body',
          truncation: { truncated: false, originalBytes: new TextEncoder().encode(testContent).length, includedBytes: new TextEncoder().encode(testContent).length },
        },
        {
          kind: 'test',
          repositoryRelativePath: 'src/math.test.ts',
          span: spanOf(testFile, hookContent),
          symbol: null,
          contentHash: hashEvidenceContent(hookContent),
          content: hookContent,
          selectionReason: 'hook-in-scope',
          truncation: { truncated: false, originalBytes: new TextEncoder().encode(hookContent).length, includedBytes: new TextEncoder().encode(hookContent).length },
        },
        {
          kind: 'production-seam',
          repositoryRelativePath: 'src/math.ts',
          span: spanOf(mathFile, addContent),
          symbol: 'add',
          contentHash: hashEvidenceContent(addContent),
          content: addContent,
          selectionReason: 'imported-binding-referenced',
          truncation: { truncated: false, originalBytes: new TextEncoder().encode(addContent).length, includedBytes: new TextEncoder().encode(addContent).length },
        },
        {
          kind: 'helper',
          repositoryRelativePath: 'src/helpers/setup.helper.ts',
          span: spanOf(setupHelperFile, setupContent),
          symbol: 'setupEnv',
          contentHash: hashEvidenceContent(setupContent),
          content: setupContent,
          selectionReason: 'imported-binding-referenced',
          truncation: { truncated: false, originalBytes: new TextEncoder().encode(setupContent).length, includedBytes: new TextEncoder().encode(setupContent).length },
        },
        {
          kind: 'production-seam',
          repositoryRelativePath: 'src/config.ts',
          span: spanOf(configFile, configureContent),
          symbol: 'configure',
          contentHash: hashEvidenceContent(configureContent),
          content: configureContent,
          selectionReason: 'imported-binding-referenced',
          truncation: { truncated: false, originalBytes: new TextEncoder().encode(configureContent).length, includedBytes: new TextEncoder().encode(configureContent).length },
        },
      ],
      denied: [],
      unresolved: [{ specifier: 'vitest', reason: 'bare-specifier' }],
      omitted: [],
    };

    // Match canonicalizeEvidenceBundle's own sort order (kind, then path, then span) so the
    // hand-authored expectation above can stay in natural reading order.
    const sortedExpectedFragments = [...expectedBundle.fragments].sort((left, right) => (
      ['test', 'helper', 'production-seam', 'mock-target'].indexOf(left.kind)
        - ['test', 'helper', 'production-seam', 'mock-target'].indexOf(right.kind)
      || left.repositoryRelativePath.localeCompare(right.repositoryRelativePath)
      || left.span.start.line - right.span.start.line
      || left.span.start.column - right.span.start.column
    ));

    expect(JSON.parse(canonicalizeEvidenceBundle(bundle))).toEqual({
      ...expectedBundle,
      fragments: sortedExpectedFragments,
    });
  });
});
