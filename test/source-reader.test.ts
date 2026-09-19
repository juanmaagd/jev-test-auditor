import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSourceFile } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-source-reader-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'safe.test.ts'), 'test("safe", () => {});');
  return root;
}

describe('repository source reader', () => {
  it('reads a repository-local source file without executing it', async () => {
    const root = await rootFixture();

    await expect(readSourceFile({ rootDir: root, repositoryRelativePath: 'src/safe.test.ts' }))
      .resolves.toBe('test("safe", () => {});');
  });

  it.each([
    '../outside.test.ts',
    '/outside.test.ts',
    'C:/outside.test.ts',
    'C:outside.test.ts',
    'C:\\outside.test.ts',
    '//server/share/outside.test.ts',
    '\\\\server\\share\\outside.test.ts',
    '.',
  ])('rejects unsafe repository path %s', async (repositoryRelativePath) => {
    const root = await rootFixture();

    await expect(readSourceFile({ rootDir: root, repositoryRelativePath })).rejects.toThrow(/inside the repository root/u);
  });

  it('rejects a symlink that resolves outside the repository', async () => {
    const root = await rootFixture();
    const outside = await mkdtemp(join(tmpdir(), 'jev-source-reader-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'outside.test.ts'), 'throw new Error("must not execute");');
    await symlink(join(outside, 'outside.test.ts'), join(root, 'outside.test.ts'));

    await expect(readSourceFile({ rootDir: root, repositoryRelativePath: 'outside.test.ts' }))
      .rejects.toThrow(/inside the repository root/u);
  });

  it('allows a symlink that resolves inside the repository', async () => {
    const root = await rootFixture();
    await symlink(join(root, 'src', 'safe.test.ts'), join(root, 'safe-link.test.ts'));

    await expect(readSourceFile({ rootDir: root, repositoryRelativePath: 'safe-link.test.ts' }))
      .resolves.toContain('test("safe"');
  });
});
