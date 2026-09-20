import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  readSourceFile,
  resolveEvidenceFiles,
  type ImportKind,
  type ResolvedEvidenceFile,
  type SourceReadRequest,
  type SourceSpan,
} from '../src/index.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-evidence-resolution-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

const ZERO_SPAN: SourceSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

function importRecord(specifier: string | undefined, kind: ImportKind = 'import'): { kind: ImportKind; specifier?: string; span: SourceSpan } {
  return { kind, ...(specifier === undefined ? {} : { specifier }), span: ZERO_SPAN };
}

function pathsOf(files: readonly ResolvedEvidenceFile[]): string[] {
  return files.map((file) => file.repositoryRelativePath);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Whether this machine/user can create filesystem symlinks (denied for some CI/sandbox users on some platforms). */
async function canCreateSymlinks(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), 'jev-evidence-symlink-probe-'));
  try {
    await writeFile(join(probe, 'target.txt'), 'x');
    await symlink(join(probe, 'target.txt'), join(probe, 'link.txt'));
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  } finally {
    await rm(probe, { force: true, recursive: true });
  }
}

const symlinksSupported = await canCreateSymlinks();

describe('extension and index probing order', () => {
  it('resolves the exact literal path before trying any rewrite or extension guess', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/sibling.js': 'export const marker = "js";',
      'src/sibling.ts': 'export const marker = "ts";',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./sibling.js')],
    });

    expect(pathsOf(result.files)).toEqual(['src/sibling.js']);
  });

  it('rewrites a .js specifier to .ts, falling back to .tsx when only .tsx exists', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/a.ts': 'export const a = true;',
      'src/b.tsx': 'export const b = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./a.js'), importRecord('./b.js')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('rewrites .jsx to .tsx, .mjs to .mts, and .cjs to .cts', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/comp.tsx': 'export const comp = true;',
      'src/mod.mts': 'export const mod = true;',
      'src/legacy.cts': 'export const legacy = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./comp.jsx'), importRecord('./mod.mjs'), importRecord('./legacy.cjs')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['src/comp.tsx', 'src/legacy.cts', 'src/mod.mts']);
  });

  it('appends extensions in order (.ts before .tsx before .js ...) for a specifier with no extension', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/order.ts': 'export const order = "ts";',
      'src/order.tsx': 'export const order = "tsx";',
      'src/onlyjs.js': 'export const onlyjs = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./order'), importRecord('./onlyjs')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['src/onlyjs.js', 'src/order.ts']);
  });

  it('probes index files inside a directory last, in the same extension order', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/widgets/index.tsx': 'export const widgets = "tsx";',
      'src/widgets/index.js': 'export const widgets = "js";',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./widgets')],
    });

    expect(pathsOf(result.files)).toEqual(['src/widgets/index.tsx']);
  });

  it('reports unsupported-extension for a resolved file whose extension is not a source extension', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/data.json': '{}',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./data.json')],
    });

    expect(result.files).toEqual([]);
    expect(result.unresolved).toEqual([{ specifier: './data.json', reason: 'unsupported-extension' }]);
  });

  it('reports not-found when no probing candidate exists', async () => {
    const root = await fixture({ 'src/math.test.ts': '' });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./missing')],
    });

    expect(result.files).toEqual([]);
    expect(result.unresolved).toEqual([{ specifier: './missing', reason: 'not-found' }]);
  });
});

describe('specifier classification', () => {
  it.each([
    ['lodash', 'bare-specifier'],
    ['@babel/core', 'bare-specifier'],
    ['@testing-library/react', 'bare-specifier'],
    ['@tanstack/react-query', 'bare-specifier'],
    ['@app/utils', 'bare-specifier'],
    ['@/components/Button', 'alias-specifier'],
    ['~/lib/util', 'alias-specifier'],
    ['#internal/thing', 'alias-specifier'],
  ] as const)('classifies %s as %s', async (specifier, reason) => {
    const root = await fixture({ 'src/math.test.ts': '' });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord(specifier)],
    });

    expect(result.files).toEqual([]);
    expect(result.unresolved).toEqual([{ specifier, reason }]);
  });

  it('reports dynamic-specifier for an import record without a literal specifier', async () => {
    const root = await fixture({ 'src/math.test.ts': '' });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord(undefined, 'dynamic-import')],
    });

    expect(result.files).toEqual([]);
    expect(result.unresolved).toEqual([{ specifier: '', reason: 'dynamic-specifier' }]);
  });
});

