import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCorpusCase, loadCorpusFromDirectory } from '../src/adapters/corpus-store.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-corpus-store-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

function manifest(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    id: 'case-a',
    operators: ['remove-assertion'],
    oracleKind: 'assertion-mutation',
    testEffect: 'The real assertion is removed.',
    productionEffect: 'A production mutation would not be caught.',
    testFile: 'test.ts',
    productionFiles: ['production.ts'],
    ...overrides,
  });
}

describe('loadCorpusCase', () => {
  it('reads a manifest and its declared files off disk, byte for byte', async () => {
    const root = await fixture({
      'case.json': manifest(),
      'test.ts': "it('x', () => {});\n",
      'production.ts': 'export const x = 1;\n',
    });

    const result = await loadCorpusCase(root);

    expect(result.id).toBe('case-a');
    expect(result.operator).toBe('remove-assertion');
    expect(result.oracleKind).toBe('assertion-mutation');
    expect(result.baseTest).toEqual({ path: 'test.ts', contents: "it('x', () => {});\n" });
    expect(result.productionSources).toEqual([{ path: 'production.ts', contents: 'export const x = 1;\n' }]);
    expect(result.proofStatus).toBe('unverified');
  });

  it('reads multiple declared production files in the manifest\'s own order', async () => {
    const root = await fixture({
      'case.json': manifest({ productionFiles: ['b.ts', 'a.ts'] }),
      'test.ts': '// test\n',
      'a.ts': '// a\n',
      'b.ts': '// b\n',
    });

    const result = await loadCorpusCase(root);

    expect(result.productionSources.map((source) => source.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('propagates the domain parser\'s rejection of a malformed manifest', async () => {
    const root = await fixture({
      'case.json': manifest({ operators: ['remove-assertion', 'mock-owned-logic'] }),
      'test.ts': '// test\n',
      'production.ts': '// production\n',
    });

    await expect(loadCorpusCase(root)).rejects.toThrow(/exactly one operator/);
  });
});

describe('loadCorpusFromDirectory', () => {
  it('reads every immediate case directory in a fixed, sorted order regardless of creation order', async () => {
    const root = await fixture({
      'zeta/case.json': manifest({ id: 'zeta' }),
      'zeta/test.ts': '// test\n',
      'zeta/production.ts': '// production\n',
      'alpha/case.json': manifest({ id: 'alpha' }),
      'alpha/test.ts': '// test\n',
      'alpha/production.ts': '// production\n',
    });

    const cases = await loadCorpusFromDirectory(root);

    expect(cases.map((c) => c.id)).toEqual(['alpha', 'zeta']);
  });

  it('rejects a case whose manifest id does not match its own directory name', async () => {
    const root = await fixture({
      'case-a/case.json': manifest({ id: 'case-b' }),
      'case-a/test.ts': '// test\n',
      'case-a/production.ts': '// production\n',
    });

    await expect(loadCorpusFromDirectory(root)).rejects.toThrow(/case-a/);
  });

  it('parses the real Git-stored discrimination corpus into eleven distinct, valid cases', async () => {
    const cases = await loadCorpusFromDirectory('test/fixtures/corpus/discrimination');

    expect(cases).toHaveLength(11);
    expect(new Set(cases.map((c) => c.id)).size).toBe(11);
    for (const corpusCase of cases) {
      expect(corpusCase.proofStatus).toBe('unverified');
      expect(corpusCase.baseTest.contents.length).toBeGreaterThan(0);
      expect(corpusCase.productionSources.length).toBeGreaterThan(0);
    }
  });

  /**
   * Pins each real case's declared operator AND oracleKind so a copy-paste
   * mistake between two case.json files (or a parser that ignored either
   * field) is detectable. Verified by mutation: temporarily swapping two of
   * these case.json "operators" values on disk turns this exact test RED
   * (see the task report) — nothing here checks it automatically on every
   * run, since a real filesystem mutation is not something a source-only
   * test suite can assert against itself.
   */
  it('parses each real discrimination case with its own declared operator and oracleKind, not another case\'s', async () => {
    const cases = await loadCorpusFromDirectory('test/fixtures/corpus/discrimination');
    const operatorById = Object.fromEntries(cases.map((c) => [c.id, c.operator]));
    const oracleKindById = Object.fromEntries(cases.map((c) => [c.id, c.oracleKind]));

    expect(operatorById).toEqual({
      'exposes-checkout-helper': 'remove-assertion',
      'works-boolean-check': 'weaken-expectation',
      'computes-subtotal-truthy': 'weaken-expectation',
      'discount-returns-number': 'weaken-expectation',
      'checkout-tautology': 'remove-assertion',
      'spies-on-math-round': 'pin-implementation-detail',
      'mocks-discount-logic': 'mock-owned-logic',
      'records-history-shared-state': 'add-shared-state',
      'subtotal-exact-value': 'weaken-expectation',
      'discount-throws-range-error': 'remove-assertion',
      'checkout-applies-percent': 'mock-owned-logic',
    });
    expect(oracleKindById).toEqual({
      'exposes-checkout-helper': 'production-mutation',
      'works-boolean-check': 'production-mutation',
      'computes-subtotal-truthy': 'production-mutation',
      'discount-returns-number': 'production-mutation',
      'checkout-tautology': 'production-mutation',
      'spies-on-math-round': 'semantics-preserving-refactor',
      'mocks-discount-logic': 'production-mutation',
      'records-history-shared-state': 'repeated-randomized-execution',
      'subtotal-exact-value': 'assertion-mutation',
      'discount-throws-range-error': 'assertion-mutation',
      'checkout-applies-percent': 'production-mutation',
    });
  });
});
