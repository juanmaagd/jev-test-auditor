import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isOutsideRootRelative } from '../src/adapters/containment.js';
import { discoverTestFiles, type DiscoveryResult } from '../src/index.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-discovery-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    const directory = dirname(target);
    await mkdir(directory, { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

function includedPaths(result: DiscoveryResult): string[] {
  return result.files.map((file) => file.repositoryRelativePath);
}

describe('repository containment', () => {
  it.each([
    ['..', true],
    ['../outside/test.ts', true],
    ['..\\outside\\test.ts', true],
    ['C:/outside/test.ts', true],
    ['C:\\outside\\test.ts', true],
    ['//server/share/outside.test.ts', true],
    ['\\\\server\\share\\outside.test.ts', true],
    ['src/test.ts', false],
    ['nested\\test.ts', false],
    ['.', false],
  ])('classifies relative result %s as outside=%s', (relativeResult, expected) => {
    expect(isOutsideRootRelative(relativeResult)).toBe(expected);
  });
});

describe('repository-local test discovery', () => {
  it('discovers all supported test extensions in lexical order and excludes unrelated files', async () => {
    const root = await fixture({
      'src/zeta.spec.tsx': '',
      'src/alpha.test.js': '',
      'src/bravo.spec.jsx': '',
      'src/charlie.test.ts': '',
      'src/helper.ts': '',
      'README.md': '',
    });

    const result = await discoverTestFiles({ rootDir: root });

    expect(includedPaths(result)).toEqual([
      'src/alpha.test.js',
      'src/bravo.spec.jsx',
      'src/charlie.test.ts',
      'src/zeta.spec.tsx',
    ]);
    expect(result.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryRelativePath: 'README.md', reason: 'unsupported-extension' }),
      expect.objectContaining({ repositoryRelativePath: 'src/helper.ts', reason: 'not-test-file' }),
    ]));
  });

  it('applies configured and default exclusions with explicit reasons', async () => {
    const root = await fixture({
      'included.test.ts': '',
      'ignored/ignored.test.ts': '',
      'vendor/vendor.test.ts': '',
      'build/build.test.ts': '',
    });

    const result = await discoverTestFiles({ rootDir: root, exclude: ['ignored/**'] });

    expect(includedPaths(result)).toEqual(['included.test.ts']);
    expect(result.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryRelativePath: 'ignored', reason: 'configured-exclude' }),
      expect.objectContaining({ repositoryRelativePath: 'vendor', reason: 'default-exclude' }),
      expect.objectContaining({ repositoryRelativePath: 'build', reason: 'default-exclude' }),
    ]));
  });

  it('excludes E2E path and static framework signals without executing the file', async () => {
    const root = await fixture({
      'e2e/login.test.ts': 'throw new Error("must not execute");',
      'browser/checkout.e2e.ts': 'export const marker = true;',
      'browser/playwright.test.ts': "import { test } from '@playwright/test';",
      'browser/cypress.test.ts': "import 'cypress';",
      'browser/webdriverio.test.ts': "import { browser } from '@wdio/globals';",
      'browser/detox.test.ts': "import { device } from 'detox';",
      'unit/math.test.ts': 'export const marker = true;',
    });

    const result = await discoverTestFiles({ rootDir: root });

    expect(includedPaths(result)).toEqual(['unit/math.test.ts']);
    expect(result.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryRelativePath: 'e2e/login.test.ts', reason: 'e2e-v1' }),
      expect.objectContaining({ repositoryRelativePath: 'browser/checkout.e2e.ts', reason: 'e2e-v1' }),
      expect.objectContaining({ repositoryRelativePath: 'browser/playwright.test.ts', reason: 'e2e-v1' }),
      expect.objectContaining({ repositoryRelativePath: 'browser/cypress.test.ts', reason: 'e2e-v1' }),
      expect.objectContaining({ repositoryRelativePath: 'browser/webdriverio.test.ts', reason: 'e2e-v1' }),
      expect.objectContaining({ repositoryRelativePath: 'browser/detox.test.ts', reason: 'e2e-v1' }),
    ]));
  });

  it('ignores comments and ordinary strings when reading framework and E2E module evidence', async () => {
    const root = await fixture({
      'commented.test.ts': `// import { test } from 'vitest'; const text = "from 'jest'";\nconst value = 'cypress';`,
      'ordinary.test.ts': "const text = '@playwright/test';",
    });

    const result = await discoverTestFiles({ rootDir: root });

    expect(result.files).toEqual([
      { repositoryRelativePath: 'commented.test.ts', framework: 'unknown', frameworkEvidence: [] },
      { repositoryRelativePath: 'ordinary.test.ts', framework: 'unknown', frameworkEvidence: [] },
    ]);
    expect(result.excluded).toEqual([]);
  });

  it('uses file-local framework imports over conflicting package declarations', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ devDependencies: { jest: '^1.0.0', vitest: '^1.0.0' } }),
      'local.test.ts': "import { test } from 'vitest';",
    });

    const result = await discoverTestFiles({ rootDir: root });

    expect(result.files).toEqual([
      {
        repositoryRelativePath: 'local.test.ts',
        framework: 'vitest',
        frameworkEvidence: [{ framework: 'vitest', source: 'import', detail: 'vitest' }],
      },
    ]);
  });

  it('extracts static import, export-from, dynamic import, and require module specifiers', async () => {
    const root = await fixture({
      'import.test.ts': "import { test } from 'vitest';",
      'export.test.ts': "export { test } from '@jest/globals';",
      'dynamic.test.ts': "const framework = import('vitest');",
      'require.test.ts': "const framework = require('jest');",
    });

    const result = await discoverTestFiles({ rootDir: root });

    expect(result.files).toEqual([
      {
        repositoryRelativePath: 'dynamic.test.ts',
        framework: 'vitest',
        frameworkEvidence: [{ framework: 'vitest', source: 'import', detail: 'vitest' }],
      },
      {
        repositoryRelativePath: 'export.test.ts',
        framework: 'jest',
        frameworkEvidence: [{ framework: 'jest', source: 'import', detail: '@jest/globals' }],
      },
      {
        repositoryRelativePath: 'import.test.ts',
        framework: 'vitest',
        frameworkEvidence: [{ framework: 'vitest', source: 'import', detail: 'vitest' }],
      },
      {
        repositoryRelativePath: 'require.test.ts',
        framework: 'jest',
        frameworkEvidence: [{ framework: 'jest', source: 'import', detail: 'jest' }],
      },
    ]);
  });

  it('reports a deterministic warning for malformed package metadata', async () => {
    const root = await fixture({
      'package.json': '{ malformed',
      'fallback.test.ts': '',
    });

    const result = await discoverTestFiles({ rootDir: root });

    expect(result.files).toEqual([
      { repositoryRelativePath: 'fallback.test.ts', framework: 'unknown', frameworkEvidence: [] },
    ]);
    expect(result.diagnostics).toEqual([
      {
        code: 'package-json-invalid',
        message: 'Unable to parse package.json for framework evidence',
        severity: 'warning',
      },
    ]);
  });

  it('returns no diagnostic when package metadata is absent', async () => {
    const root = await fixture({ 'no-package.test.ts': '' });

    const result = await discoverTestFiles({ rootDir: root });

    expect(result.diagnostics).toEqual([]);
  });

  it('attributes unambiguous framework imports with static evidence', async () => {
    const root = await fixture({
      'jest.test.ts': "import { test } from '@jest/globals';",
      'vitest.test.ts': "import { test } from 'vitest';",
    });

    const result = await discoverTestFiles({ rootDir: root });

    expect(result.files).toEqual([
      {
        repositoryRelativePath: 'jest.test.ts',
        framework: 'jest',
        frameworkEvidence: [{ framework: 'jest', source: 'import', detail: '@jest/globals' }],
      },
      {
        repositoryRelativePath: 'vitest.test.ts',
        framework: 'vitest',
        frameworkEvidence: [{ framework: 'vitest', source: 'import', detail: 'vitest' }],
      },
    ]);
  });

  it('returns unknown when static framework evidence is ambiguous', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ devDependencies: { jest: '^1.0.0', vitest: '^1.0.0' } }),
      'ambiguous.test.ts': 'describe("ambiguous", () => {});',
    });

    const result = await discoverTestFiles({ rootDir: root });

    expect(result.files).toEqual([
      {
        repositoryRelativePath: 'ambiguous.test.ts',
        framework: 'unknown',
        frameworkEvidence: [
          { framework: 'jest', source: 'package', detail: 'jest' },
          { framework: 'vitest', source: 'package', detail: 'vitest' },
        ],
      },
    ]);
  });

  it('does not follow symlinks and records outside-root targets explicitly', async () => {
    const root = await fixture({ 'inside.test.ts': '' });
    const outside = await mkdtemp(join(tmpdir(), 'jev-discovery-outside-'));
    temporaryRoots.push(outside);
    const outsideFile = join(outside, 'outside.test.ts');
    await writeFile(outsideFile, 'throw new Error("outside code must not execute");');
    await symlink(outsideFile, join(root, 'outside-link.test.ts'));
    await symlink(join(root, 'inside.test.ts'), join(root, 'inside-link.test.ts'));

    const result = await discoverTestFiles({ rootDir: root });

    expect(includedPaths(result)).toEqual(['inside.test.ts']);
    expect(result.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryRelativePath: 'outside-link.test.ts', reason: 'outside-root' }),
      expect.objectContaining({ repositoryRelativePath: 'inside-link.test.ts', reason: 'symlink' }),
    ]));
  });

  it('rejects a symlinked repository root instead of following it', async () => {
    const realRoot = await fixture({ 'inside.test.ts': '' });
    const linkRoot = join(realRoot, '..', 'jev-discovery-root-link');
    await symlink(realRoot, linkRoot, 'dir');
    temporaryRoots.push(linkRoot);

    await expect(discoverTestFiles({ rootDir: linkRoot })).rejects.toThrow(/symlink/u);
  });

  it('reads static evidence without executing package scripts or configuration modules', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ scripts: { test: 'node -e "throw new Error()"' }, devDependencies: { vitest: '^1.0.0' } }),
      'jest.config.js': 'throw new Error("configuration must not execute");',
      'canary.test.ts': 'throw new Error("test source must not execute");',
    });
    const canary = join(root, 'executed.marker');

    const result = await discoverTestFiles({ rootDir: root });

    expect(result.files).toEqual([
      {
        repositoryRelativePath: 'canary.test.ts',
        framework: 'vitest',
        frameworkEvidence: [{ framework: 'vitest', source: 'package', detail: 'vitest' }],
      },
    ]);
    await expect(readFile(canary, 'utf8')).rejects.toThrow();
  });
});
