/**
 * End-to-end coverage for the rootDir-identity defect fix (2026-09-20): a run's persisted
 * `rootDir` must identify a repository, not just record whatever spelling the caller passed.
 *
 * Before this fix, `getResolvedConfiguration` defaulted `rootDir` to the literal string `"."`
 * and `runAudit` persisted/compared that raw string verbatim. Two failures followed:
 *
 * 1. **False reject**: the same repository audited via two different-but-equivalent spellings
 *    (relative vs. absolute, a trailing slash, a symlinked ancestor) was wrongly rejected as a
 *    root mismatch.
 * 2. **False accept** (the serious one): two DIFFERENT repositories, each audited with no
 *    `--rootDir` (so both store the literal `"."`), compared EQUAL — a `--resume` against
 *    repository B, using a run id minted for repository A, was silently accepted and B's work
 *    items were written into A's run.
 *
 * These tests exercise the real `node:sqlite` adapter and the real CLI (`runCli`), never a fake
 * store, since the defect and its fix both live in real filesystem canonicalization —
 * `test/resume.test.ts`'s "--resume rootDir identity" describe block covers `preflightResume`'s
 * own orchestration logic against a hand-controlled fake instead.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';
import { createSqliteAuditStore } from '../src/adapters/sqlite-audit-store.js';
import type { AuditEvaluationPort, AuditStorePort } from '../src/domain/audit.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-rootdir-identity-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

async function tempDbFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-rootdir-identity-store-'));
  temporaryRoots.push(dir);
  return join(dir, 'audit-store.sqlite3');
}

function captureOutput(): { readonly io: CliIo; readonly lines: string[] } {
  const lines: string[] = [];
  return { io: { writeLine: (line) => lines.push(line) }, lines };
}

/** Deterministic and dispatch-tracking: every call records the test case name it was asked to evaluate. */
function trackedEvaluationPort(onCall: (name: string) => void): AuditEvaluationPort {
  return {
    async evaluate(request) {
      onCall(request.testCase.name);
      return {
        evaluation: {
          requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true,
          answers: {}, usage: { inputTokens: 10, outputTokens: 1 }, attempts: 1,
        },
        classification: {
          testCaseId: request.testCase.id,
          repositoryRelativePath: request.testCase.repositoryRelativePath,
          name: request.testCase.name,
          status: 'healthy',
          dimensions: [],
          findings: [],
          policyVersion: 2,
          rubricVersion: 2,
          model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
          usage: { inputTokens: 10, outputTokens: 1 },
        },
      };
    },
  };
}

/** Wraps a real store so a test can learn the runId `beginRun` mints, without changing behavior. */
function capturingRunId(store: AuditStorePort, onRunId: (runId: string) => void): AuditStorePort {
  return {
    ...store,
    beginRun: async (rootDir: string) => {
      const runId = await store.beginRun(rootDir);
      onRunId(runId);
      return runId;
    },
  };
}

describe('rootDir identity — false accept (defect fix, 2026-09-20)', () => {
  it(
    'the single most important case: two different repositories, each audited without --rootDir (so both would '
    + 'otherwise store the same literal "."), are NOT mutually resumable — a resume against the wrong repository '
    + 'is rejected, never silently accepted, and dispatches nothing against it',
    async () => {
      const originalCwd = process.cwd();
      try {
        // Distinct, non-symmetric fixture content and test names on each side, so an accidental
        // cross-contamination would be unmistakable rather than masked by identical values.
        const repoA = await fixture({ 'a.test.ts': "import { test, expect } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n" });
        const repoB = await fixture({ 'b.test.ts': "import { test, expect } from 'vitest';\ntest('multiplies', () => { expect(2 * 3).toBe(6); });\n" });
        const db = await tempDbFile();

        let runId: string | undefined;
        const storeA = capturingRunId(await createSqliteAuditStore({ databaseFile: db }), (id) => { runId = id; });

        process.chdir(repoA);
        const firstOutput = captureOutput();
        const firstExit = await runCli(['audit', '--evaluate'], firstOutput.io, {
          createEvaluationPort: () => trackedEvaluationPort(() => {}),
          createStorePort: () => storeA,
        });
        expect(firstExit).toBe(0);
        if (runId === undefined) throw new Error('expected a captured run id');

        const dispatchedAgainstB: string[] = [];
        process.chdir(repoB);
        const secondOutput = captureOutput();
        const secondExit = await runCli(['audit', '--evaluate', '--resume', runId], secondOutput.io, {
          createEvaluationPort: () => trackedEvaluationPort((name) => dispatchedAgainstB.push(name)),
          createStorePort: () => createSqliteAuditStore({ databaseFile: db }),
        });

        expect(secondExit).toBe(1);
        expect(dispatchedAgainstB).toEqual([]);
        expect(secondOutput.lines).toHaveLength(1);
        expect(secondOutput.lines[0]).toContain(runId);
      } finally {
        process.chdir(originalCwd);
      }
    },
  );
});

