import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBenchmarkJsonlPath, writeBenchmarkJsonl } from '../src/adapters/benchmark-jsonl-writer.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'jev-benchmark-jsonl-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('checkBenchmarkJsonlPath', () => {
  it('reports no problem for a path whose parent exists and which is not itself a directory', async () => {
    expect(await checkBenchmarkJsonlPath(join(workDir, 'out.jsonl'))).toBeUndefined();
  });

  it('reports is-directory when the path itself is an existing directory', async () => {
    const dirPath = join(workDir, 'a-directory');
    await mkdir(dirPath);
    const problem = await checkBenchmarkJsonlPath(dirPath);
    expect(problem?.reason).toBe('is-directory');
  });

  it('reports parent-missing when the parent directory does not exist', async () => {
    const problem = await checkBenchmarkJsonlPath(join(workDir, 'no-such-dir', 'out.jsonl'));
    expect(problem?.reason).toBe('parent-missing');
  });
});

describe('writeBenchmarkJsonl', () => {
  it('writes one JSON line per record, each independently parseable', async () => {
    const path = join(workDir, 'out.jsonl');
    const result = await writeBenchmarkJsonl(path, [{ a: 1 }, { b: 2 }]);
    expect(result).toEqual({ written: true, overwrote: false, recordCount: 2 });

    const contents = await readFile(path, 'utf8');
    const lines = contents.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ b: 2 });
  });

  it('writes nothing to disk for zero records beyond an empty file, and reports recordCount 0', async () => {
    const path = join(workDir, 'empty.jsonl');
    const result = await writeBenchmarkJsonl(path, []);
    expect(result).toEqual({ written: true, overwrote: false, recordCount: 0 });
    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('reports overwrote: true when a regular file already existed at the path, and replaces its contents', async () => {
    const path = join(workDir, 'existing.jsonl');
    await writeFile(path, 'stale contents\n', 'utf8');
    const result = await writeBenchmarkJsonl(path, [{ fresh: true }]);
    expect(result).toEqual({ written: true, overwrote: true, recordCount: 1 });
    expect(await readFile(path, 'utf8')).toBe('{"fresh":true}\n');
  });

  it('fails with reason is-directory rather than writing, when the path is a directory', async () => {
    const dirPath = join(workDir, 'a-directory');
    await mkdir(dirPath);
    const result = await writeBenchmarkJsonl(dirPath, [{ a: 1 }]);
    expect(result.written).toBe(false);
    expect(result).toMatchObject({ written: false, reason: 'is-directory' });
  });

  it('fails with reason parent-missing rather than writing, when the parent directory does not exist', async () => {
    const path = join(workDir, 'no-such-dir', 'out.jsonl');
    const result = await writeBenchmarkJsonl(path, [{ a: 1 }]);
    expect(result).toMatchObject({ written: false, reason: 'parent-missing' });
  });
});
