import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createAuditEvidencePort,
  createMemoizingSourceReader,
  DEFAULT_EVIDENCE_BUDGET,
  extractTestCases,
  readSourceFile,
  type SourceReadRequest,
  type TestCase,
} from '../src/index.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-evidence-audit-port-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

function dedent(text: string): string {
  const lines = text.replace(/^\n/u, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  const indents = lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return `${lines.map((line) => line.slice(indent)).join('\n')}\n`;
}

async function extractedCases(root: string, path: string): Promise<{ readonly source: string; readonly testCases: readonly TestCase[] }> {
  const source = await readSourceFile({ rootDir: root, repositoryRelativePath: path });
  const { testCases } = extractTestCases({ repositoryRelativePath: path, sourceText: source });
  return { source, testCases };
}

describe('createMemoizingSourceReader', () => {
  it('caches the pending promise so concurrent reads of the same path dedupe onto one underlying read', async () => {
    let calls = 0;
    const underlying = async (request: SourceReadRequest): Promise<string> => {
      calls += 1;
      return `content:${request.repositoryRelativePath}`;
    };
    const memoized = createMemoizingSourceReader(underlying);

    const [first, second] = await Promise.all([
      memoized({ rootDir: '/repo', repositoryRelativePath: 'a.ts' }),
      memoized({ rootDir: '/repo', repositoryRelativePath: 'a.ts' }),
    ]);

    expect(first).toBe('content:a.ts');
    expect(second).toBe('content:a.ts');
    expect(calls).toBe(1);
  });

  it('reads a different path independently', async () => {
    const reads: string[] = [];
    const memoized = createMemoizingSourceReader(async (request) => {
      reads.push(request.repositoryRelativePath);
      return request.repositoryRelativePath;
    });

    await memoized({ rootDir: '/repo', repositoryRelativePath: 'a.ts' });
    await memoized({ rootDir: '/repo', repositoryRelativePath: 'b.ts' });
    await memoized({ rootDir: '/repo', repositoryRelativePath: 'a.ts' });

    expect(reads).toEqual(['a.ts', 'b.ts']);
  });
});

describe('createAuditEvidencePort', () => {
  it('returns no bundles, no diagnostics, and performs no work for a file with zero test cases', async () => {
    const port = createAuditEvidencePort(async () => { throw new Error('must not be called'); });

    const result = await port.build({
      rootDir: '/repo',
      repositoryRelativePath: 'empty.test.ts',
      sourceText: '',
      testCases: [],
      budget: DEFAULT_EVIDENCE_BUDGET,
      deny: [],
    });

    expect(result).toEqual({ bundles: [], diagnostics: [] });
  });

  it('reads a production file shared by two test cases in the same file only once (memoized across the whole build)', async () => {
    const root = await fixture({
      'shared.ts': dedent(`
        export function shared(): number {
          return 1;
        }
      `),
      'multi.test.ts': dedent(`
        import { expect, test } from 'vitest';
        import { shared } from './shared.js';

        test('a', () => {
          expect(shared()).toBe(1);
        });

        test('b', () => {
          expect(shared()).toBe(1);
        });
      `),
    });
    const { source, testCases } = await extractedCases(root, 'multi.test.ts');
    expect(testCases).toHaveLength(2);

    const reads = new Map<string, number>();
    const countingRead = async (request: SourceReadRequest): Promise<string> => {
      reads.set(request.repositoryRelativePath, (reads.get(request.repositoryRelativePath) ?? 0) + 1);
      return readSourceFile(request);
    };
    const port = createAuditEvidencePort(countingRead);

    const { bundles, diagnostics } = await port.build({
      rootDir: root,
      repositoryRelativePath: 'multi.test.ts',
      sourceText: source,
      testCases,
      budget: DEFAULT_EVIDENCE_BUDGET,
      deny: [],
    });

    expect(bundles).toHaveLength(2);
    expect(diagnostics).toEqual([]);
    expect(reads.get('shared.ts')).toBe(1);
  });

  it("isolates one test case's selection failure: no bundle is produced for it (never a placeholder standing in for missing evidence), one evidence-selection-failed diagnostic names its test case id and name, and the other test case keeps its real evidence", async () => {
    const root = await fixture({
      'prodA.ts': dedent(`
        export function fnA(): number {
          return 1;
        }
      `),
      'prodB.ts': dedent(`
        export function fnB(): number {
          return 2;
        }
      `),
      'multi.test.ts': dedent(`
        import { expect, test } from 'vitest';
        import { fnA } from './prodA.js';
        import { fnB } from './prodB.js';

        test('a', () => {
          expect(fnA()).toBe(1);
        });

        test('b', () => {
          expect(fnB()).toBe(2);
        });
      `),
    });
    const { source, testCases } = await extractedCases(root, 'multi.test.ts');
    expect(testCases).toHaveLength(2);

    const port = createAuditEvidencePort(async (request) => {
      if (request.repositoryRelativePath === 'prodB.ts') throw new Error('prodB read boom');
      return readSourceFile(request);
    });
    const testCaseA = testCases[0];
    const testCaseB = testCases[1];
    if (testCaseA === undefined || testCaseB === undefined) throw new Error('expected two extracted test cases');

    const { bundles, diagnostics } = await port.build({
      rootDir: root,
      repositoryRelativePath: 'multi.test.ts',
      sourceText: source,
      testCases,
      budget: DEFAULT_EVIDENCE_BUDGET,
      deny: [],
    });

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.testCaseId).toBe(testCaseA.id);
    expect(bundles[0]?.fragments.some((fragment) => fragment.symbol === 'fnA')).toBe(true);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'evidence-selection-failed', severity: 'error' });
    expect(diagnostics[0]?.message).toContain(testCaseB.id);
    expect(diagnostics[0]?.message).toContain(testCaseB.name);
  });

  it('propagates a whole-file resolution failure (e.g. a helper read failing) rather than silently degrading', async () => {
    const root = await fixture({
      'helper.ts': 'export function helperFn(): number { return 1; }',
      'multi.test.ts': dedent(`
        import { expect, test } from 'vitest';
        import { helperFn } from './helper.js';

        test('a', () => {
          expect(helperFn()).toBe(1);
        });
      `),
    });
    const { source, testCases } = await extractedCases(root, 'multi.test.ts');
    expect(testCases).toHaveLength(1);

    const port = createAuditEvidencePort(async (request) => {
      if (request.repositoryRelativePath === 'helper.ts') throw new Error('helper read boom');
      return readSourceFile(request);
    });

    await expect(port.build({
      rootDir: root,
      repositoryRelativePath: 'multi.test.ts',
      sourceText: source,
      testCases,
      budget: DEFAULT_EVIDENCE_BUDGET,
      deny: [],
    })).rejects.toThrow('helper read boom');
  });
});
