import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkHtmlReportPath, writeHtmlReport } from '../src/adapters/html-report-writer.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-html-writer-'));
  temporaryRoots.push(dir);
  return dir;
}

describe('checkHtmlReportPath: preflight, before any evaluation runs', () => {
  it('reports no problem for a path whose parent exists and which is not itself a directory', async () => {
    const dir = await tempDir();
    const problem = await checkHtmlReportPath(join(dir, 'report.html'));
    expect(problem).toBeUndefined();
  });

  it('reports no problem for a path that already exists as a regular file (an explicit --html path is expected to be overwritten)', async () => {
    const dir = await tempDir();
    const target = join(dir, 'report.html');
    await writeFile(target, 'stale content');
    const problem = await checkHtmlReportPath(target);
    expect(problem).toBeUndefined();
  });

  it('reports "is-directory" when the path already exists as a directory', async () => {
    const dir = await tempDir();
    const target = join(dir, 'a-directory');
    await mkdir(target);
    const problem = await checkHtmlReportPath(target);
    expect(problem?.reason).toBe('is-directory');
    expect(problem?.message).toContain(target);
  });

  it('reports "parent-missing" when the parent directory does not exist', async () => {
    const dir = await tempDir();
    const target = join(dir, 'does-not-exist-yet', 'report.html');
    const problem = await checkHtmlReportPath(target);
    expect(problem?.reason).toBe('parent-missing');
    expect(problem?.message).toContain(join(dir, 'does-not-exist-yet'));
  });

  it('reports "parent-missing" when the parent path exists but is itself a file, not a directory', async () => {
    const dir = await tempDir();
    const parentThatIsAFile = join(dir, 'not-a-directory');
    await writeFile(parentThatIsAFile, 'x');
    const target = join(parentThatIsAFile, 'report.html');
    const problem = await checkHtmlReportPath(target);
    expect(problem?.reason).toBe('parent-missing');
  });
});

describe('writeHtmlReport: the actual write', () => {
  it('writes the exact HTML string to a fresh path and reports it was NOT an overwrite', async () => {
    const dir = await tempDir();
    const target = join(dir, 'report.html');
    const result = await writeHtmlReport(target, '<!DOCTYPE html><html></html>');
    expect(result).toEqual({ written: true, overwrote: false });
    expect(await readFile(target, 'utf8')).toBe('<!DOCTYPE html><html></html>');
  });

  it('overwrites an existing file at the same path and reports it as an overwrite, with the new content fully replacing the old (never appended)', async () => {
    const dir = await tempDir();
    const target = join(dir, 'report.html');
    await writeFile(target, 'stale content that must not survive');
    const result = await writeHtmlReport(target, '<!DOCTYPE html><html>fresh</html>');
    expect(result).toEqual({ written: true, overwrote: true });
    const contents = await readFile(target, 'utf8');
    expect(contents).toBe('<!DOCTYPE html><html>fresh</html>');
    expect(contents).not.toContain('stale content');
  });

  it('fails with reason "is-directory" and never writes when the path is an existing directory, leaving the directory untouched', async () => {
    const dir = await tempDir();
    const target = join(dir, 'a-directory');
    await mkdir(target);
    const result = await writeHtmlReport(target, '<html></html>');
    expect(result).toEqual({ written: false, reason: 'is-directory', message: expect.stringContaining(target) as unknown as string });
    const stats = await stat(target);
    expect(stats.isDirectory()).toBe(true);
  });

  it('fails with reason "parent-missing" and never creates the missing parent directory (no auto-mkdir)', async () => {
    const dir = await tempDir();
    const missingParent = join(dir, 'no-such-dir');
    const target = join(missingParent, 'report.html');
    const result = await writeHtmlReport(target, '<html></html>');
    expect(result).toEqual({ written: false, reason: 'parent-missing', message: expect.stringContaining(missingParent) as unknown as string });
    await expect(stat(missingParent)).rejects.toThrow();
  });

  it('never passes a restrictive mode of its own — this report is explicitly meant to be shared, unlike the owner-only credentials/store files, so it is born at whatever the ordinary default (OS umask) permissions are', async () => {
    const dir = await tempDir();
    const target = join(dir, 'report.html');
    await writeHtmlReport(target, '<html></html>');
    const stats = await stat(target);
    const ownerOnly = (stats.mode & 0o777) === 0o600;
    // A umask this restrictive is possible but unusual; the real property under test is that this
    // adapter itself never calls chmod / passes an explicit owner-only mode (contrast
    // `src/adapters/auth-storage.ts`'s deliberate `0o600`) — this is a best-effort corroboration,
    // not the sole proof (see this module's own doc for the explicit design decision).
    expect(ownerOnly).toBe(false);
  });
});