describe('containment', () => {
  it('reports outside-root for a specifier that walks above the repository root, reading nothing', async () => {
    const root = await fixture({ 'src/nested/deep.test.ts': '' });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/nested/deep.test.ts',
      imports: [importRecord('../../../outside')],
    });

    expect(result.files).toEqual([]);
    expect(result.denied).toEqual([]);
    expect(result.unresolved).toEqual([{ specifier: '../../../outside', reason: 'outside-root' }]);
  });

  it.skipIf(!symlinksSupported)('reports outside-root for a symlink resolving outside the root and never surfaces its content', async () => {
    const root = await fixture({ 'src/math.test.ts': '' });
    const outside = await mkdtemp(join(tmpdir(), 'jev-evidence-outside-'));
    temporaryRoots.push(outside);
    await writeFile(join(outside, 'secret.ts'), 'throw new Error("must not execute or surface");');
    await symlink(join(outside, 'secret.ts'), join(root, 'src', 'link.ts'));

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./link')],
    });

    expect(result.files).toEqual([]);
    expect(result.unresolved).toEqual([{ specifier: './link', reason: 'outside-root' }]);
  });
});

describe('deny list', () => {
  it('denies dotenv files before any read', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/.env': "throw new Error('must not execute or be read');",
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./.env')],
    });

    expect(result.denied).toEqual([{ repositoryRelativePath: 'src/.env', rule: 'deny-list:.env*' }]);
    expect(result.files).toEqual([]);
  });

  it('denies a helper-shaped file before reading it, so its own imports are never discovered (proves the deny gate blocks the read, not just the extension)', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/secrets/setup.ts': "import './leaked';\nthrow new Error('must not execute or be read');",
      'src/secrets/leaked.ts': 'export const leaked = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./secrets/setup')],
    });

    expect(result.denied).toEqual([
      { repositoryRelativePath: 'src/secrets/setup.ts', rule: 'deny-list:**/secrets/**' },
    ]);
    expect(result.files).toEqual([]);
    expect(pathsOf(result.files)).not.toContain('src/secrets/leaked.ts');
  });

  it('denies .pem files at any depth', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/secrets/key.pem': 'throw new Error("must not execute");',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./secrets/key.pem')],
    });

    expect(result.denied).toEqual([{ repositoryRelativePath: 'src/secrets/key.pem', rule: 'deny-list:*.pem' }]);
  });

  it('denies any file under a secrets directory regardless of extension', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/secrets/config.ts': 'throw new Error("must not execute");',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./secrets/config')],
    });

    expect(result.denied).toEqual([
      { repositoryRelativePath: 'src/secrets/config.ts', rule: 'deny-list:**/secrets/**' },
    ]);
  });

  it('adds caller deny patterns on top of, not instead of, the defaults', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/internal/blocked.ts': 'throw new Error("must not execute");',
      'src/.env': 'throw new Error("must not execute");',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./internal/blocked'), importRecord('./.env')],
      deny: ['**/internal/**'],
    });

    expect(result.denied.map((entry) => entry.repositoryRelativePath).sort()).toEqual([
      'src/.env',
      'src/internal/blocked.ts',
    ]);
  });
});

