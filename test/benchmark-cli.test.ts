import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBenchmarkCli } from '../src/cli/benchmark.js';

class RecordingIo {
  readonly lines: string[] = [];
  writeLine(message: string): void {
    this.lines.push(message);
  }
}

let caseDir: string;
let corpusRoot: string;

beforeEach(async () => {
  corpusRoot = await mkdtemp(join(tmpdir(), 'jev-benchmark-cli-corpus-'));
  caseDir = join(corpusRoot, 'trivially-true');
});

afterEach(async () => {
  await rm(corpusRoot, { recursive: true, force: true });
});

describe('runBenchmarkCli', () => {
  it('reports a usage error for an unknown option, without touching the corpus', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--bogus'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/Unknown option/);
  });

  it('reports a usage error when --corpus is missing its value', async () => {
    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--corpus'], io);
    expect(exitCode).toBe(1);
    expect(io.lines[0]).toMatch(/--corpus requires a path/);
  });

  it('prints an exit code 1 and an unproven-case reason for a corpus with no registered oracle recipe', async () => {
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(caseDir, 'case.json'), JSON.stringify({
      id: 'trivially-true',
      operators: ['remove-assertion'],
      operatorRole: 'descriptive',
      oracleKind: 'production-mutation',
      testEffect: 'irrelevant for this CLI-level test',
      productionEffect: 'irrelevant for this CLI-level test',
      expectedOutcome: 'expected-to-keep-passing',
      testFile: 'test.ts',
      productionFiles: ['lib.ts'],
    }), 'utf8');
    await writeFile(join(caseDir, 'test.ts'), "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });\n", 'utf8');
    await writeFile(join(caseDir, 'lib.ts'), 'export const unused = 1;\n', 'utf8');

    const io = new RecordingIo();
    const exitCode = await runBenchmarkCli(['--corpus', corpusRoot], io);
    expect(exitCode).toBe(1);
    expect(io.lines.some((line) => line.includes('UNPROVEN') && line.includes('no-mutation-declared'))).toBe(true);
    expect(io.lines.at(-1)).toBe('0/1 case(s) proven.');
  });
});
