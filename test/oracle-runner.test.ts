import { readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChildEnv, createOracleRunnerPort, type OracleObservationPort } from '../src/adapters/oracle-runner.js';
import type { OracleRun } from '../src/domain/oracle.js';

function run(overrides: Partial<OracleRun> & Pick<OracleRun, 'files' | 'testFile'>): OracleRun {
  return { label: 'test-run', expectedTestCount: 1, mutatedFiles: [], ...overrides };
}

/**
 * Counts only scratch directories left behind by THIS port instance's own
 * unique, randomized prefix — never a fixed shared prefix, which would race
 * every other test file this suite runs concurrently against the same
 * `os.tmpdir()`.
 */
async function ownScratchDirCount(port: OracleObservationPort): Promise<number> {
  const entries = await readdir(dirname(port.scratchPrefix));
  const prefix = basename(port.scratchPrefix);
  return entries.filter((name) => name.startsWith(prefix)).length;
}

describe('buildChildEnv', () => {
  it('allow-lists only a small fixed set of environment variables, never spreading the source env', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/x',
      VITEST: 'true',
      VITEST_WORKER_ID: '3',
      NODE_ENV: 'test',
      CI: 'true',
      SOME_SECRET: 'shh',
    });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.NO_COLOR).toBe('1');
    expect(env.VITEST).toBeUndefined();
    expect(env.VITEST_WORKER_ID).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.CI).toBeUndefined();
    expect(env.SOME_SECRET).toBeUndefined();
  });
});

