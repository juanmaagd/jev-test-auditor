import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createMemoizingSourceReader,
  readSourceFile,
  resolveAliasConfig,
  type AliasMappingEntry,
} from '../src/index.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

/** Whether this machine/user can create filesystem symlinks (denied for some CI/sandbox users on some platforms). */
async function canCreateSymlinks(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), 'jev-alias-symlink-probe-'));
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

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-alias-config-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function entriesBySource(entries: readonly AliasMappingEntry[], source: AliasMappingEntry['source']): AliasMappingEntry[] {
  return entries.filter((entry) => entry.source === source);
}

function entryFor(entries: readonly AliasMappingEntry[], pattern: string): AliasMappingEntry | undefined {
  return entries.find((entry) => entry.pattern === pattern);
}

describe('nearest configuration selection', () => {
  it('uses the nearest tsconfig over the root tsconfig, not a merge of both', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@root/*': ['./root-src/*'] } } }),
      'nested/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@nested/*': ['./nested-src/*'] } } }),
      'nested/deep/file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'nested/deep/file.ts' });

    expect(entryFor(result.entries, '@nested/*')).toMatchObject({ declaredIn: 'nested/tsconfig.json' });
    expect(entryFor(result.entries, '@root/*')).toBeUndefined();
    expect(result.configFiles).toEqual(['nested/tsconfig.json']);
  });

  it('prefers tsconfig.json over jsconfig.json in the same directory', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@ts/*': ['./ts-src/*'] } } }),
      'jsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@js/*': ['./js-src/*'] } } }),
      'file.js': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.js' });

    expect(entryFor(result.entries, '@ts/*')).toBeDefined();
    expect(entryFor(result.entries, '@js/*')).toBeUndefined();
  });

  it('falls back to jsconfig.json when no tsconfig.json exists in that directory', async () => {
    const root = await fixture({
      'jsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@js/*': ['./js-src/*'] } } }),
      'file.js': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.js' });

    expect(entryFor(result.entries, '@js/*')).toBeDefined();
  });
});

describe('extends chains', () => {
  it('resolves paths relative to the baseUrl-declaring config when baseUrl is in the parent and paths in the child', async () => {
    const root = await fixture({
      'parent/tsconfig.base.json': json({ compilerOptions: { baseUrl: './libs' } }),
      'child/tsconfig.json': json({
        extends: '../parent/tsconfig.base.json',
        compilerOptions: { paths: { '@x/*': ['./x/*'] } },
      }),
      'child/file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'child/file.ts' });

    const pathsEntry = entryFor(result.entries, '@x/*');
    expect(pathsEntry).toMatchObject({
      source: 'paths',
      targets: ['parent/libs/x/*'],
      declaredIn: 'child/tsconfig.json',
    });
    const baseUrlEntry = entryFor(result.entries, '*');
    expect(baseUrlEntry).toMatchObject({ source: 'baseUrl', targets: ['parent/libs/*'], declaredIn: 'parent/tsconfig.base.json' });
  });

  it('still resolves paths relative to baseUrl when baseUrl is declared in the child and paths in the parent (the reverse)', async () => {
    const root = await fixture({
      'parent/tsconfig.base.json': json({ compilerOptions: { paths: { '@y/*': ['./y/*'] } } }),
      'child/tsconfig.json': json({
        extends: '../parent/tsconfig.base.json',
        compilerOptions: { baseUrl: './libs' },
      }),
      'child/file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'child/file.ts' });

    const pathsEntry = entryFor(result.entries, '@y/*');
    // baseUrl lives in child/, so "./y/*" resolves against child/libs, NOT parent/ (where the
    // paths key itself is textually declared) and NOT parent/libs (mismatching the dir that
    // declares paths with the dir that declares baseUrl is the classic bug this test catches).
    expect(pathsEntry).toMatchObject({ source: 'paths', targets: ['child/libs/y/*'] });
  });

  it('lets the child override an inherited baseUrl and paths entirely (no merge)', async () => {
    const root = await fixture({
      'parent/tsconfig.base.json': json({
        compilerOptions: { baseUrl: './parent-base', paths: { '@shared/*': ['./shared/*'] } },
      }),
      'child/tsconfig.json': json({
        extends: '../parent/tsconfig.base.json',
        compilerOptions: { baseUrl: './child-base', paths: { '@own/*': ['./own/*'] } },
      }),
      'child/file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'child/file.ts' });

    expect(entryFor(result.entries, '@shared/*')).toBeUndefined();
    // Child also declares its own baseUrl, so its own paths resolve relative
    // to ITS baseUrl (child/child-base), not directly relative to child/ —
    // same "paths follow baseUrl" rule as the parent/child split case above.
    expect(entryFor(result.entries, '@own/*')).toMatchObject({ targets: ['child/child-base/own/*'] });
    expect(entryFor(result.entries, '*')).toMatchObject({ targets: ['child/child-base/*'] });
  });

  it('follows a multi-level extends chain (grandparent -> parent -> child)', async () => {
    const root = await fixture({
      'a/tsconfig.json': json({ compilerOptions: { baseUrl: './a-base' } }),
      'b/tsconfig.json': json({ extends: '../a/tsconfig.json' }),
      'c/tsconfig.json': json({ extends: '../b/tsconfig.json' }),
      'c/file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'c/file.ts' });

    expect(entryFor(result.entries, '*')).toMatchObject({ targets: ['a/a-base/*'], declaredIn: 'a/tsconfig.json' });
    expect([...result.configFiles].sort()).toEqual(['a/tsconfig.json', 'b/tsconfig.json', 'c/tsconfig.json']);
  });

  it('applies an extends array left to right, the last entry winning', async () => {
    const root = await fixture({
      'a/tsconfig.json': json({ compilerOptions: { baseUrl: './a-base' } }),
      'b/tsconfig.json': json({ compilerOptions: { baseUrl: './b-base' } }),
      'child/tsconfig.json': json({ extends: ['../a/tsconfig.json', '../b/tsconfig.json'] }),
      'child/file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'child/file.ts' });

    expect(entryFor(result.entries, '*')).toMatchObject({ targets: ['b/b-base/*'], declaredIn: 'b/tsconfig.json' });
  });

  it('falls back to the .json-appended extends target when the literal path does not exist', async () => {
    const root = await fixture({
      'base.json': json({ compilerOptions: { baseUrl: './base-libs' } }),
      'tsconfig.json': json({ extends: './base' }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '*')).toMatchObject({ targets: ['base-libs/*'], declaredIn: 'base.json' });
    expect(result.refusals).toEqual([]);
  });

  it.skipIf(!symlinksSupported)('refuses an extends target whose realpath escapes the root, reading nothing from it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'jev-alias-outside-'));
    temporaryRoots.push(outside);
    await writeFile(join(outside, 'poison.json'), json({ compilerOptions: { baseUrl: './danger' } }));
    const root = await fixture({
      'tsconfig.json': json({ extends: './linked.json' }),
      'file.ts': '',
    });
    await symlink(join(outside, 'poison.json'), join(root, 'linked.json'));

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    // Attributed to the symlink itself (the file that was actually
    // attempted and refused), not to the referencing tsconfig — `linked.json`
    // is still listed in `configFiles` as an attempted read.
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'config-unreadable', declaredIn: 'linked.json' }),
    ]));
    expect(result.configFiles).toEqual(expect.arrayContaining(['linked.json']));
    expect(entryFor(result.entries, '*')).toBeUndefined();
  });

  it('detects and records an extends cycle without throwing or hanging', async () => {
    const root = await fixture({
      'a/tsconfig.json': json({ extends: '../b/tsconfig.json', compilerOptions: { baseUrl: './a-base' } }),
      'b/tsconfig.json': json({ extends: '../a/tsconfig.json', compilerOptions: { baseUrl: './b-base' } }),
      'a/file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'a/file.ts' });

    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'extends-cycle' }),
    ]));
    // The file's own nearest config still wins its own baseUrl regardless of the cycle.
    expect(entryFor(result.entries, '*')).toMatchObject({ targets: ['a/a-base/*'] });
  });

  it('refuses an extends target outside the repository root, reading nothing from it', async () => {
    const root = await fixture({
      'tsconfig.json': json({ extends: '../../../../../../outside-does-not-matter/tsconfig.json' }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'extends-outside-root', declaredIn: 'tsconfig.json' }),
    ]));
    expect(entryFor(result.entries, '*')).toBeUndefined();
  });

  it('refuses an extends target inside node_modules, never reading it', async () => {
    const root = await fixture({
      'node_modules/@org/tsconfig/tsconfig.json': json({ compilerOptions: { baseUrl: './danger' } }),
      'tsconfig.json': json({ extends: './node_modules/@org/tsconfig/tsconfig.json' }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'extends-node-modules', declaredIn: 'tsconfig.json' }),
    ]));
    expect(entryFor(result.entries, '*')).toBeUndefined();
  });

  it('refuses a bare-specifier extends target (an npm package name) as extends-node-modules', async () => {
    const root = await fixture({
      'tsconfig.json': json({ extends: '@tsconfig/node20/tsconfig.json' }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'extends-node-modules', declaredIn: 'tsconfig.json' }),
    ]));
  });

  it('treats an absolute extends specifier as a real filesystem path, never as repository-root-relative', async () => {
    // "/etc/passwd.json" is a genuine absolute path outside the fixture root.
    // A decoy file at "<root>/etc/passwd.json" exists only to prove a wrong
    // (root-relative) reading would wrongly inherit it — the correct reading
    // must refuse the absolute path without ever touching the decoy.
    const root = await fixture({
      'etc/passwd.json': json({ compilerOptions: { baseUrl: './poison' } }),
      'tsconfig.json': json({ extends: '/etc/passwd.json' }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '*')).toBeUndefined();
    expect(result.configFiles).not.toContain('etc/passwd.json');
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'extends-outside-root', declaredIn: 'tsconfig.json', detail: '/etc/passwd.json' }),
    ]));
  });

  it('still follows an absolute extends specifier whose realpath genuinely lands inside the repository root', async () => {
    const root = await fixture({
      'shared/tsconfig.base.json': json({ compilerOptions: { baseUrl: './shared-libs' } }),
      'child/file.ts': '',
    });
    await writeFile(
      join(root, 'child/tsconfig.json'),
      json({ extends: join(root, 'shared/tsconfig.base.json') }),
    );

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'child/file.ts' });

    expect(entryFor(result.entries, '*')).toMatchObject({
      targets: ['shared/shared-libs/*'],
      declaredIn: 'shared/tsconfig.base.json',
    });
    expect(result.refusals).toEqual([]);
  });

  it('records a missing extends target without throwing, continuing with what it has', async () => {
    const root = await fixture({
      'tsconfig.json': json({ extends: './does-not-exist.json', compilerOptions: { baseUrl: './own' } }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'extends-missing', declaredIn: 'tsconfig.json' }),
    ]));
    expect(entryFor(result.entries, '*')).toMatchObject({ targets: ['own/*'] });
  });
});

describe('JSONC and malformed configuration', () => {
  it('parses comments and trailing commas without treating them as malformed', async () => {
    const root = await fixture({
      'tsconfig.json': [
        '{',
        '  // leading comment',
        '  "compilerOptions": {',
        '    "baseUrl": "./src", // trailing comment',
        '    "paths": {',
        '      "@x/*": ["./x/*"],',
        '    },',
        '  },',
        '}',
        '',
      ].join('\n'),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '@x/*')).toMatchObject({ targets: ['src/x/*'] });
    expect(result.refusals).toEqual([]);
  });

  it('reports config-malformed for invalid JSON and yields no entries from that file, without throwing', async () => {
    const root = await fixture({
      'tsconfig.json': '{ "compilerOptions": { not valid json',
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(result.refusals).toEqual([
      { reason: 'config-malformed', declaredIn: 'tsconfig.json', detail: expect.any(String) },
    ]);
    expect(result.entries).toEqual([]);
    expect(result.configFiles).toEqual(['tsconfig.json']);
  });
});

describe('tsconfig paths and baseUrl', () => {
  it('maps an exact key (no wildcard) and a wildcard key independently', async () => {
    const root = await fixture({
      'tsconfig.json': json({
        compilerOptions: {
          paths: {
            '@exact': ['./exact/file.ts'],
            '@star/*': ['./star/*'],
          },
        },
      }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '@exact')).toMatchObject({ targets: ['exact/file.ts'] });
    expect(entryFor(result.entries, '@star/*')).toMatchObject({ targets: ['star/*'] });
  });

  it('keeps multiple fallback targets for one paths key, in declared order', async () => {
    const root = await fixture({
      'tsconfig.json': json({
        compilerOptions: { paths: { '@multi/*': ['./first/*', './second/*'] } },
      }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '@multi/*')).toMatchObject({ targets: ['first/*', 'second/*'] });
  });

  it('produces a single baseUrl catch-all entry when baseUrl is declared alone', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: './libs' } }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entriesBySource(result.entries, 'baseUrl')).toEqual([
      { source: 'baseUrl', pattern: '*', targets: ['libs/*'], declaredIn: 'tsconfig.json' },
    ]);
  });

  it('refuses a paths target that lexically escapes the repository root', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { paths: { '@escape/*': ['../../../outside/*'] } } }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '@escape/*')).toBeUndefined();
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'target-outside-root', declaredIn: 'tsconfig.json' }),
    ]));
  });
});

describe('Node subpath imports (package.json "imports")', () => {
  it('maps a plain string subpath import', async () => {
    const root = await fixture({
      'package.json': json({ imports: { '#review/*': './src/review/*.ts' } }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '#review/*')).toMatchObject({ source: 'imports', targets: ['src/review/*.ts'] });
  });

  it('picks default, then import, then node from a conditional imports value, ignoring unsupported conditions', async () => {
    const root = await fixture({
      'package.json': json({
        imports: {
          '#cond/*': { node: './src/cond-node/*.ts', default: './src/cond-default/*.ts' },
          '#import-only/*': { import: './src/import-only/*.ts' },
          '#node-only/*': { node: './src/node-only/*.ts' },
          '#browser-only/*': { browser: './src/browser-only/*.ts' },
          '#blocked/*': null,
        },
      }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '#cond/*')).toMatchObject({ targets: ['src/cond-default/*.ts'] });
    expect(entryFor(result.entries, '#import-only/*')).toMatchObject({ targets: ['src/import-only/*.ts'] });
    expect(entryFor(result.entries, '#node-only/*')).toMatchObject({ targets: ['src/node-only/*.ts'] });
    expect(entryFor(result.entries, '#blocked/*')).toBeUndefined();
    expect(entryFor(result.entries, '#browser-only/*')).toBeUndefined();
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'imports-unsupported-conditions', detail: '#browser-only/*' }),
    ]));
  });

  it('refuses an imports target that points to an external package rather than a repository-relative path', async () => {
    const root = await fixture({
      'package.json': json({ imports: { '#external': 'some-external-package' } }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(result.entries, '#external')).toBeUndefined();
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'imports-external-target', detail: '#external' }),
    ]));
  });
});

describe('workspace packages', () => {
  it('expands an array-form workspaces glob into two packages, each mapped by exact name and name/*', async () => {
    const root = await fixture({
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/foo/package.json': json({ name: '@scope/foo' }),
      'packages/bar/package.json': json({ name: 'bar-pkg' }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    const workspaceEntries = entriesBySource(result.entries, 'workspace');
    expect(entryFor(workspaceEntries, '@scope/foo')).toMatchObject({ targets: ['packages/foo'] });
    expect(entryFor(workspaceEntries, '@scope/foo/*')).toMatchObject({ targets: ['packages/foo/*'] });
    // Exact package name, no wildcard at all — distinct from its own "/*" sibling entry.
    expect(entryFor(workspaceEntries, 'bar-pkg')).toMatchObject({ targets: ['packages/bar'] });
    expect(entryFor(workspaceEntries, 'bar-pkg/*')).toMatchObject({ targets: ['packages/bar/*'] });
  });

  it('expands the object form { packages: [...] } the same way', async () => {
    const root = await fixture({
      'package.json': json({ workspaces: { packages: ['packages/*'] } }),
      'packages/one/package.json': json({ name: 'pkg-one' }),
      'packages/two/package.json': json({ name: 'pkg-two' }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    const workspaceEntries = entriesBySource(result.entries, 'workspace');
    expect(entryFor(workspaceEntries, 'pkg-one')).toMatchObject({ targets: ['packages/one'] });
    expect(entryFor(workspaceEntries, 'pkg-two')).toMatchObject({ targets: ['packages/two'] });
  });

  it('never resolves a workspace glob into node_modules', async () => {
    const root = await fixture({
      'package.json': json({ workspaces: ['*'] }),
      'node_modules/evil/package.json': json({ name: 'evil' }),
      'packages-real/package.json': json({ name: 'real-pkg' }),
      'file.ts': '',
    });

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(entriesBySource(result.entries, 'workspace'), 'evil')).toBeUndefined();
  });
});

describe('caching within a run', () => {
  it('reads each config file at most once across multiple resolve calls sharing a memoizing reader', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: './root-libs' } }),
      'a/tsconfig.json': json({ extends: '../tsconfig.json', compilerOptions: { paths: { '@a/*': ['./a-src/*'] } } }),
      'a/one.ts': '',
      'a/two.ts': '',
      'a/child/tsconfig.json': json({ extends: '../../tsconfig.json' }),
      'a/child/three.ts': '',
    });

    const reads: string[] = [];
    const countingReader = async (request: { rootDir: string; repositoryRelativePath: string }) => {
      reads.push(request.repositoryRelativePath);
      return readSourceFile(request);
    };
    const memoized = createMemoizingSourceReader(countingReader);

    await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'a/one.ts', readSource: memoized });
    await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'a/two.ts', readSource: memoized });
    await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'a/child/three.ts', readSource: memoized });

    const countsByPath = new Map<string, number>();
    for (const path of reads) countsByPath.set(path, (countsByPath.get(path) ?? 0) + 1);

    expect(countsByPath.get('tsconfig.json')).toBe(1);
    expect(countsByPath.get('a/tsconfig.json')).toBe(1);
    expect(countsByPath.get('a/child/tsconfig.json')).toBe(1);
  });

  it('produces an identical table for identical inputs (deterministic, order-stable)', async () => {
    const root = await fixture({
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@x/*': ['./x/*'], '@y/*': ['./y/*'] } } }),
      'file.ts': '',
    });

    const first = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });
    const second = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(first).toEqual(second);
  });
});

describe('no execution', () => {
  it('never executes a workspace package entry file, only records its path as a string target', async () => {
    const root = await fixture({
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/danger/package.json': json({ name: '@scope/danger', main: './index.js' }),
      'file.ts': '',
    });
    // The marker path is absolute (inside `root`, computed after `fixture()`
    // returns) so this assertion is meaningful regardless of process cwd: if
    // `index.js` were ever executed, the marker would land exactly here.
    const canaryPath = join(root, 'executed.marker');
    await writeFile(
      join(root, 'packages/danger/index.js'),
      `throw new Error('must not execute'); require('fs').writeFileSync(${JSON.stringify(canaryPath)}, 'x');`,
    );

    const result = await resolveAliasConfig({ rootDir: root, repositoryRelativePath: 'file.ts' });

    expect(entryFor(entriesBySource(result.entries, 'workspace'), '@scope/danger')).toBeDefined();
    await expect(readFile(canaryPath, 'utf8')).rejects.toThrow();
  });
});
