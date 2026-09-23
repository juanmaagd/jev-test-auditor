import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  loadLatestPersistedReport,
  loadPersistedReportByRunId,
  persistAuditReport,
} from '../src/adapters/persisted-report-store.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-persisted-report-'));
  temporaryRoots.push(dir);
  return dir;
}

describe('persistAuditReport: writes the canonical report under <rootDir>/.jta/', () => {
  it('writes <rootDir>/.jta/reports/<runId>.json and <rootDir>/.jta/latest.json with byte-identical content', async () => {
    const root = await tempDir();
    const json = '{"reportVersion":1,"runId":"run-1"}';

    const result = await persistAuditReport(root, 'run-1', json);

    expect(result.persisted).toBe(true);
    const runFile = await readFile(join(root, '.jta', 'reports', 'run-1.json'), 'utf8');
    const latestFile = await readFile(join(root, '.jta', 'latest.json'), 'utf8');
    expect(runFile).toBe(json);
    expect(latestFile).toBe(json);
  });

  it('creates <rootDir>/.jta/.gitignore containing "*" when missing', async () => {
    const root = await tempDir();
    await persistAuditReport(root, 'run-1', '{}');
    const gitignore = await readFile(join(root, '.jta', '.gitignore'), 'utf8');
    expect(gitignore).toBe('*\n');
  });

  it('never overwrites an existing .jta/.gitignore', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.jta'), { recursive: true });
    await writeFile(join(root, '.jta', '.gitignore'), 'custom-content\n');
    await persistAuditReport(root, 'run-1', '{}');
    const gitignore = await readFile(join(root, '.jta', '.gitignore'), 'utf8');
    expect(gitignore).toBe('custom-content\n');
  });

  it('keeps only the 5 most recent reports by file mtime, deleting the oldest, and never deletes the report it just wrote', async () => {
    const root = await tempDir();
    const reportsDir = join(root, '.jta', 'reports');
    await mkdir(reportsDir, { recursive: true });

    const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
    const existingIds = ['run-a', 'run-b', 'run-c', 'run-d', 'run-e'];
    for (const [index, id] of existingIds.entries()) {
      const file = join(reportsDir, `${id}.json`);
      await writeFile(file, `{"runId":"${id}"}`);
      const time = new Date(baseTime + index * 1000);
      await utimes(file, time, time);
    }

    const result = await persistAuditReport(root, 'run-f', '{"runId":"run-f"}');

    expect(result.persisted).toBe(true);
    const remainingNames = (await readdir(reportsDir)).sort();
    expect(remainingNames).toEqual(['run-b.json', 'run-c.json', 'run-d.json', 'run-e.json', 'run-f.json']);
  });

  it('reports a non-fatal failure (never throws) when the .jta path cannot be created', async () => {
    const root = await tempDir();
    // A regular file where the .jta directory needs to go makes mkdir fail.
    await writeFile(join(root, '.jta'), 'not a directory');

    const result = await persistAuditReport(root, 'run-1', '{}');

    expect(result.persisted).toBe(false);
    if (!result.persisted) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('creates the .jta/reports directory tree when rootDir has nothing yet', async () => {
    const root = await tempDir();
    const result = await persistAuditReport(root, 'run-1', '{}');
    expect(result.persisted).toBe(true);
    const info = await stat(join(root, '.jta', 'reports'));
    expect(info.isDirectory()).toBe(true);
  });
});

describe('loadLatestPersistedReport: reads back <rootDir>/.jta/latest.json', () => {
  it('reports found: false, reason: "no-reports" when .jta/ does not exist at all', async () => {
    const root = await tempDir();
    const result = await loadLatestPersistedReport(root);
    expect(result).toEqual({ found: false, reason: 'no-reports' });
  });

  it('returns the exact raw content of latest.json plus its own mtime as recordedAt', async () => {
    const root = await tempDir();
    const json = '{"reportVersion":1,"runId":"run-1"}';
    await persistAuditReport(root, 'run-1', json);

    const result = await loadLatestPersistedReport(root);

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.raw).toBe(json);
      expect(result.recordedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(result.recordedAt.getTime())).toBe(false);
    }
  });
});

describe('loadPersistedReportByRunId: reads back <rootDir>/.jta/reports/<runId>.json', () => {
  it('reports found: false, reason: "no-reports" when .jta/ does not exist at all', async () => {
    const root = await tempDir();
    const result = await loadPersistedReportByRunId(root, 'run-1');
    expect(result).toEqual({ found: false, reason: 'no-reports' });
  });

  it('returns the exact raw content of the named run and its own mtime as recordedAt', async () => {
    const root = await tempDir();
    const json = '{"reportVersion":1,"runId":"run-1"}';
    await persistAuditReport(root, 'run-1', json);

    const result = await loadPersistedReportByRunId(root, 'run-1');

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.raw).toBe(json);
      expect(result.recordedAt).toBeInstanceOf(Date);
    }
  });

  it('reports found: false, reason: "unknown-run-id" with the sorted list of available ids when the run id does not exist but others do', async () => {
    const root = await tempDir();
    await persistAuditReport(root, 'run-b', '{"runId":"run-b"}');
    // A distinct fixed mtime avoids a same-millisecond retention tie between the two writes.
    await new Promise((r) => setTimeout(r, 5));
    await persistAuditReport(root, 'run-a', '{"runId":"run-a"}');

    const result = await loadPersistedReportByRunId(root, 'does-not-exist');

    expect(result).toEqual({ found: false, reason: 'unknown-run-id', availableRunIds: ['run-a', 'run-b'] });
  });

  it('rejects a path-traversal run id as unknown-run-id rather than escaping .jta/reports/', async () => {
    const root = await tempDir();
    await persistAuditReport(root, 'run-1', '{"runId":"run-1"}');

    const result = await loadPersistedReportByRunId(root, '../../etc/passwd');

    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe('unknown-run-id');
  });
});
