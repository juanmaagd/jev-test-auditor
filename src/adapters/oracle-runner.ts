/**
 * I/O for the Phase 7 oracle runner (task P7-2,
 * `odd/tasks/phase-7-benchmarks.md`). This is the ONE place in this
 * repository that spawns a test runner against real source: not the audited
 * repository's — this module never receives, imports, or reaches anything
 * outside `src/domain/oracle.ts`'s already-built {@link OracleRun}, which is
 * always assembled from this repository's own Git-stored corpus
 * (`test/fixtures/corpus/`). It is reachable only from
 * `src/cli/benchmark.ts` — `src/cli/index.ts` (the `audit` command) never
 * imports this module or `src/cli/benchmark.ts` on any path, which
 * `test/benchmark-cli-boundary.test.ts` checks by static import-graph
 * closure, not by prose.
 *
 * **What this module never does.** It never writes to
 * `test/fixtures/corpus/` — every file it writes goes into one fresh
 * `fs.mkdtemp` scratch directory outside the repository entirely (under
 * `os.tmpdir()`), and that directory is always removed in a `finally` block,
 * on every outcome (pass, fail, timeout, or a thrown error). It never spawns
 * anything unbounded: every child process is killed (by process GROUP, via a
 * detached child and `process.kill(-pid, 'SIGKILL')`, so a pool of worker
 * processes vitest itself might spawn dies too) once its own `timeoutMs`
 * elapses, and a killed run is reported `'timed-out'` — never silently
 * treated as `'passed'` or `'failed'`.
 *
 * **An explicit, minimal child environment** (`buildChildEnv`): this
 * repository's OWN `npx vitest run` (the outer process this file may itself
 * be running inside, as a test) sets `VITEST`, `VITEST_WORKER_ID`, and
 * `NODE_ENV` on `process.env`. Spreading `process.env` into the spawned
 * child would let those leak in, and a vitest instance that sees `VITEST=true`
 * on startup behaves differently (worker-pool detection, among other
 * things) — exactly the "child that inherits the parent's config... can
 * pass while proving nothing" failure this phase's own instructions warn
 * about. `buildChildEnv` allow-lists a small fixed set of keys instead of
 * blocking a list of known-bad ones, so a *future* env var the outer
 * `vitest` starts setting is excluded by default, not by having to be
 * remembered.
 *
 * **Module resolution, without a copied `node_modules`.** The scratch
 * directory gets one symlink, `node_modules -> <this package's own real
 * node_modules>`, resolved via `import.meta.resolve('vitest/package.json')`
 * (never a hardcoded `node_modules/vitest/vitest.mjs` path, which would
 * silently stop working the moment vitest's own `bin` entry point changes
 * name). This is the exact directory Node's own module resolution algorithm
 * would find anyway by walking up from a file two levels below it — the
 * symlink only makes that walk succeed without vendoring a second copy of
 * every dependency into every scratch run. Removing that scratch directory
 * (`fs.rm(scratchDir, { recursive: true, force: true })`) unlinks the
 * symlink itself and never dereferences into the real `node_modules` it
 * points at — verified directly before this module was written (a real
 * `fs.rmSync` against a directory containing a symlinked child, checking the
 * symlink's target file survives).
 *
 * **Reading vitest's own JSON reporter**, not just its exit code — an exit
 * code alone cannot tell "the test genuinely failed an assertion" apart from
 * "the file never loaded at all" (a syntax error in a mutated fixture is a
 * realistic outcome this phase's own instructions call out). `assertionResults.length`
 * is compared against the run's own declared `expectedTestCount`: a
 * mismatch — including zero results, the load-error shape — is
 * `'runner-error'`, never misread as a pass or a fail.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, OracleRun } from '../domain/oracle.js';

/** Generous enough for a tiny fixture's genuine startup + run; short enough that a genuinely hung run does not stall a benchmark pass. Overridable per call. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ObserveOutcome {
  readonly observation: Observation;
  /** sha256 of exactly the bytes this run executed: every file's path and contents, plus which one was the spec entry. See the module doc's "record as data" requirement. */
  readonly contentHash: string;
}