describe('helper classification and hop expansion', () => {
  it('classifies helper vs production files per the documented convention', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/lib/production.ts': 'export const value = 1;',
      'src/lib/helpers.helper.ts': 'export const value = 1;',
      'src/__mocks__/api.ts': 'export const value = 1;',
      'src/tests/scenario.ts': 'export const value = 1;',
      'src/util/setup-env.ts': 'export const value = 1;',
      'src/lib/production.spec.ts': 'export const value = 1;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [
        importRecord('./lib/production'),
        importRecord('./lib/helpers.helper'),
        importRecord('./__mocks__/api'),
        importRecord('./tests/scenario'),
        importRecord('./util/setup-env'),
        importRecord('./lib/production.spec'),
      ],
    });

    const roleByPath = Object.fromEntries(result.files.map((file) => [file.repositoryRelativePath, file.role]));
    expect(roleByPath).toEqual({
      'src/lib/production.ts': 'production',
      'src/lib/helpers.helper.ts': 'helper',
      'src/__mocks__/api.ts': 'helper',
      'src/tests/scenario.ts': 'helper',
      'src/util/setup-env.ts': 'helper',
      'src/lib/production.spec.ts': 'helper',
    });
  });

  it('expands a hop-1 helper one level to discover hop-2 evidence', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/helpers/setup.ts': "import './deep-helper';\nimport '../lib/util';\nexport const marker = true;",
      'src/helpers/deep-helper.ts': 'export const nested = true;',
      'src/lib/util.ts': 'export const util = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./helpers/setup')],
    });

    const byPath = Object.fromEntries(result.files.map((file) => [file.repositoryRelativePath, file]));
    expect(byPath['src/helpers/setup.ts']).toMatchObject({
      role: 'helper',
      hop: 1,
      importedFrom: 'src/math.test.ts',
      specifier: './helpers/setup',
    });
    expect(byPath['src/helpers/setup.ts']?.sourceText).toContain('marker');
    expect(byPath['src/helpers/deep-helper.ts']).toMatchObject({
      role: 'helper',
      hop: 2,
      importedFrom: 'src/helpers/setup.ts',
      specifier: './deep-helper',
    });
    expect('sourceText' in (byPath['src/helpers/deep-helper.ts'] ?? {})).toBe(false);
    expect(byPath['src/lib/util.ts']).toMatchObject({
      role: 'production',
      hop: 2,
      importedFrom: 'src/helpers/setup.ts',
      specifier: '../lib/util',
    });
  });

  it('never expands a production file even though it has its own relative imports', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/lib/util.ts': "import './should-not-appear';\nexport const util = true;",
      'src/lib/should-not-appear.ts': 'export const hidden = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./lib/util')],
    });

    expect(pathsOf(result.files)).toEqual(['src/lib/util.ts']);
    expect('sourceText' in (result.files[0] ?? {})).toBe(false);
    expect(result.unresolved).toEqual([]);
  });

  it('never expands a hop-2 file further, even when it is itself helper-shaped', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/helpers/outer.helper.ts': "import './inner.helper';\nexport const outer = true;",
      'src/helpers/inner.helper.ts': "import './should-not-appear';\nexport const inner = true;",
      'src/helpers/should-not-appear.ts': 'export const hidden = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./helpers/outer.helper')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['src/helpers/inner.helper.ts', 'src/helpers/outer.helper.ts']);
  });

  it('terminates a helper self-import without duplicating the file', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/helpers/self.helper.ts': "import './self.helper';\nexport const marker = true;",
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./helpers/self.helper')],
    });

    expect(pathsOf(result.files)).toEqual(['src/helpers/self.helper.ts']);
    expect(result.files[0]).toMatchObject({ hop: 1 });
  });

  it('terminates a cycle between two hop-1 helpers without duplication', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/helpers/a.helper.ts': "import './b.helper';\nexport const a = true;",
      'src/helpers/b.helper.ts': "import './a.helper';\nexport const b = true;",
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./helpers/a.helper'), importRecord('./helpers/b.helper')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['src/helpers/a.helper.ts', 'src/helpers/b.helper.ts']);
    expect(result.files.every((file) => file.hop === 1)).toBe(true);
  });

  it('keeps the hop-1 entry when the same file is also reached at hop 2', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/lib/shared.ts': 'export const shared = true;',
      'src/helpers/wrapper.helper.ts': "import '../lib/shared';\nexport const wrapper = true;",
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./lib/shared'), importRecord('./helpers/wrapper.helper')],
    });

    const shared = result.files.find((file) => file.repositoryRelativePath === 'src/lib/shared.ts');
    expect(shared).toMatchObject({ hop: 1, importedFrom: 'src/math.test.ts', specifier: './lib/shared' });
    expect(pathsOf(result.files).filter((path) => path === 'src/lib/shared.ts')).toHaveLength(1);
  });

  it('tie-breaks duplicate same-hop resolutions by importer then specifier', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/lib/util.ts': 'export const util = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./lib/util.ts'), importRecord('./lib/util')],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ specifier: './lib/util' });
  });

  it('never returns the test file itself as evidence, even via a self-referencing import', async () => {
    const root = await fixture({
      'src/math.test.ts': "import './math.test';\nexport const marker = true;",
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./math.test')],
    });

    expect(result.files).toEqual([]);
    expect(result.denied).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('sorts files, denied, and unresolved entries deterministically regardless of input order', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/z.ts': 'export const z = true;',
      'src/a.ts': 'export const a = true;',
      'src/.env': 'throw new Error("must not execute");',
      'src/secrets/key.pem': 'throw new Error("must not execute");',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [
        importRecord('./z'),
        importRecord('./a'),
        importRecord('lodash'),
        importRecord('@app/utils'),
        importRecord('./.env'),
        importRecord('./secrets/key.pem'),
      ],
    });

    expect(pathsOf(result.files)).toEqual(['src/a.ts', 'src/z.ts']);
    expect(result.denied.map((entry) => entry.repositoryRelativePath)).toEqual(['src/.env', 'src/secrets/key.pem']);
    expect(result.unresolved.map((entry) => entry.specifier)).toEqual(['@app/utils', 'lodash']);
  });
});

