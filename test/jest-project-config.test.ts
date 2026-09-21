import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJestFrameworkHintReader } from '../src/adapters/jest-project-config.js';

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Builds a fixture tree under a fresh temp directory. Every fixture gets an
 * empty `.git/` marker at its own root so a walk that fails to find a
 * `package.json` stops at this fixture's boundary instead of escaping into
 * the real `/private/tmp` ancestry and picking up an unrelated `package.json`
 * that happens to exist on the machine running the suite.
 */
async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-jest-project-config-'));
  createdRoots.push(root);
  await mkdir(join(root, '.git'), { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }
  return root;
}

describe('createJestFrameworkHintReader', () => {
  it('attributes jest from the "jest" key in an ancestor package.json above rootDir\'s own directory', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ devDependencies: { jest: '^30.0.0' }, jest: { preset: 'ts-jest' } }),
      'src/modules/auth/auth.service.spec.ts': 'describe("auth", () => { it("works", () => {}); });',
    });

    const reader = createJestFrameworkHintReader(root);
    const hint = await reader('src/modules/auth/auth.service.spec.ts');

    expect(hint).toBe('jest');
  });

  it('attributes jest from a "test": "jest"-style runner script when there is no "jest" key', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ scripts: { test: 'cross-env NODE_ENV=test jest --runInBand' } }),
      'spec/thing.spec.ts': 'it("works", () => {});',
    });

    const reader = createJestFrameworkHintReader(root);

    expect(await reader('spec/thing.spec.ts')).toBe('jest');
  });

  it('attributes jest from a jest.config.js file\'s presence alone, never reading or evaluating it', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'pkg' }),
      'jest.config.js': 'throw new Error("must never be executed");',
      'thing.test.ts': 'it("works", () => {});',
    });

    const reader = createJestFrameworkHintReader(root);

    expect(await reader('thing.test.ts')).toBe('jest');
  });

  it('does not attribute jest for a vitest project even with no imports in the spec (conflicting evidence stays unknown)', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({
        devDependencies: { vitest: '^2.0.0' },
        scripts: { test: 'vitest run' },
      }),
      'vitest.config.ts': 'export default {};',
      'thing.test.ts': 'it("works", () => {});',
    });

    const reader = createJestFrameworkHintReader(root);

    expect(await reader('thing.test.ts')).toBeUndefined();
  });

  it('does not attribute jest when the same package.json carries both jest and vitest evidence', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({
        jest: { preset: 'ts-jest' },
        devDependencies: { vitest: '^2.0.0' },
      }),
      'thing.test.ts': 'it("works", () => {});',
    });

    const reader = createJestFrameworkHintReader(root);

    expect(await reader('thing.test.ts')).toBeUndefined();
  });

  it('stays undefined when no package.json is reachable before the repository boundary', async () => {
    const root = await fixture({
      'thing.test.ts': 'it("works", () => {});',
    });

    const reader = createJestFrameworkHintReader(root);

    expect(await reader('thing.test.ts')).toBeUndefined();
  });

  it('stays undefined for a malformed package.json rather than guessing', async () => {
    const root = await fixture({
      'package.json': '{ not valid json',
      'thing.test.ts': 'it("works", () => {});',
    });

    const reader = createJestFrameworkHintReader(root);

    expect(await reader('thing.test.ts')).toBeUndefined();
  });

  it('stops at a nested repository\'s own .git boundary and never escapes into an outer package.json', async () => {
    const outerRoot = await mkdtemp(join(tmpdir(), 'jev-jest-project-config-'));
    createdRoots.push(outerRoot);
    await writeFile(join(outerRoot, 'package.json'), JSON.stringify({ jest: {} }), 'utf8');
    const nestedRepo = join(outerRoot, 'nested-repo');
    await mkdir(join(nestedRepo, '.git'), { recursive: true });
    await writeFile(join(nestedRepo, 'thing.test.ts'), 'it("works", () => {});', 'utf8');

    const reader = createJestFrameworkHintReader(nestedRepo);

    expect(await reader('thing.test.ts')).toBeUndefined();
  });

  it('uses the nearest package.json, not a farther ancestor one, when both exist', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ jest: {} }),
      'packages/app/package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1.0.0' } }),
      'packages/app/thing.test.ts': 'it("works", () => {});',
    });

    const reader = createJestFrameworkHintReader(root);

    expect(await reader('packages/app/thing.test.ts')).toBeUndefined();
  });
});