describe('createOracleRunnerPort — real, isolated vitest subprocess execution', () => {
  it('observes "passed" for a genuinely passing fixture', async () => {
    const port = createOracleRunnerPort();
    const plan = run({
      files: [{ path: 'proof.ts', contents: "import { describe, expect, it } from 'vitest';\ndescribe('s', () => { it('t', () => { expect(1 + 1).toBe(2); }); });\n" }],
      testFile: 'proof.ts',
    });
    const result = await port.observe(plan);
    expect(result.observation).toEqual({ kind: 'passed' });
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('observes "failed" with a detail for a genuinely failing fixture', async () => {
    const port = createOracleRunnerPort();
    const plan = run({
      files: [{ path: 'proof.ts', contents: "import { describe, expect, it } from 'vitest';\ndescribe('s', () => { it('t', () => { expect(1 + 1).toBe(3); }); });\n" }],
      testFile: 'proof.ts',
    });
    const result = await port.observe(plan);
    expect(result.observation.kind).toBe('failed');
    expect(result.observation.kind === 'failed' && result.observation.detail).toMatch(/expected 2 to be 3/);
  });

  it('resolves relative production imports the way the real corpus does (./cart.js against cart.ts)', async () => {
    const port = createOracleRunnerPort();
    const plan = run({
      files: [
        { path: 'cart.ts', contents: 'export function double(n: number): number { return n * 2; }\n' },
        { path: 'proof.ts', contents: "import { describe, expect, it } from 'vitest';\nimport { double } from './cart.js';\ndescribe('s', () => { it('t', () => { expect(double(21)).toBe(42); }); });\n" },
      ],
      testFile: 'proof.ts',
    });
    const result = await port.observe(plan);
    expect(result.observation).toEqual({ kind: 'passed' });
  });

  it('reports "runner-error" (never "failed") when the fixture fails to load at all, e.g. a syntax error', async () => {
    const port = createOracleRunnerPort();
    const plan = run({
      files: [{ path: 'proof.ts', contents: "import { describe, it } from 'vitest';\ndescribe('s', ( => { it('t', () => {}); });\n" }],
      testFile: 'proof.ts',
    });
    const result = await port.observe(plan);
    expect(result.observation.kind).toBe('runner-error');
  });

  it('reports "runner-error" when fewer test results are observed than expected', async () => {
    const port = createOracleRunnerPort();
    const plan = run({
      files: [{ path: 'proof.ts', contents: "import { describe, expect, it } from 'vitest';\ndescribe('s', () => { it('t', () => { expect(1).toBe(1); }); });\n" }],
      testFile: 'proof.ts',
      expectedTestCount: 2,
    });
    const result = await port.observe(plan);
    expect(result.observation.kind).toBe('runner-error');
  });

  it('kills a genuinely hanging fixture at the given timeout and reports "timed-out", never "failed"', async () => {
    const port = createOracleRunnerPort();
    const plan = run({
      files: [{ path: 'proof.ts', contents: "import { describe, it } from 'vitest';\ndescribe('s', () => { it('hangs', () => { while (true) { /* never returns */ } }); });\n" }],
      testFile: 'proof.ts',
    });
    const start = Date.now();
    const result = await port.observe(plan, { timeoutMs: 1500 });
    const elapsed = Date.now() - start;
    expect(result.observation).toEqual({ kind: 'timed-out' });
    // Well under vitest's own default 5s test timeout: proves OUR kill fired, not vitest's.
    expect(elapsed).toBeLessThan(4000);
  }, 10_000);

  it('always removes its scratch directory, on a normal outcome and on a timeout alike', async () => {
    const port = createOracleRunnerPort();

    await port.observe(run({
      files: [{ path: 'proof.ts', contents: "import { describe, expect, it } from 'vitest';\ndescribe('s', () => { it('t', () => { expect(1).toBe(1); }); });\n" }],
      testFile: 'proof.ts',
    }));
    await port.observe(run({
      files: [{ path: 'proof.ts', contents: "import { describe, it } from 'vitest';\ndescribe('s', () => { it('hangs', () => { while (true) { /* spin */ } }); });\n" }],
      testFile: 'proof.ts',
    }), { timeoutMs: 1200 });

    expect(await ownScratchDirCount(port)).toBe(0);
  }, 10_000);

  it('does not misreport a fixture that prints a lot as "timed-out" (stdout must never back-pressure the child)', async () => {
    const port = createOracleRunnerPort();
    // ~100KB of stdout output before a genuine, fast pass — large enough to fill an unread OS pipe
    // buffer (typically 64KB) and block the child if stdout were ever piped without being drained.
    const plan = run({
      files: [{
        path: 'proof.ts',
        contents: "import { describe, expect, it } from 'vitest';\n"
          + "describe('s', () => { it('t', () => { for (let i = 0; i < 2000; i += 1) { console.log('x'.repeat(50)); } expect(1).toBe(1); }); });\n",
      }],
      testFile: 'proof.ts',
    });
    const result = await port.observe(plan, { timeoutMs: 5000 });
    expect(result.observation).toEqual({ kind: 'passed' });
  }, 10_000);

  it('hashes the exact bytes of a run deterministically, and differently for different bytes', async () => {
    const port = createOracleRunnerPort();
    const planA = run({ files: [{ path: 'proof.ts', contents: 'const a = 1;' }], testFile: 'proof.ts' });
    const planB = run({ files: [{ path: 'proof.ts', contents: 'const a = 2;' }], testFile: 'proof.ts' });
    // Use a tiny always-fails-fast pair just to exercise observe()'s hashing without a real test body.
    const [resultA1, resultA2, resultB] = await Promise.all([
      port.observe({ ...planA, files: [{ path: 'proof.ts', contents: "import {it} from 'vitest'; it('x', () => {});" }] }),
      port.observe({ ...planA, files: [{ path: 'proof.ts', contents: "import {it} from 'vitest'; it('x', () => {});" }] }),
      port.observe({ ...planB, files: [{ path: 'proof.ts', contents: "import {it} from 'vitest'; it('x', () => { throw new Error('x'); });" }] }),
    ]);
    expect(resultA1.contentHash).toBe(resultA2.contentHash);
    expect(resultA1.contentHash).not.toBe(resultB.contentHash);
  });
});