describe('no execution', () => {
  it('never executes file content, only reads and statically parses it', async () => {
    const root = await fixture({
      'src/math.test.ts': '',
      'src/lib/dangerous.ts': 'throw new Error("must not execute");\nexport const marker = true;',
      'src/helpers/dangerous.helper.ts': "throw new Error('must not execute');\nimport '../lib/dangerous';\nexport const marker = true;",
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('./lib/dangerous'), importRecord('./helpers/dangerous.helper')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['src/helpers/dangerous.helper.ts', 'src/lib/dangerous.ts']);
  });

  it('never executes a paths-mapped target file, only reads and statically parses it', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['./lib/*'] } } }),
      'math.test.ts': '',
      'lib/dangerous.ts': 'throw new Error("must not execute");\nexport const marker = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@lib/dangerous')],
    });

    expect(pathsOf(result.files)).toEqual(['lib/dangerous.ts']);
  });
});

describe('alias mapping resolution (task A-2)', () => {
  it('resolves a Node subpath #import specifier via package.json imports', async () => {
    const root = await fixture({
      'package.json': json({ imports: { '#review/*': './src/review/*.ts' } }),
      'src/math.test.ts': '',
      'src/review/analyzer.ts': 'export const analyzer = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('#review/analyzer')],
    });

    expect(pathsOf(result.files)).toEqual(['src/review/analyzer.ts']);
    expect(result.unresolved).toEqual([]);
  });

  it('picks the longest matching paths prefix over a shorter overlapping one', async () => {
    const root = await fixture({
      'tsconfig.json': json({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@app/*': ['./generic/*'],
            '@app/feature/*': ['./specific/*'],
          },
        },
      }),
      'math.test.ts': '',
      'specific/widget.ts': 'export const widget = "specific";',
      'generic/feature/widget.ts': 'export const widget = "generic";',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@app/feature/widget')],
    });

    expect(pathsOf(result.files)).toEqual(['specific/widget.ts']);
  });

  it('prefers an exact star-less paths pattern over a matching wildcard pattern', async () => {
    const root = await fixture({
      'tsconfig.json': json({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@app/*': ['./generic/*'],
            '@app/exact': ['./special/exact-target'],
          },
        },
      }),
      'math.test.ts': '',
      'generic/exact.ts': 'export const exact = "generic";',
      'special/exact-target.ts': 'export const exact = "special";',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@app/exact')],
    });

    expect(pathsOf(result.files)).toEqual(['special/exact-target.ts']);
  });

  it('tries multiple paths targets for one pattern in declaration order', async () => {
    const root = await fixture({
      'tsconfig.json': json({
        compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['./missing/*', './present/*'] } },
      }),
      'math.test.ts': '',
      'present/thing.ts': 'export const thing = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@shared/thing')],
    });

    expect(pathsOf(result.files)).toEqual(['present/thing.ts']);
  });

  it('falls back to the baseUrl catch-all only when no imports/paths/workspace mapping matches', async () => {
    // paths targets resolve relative to baseUrl's OWN directory whenever a
    // baseUrl exists anywhere in the chain (TypeScript's real rule, already
    // applied by A-1 in `buildTsconfigEntries`) — so '@app/*': ['./app/*']
    // resolves to 'root-src/app/*', not a top-level 'app/*'.
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: './root-src', paths: { '@app/*': ['./app/*'] } } }),
      'math.test.ts': '',
      'root-src/util.ts': 'export const util = true;',
      'root-src/app/widget.ts': 'export const widget = true;',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('util'), importRecord('@app/widget')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['root-src/app/widget.ts', 'root-src/util.ts']);
  });

  it('still classifies an unmapped bare specifier as bare-specifier even when a baseUrl catch-all exists', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: './src' } }),
      'src/math.test.ts': '',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('lodash')],
    });

    expect(result.files).toEqual([]);
    expect(result.unresolved).toEqual([{ specifier: 'lodash', reason: 'bare-specifier' }]);
  });

  it('resolves a workspace package name and a name/* subpath import', async () => {
    const root = await fixture({
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/common/package.json': json({ name: '@musive/common', main: './index.ts' }),
      'packages/common/index.ts': 'export const common = true;',
      'packages/common/utils.ts': 'export const utils = true;',
      'math.test.ts': '',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@musive/common'), importRecord('@musive/common/utils')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['packages/common/index.ts', 'packages/common/utils.ts']);
  });

  it('prefers a discoverable source entry over a declared dist entry point for a workspace package', async () => {
    const root = await fixture({
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/common/package.json': json({ name: '@musive/common', main: './dist/index.js' }),
      'packages/common/dist/index.js': 'throw new Error("must not execute or be read");',
      'packages/common/src/index.ts': 'export const common = "source";',
      'math.test.ts': '',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@musive/common')],
    });

    expect(pathsOf(result.files)).toEqual(['packages/common/src/index.ts']);
    expect(result.denied).toEqual([]);
  });

  it('records a workspace dist-only entry as denied rather than silently dropping it', async () => {
    const root = await fixture({
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/common/package.json': json({ name: '@musive/common', main: './dist/index.js' }),
      'packages/common/dist/index.js': 'throw new Error("must not execute or be read");',
      'math.test.ts': '',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@musive/common')],
    });

    expect(result.files).toEqual([]);
    expect(result.denied).toEqual([
      { repositoryRelativePath: 'packages/common/dist/index.js', rule: 'deny-list:**/dist/**' },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it('reports alias-mapped-not-found for a paths specifier whose mapped target does not exist', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['./app/*'] } } }),
      'math.test.ts': '',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@app/missing')],
    });

    expect(result.files).toEqual([]);
    expect(result.unresolved).toEqual([{ specifier: '@app/missing', reason: 'alias-mapped-not-found' }]);
  });

  it('denies a paths-mapped target inside a denied directory before reading it', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@secret/*': ['./secrets/*'] } } }),
      'math.test.ts': '',
      'secrets/config.ts': 'throw new Error("must not execute or be read");',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@secret/config')],
    });

    expect(result.files).toEqual([]);
    expect(result.denied).toEqual([
      { repositoryRelativePath: 'secrets/config.ts', rule: 'deny-list:**/secrets/**' },
    ]);
  });

  it('denies a paths-mapped target landing inside node_modules before reading it', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@pkg/*': ['./node_modules/some-package/*'] } } }),
      'math.test.ts': '',
      'node_modules/some-package/index.ts': 'throw new Error("must not execute or be read");',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@pkg/index')],
    });

    expect(result.files).toEqual([]);
    expect(result.denied).toEqual([
      { repositoryRelativePath: 'node_modules/some-package/index.ts', rule: 'deny-list:**/node_modules/**' },
    ]);
  });

  it('refuses a paths-mapped target whose substituted wildcard segment escapes the repository root', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['./lib/*'] } } }),
      'math.test.ts': '',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'math.test.ts',
      imports: [importRecord('@lib/../../../../../../etc/passwd')],
    });

    expect(result.files).toEqual([]);
    expect(result.denied).toEqual([]);
    expect(result.unresolved).toEqual([
      { specifier: '@lib/../../../../../../etc/passwd', reason: 'outside-root' },
    ]);
  });

  it("resolves a hop-2 alias specifier using the helper file's own nearest config, not the test file's", async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['./test-src/*'] } } }),
      'src/math.test.ts': '',
      'helpers/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['./helper-src/*'] } } }),
      'helpers/setup.helper.ts': "import '@shared/util';\nexport const marker = true;",
      'helpers/helper-src/util.ts': 'export const util = "helper";',
      'test-src/util.ts': 'export const util = "test";',
    });

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('../helpers/setup.helper')],
    });

    expect(pathsOf(result.files).sort()).toEqual(['helpers/helper-src/util.ts', 'helpers/setup.helper.ts']);
    expect(pathsOf(result.files)).not.toContain('test-src/util.ts');
  });

  it("reads each importing directory's alias configuration once per run, not once per specifier", async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['./lib/*'] } } }),
      'src/math.test.ts': '',
      'lib/a.ts': 'export const a = true;',
      'lib/b.ts': 'export const b = true;',
      'lib/c.ts': 'export const c = true;',
    });

    const reads: string[] = [];
    const countingReader = async (request: SourceReadRequest): Promise<string> => {
      reads.push(request.repositoryRelativePath);
      return readSourceFile(request);
    };

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('@lib/a'), importRecord('@lib/b'), importRecord('@lib/c')],
      readSource: countingReader,
    });

    expect(pathsOf(result.files).sort()).toEqual(['lib/a.ts', 'lib/b.ts', 'lib/c.ts']);
    expect(reads.filter((path) => path === 'tsconfig.json')).toEqual(['tsconfig.json']);
  });

  it("adds exactly one more configuration read batch for a helper in a different directory", async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['./lib/*'] } } }),
      'src/math.test.ts': '',
      'lib/a.ts': 'export const a = true;',
      'helpers/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@helper-lib/*': ['./helper-lib/*'] } } }),
      'helpers/setup.helper.ts': "import '@helper-lib/thing';\nexport const marker = true;",
      'helpers/helper-lib/thing.ts': 'export const thing = true;',
    });

    const reads: string[] = [];
    const countingReader = async (request: SourceReadRequest): Promise<string> => {
      reads.push(request.repositoryRelativePath);
      return readSourceFile(request);
    };

    const result = await resolveEvidenceFiles({
      rootDir: root,
      testFilePath: 'src/math.test.ts',
      imports: [importRecord('@lib/a'), importRecord('./../helpers/setup.helper')],
      readSource: countingReader,
    });

    expect(pathsOf(result.files).sort()).toEqual(['helpers/setup.helper.ts', 'helpers/helper-lib/thing.ts', 'lib/a.ts'].sort());
    expect(reads.filter((path) => path === 'tsconfig.json')).toEqual(['tsconfig.json']);
    expect(reads.filter((path) => path === 'helpers/tsconfig.json')).toEqual(['helpers/tsconfig.json']);
  });
});