export interface OracleObservationPort {
  observe(run: OracleRun, options?: { readonly timeoutMs?: number }): Promise<ObserveOutcome>;
  /**
   * The exact `fs.mkdtemp` prefix this port instance uses for its scratch
   * directories — unique per `createOracleRunnerPort()` call (a random
   * `crypto.randomUUID()` segment), never a fixed shared constant. Exposed
   * so a test can assert "this port left nothing behind" without racing
   * every OTHER concurrently-running test file that also happens to poll
   * `os.tmpdir()` (this repository's own suite runs test files in
   * parallel).
   */
  readonly scratchPrefix: string;
}

function hashRun(run: OracleRun): string {
  const hash = createHash('sha256');
  hash.update(`testFile:${run.testFile}\0`);
  const sortedFiles = [...run.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sortedFiles) {
    hash.update(`path:${file.path}\0`);
    hash.update(file.contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Allow-list, never a block-list: only these keys ever reach the spawned
 * child, plus a fixed `NO_COLOR=1` (keeps captured stderr free of ANSI
 * escapes). `PATH`/`HOME`/`TMPDIR` are what module/file resolution and
 * temp-file conventions need cross-platform; the rest are Windows
 * equivalents, included only when actually present.
 */
const ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE'] as const;

export function buildChildEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: Record<string, string> = { NO_COLOR: '1' };
  for (const key of ALLOWED_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface VitestEntry {
  readonly nodeModulesDir: string;
  readonly entry: string;
}

let cachedVitestEntry: VitestEntry | undefined;

/**
 * Resolves vitest's own CLI entry point from its `package.json` "bin" field
 * (never a hardcoded `node_modules/vitest/vitest.mjs` guess), and the real
 * `node_modules` directory it lives in — the exact directory the scratch
 * symlink points at. Cached for the process lifetime: this never changes
 * between calls within one run.
 */
async function resolveVitestEntry(): Promise<VitestEntry> {
  if (cachedVitestEntry !== undefined) return cachedVitestEntry;
  const packageJsonPath = fileURLToPath(import.meta.resolve('vitest/package.json'));
  const vitestDir = dirname(packageJsonPath);
  const nodeModulesDir = dirname(vitestDir);
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { readonly bin?: string | Readonly<Record<string, string>> };
  const relativeEntry = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.['vitest'];
  if (relativeEntry === undefined) {
    throw new Error('Could not resolve the vitest CLI entry point from its own package.json "bin" field');
  }
  cachedVitestEntry = { nodeModulesDir, entry: join(vitestDir, relativeEntry) };
  return cachedVitestEntry;
}

function vitestConfigSource(scratchDir: string, testFile: string): string {
  return [
    'export default {',
    '  test: {',
    `    root: ${JSON.stringify(scratchDir)},`,
    `    include: [${JSON.stringify(testFile)}],`,
    '    watch: false,',
    '    passWithNoTests: false,',
    '  },',
    '};',
    '',
  ].join('\n');
}

interface VitestAssertionResult {
  readonly status: string;
  readonly failureMessages?: readonly string[];
}

interface VitestTestFileResult {
  readonly assertionResults: readonly VitestAssertionResult[];
  readonly message?: string;
}

interface VitestJsonReport {
  readonly testResults: readonly VitestTestFileResult[];
}

async function spawnVitest(entry: string, configPath: string, reportPath: string, cwd: string, timeoutMs: number): Promise<{ readonly timedOut: boolean; readonly spawnError: Error | undefined; readonly stderr: string }> {
  const child = spawn(process.execPath, [entry, 'run', '--config', configPath, '--reporter=json', `--outputFile=${reportPath}`], {
    cwd,
    detached: true,
    // stdout is deliberately 'ignore', not 'pipe': the outcome this module cares about is read back
    // from vitest's own `--outputFile` JSON report, never stdout, and nothing here ever reads a
    // piped stdout stream. A fixture that prints a lot (a logging loop, a realistic mutation outcome
    // this task's own instructions name) would otherwise fill an unread stdout pipe, block the child
    // on a full buffer, and get misreported as `'timed-out'` even though it never actually hung.
    stdio: ['ignore', 'ignore', 'pipe'],
    env: buildChildEnv(process.env),
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString('utf8');
  });

  let timedOut = false;
  let spawnError: Error | undefined;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          // Kill the whole process GROUP (negative pid), not just this one process: `detached: true`
          // makes this child its own group leader, so any worker process vitest itself spawns dies
          // too. Most commonly throws only because the child already exited between the timeout
          // firing and this call — nothing left to kill, safe to ignore.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // A genuinely different failure (e.g. negative pids are unsupported on Windows) must still
          // not leave the child running forever — fall back to killing this one process directly.
          // Never letting `observe()` hang is the acceptance criterion this whole path exists for.
          try {
            child.kill('SIGKILL');
          } catch {
            // Nothing left this module can do; the 'exit' listener below still resolves once the OS
            // itself reaps the process (or never, if it is already gone some other way).
          }
        }
      }
    }, timeoutMs);
    child.once('error', (error) => {
      spawnError = error;
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return { timedOut, spawnError, stderr };
}

async function readObservationFromReport(reportPath: string, expectedTestCount: number, context: { readonly timedOut: boolean; readonly spawnError: Error | undefined; readonly stderr: string }): Promise<Observation> {
  if (context.timedOut) return { kind: 'timed-out' };
  if (context.spawnError !== undefined) return { kind: 'runner-error', detail: `failed to spawn vitest: ${context.spawnError.message}` };

  let reportRaw: string;
  try {
    reportRaw = await readFile(reportPath, 'utf8');
  } catch {
    return { kind: 'runner-error', detail: `no JSON report was written; stderr: ${context.stderr.slice(0, 2000)}` };
  }

  let report: VitestJsonReport;
  try {
    report = JSON.parse(reportRaw) as VitestJsonReport;
  } catch (error) {
    return { kind: 'runner-error', detail: `could not parse the JSON report: ${error instanceof Error ? error.message : String(error)}` };
  }

  const assertionResults = report.testResults.flatMap((file) => file.assertionResults);
  if (assertionResults.length !== expectedTestCount) {
    const loadMessages = report.testResults.map((file) => file.message).filter((message): message is string => message !== undefined && message.length > 0);
    const detail = `expected ${expectedTestCount} test result(s), observed ${assertionResults.length}`
      + (loadMessages.length > 0 ? `: ${loadMessages.join('; ').slice(0, 2000)}` : '');
    return { kind: 'runner-error', detail };
  }

  const unexpectedStatus = assertionResults.filter((result) => result.status !== 'passed' && result.status !== 'failed');
  if (unexpectedStatus.length > 0) {
    return { kind: 'runner-error', detail: `unexpected assertion status(es): ${unexpectedStatus.map((result) => result.status).join(', ')}` };
  }

  const failures = assertionResults.filter((result) => result.status === 'failed');
  if (failures.length > 0) {
    return { kind: 'failed', detail: failures.flatMap((result) => result.failureMessages ?? []).join('\n').slice(0, 2000) };
  }
  return { kind: 'passed' };
}

async function writeRunFiles(scratchDir: string, run: OracleRun): Promise<void> {
  for (const file of run.files) {
    const target = join(scratchDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, 'utf8');
  }
}

/**
 * Builds the one real `OracleObservationPort` this module offers:
 * materializes one {@link OracleRun} into a fresh scratch directory outside
 * the repository, spawns an isolated vitest subprocess bounded by
 * `timeoutMs` against it, and always removes the scratch directory again —
 * on a pass, a fail, a timeout, or a thrown error alike.
 */
export function createOracleRunnerPort(portOptions?: { readonly defaultTimeoutMs?: number }): OracleObservationPort {
  const defaultTimeoutMs = portOptions?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scratchPrefix = join(tmpdir(), `jev-benchmark-${randomUUID()}-`);

  return {
    scratchPrefix,
    async observe(run, options) {
      const contentHash = hashRun(run);
      const { nodeModulesDir, entry } = await resolveVitestEntry();
      const scratchDir = await mkdtemp(scratchPrefix);
      try {
        await symlink(nodeModulesDir, join(scratchDir, 'node_modules'), 'dir');
        await writeRunFiles(scratchDir, run);
        const configPath = join(scratchDir, 'vitest.config.mjs');
        await writeFile(configPath, vitestConfigSource(scratchDir, run.testFile), 'utf8');
        const reportPath = join(scratchDir, 'report.json');

        const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
        const spawnContext = await spawnVitest(entry, configPath, reportPath, scratchDir, timeoutMs);
        const observation = await readObservationFromReport(reportPath, run.expectedTestCount, spawnContext);
        return { observation, contentHash };
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  };
}