describe('rootDir identity — false reject (defect fix, 2026-09-20)', () => {
  const oneTestFixture = { 'a.test.ts': "import { test, expect } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n" };

  /**
   * Runs to completion with `firstRootDir`, then attempts `--resume` with `secondRootDir` — a
   * DIFFERENT spelling of the SAME repository. If the two spellings compare equal (the fix), the
   * first run already finished with nothing outstanding, so the resume reports that honestly
   * (exit 0, "Nothing to resume") rather than a root-mismatch usage error (exit 1). This
   * distinguishes "recognized as the same repository" from "rejected as a mismatch" directly.
   */
  async function expectResumableAcrossSpellings(firstRootDir: string, secondRootDir: string): Promise<void> {
    const db = await tempDbFile();
    let runId: string | undefined;
    const store = capturingRunId(await createSqliteAuditStore({ databaseFile: db }), (id) => { runId = id; });

    const first = await runCli(['audit', '--rootDir', firstRootDir, '--evaluate'], captureOutput().io, {
      createEvaluationPort: () => trackedEvaluationPort(() => {}),
      createStorePort: () => store,
    });
    expect(first).toBe(0);
    if (runId === undefined) throw new Error('expected a captured run id');

    const output = captureOutput();
    const exitCode = await runCli(['audit', '--rootDir', secondRootDir, '--evaluate', '--resume', runId], output.io, {
      createEvaluationPort: () => trackedEvaluationPort(() => { throw new Error('must not dispatch: nothing should be outstanding'); }),
      createStorePort: () => createSqliteAuditStore({ databaseFile: db }),
    });

    expect(exitCode).toBe(0);
    expect(output.lines[0]).toContain('Nothing to resume');
  }

  it('the same repository audited via a relative path, then an absolute path, is resumable', async () => {
    const root = await fixture(oneTestFixture);
    const originalCwd = process.cwd();
    try {
      process.chdir(dirname(root));
      const relative = `./${root.slice(dirname(root).length + 1)}`;
      await expectResumableAcrossSpellings(relative, root);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('the same repository audited via an absolute path, then the same path with a trailing slash, is resumable', async () => {
    const root = await fixture(oneTestFixture);
    await expectResumableAcrossSpellings(root, `${root}/`);
  });

  // The one variant that actually discriminates "resolve only" from "resolve then realpath" (see
  // `AuditStorePort.canonicalizeRootDir`'s own doc): a symlinked ANCESTOR directory, built
  // explicitly rather than relying on this dev machine's own macOS `/var` -> `/private/var`
  // layout, so the test is portable. Never a symlinked LEAF — `discoverTestFiles` already rejects
  // that outright for its own, unrelated reasons, which would fail this test for the wrong reason.
  it('the same repository reached through a symlinked ancestor directory, and directly, is resumable', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'jev-rootdir-identity-symlink-'));
    temporaryRoots.push(parent);
    const realParent = join(parent, 'real-parent');
    const repoDir = join(realParent, 'repo');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'a.test.ts'), oneTestFixture['a.test.ts']!);
    const linkParent = join(parent, 'link-parent');
    await symlink(realParent, linkParent);

    await expectResumableAcrossSpellings(join(linkParent, 'repo'), join(realParent, 'repo'));
  });
});

describe('rootDir identity — genuine mismatch still rejected (regression guard, defect fix 2026-09-20)', () => {
  it('two different repositories, both given explicit distinct absolute --rootDir values, are still rejected as a mismatch', async () => {
    const oneTestFixture = { 'a.test.ts': "import { test, expect } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n" };
    const rootA = await fixture(oneTestFixture);
    const rootB = await fixture(oneTestFixture);
    const db = await tempDbFile();
    let runId: string | undefined;
    const store = capturingRunId(await createSqliteAuditStore({ databaseFile: db }), (id) => { runId = id; });

    const first = await runCli(['audit', '--rootDir', rootA, '--evaluate'], captureOutput().io, {
      createEvaluationPort: () => trackedEvaluationPort(() => {}),
      createStorePort: () => store,
    });
    expect(first).toBe(0);
    if (runId === undefined) throw new Error('expected a captured run id');

    const dispatched: string[] = [];
    const output = captureOutput();
    const exitCode = await runCli(['audit', '--rootDir', rootB, '--evaluate', '--resume', runId], output.io, {
      createEvaluationPort: () => trackedEvaluationPort((name) => dispatched.push(name)),
      createStorePort: () => createSqliteAuditStore({ databaseFile: db }),
    });

    expect(exitCode).toBe(1);
    expect(dispatched).toEqual([]);
    expect(output.lines[0]).toContain(runId);
  });
});

describe('rootDir identity — pre-existing (legacy) run, real adapter (defect fix, 2026-09-20)', () => {
  it('a run recorded before this fix, holding a non-canonical root_dir, is refused with a named, visible error — never a silent accept, never a confusing mismatch', async () => {
    const databaseFile = await tempDbFile();
    // Create the schema first (via the real adapter), then close it and insert a row directly —
    // exactly mirroring what pre-fix `beginRun` did: store the raw, uninterpreted rootDir string
    // (here, the literal "." default) with no canonicalization at all.
    const bootstrap = await createSqliteAuditStore({ databaseFile });
    await bootstrap.close();
    const raw = new DatabaseSync(databaseFile);
    raw.prepare('INSERT INTO runs (id, root_dir, started_at) VALUES (?, ?, ?)').run('legacy-run', '.', '2026-01-01T00:00:00.000Z');
    raw.close();

    const root = await fixture({ 'a.test.ts': "import { test, expect } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n" });
    const dispatched: string[] = [];
    const output = captureOutput();
    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--resume', 'legacy-run'], output.io, {
      createEvaluationPort: () => trackedEvaluationPort((name) => dispatched.push(name)),
      createStorePort: () => createSqliteAuditStore({ databaseFile }),
    });

    expect(exitCode).toBe(1);
    expect(dispatched).toEqual([]);
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).toContain('legacy-run');
    // Never reported as an ordinary mismatch — this run was never actually compared against
    // anything; it was refused outright as unresumable.
    expect(output.lines[0]).not.toContain('was recorded against root');
  });
});
