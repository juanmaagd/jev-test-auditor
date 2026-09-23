import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAudit } from '../src/application/audit.js';
import { runCli, type CliIo } from '../src/cli/index.js';
import { createJevEvaluationPort } from '../src/adapters/jev-evaluation-port.js';
import { readStoredCredentials, resolveAuthStoragePaths, writeStoredCredentials } from '../src/adapters/auth-storage.js';
import { createSqliteAuditStore, resolveAuditStorePaths } from '../src/adapters/sqlite-audit-store.js';
import { AuthPromptCancelledError } from '../src/domain/auth.js';
import { AuditStoreSchemaVersionError } from '../src/domain/audit.js';
import type { AuditEvaluationPort, AuditFileResult, AuditPorts, AuditResult, AuditStorePort, AuditStoreWorkItemOutcome } from '../src/domain/audit.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import { canonicalizeEvidenceBundle } from '../src/index.js';
import type { JevAnswer, JevEvaluation, JevGatewayPort } from '../src/domain/jev-gateway.js';
import type { JevRequest } from '../src/domain/jev-request.js';
import type { TestCase, TestCaseId, TestModifierKind } from '../src/domain/test-understanding.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

/**
 * Global safety net (Phase 4, task P4-5): every test in this file runs
 * against a temp per-user config directory, never the real
 * `~/.config`/`%APPDATA%`. Without this, any test that reaches the
 * production `--evaluate`/`auth` code paths (most do not override
 * `createEvaluationPort`) would resolve real on-host storage paths — a
 * developer's own stored TypeSafe key would then silently change test
 * behavior. `XDG_CONFIG_HOME` and `APPDATA` are both set so this holds on
 * every platform regardless of which one a given test run honors.
 */
let originalXdgConfigHome: string | undefined;
let originalAppData: string | undefined;
let globalTestConfigHome: string;

beforeAll(async () => {
  globalTestConfigHome = await mkdtemp(join(tmpdir(), 'jev-cli-auth-config-'));
  originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
  originalAppData = process.env['APPDATA'];
  process.env['XDG_CONFIG_HOME'] = globalTestConfigHome;
  process.env['APPDATA'] = globalTestConfigHome;
});

afterAll(async () => {
  if (originalXdgConfigHome === undefined) delete process.env['XDG_CONFIG_HOME'];
  else process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
  if (originalAppData === undefined) delete process.env['APPDATA'];
  else process.env['APPDATA'] = originalAppData;
  await rm(globalTestConfigHome, { recursive: true, force: true });
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-cli-'));
  temporaryRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([path, source]) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }));
  return root;
}

function captureOutput(): { io: CliIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { writeLine: (line) => lines.push(line) }, lines };
}

const zeroEvidenceTotals = {
  evidenceBundles: 0,
  evidenceFragments: 0,
  evidenceTruncatedFragments: 0,
  evidenceOmitted: 0,
  evidenceDenied: 0,
  evidenceUnresolved: 0,
  unsupportedFrameworkFiles: 0,
};

function bundleFor(testCaseId: string): EvidenceBundle {
  const content = 'body';
  return buildEvidenceBundle({
    testCaseId: testCaseId as TestCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [{
      kind: 'test',
      repositoryRelativePath: 'a.test.ts',
      span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      content,
      contentHash: 'h'.repeat(64),
      selectionReason: 'test-body',
      truncation: { truncated: false, originalBytes: content.length, includedBytes: content.length },
    }],
    denied: [],
    unresolved: [],
    omitted: [],
  });
}

function fileWithEvidence(path: string, bundles: readonly EvidenceBundle[]): AuditFileResult {
  return {
    discovered: { repositoryRelativePath: path, framework: 'vitest', frameworkEvidence: [] },
    testCases: bundles.map((bundle) => ({
      id: bundle.testCaseId,
      repositoryRelativePath: path,
      kind: 'test',
      framework: 'vitest',
      name: bundle.testCaseId,
      structuralAncestry: [{ kind: 'test', name: bundle.testCaseId, ordinal: 0 }],
      source: `test('${bundle.testCaseId}', () => {});`,
      span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      modifiers: [],
      hooks: [],
      imports: [],
      mocks: [],
      assertions: [],
      parameterization: { mode: 'none', cases: [] },
      diagnostics: [],
    })),
    dynamicMetadata: [],
    diagnostics: [],
    evidence: bundles,
  };
}

const dryRunSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };

function testCaseWithModifiers(id: string, modifierKinds: readonly TestModifierKind[]): TestCase {
  return {
    id: id as TestCaseId,
    repositoryRelativePath: 'a.test.ts',
    kind: 'test',
    framework: 'vitest',
    name: id,
    structuralAncestry: [{ kind: 'test', name: id, ordinal: 0 }],
    source: `test('${id}', () => {});`,
    span: dryRunSpan,
    modifiers: modifierKinds.map((kind) => ({ kind, span: dryRunSpan })),
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
  };
}

/**
 * One fragment, 1-byte content, path `a.ts`, hash `h`. With `testCaseId`
 * `tc:v1:abc` its canonical form is exactly 477 UTF-8 bytes — the same
 * fixture and hand-derived arithmetic as `test/estimate.test.ts`'s golden
 * (see that file's `smallBundle` doc comment for the byte count derivation).
 */
function smallEvidenceBundle(testCaseId: string): EvidenceBundle {
  return buildEvidenceBundle({
    testCaseId: testCaseId as TestCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [{
      kind: 'test',
      repositoryRelativePath: 'a.ts',
      span: dryRunSpan,
      content: 'x',
      contentHash: 'h',
      selectionReason: 'test-body',
      truncation: { truncated: false, originalBytes: 1, includedBytes: 1 },
    }],
    denied: [],
    unresolved: [],
    omitted: [],
  });
}

/** Golden fixture: one evaluable test (`tc:v1:abc`, 477-byte bundle) plus one skip, one todo, and one test with no built bundle. */
function dryRunGoldenAudit(): AuditResult {
  const testCases = [
    testCaseWithModifiers('tc:v1:abc', []),
    testCaseWithModifiers('tc:v1:skip-1', ['skip']),
    testCaseWithModifiers('tc:v1:todo-1', ['todo']),
    testCaseWithModifiers('tc:v1:missing-1', []),
  ];
  const evidence = [smallEvidenceBundle('tc:v1:abc')];
  return {
    rootDir: '/workspace',
    files: [{
      discovered: { repositoryRelativePath: 'a.test.ts', framework: 'vitest', frameworkEvidence: [] },
      testCases,
      dynamicMetadata: [],
      diagnostics: [],
      evidence,
    }],
    excluded: [],
    diagnostics: [],
    totals: {
      files: 1, excluded: 0, testCases: 4, dynamicMetadata: 0, diagnostics: 0,
      ...zeroEvidenceTotals, evidenceBundles: 1, evidenceFragments: 1,
    },
    reportingOnly: true,
  };
}

async function readdirSorted(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return [...entries].sort();
}

describe('CLI foundation', () => {
  it('prints help from the public CLI seam, documenting --inspect-payloads and --dry-run', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['--help'], output.io);

    expect(exitCode).toBe(0);
    expect(output.lines[0]).toContain('Usage:');
    expect(output.lines[0]).toContain('--inspect-payloads');
    expect(output.lines[0]).toContain('--dry-run');
    expect(output.lines[0]).toContain('--json');
  });

  it('emits one deterministic reporting-only summary for audit, with evidence totals and per-file bundle counts', async () => {
    const output = captureOutput();
    const audit: AuditResult = {
      rootDir: '/workspace',
      files: [{
        discovered: { repositoryRelativePath: 'a.test.ts', framework: 'vitest', frameworkEvidence: [] },
        testCases: [],
        dynamicMetadata: [{
          reason: 'dynamic-test-name',
          expression: "test(name, () => {})",
          span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        }],
        diagnostics: [],
        evidence: [],
      }],
      excluded: [{ repositoryRelativePath: 'skip.test.ts', reason: 'default-exclude', evidence: [] }],
      diagnostics: [{
        code: 'source-read-failed',
        message: 'Unable to read broken.test.ts: denied',
        severity: 'error',
        repositoryRelativePath: 'broken.test.ts',
      }],
      totals: { files: 1, excluded: 1, testCases: 0, dynamicMetadata: 1, diagnostics: 1, ...zeroEvidenceTotals },
      reportingOnly: true,
    };

    // Phase 7 (orchestrator scope change): bare `audit` now prints a human-readable report, so
    // this golden (asserting the exact discovery JSON shape) deliberately passes `--json` — the
    // shape itself is unchanged, only how it is reached (see `describe('audit --json (bare)')`
    // below for the behavior change itself).
    const exitCode = await runCli(['audit', '--json'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(1);
    expect(JSON.parse(output.lines[0] ?? '')).toEqual({
      reportingOnly: true,
      rootDir: '/workspace',
      files: [{ path: 'a.test.ts', framework: 'vitest', testCaseCount: 0, dynamicMetadataCount: 1, evidenceBundleCount: 0 }],
      excluded: [{ path: 'skip.test.ts', reason: 'default-exclude' }],
      totals: { files: 1, excluded: 1, testCases: 0, dynamicMetadata: 1, diagnostics: 1, ...zeroEvidenceTotals },
      diagnostics: [{
        path: 'broken.test.ts',
        code: 'source-read-failed',
        message: 'Unable to read broken.test.ts: denied',
        severity: 'error',
      }],
    });
  });

  it('surfaces totals.unsupportedFrameworkFiles in the reporting-only summary (B-1)', async () => {
    const output = captureOutput();
    const audit: AuditResult = {
      rootDir: '/workspace',
      files: [{
        discovered: { repositoryRelativePath: 'a.test.ts', framework: 'unknown', frameworkEvidence: [] },
        testCases: [],
        dynamicMetadata: [],
        diagnostics: [{
          code: 'unsupported-framework',
          message: 'Test framework could not be attributed for this file; found test-framework-looking import(s): bun:test.',
          severity: 'warning',
        }],
        evidence: [],
      }],
      excluded: [],
      diagnostics: [{
        code: 'unsupported-framework',
        message: 'Test framework could not be attributed for this file; found test-framework-looking import(s): bun:test.',
        severity: 'warning',
        repositoryRelativePath: 'a.test.ts',
      }],
      totals: { files: 1, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 1, ...zeroEvidenceTotals, unsupportedFrameworkFiles: 1 },
      reportingOnly: true,
    };

    // Phase 7: bare `audit` now prints a human-readable report — `--json` reaches the unchanged
    // discovery JSON this test actually asserts on.
    const exitCode = await runCli(['audit', '--json'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output.lines[0] ?? '') as { totals: { unsupportedFrameworkFiles: number } };
    expect(parsed.totals.unsupportedFrameworkFiles).toBe(1);
  });

  it('returns zero for audit diagnostics and one for usage errors', async () => {
    const diagnosticOutput = captureOutput();
    // Phase 7: `--json` added — this test parses the JSON summary, which is now behind the flag.
    const diagnosticExitCode = await runCli(['audit', '--json'], diagnosticOutput.io, {
      audit: async () => ({
        rootDir: '.', files: [], excluded: [], diagnostics: [{ code: 'failure', message: 'info', severity: 'error' }],
        totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 1, ...zeroEvidenceTotals }, reportingOnly: true,
      }),
    });
    const usageOutput = captureOutput();
    const usageExitCode = await runCli(['unknown'], usageOutput.io);

    expect(diagnosticExitCode).toBe(0);
    expect(JSON.parse(diagnosticOutput.lines[0] ?? '')).toMatchObject({ reportingOnly: true });
    expect(usageExitCode).toBe(1);
    expect(usageOutput.lines[0]).toContain('Unknown command');
  });

  it('rejects --inspect-payloads-like typos as an unknown option', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--inspect-payload'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('Unknown option');
  });

  it('never leaks bundle payload lines when a file carries evidence but --inspect-payloads was not requested', async () => {
    const output = captureOutput();
    const audit: AuditResult = {
      rootDir: '/workspace',
      files: [fileWithEvidence('a.test.ts', [bundleFor('tc:v1:a-1'), bundleFor('tc:v1:a-2')])],
      excluded: [],
      diagnostics: [],
      totals: { files: 1, excluded: 0, testCases: 2, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals, evidenceBundles: 2 },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(1);
  });
});

describe('--inspect-payloads', () => {
  it('prints the summary line first, then one exact canonical bundle line per bundle, ordered by file path then test-case order', async () => {
    const output = captureOutput();
    const bundleA1 = bundleFor('tc:v1:a-1');
    const bundleA2 = bundleFor('tc:v1:a-2');
    const bundleB1 = bundleFor('tc:v1:b-1');
    const audit: AuditResult = {
      rootDir: '/workspace',
      files: [
        fileWithEvidence('a.test.ts', [bundleA1, bundleA2]),
        fileWithEvidence('b.test.ts', [bundleB1]),
      ],
      excluded: [],
      diagnostics: [],
      totals: { files: 2, excluded: 0, testCases: 3, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals, evidenceBundles: 3 },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit', '--inspect-payloads'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(4);
    expect(JSON.parse(output.lines[0] ?? '')).toMatchObject({ reportingOnly: true });
    expect(output.lines[1]).toBe(canonicalizeEvidenceBundle(bundleA1));
    expect(output.lines[2]).toBe(canonicalizeEvidenceBundle(bundleA2));
    expect(output.lines[3]).toBe(canonicalizeEvidenceBundle(bundleB1));
  });

  it('prints only the summary line when no file carries any evidence', async () => {
    const output = captureOutput();
    const audit: AuditResult = {
      rootDir: '/workspace',
      files: [],
      excluded: [],
      diagnostics: [],
      totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit', '--inspect-payloads'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(1);
  });
});

describe('no network activity', () => {
  const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });

  afterEach(() => {
    fetchSpy.mockClear();
  });

  it('never calls fetch while running a real audit (production discovery, read, extraction, and evidence) with --inspect-payloads', async () => {
    const root = await fixture({
      'math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'math.test.ts': "import { expect, test } from 'vitest';\nimport { add } from './math.js';\n\ntest('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--rootDir', root, '--inspect-payloads'], output.io);

      expect(exitCode).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(output.lines.length).toBeGreaterThan(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Phase 7 (orchestrator scope change on top of the readable-default-summary task): the plain
 * `audit` (no `--dry-run`/`--evaluate`/`--json`/`--inspect-payloads`) now prints one human-readable
 * report for the human running it — combining discovery (files, exclusions, evidence provenance,
 * diagnostics — the same data `--json` exposes) with the exact same no-network, no-write cost/call
 * estimate `--dry-run` computes (`estimateDryRun`, reused verbatim) and the exact same read-only
 * cache consultation `--dry-run` already performs. `--json` and `--inspect-payloads` stay pure
 * discovery-only surfaces, byte-identical to before this task.
 */
describe('audit (default readable summary, folds in the --dry-run cost estimate)', () => {
  const distinctTotals = {
    files: 2,
    excluded: 3,
    testCases: 41,
    dynamicMetadata: 5,
    diagnostics: 11,
    unsupportedFrameworkFiles: 7,
    evidenceBundles: 13,
    evidenceFragments: 17,
    evidenceTruncatedFragments: 19,
    evidenceOmitted: 23,
    evidenceDenied: 29,
    evidenceUnresolved: 31,
  };

  it(
    'labels every totals figure distinctly (all-distinct-prime fixture: swapping any two reported '
    + 'counts must turn this red)',
    async () => {
      const output = captureOutput();
      const audit: AuditResult = {
        rootDir: '/workspace-totals',
        files: [],
        excluded: [],
        diagnostics: [],
        totals: distinctTotals,
        reportingOnly: true,
      };

      const exitCode = await runCli(['audit'], output.io, { audit: async () => audit });

      expect(exitCode).toBe(0);
      expect(output.lines).toHaveLength(1);
      const report = output.lines[0] ?? '';
      expect(report).toContain('Audit summary (reporting-only)');
      expect(report).toContain('Root: /workspace-totals');
      expect(report).toContain('Files discovered: 2');
      expect(report).toContain('Files excluded: 3');
      expect(report).toContain('Dynamic metadata entries: 5');
      expect(report).toContain('Unsupported framework files: 7');
      expect(report).toContain('Diagnostics (total): 11');
      expect(report).toContain('Evidence fragments: 17 (19 truncated)');
      expect(report).toContain('Evidence omitted: 23');
      expect(report).toContain('Evidence denied: 29');
      expect(report).toContain('Evidence unresolved: 31');
      // Deliberate dedup (this task's own report): `Evidence bundles` and `Discovered test cases`
      // (from the folded-in cost estimate, asserted separately below) are the same number under two
      // different names in the common case — one evidence bundle per discovered test case. This
      // fixture's `evidenceBundles: 13` value stays in the `AuditTotals` object (still a required
      // field, still exposed unchanged by `audit --json`) but must never surface as its own text line.
      expect(report).not.toContain('Evidence bundles');
    },
  );

  it('folds in the exact --dry-run cost/call estimate, computed by the real estimateDryRun over the discovered files', async () => {
    const output = captureOutput();
    const evaluableIds = ['tc:v1:eval-1', 'tc:v1:eval-2', 'tc:v1:eval-3', 'tc:v1:eval-4'];
    const skipIds = ['tc:v1:skip-1', 'tc:v1:skip-2'];
    const todoIds = ['tc:v1:todo-1', 'tc:v1:todo-2', 'tc:v1:todo-3'];
    const fileA: AuditFileResult = {
      discovered: { repositoryRelativePath: 'a.test.ts', framework: 'vitest', frameworkEvidence: [] },
      testCases: [
        ...evaluableIds.map((id) => testCaseWithModifiers(id, [])),
        ...skipIds.map((id) => testCaseWithModifiers(id, ['skip'])),
        ...todoIds.map((id) => testCaseWithModifiers(id, ['todo'])),
      ],
      dynamicMetadata: [],
      diagnostics: [],
      evidence: evaluableIds.map((id) => smallEvidenceBundle(id)),
    };
    const fileB: AuditFileResult = {
      discovered: { repositoryRelativePath: 'b.test.ts', framework: 'vitest', frameworkEvidence: [] },
      testCases: [testCaseWithModifiers('tc:v1:missing-1', [])],
      dynamicMetadata: [],
      diagnostics: [],
      evidence: [],
    };
    const audit: AuditResult = {
      rootDir: '/workspace-estimate',
      files: [fileA, fileB],
      excluded: [],
      diagnostics: [],
      totals: {
        files: 2, excluded: 0, testCases: 10, dynamicMetadata: 0, diagnostics: 0,
        ...zeroEvidenceTotals, evidenceBundles: 4, evidenceFragments: 4,
      },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(1);
    const report = output.lines[0] ?? '';
    // Discovered=10 (4 evaluable + 2 skip + 3 todo + 1 evidence-unavailable), all distinct so a
    // swap between any two of these is independently detectable.
    expect(report).toContain('Discovered test cases: 10');
    expect(report).toContain('Evaluable: 4');
    expect(report).toContain('Skipped: 6 (skip: 2, todo: 3, evidence-unavailable: 1)');
    expect(report).toContain('Initial Jev calls (one per evaluable test case, exact): 4');
    expect(report).toContain('Model: jev-1.13');
    expect(report).toContain('Pricing/overhead snapshot: v2 (as of 2026-09-20)');
    expect(report).toContain('Estimated cost in USD (approximate):');
    expect(report).toContain('No network calls were made');
    expect(report).toContain('nothing was written to disk');
    // The seam never attempts a real store lookup (no `dependencies.audit === undefined` gate
    // reached), so neither a cache-hit line nor a not-consulted disclosure should appear here —
    // that disclosure is proven separately, against the real store lookup, below.
    expect(report).not.toContain('Cache');
  });

  it('prints discovered files, then excluded files, then diagnostics — grouped found -> skipped -> wrong', async () => {
    const output = captureOutput();
    const fileA: AuditFileResult = {
      discovered: { repositoryRelativePath: 'a.test.ts', framework: 'vitest', frameworkEvidence: [] },
      testCases: [
        testCaseWithModifiers('tc:v1:a-1', []),
        testCaseWithModifiers('tc:v1:a-2', []),
        testCaseWithModifiers('tc:v1:a-3', []),
      ],
      dynamicMetadata: [],
      diagnostics: [],
      evidence: [bundleFor('tc:v1:a-1'), bundleFor('tc:v1:a-2')],
    };
    const fileB: AuditFileResult = {
      discovered: { repositoryRelativePath: 'b.test.ts', framework: 'unknown', frameworkEvidence: [] },
      testCases: [testCaseWithModifiers('tc:v1:b-1', [])],
      dynamicMetadata: [{
        reason: 'dynamic-test-name',
        expression: 'test(name, () => {})',
        span: dryRunSpan,
      }],
      diagnostics: [],
      evidence: [],
    };
    const audit: AuditResult = {
      rootDir: '/workspace-detail',
      files: [fileA, fileB],
      excluded: [
        { repositoryRelativePath: 'skip.test.ts', reason: 'default-exclude', evidence: [] },
        { repositoryRelativePath: 'e2e/flow.spec.ts', reason: 'e2e-v1', evidence: [] },
      ],
      diagnostics: [
        { code: 'source-read-failed', message: 'Unable to read broken.test.ts: denied', severity: 'error', repositoryRelativePath: 'broken.test.ts' },
        { code: 'failure', message: 'info', severity: 'error' },
      ],
      totals: {
        files: 2, excluded: 2, testCases: 4, dynamicMetadata: 1, diagnostics: 2,
        ...zeroEvidenceTotals, evidenceBundles: 2,
      },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    const report = output.lines[0] ?? '';
    expect(report).toContain('Discovered files:');
    expect(report).toContain('  - a.test.ts [vitest] — 3 test case(s), 2 evidence bundle(s)');
    expect(report).toContain('  - b.test.ts [unknown] — 1 test case(s), 0 evidence bundle(s), 1 dynamic metadata');
    expect(report).toContain('Excluded files:');
    expect(report).toContain('  - skip.test.ts (reason: default-exclude)');
    expect(report).toContain('  - e2e/flow.spec.ts (reason: e2e-v1)');
    expect(report).toContain('Diagnostics:');
    expect(report).toContain('  - source-read-failed (broken.test.ts): Unable to read broken.test.ts: denied');
    expect(report).toContain('  - failure: info');

    const discoveredIndex = report.indexOf('Discovered files:');
    const excludedIndex = report.indexOf('Excluded files:');
    const diagnosticsIndex = report.indexOf('Diagnostics:');
    expect(discoveredIndex).toBeGreaterThan(-1);
    expect(excludedIndex).toBeGreaterThan(discoveredIndex);
    expect(diagnosticsIndex).toBeGreaterThan(excludedIndex);
  });

  it('truncates a long discovered-file list at 20 entries without hiding what was left out', async () => {
    const output = captureOutput();
    const files: AuditFileResult[] = Array.from({ length: 25 }, (_unused, index) => ({
      discovered: { repositoryRelativePath: `file-${String(index).padStart(2, '0')}.test.ts`, framework: 'vitest', frameworkEvidence: [] },
      testCases: [],
      dynamicMetadata: [],
      diagnostics: [],
      evidence: [],
    }));
    const audit: AuditResult = {
      rootDir: '/workspace-long-list',
      files,
      excluded: [],
      diagnostics: [],
      totals: { files: 25, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    const report = output.lines[0] ?? '';
    // The true total is unaffected by truncation.
    expect(report).toContain('Files discovered: 25');
    const discoveredSection = report.slice(report.indexOf('Discovered files:'), report.indexOf('Excluded files:'));
    const shownLines = discoveredSection.split('\n').filter((line) => line.startsWith('  - '));
    expect(shownLines).toHaveLength(20);
    expect(discoveredSection).toContain('  ... and 5 more not shown (run `audit --json` to see the complete list).');
  });

  /**
   * Problem 1 (this task's own report): a real audit against a NestJS backend produced 20+ lines
   * all reading `(reason: not-test-file)` — the overwhelmingly common, zero-signal case (any
   * production source file lands here). These tests build a fixture with seven distinct exclusion
   * reasons at seven distinct counts (`DiscoveryExclusionReason`, `src/domain/discovery.ts`) so a
   * mis-grouping or a swapped count is independently detectable, and so signal/non-signal filtering
   * cannot pass by coincidence.
   */
  describe('groups exclusions by reason, listing individual paths only where an exclusion could surprise a reader', () => {
    function excludedFixture(count: number, reason: AuditResult['excluded'][number]['reason'], prefix: string): AuditResult['excluded'][number][] {
      return Array.from({ length: count }, (_unused, index) => ({
        repositoryRelativePath: `${prefix}-${String(index).padStart(2, '0')}.ts`,
        reason,
        evidence: [],
      }));
    }

    function distinctReasonExcluded(): AuditResult['excluded'][number][] {
      return [
        ...excludedFixture(16, 'not-test-file', 'src/prod'),
        ...excludedFixture(3, 'unsupported-extension', 'docs/readme'),
        ...excludedFixture(6, 'configured-exclude', 'fixtures/cfg'),
        ...excludedFixture(2, 'default-exclude', 'vendor/lib'),
        ...excludedFixture(4, 'e2e-v1', 'e2e/flow'),
        ...excludedFixture(1, 'symlink', 'links/link'),
        ...excludedFixture(5, 'outside-root', 'escaped/out'),
      ];
    }

    function baseAudit(excluded: AuditResult['excluded'][number][]): AuditResult {
      return {
        rootDir: '/workspace-exclusion-signal',
        files: [],
        excluded,
        diagnostics: [],
        totals: {
          files: 0, excluded: excluded.length, testCases: 0, dynamicMetadata: 0, diagnostics: 0,
          ...zeroEvidenceTotals,
        },
        reportingOnly: true,
      };
    }

    it('prints one "Excluded files by reason:" count per distinct reason (alphabetical, all seven distinct) and lists individual paths only for the five reasons that could mean a reader missed an expected test', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['audit'], output.io, { audit: async () => baseAudit(distinctReasonExcluded()) });

      expect(exitCode).toBe(0);
      const report = output.lines[0] ?? '';

      expect(report).toContain('Excluded files by reason:');
      expect(report).toContain('  - configured-exclude: 6');
      expect(report).toContain('  - default-exclude: 2');
      expect(report).toContain('  - e2e-v1: 4');
      expect(report).toContain('  - not-test-file: 16');
      expect(report).toContain('  - outside-root: 5');
      expect(report).toContain('  - symlink: 1');
      expect(report).toContain('  - unsupported-extension: 3');
      // Alphabetically sorted, for a deterministic report regardless of the order exclusions were
      // discovered in — asserted as relative positions, not mere containment.
      const byReasonSection = report.slice(report.indexOf('Excluded files by reason:'), report.indexOf('Excluded files:'));
      const reasonLineOrder = [
        '  - configured-exclude: 6', '  - default-exclude: 2', '  - e2e-v1: 4',
        '  - not-test-file: 16', '  - outside-root: 5', '  - symlink: 1', '  - unsupported-extension: 3',
      ].map((line) => byReasonSection.indexOf(line));
      for (let index = 1; index < reasonLineOrder.length; index += 1) {
        expect(reasonLineOrder[index]).toBeGreaterThan(reasonLineOrder[index - 1] ?? -1);
      }

      // The individually-listed section (18 signal-reason paths total — under the 20-entry
      // truncation limit, so its own "run `audit --json`" truncation note never fires here) is
      // bounded between its own header and the diagnostics-total line that now follows every
      // listing (see the reordering tests below).
      const individualStart = report.indexOf('Excluded files:');
      const individualEnd = report.indexOf('Diagnostics (total):');
      expect(individualStart).toBeGreaterThan(-1);
      expect(individualEnd).toBeGreaterThan(individualStart);
      const individualSection = report.slice(individualStart, individualEnd);

      expect(individualSection).toContain('  - fixtures/cfg-00.ts (reason: configured-exclude)');
      expect(individualSection).toContain('  - vendor/lib-00.ts (reason: default-exclude)');
      expect(individualSection).toContain('  - e2e/flow-00.ts (reason: e2e-v1)');
      expect(individualSection).toContain('  - links/link-00.ts (reason: symlink)');
      expect(individualSection).toContain('  - escaped/out-00.ts (reason: outside-root)');
      // The two collapsed (non-signal) reasons never get an individual line, even though their
      // counts appear above — checked against the bounded slice, not the whole report, since
      // `Excluded files by reason:` legitimately contains these reason names as text.
      expect(individualSection).not.toContain('src/prod');
      expect(individualSection).not.toContain('docs/readme');
      expect(individualSection).not.toContain('reason: not-test-file)');
      expect(individualSection).not.toContain('reason: unsupported-extension)');

      // Whatever was collapsed stays reachable (this task's own requirement), the same guarantee
      // `fileListTextLines`'s own truncation note already makes elsewhere in this report. Checked
      // against the reachability note's own distinctive phrase, not the bare `audit --json`
      // substring (which `fileListTextLines`'s unrelated truncation note also contains, though it
      // never fires in this fixture: 18 signal entries stay under its 20-entry limit).
      expect(report).toContain('including the reasons collapsed here');
    });

    it('shows "Excluded files: none" when every present reason is collapsed, while still reporting per-reason counts and the reachability note', async () => {
      const output = captureOutput();
      const excluded = [
        ...excludedFixture(5, 'not-test-file', 'src/prod'),
        ...excludedFixture(2, 'unsupported-extension', 'docs/readme'),
      ];
      const exitCode = await runCli(['audit'], output.io, { audit: async () => baseAudit(excluded) });

      expect(exitCode).toBe(0);
      const report = output.lines[0] ?? '';
      expect(report).toContain('  - not-test-file: 5');
      expect(report).toContain('  - unsupported-extension: 2');
      expect(report).toContain('Excluded files: none');
      expect(report).toContain('including the reasons collapsed here');
    });

    it('omits the reachability note when nothing was collapsed (every present reason already gets an individual line)', async () => {
      const output = captureOutput();
      const excluded = [
        ...excludedFixture(2, 'e2e-v1', 'e2e/flow'),
        ...excludedFixture(1, 'symlink', 'links/link'),
      ];
      const exitCode = await runCli(['audit'], output.io, { audit: async () => baseAudit(excluded) });

      expect(exitCode).toBe(0);
      const report = output.lines[0] ?? '';
      expect(report).toContain('  - e2e-v1: 2');
      expect(report).toContain('  - symlink: 1');
      expect(report).toContain('  - e2e/flow-00.ts (reason: e2e-v1)');
      expect(report).toContain('  - links/link-00.ts (reason: symlink)');
      // Nothing was collapsed here, so the reachability note must not appear at all. Checked
      // against its own distinctive phrase, not the bare `audit --json` substring: that phrase
      // also appears in `fileListTextLines`'s own (unrelated) truncation note, which this small
      // fixture never triggers either — asserting the narrower phrase keeps this test honest about
      // exactly which behavior it verifies.
      expect(report).not.toContain('including the reasons collapsed here');
    });

    it('treats a test-shaped file excluded only by a configured include pattern as signal, distinct from an ordinary production file sharing the same raw `not-test-file` reason', async () => {
      const output = captureOutput();
      const excluded: AuditResult['excluded'][number][] = [
        { repositoryRelativePath: 'looks-like-a-test.spec.ts', reason: 'not-test-file', evidence: ['include-pattern'] },
        { repositoryRelativePath: 'ordinary-production-file.ts', reason: 'not-test-file', evidence: [] },
      ];
      const exitCode = await runCli(['audit'], output.io, { audit: async () => baseAudit(excluded) });

      expect(exitCode).toBe(0);
      const report = output.lines[0] ?? '';
      // Two distinct counts under two distinct labels — never folded into one `not-test-file: 2`.
      expect(report).toContain('  - not-test-file: 1');
      expect(report).toContain('  - not-test-file (excluded by a configured include pattern): 1');
      const individualSection = report.slice(report.indexOf('Excluded files:'), report.indexOf('Diagnostics (total):'));
      expect(individualSection).toContain('looks-like-a-test.spec.ts (reason: not-test-file (excluded by a configured include pattern))');
      expect(individualSection).not.toContain('ordinary-production-file.ts');
    });
  });

  it('orders the report as run-shape+cost, then evidence detail, then listings, then diagnostics, then the closing guarantee — and never states the evidence-bundle count as a line separate from "Discovered test cases"', async () => {
    const output = captureOutput();
    const fileA: AuditFileResult = {
      discovered: { repositoryRelativePath: 'a.test.ts', framework: 'vitest', frameworkEvidence: [] },
      testCases: [testCaseWithModifiers('tc:v1:a-1', [])],
      dynamicMetadata: [],
      diagnostics: [],
      evidence: [bundleFor('tc:v1:a-1')],
    };
    const audit: AuditResult = {
      rootDir: '/workspace-order',
      files: [fileA],
      excluded: [{ repositoryRelativePath: 'skip.test.ts', reason: 'default-exclude', evidence: [] }],
      diagnostics: [{ code: 'failure', message: 'info', severity: 'error' }],
      totals: {
        files: 1, excluded: 1, testCases: 1, dynamicMetadata: 0, diagnostics: 1,
        ...zeroEvidenceTotals, evidenceBundles: 1, evidenceFragments: 1,
      },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    const report = output.lines[0] ?? '';

    const filesDiscoveredIndex = report.indexOf('Files discovered:');
    const modelIndex = report.indexOf('Model:');
    const discoveredTestCasesIndex = report.indexOf('Discovered test cases:');
    const estimatedCostIndex = report.indexOf('Estimated cost in USD');
    const evidenceFragmentsIndex = report.indexOf('Evidence fragments:');
    const discoveredFilesListIndex = report.indexOf('Discovered files:');
    const excludedByReasonIndex = report.indexOf('Excluded files by reason:');
    const diagnosticsTotalIndex = report.indexOf('Diagnostics (total):');
    const diagnosticsListIndex = report.indexOf('Diagnostics:');
    const closingIndex = report.indexOf('No network calls were made');

    for (const index of [
      filesDiscoveredIndex, modelIndex, discoveredTestCasesIndex, estimatedCostIndex,
      evidenceFragmentsIndex, discoveredFilesListIndex, excludedByReasonIndex,
      diagnosticsTotalIndex, diagnosticsListIndex, closingIndex,
    ]) {
      expect(index).toBeGreaterThan(-1);
    }

    // Tier 1->2: what it found, then what it would cost.
    expect(modelIndex).toBeGreaterThan(filesDiscoveredIndex);
    expect(discoveredTestCasesIndex).toBeGreaterThan(modelIndex);
    expect(estimatedCostIndex).toBeGreaterThan(discoveredTestCasesIndex);
    // Tier 2->3: the cost estimate, then the evidence detail behind it.
    expect(evidenceFragmentsIndex).toBeGreaterThan(estimatedCostIndex);
    // Tier 3->4: evidence detail, then the listings.
    expect(discoveredFilesListIndex).toBeGreaterThan(evidenceFragmentsIndex);
    expect(excludedByReasonIndex).toBeGreaterThan(discoveredFilesListIndex);
    // Tier 4->5: listings, then diagnostics (count travels with its own list, not with the totals
    // near the top — this task's own deliberate reordering).
    expect(diagnosticsTotalIndex).toBeGreaterThan(excludedByReasonIndex);
    expect(diagnosticsListIndex).toBeGreaterThan(diagnosticsTotalIndex);
    // Tier 5->6: diagnostics, then the closing guarantee.
    expect(closingIndex).toBeGreaterThan(diagnosticsListIndex);

    // Problem 2's dedup: `evidenceBundles: 1` stays a real field on `totals` (unaffected `--json`
    // shape), but must never surface as its own "Evidence bundles" text line now that it is the
    // exact same number as "Discovered test cases" above.
    expect(report).not.toContain('Evidence bundles');
  });

  it('accepts bare --json (no longer a usage error) and prints exactly the plain discovery JSON', async () => {
    const output = captureOutput();
    const audit: AuditResult = {
      rootDir: '/workspace-bare-json',
      files: [],
      excluded: [],
      diagnostics: [],
      totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit', '--json'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(1);
    expect(JSON.parse(output.lines[0] ?? '')).toMatchObject({ reportingOnly: true, rootDir: '/workspace-bare-json' });
    // The readable-report title/estimate lines must never leak into --json's output.
    expect(output.lines[0]).not.toContain('Audit summary');
  });

  it('--inspect-payloads --json is legal now (no longer rejected) and behaves exactly like --inspect-payloads alone', async () => {
    const withoutJson = captureOutput();
    const withJson = captureOutput();
    const audit: AuditResult = {
      rootDir: '/workspace',
      files: [fileWithEvidence('a.test.ts', [bundleFor('tc:v1:a-1')])],
      excluded: [],
      diagnostics: [],
      totals: { files: 1, excluded: 0, testCases: 1, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals, evidenceBundles: 1 },
      reportingOnly: true,
    };

    const exitCodeWithoutJson = await runCli(['audit', '--inspect-payloads'], withoutJson.io, { audit: async () => audit });
    const exitCodeWithJson = await runCli(['audit', '--inspect-payloads', '--json'], withJson.io, { audit: async () => audit });

    expect(exitCodeWithoutJson).toBe(0);
    expect(exitCodeWithJson).toBe(0);
    expect(withJson.lines).toEqual(withoutJson.lines);
  });

  describe('real, read-only cache consultation (no store yet — the common case)', () => {
    useIsolatedConfigHome();

    it('discloses why the cache was not consulted, through the exact same read-only lookup --dry-run uses, and still creates no database file', async () => {
      const root = await fixture({
        'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
      });
      const storePaths = resolveAuditStorePaths();
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--rootDir', root], output.io);

      expect(exitCode).toBe(0);
      const report = output.lines[0] ?? '';
      expect(report).toContain('Cache: not consulted (no audit store exists yet at the configured location).');
      expect(report).toContain('Discovered test cases: 1');
      expect(report).toContain('Evaluable: 1');
      await expect(access(storePaths.databaseFile)).rejects.toThrow();
      await expect(access(storePaths.configDir)).rejects.toThrow();
    });
  });
});

describe('--dry-run usage errors', () => {
  it('rejects --dry-run combined with --inspect-payloads as a usage error and never runs the audit seam', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--dry-run', '--inspect-payloads'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--dry-run');
    expect(output.lines[0]).toContain('--inspect-payloads');
  });

  it('rejects --dry-run --json combined with --inspect-payloads as a usage error', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--dry-run', '--json', '--inspect-payloads'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
  });
});

describe('--dry-run --json', () => {
  it(
    'prints exactly one literal golden JSON line for the fixed golden audit result '
    + '(1 evaluable / 3 skipped [skip:1, todo:1, evidence-unavailable:1]; '
    + 'tokens 5847..9356, follow-up max 9356, usd 0.000245574..0.000785904 — see test/estimate.test.ts for the arithmetic). '
    + 'This is the golden fixture the cache-consultation disclosure (orchestrator decision, 2026-09-20) deliberately '
    + 'changes: cacheConsulted:false is now always present, right after initialCalls — the exact-match assertion below '
    + 'was updated to include it rather than loosened to a substring match.',
    async () => {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--dry-run', '--json'], output.io, { audit: async () => dryRunGoldenAudit() });

      expect(exitCode).toBe(0);
      expect(output.lines).toHaveLength(1);
      expect(output.lines[0]).toBe(
        '{"dryRun":true,"reportingOnly":true,"rootDir":"/workspace","model":"jev-1.13.0","snapshotVersion":2,'
        + '"asOf":"2026-09-20","discovered":4,"evaluable":1,'
        + '"skipped":{"total":3,"byReason":{"skip":1,"todo":1,"evidence-unavailable":1}},'
        + '"initialCalls":1,"cacheConsulted":false,"followUpCalls":{"min":0,"max":1},"evidenceBytes":477,'
        + '"requestBytes":28068,"rubricBytesPerRequest":27701,'
        + '"estimatedInputTokens":{"min":5847,"max":9356},'
        + '"estimatedFollowUpInputTokens":{"min":0,"max":9356},'
        + '"estimatedUsd":{"min":0.000245574,"max":0.000785904},'
        + '"bundlesOverCeiling":0,"requestTokenCeiling":64000,"networkCalls":0,"filesWritten":0}',
      );
    },
  );

  it('reports an all-zero dry-run preview for a repository with no discovered test cases', async () => {
    const output = captureOutput();
    const emptyResult: AuditResult = {
      rootDir: '.',
      files: [],
      excluded: [],
      diagnostics: [],
      totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit', '--dry-run', '--json'], output.io, { audit: async () => emptyResult });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.lines[0] ?? '')).toMatchObject({
      discovered: 0,
      evaluable: 0,
      initialCalls: 0,
      followUpCalls: { min: 0, max: 0 },
      evidenceBytes: 0,
      requestBytes: 0,
      // Rubric-only cost, still reported even with zero discovered test cases (default RUBRIC_V2).
      rubricBytesPerRequest: 27_701,
      estimatedUsd: { min: 0, max: 0 },
      bundlesOverCeiling: 0,
    });
  });

  it('diagnostics from the underlying audit do not change the exit code', async () => {
    const output = captureOutput();
    const withDiagnostics: AuditResult = {
      rootDir: '.',
      files: [],
      excluded: [],
      diagnostics: [{ code: 'failure', message: 'info', severity: 'error' }],
      totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 1, ...zeroEvidenceTotals },
      reportingOnly: true,
    };

    const exitCode = await runCli(['audit', '--dry-run', '--json'], output.io, { audit: async () => withDiagnostics });

    expect(exitCode).toBe(0);
  });
});

describe('--dry-run (human-readable text)', () => {
  it('prints one concise multi-line report labeling token/USD figures as estimated and disclosing no network/writes', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--dry-run'], output.io, { audit: async () => dryRunGoldenAudit() });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(1);
    const report = output.lines[0] ?? '';
    expect(report).toContain('jev-1.13');
    expect(report).toContain('2026-09-20');
    expect(report).toContain('Discovered test cases: 4');
    expect(report).toContain('Evaluable: 1');
    expect(report).toContain('Skipped: 3 (skip: 1, todo: 1, evidence-unavailable: 1)');
    expect(report).toContain('Initial Jev calls');
    expect(report).toContain('1');
    expect(report).toContain('Evidence bytes');
    expect(report).toContain('477');
    expect(report).toContain('Request bytes');
    expect(report).toContain('28068');
    expect(report).toContain('Rubric bytes per request');
    expect(report).toContain('27701');
    expect(report).toContain('Estimated input tokens');
    expect(report).toContain('5847 - 9356');
    expect(report).toContain('Estimated follow-up input tokens');
    expect(report).toContain('Estimated cost in USD (approximate): 0.000245574 - 0.000785904');
    expect(report).toContain('No network calls were made');
    expect(report).toContain('nothing was written');
  });

  it('never prints --inspect-payloads-style bundle lines under --dry-run', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--dry-run'], output.io, { audit: async () => dryRunGoldenAudit() });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).not.toContain('"testCaseId"');
  });
});

describe('--dry-run: no network, no writes, no API key required', () => {
  const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });

  afterEach(() => {
    fetchSpy.mockClear();
  });

  it('never calls fetch during a real --dry-run audit (production discovery, read, extraction, and evidence)', async () => {
    const root = await fixture({
      'math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'math.test.ts': "import { expect, test } from 'vitest';\nimport { add } from './math.js';\n\ntest('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--rootDir', root, '--dry-run', '--json'], output.io);

      expect(exitCode).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(output.lines).toHaveLength(1);
      expect(JSON.parse(output.lines[0] ?? '')).toMatchObject({ dryRun: true, discovered: 1, evaluable: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('writes nothing under the fixture root during --dry-run (directory listing unchanged before/after)', async () => {
    const root = await fixture({
      'math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'math.test.ts': "import { expect, test } from 'vitest';\nimport { add } from './math.js';\n\ntest('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
    });
    const before = await readdirSorted(root);

    const output = captureOutput();
    const exitCode = await runCli(['audit', '--rootDir', root, '--dry-run'], output.io);
    const after = await readdirSorted(root);

    expect(exitCode).toBe(0);
    expect(after).toEqual(before);
  });

  it('works with TYPESAFE_API_KEY and similar provider env vars unset', async () => {
    const root = await fixture({
      'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
    });
    const keyNames = ['TYPESAFE_API_KEY', 'JEV_API_KEY'];
    const saved = keyNames.map((name) => [name, process.env[name]] as const);
    for (const name of keyNames) delete process.env[name];
    try {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--rootDir', root, '--dry-run', '--json'], output.io);

      expect(exitCode).toBe(0);
      expect(JSON.parse(output.lines[0] ?? '')).toMatchObject({ dryRun: true });
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});

describe('--evaluate', () => {
  it('documents --evaluate and --evaluate --json in --help', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['--help'], output.io);

    expect(exitCode).toBe(0);
    expect(output.lines[0]).toContain('--evaluate');
    expect(output.lines[0]).toContain('TYPESAFE_API_KEY');
  });

  it('rejects --dry-run combined with --evaluate as a usage error and never runs the audit seam', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--dry-run', '--evaluate'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--dry-run');
    expect(output.lines[0]).toContain('--evaluate');
  });

  it('rejects --evaluate combined with --inspect-payloads as a usage error and never runs the audit seam', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--evaluate', '--inspect-payloads'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--evaluate');
    expect(output.lines[0]).toContain('--inspect-payloads');
  });

  it('rejects --fresh without --evaluate as a usage error and never runs the audit seam', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--fresh'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--fresh');
    expect(output.lines[0]).toContain('--evaluate');
  });

  it('rejects --fresh combined with --dry-run (no --evaluate) as a usage error', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--dry-run', '--fresh'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--fresh');
    expect(output.lines[0]).toContain('--evaluate');
  });

  it('accepts --evaluate --fresh together and forwards fresh:true to the audit seam', async () => {
    const output = captureOutput();
    const audit: AuditResult = {
      rootDir: '/workspace',
      files: [],
      excluded: [],
      diagnostics: [],
      totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
      reportingOnly: true,
      evaluation: {
        classifications: [],
        totals: {
          evaluated: 0,
          cached: 0,
          failed: 0,
          skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
          usage: { inputTokens: 0, outputTokens: 0 },
          statusCounts: { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 },
          respondedModel: undefined,
          modelMismatches: 0,
        },
        cacheStatusByTestCaseId: new Map(),
        latencyByTestCaseId: new Map(),
      },
    };

    const exitCode = await runCli(['audit', '--evaluate', '--fresh'], output.io, {
      audit: async () => audit,
    });

    expect(exitCode).toBe(0);
  });

  describe('key safety (real gateway construction path, no dependencies.audit override)', () => {
    let savedKey: string | undefined;
    let originalFetch: typeof fetch;
    const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });

    beforeEach(() => {
      savedKey = process.env['TYPESAFE_API_KEY'];
      delete process.env['TYPESAFE_API_KEY'];
      originalFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY']; else process.env['TYPESAFE_API_KEY'] = savedKey;
      globalThis.fetch = originalFetch;
      fetchSpy.mockClear();
    });

    it('exits 1 with a clear usage message and makes no network call when --evaluate is requested and TYPESAFE_API_KEY is unset', async () => {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--evaluate'], output.io);

      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--evaluate');
      expect(output.lines[0]).toContain('TYPESAFE_API_KEY');
      expect(output.lines[0]).toContain('auth login');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('exits 1 with the same message for --evaluate --json without a key, and makes no network call', async () => {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--evaluate', '--json'], output.io);

      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('TYPESAFE_API_KEY');
      expect(output.lines[0]).toContain('auth login');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('uses the locally stored key when TYPESAFE_API_KEY is unset, constructing the gateway and attempting a request', async () => {
      const isolatedConfigHome = await mkdtemp(join(tmpdir(), 'jev-cli-auth-isolated-'));
      temporaryRoots.push(isolatedConfigHome);
      const savedXdg = process.env['XDG_CONFIG_HOME'];
      const savedAppData = process.env['APPDATA'];
      process.env['XDG_CONFIG_HOME'] = isolatedConfigHome;
      process.env['APPDATA'] = isolatedConfigHome;
      const evaluateFetchSpy = vi.fn(async () => new Response(JSON.stringify({
        model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 },
      }), { status: 200 }));
      globalThis.fetch = evaluateFetchSpy as unknown as typeof fetch;

      try {
        const paths = resolveAuthStoragePaths();
        await writeStoredCredentials(paths, 'stored-secret-key');
        const output = captureOutput();

        // Audit a small fixture, not the working directory. This test's claim is about key
        // resolution — that the real gateway is constructed with the stored key — and auditing
        // this repository was incidental to it. Without `--rootDir` the run discovers, extracts,
        // and persists checkpoints for every test case this project has, so its cost grew with
        // our own suite: it measured 3.33s against a 5000ms timeout and failed intermittently
        // under full-suite parallel load. P5-3 hit the same test once and bought time with WAL;
        // it came back as soon as the suite grew again. A fixed fixture makes the cost constant.
        const root = await fixture({
          'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
        });
        const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate'], output.io);

        expect(exitCode).toBe(0);
        expect(evaluateFetchSpy).toHaveBeenCalled();
        const [, requestInit] = evaluateFetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        const headers = requestInit.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer stored-secret-key');
        expect(output.lines.join('\n')).not.toContain('stored-secret-key');
      } finally {
        if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME']; else process.env['XDG_CONFIG_HOME'] = savedXdg;
        if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData;
      }
    });

    it('never constructs or touches the network for a plain audit (no --evaluate) even though a key is missing', async () => {
      const root = await fixture({
        'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
      });
      const output = captureOutput();

      // Phase 7: `--json` added so this golden keeps asserting the unchanged discovery JSON shape;
      // the behavior under test here (no key needed, no network touched for a plain audit) holds
      // identically for the bare human-readable default, which is covered separately.
      const exitCode = await runCli(['audit', '--rootDir', root, '--json'], output.io);

      expect(exitCode).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.parse(output.lines[0] ?? '')).toMatchObject({ reportingOnly: true });
    });

    it('mutation probe: never constructs the evaluation port when --evaluate is not passed, even if construction would throw', async () => {
      const output = captureOutput();
      const canned: AuditResult = {
        rootDir: '.',
        files: [],
        excluded: [],
        diagnostics: [],
        totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
        reportingOnly: true,
      };

      const exitCode = await runCli(['audit'], output.io, {
        audit: async () => canned,
        createEvaluationPort: () => { throw new Error('must not construct the evaluation port without --evaluate'); },
      });

      expect(exitCode).toBe(0);
    });
  });

  describe('golden --evaluate --json line (real runAudit + real jev-evaluation-port adapter + a stub JevGatewayPort with fixed answers)', () => {
    const fixedTestCaseId = 'tc:v1:abc' as TestCaseId;

    /**
     * Every `.applicable` noul answer is `0.1` — below `applicabilityMin` of
     * `0.5`, shared unchanged by `CLASSIFICATION_POLICY_V1` and the shipped
     * `CLASSIFICATION_POLICY_V2` — so every one of the shipped rubric's 7
     * dimensions is judged `not-applicable` and its `.quality`
     * score/probabilities are never read (the score answers below are
     * structurally valid but their value never matters, and this stays true
     * regardless of a dimension's exact applicability wording, so it is
     * unaffected by task C-2's `determinism-isolation`/`falsifiability`
     * rewrite). Walking `classifyEvaluation`'s branches by hand for this
     * fixed input: every dimension takes the `applicabilityProbability <
     * policy.applicabilityMin` branch of `judgeDimensionV2` (`status:
     * 'not-applicable'`, `applicable: false`, `level`/`score`/`confidence`/
     * `reason`/`probabilities`/masses all `undefined` and so dropped by
     * `JSON.stringify`) — identical to `judgeDimensionV1`'s same-named branch,
     * since task C-1 does not touch applicability; `classifyOverall` then sees
     * zero `applicableDimensions`, which is the `applicableDimensions.length
     * === 0` branch, giving the overall `status: 'needs-review'`;
     * `isFindingWorthy` never matches a `not-applicable` judgment, so
     * `findings: []`. This golden therefore stays green across both the
     * V1→V2 policy wiring switch (task C-1) and the V1→V2 rubric wiring
     * switch (task C-2) except for `policyVersion`/`rubricVersion` themselves.
     */
    function fixedAnswersGateway(): JevGatewayPort {
      return {
        async evaluate(request: JevRequest): Promise<JevEvaluation> {
          const answers: Record<string, JevAnswer> = {};
          for (const questionId of Object.keys(request.questions)) {
            answers[questionId] = questionId.endsWith('.applicable')
              ? { type: 'noul', probability: 0.1, raw: { type: 'noul', noul: 0.1 } }
              : {
                type: 'score',
                score: 0,
                legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
                probabilities: { '0': 0.25, '1': 0.25, '2': 0.25, '3': 0.25 },
                confidence: 0.9,
                raw: {
                  type: 'score',
                  score: 0,
                  legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
                  probabilities: { '0': 0.25, '1': 0.25, '2': 0.25, '3': 0.25 },
                  confidence: 0.9,
                },
              };
          }
          return {
            requestedModel: request.model,
            respondedModel: request.model,
            modelMatchesPin: true,
            answers,
            usage: { inputTokens: 100, outputTokens: 0 },
            attempts: 1,
          };
        },
      };
    }

    function onlyBundle(): EvidenceBundle {
      return buildEvidenceBundle({
        testCaseId: fixedTestCaseId,
        budget: DEFAULT_EVIDENCE_BUDGET,
        fragments: [],
        denied: [],
        unresolved: [],
        omitted: [],
      });
    }

    function realPorts(evaluation: AuditEvaluationPort): AuditPorts {
      return {
        discovery: {
          discover: async () => ({
            files: [{ repositoryRelativePath: 'abc.test.ts', framework: 'vitest', frameworkEvidence: [] }],
            excluded: [],
            diagnostics: [],
          }),
        },
        sourceReader: { read: async () => 'source' },
        extractor: {
          extract: () => ({
            testCases: [{
              id: fixedTestCaseId,
              repositoryRelativePath: 'abc.test.ts',
              kind: 'test',
              framework: 'vitest',
              name: 'abc',
              structuralAncestry: [{ kind: 'test', name: 'abc', ordinal: 0 }],
              source: "test('abc', () => {});",
              span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
              modifiers: [],
              hooks: [],
              imports: [],
              mocks: [],
              assertions: [],
              parameterization: { mode: 'none', cases: [] },
              diagnostics: [],
            }],
            dynamicMetadata: [],
            diagnostics: [],
          }),
        },
        evidence: { build: async (request) => ({ bundles: request.testCases.map(() => onlyBundle()), diagnostics: [] }) },
        evaluation,
      };
    }

    it(
      'prints exactly one literal golden JSON line for a one-test-case fixture, built through the real runAudit '
      + 'pipeline and the real jev-evaluation-port adapter against a stub JevGatewayPort with fixed answers',
      async () => {
        const output = captureOutput();
        const evaluation = createJevEvaluationPort(fixedAnswersGateway());

        const exitCode = await runCli(['audit', '--rootDir', '/workspace', '--evaluate', '--json'], output.io, {
          audit: async (request) => runAudit(request, realPorts(evaluation)),
        });

        expect(exitCode).toBe(0);
        expect(output.lines).toHaveLength(1);
        expect(output.lines[0]).toBe(
          '{"reportVersion":1,"rootDir":"/workspace","reportingOnly":true,"complete":true,"versions":{"storeSchema":4,"rubric":2,"policy":2},'
          + '"modelRequested":"jev-1.13.0","discovery":{"files":[{"path":"abc.test.ts","framework":"vitest","testCaseCount":1,"dynamicMetadataCount":0,'
          + '"evidenceBundleCount":1}],"excluded":[],"totals":{"files":1,"excluded":0,"testCases":1,"dynamicMetadata":0,"diagnostics":0,'
          + '"unsupportedFrameworkFiles":0,"evidenceBundles":1,"evidenceFragments":0,"evidenceTruncatedFragments":0,"evidenceOmitted":0,'
          + '"evidenceDenied":0,"evidenceUnresolved":0}},"totals":{"evaluated":1,"cached":0,"failed":0,"skipped":{"total":0,"byReason":{"skip":0,"todo":0,'
          + '"evidence-unavailable":0}},"usage":{"inputTokens":100,"outputTokens":0},"statusCounts":{"healthy":0,"weak":0,"misleading":0,'
          + '"needs-review":1},"respondedModel":"jev-1.13.0","modelMismatches":0},"latency":{"measuredTestCases":0},'
          + '"cacheStatus":[{"testCaseId":"tc:v1:abc","repositoryRelativePath":"abc.test.ts","name":"abc","status":"fresh"}],'
          + '"classifications":[{"testCaseId":"tc:v1:abc","repositoryRelativePath":"abc.test.ts","name":"abc","status":"needs-review",'
          + '"dimensions":[{"dimensionId":"assertion-strength","dimensionLabel":"Assertion strength","applicable":false,"applicabilityProbability":0.1,'
          + '"status":"not-applicable"},{"dimensionId":"behavioral-focus","dimensionLabel":"Behavioral focus","applicable":false,'
          + '"applicabilityProbability":0.1,"status":"not-applicable"},{"dimensionId":"determinism-isolation",'
          + '"dimensionLabel":"Determinism and isolation","applicable":false,"applicabilityProbability":0.1,"status":"not-applicable"},'
          + '{"dimensionId":"diagnostic-quality","dimensionLabel":"Diagnostic quality","applicable":false,"applicabilityProbability":0.1,'
          + '"status":"not-applicable"},{"dimensionId":"falsifiability","dimensionLabel":"Falsifiability","applicable":false,'
          + '"applicabilityProbability":0.1,"status":"not-applicable"},{"dimensionId":"refactor-resistance","dimensionLabel":"Refactor resistance",'
          + '"applicable":false,"applicabilityProbability":0.1,"status":"not-applicable"},{"dimensionId":"test-double-quality",'
          + '"dimensionLabel":"Test-double quality","applicable":false,"applicabilityProbability":0.1,"status":"not-applicable"}],"findings":[],'
          + '"policyVersion":2,"rubricVersion":2,"model":{"requested":"jev-1.13.0","responded":"jev-1.13.0","matchesPin":true},"usage":{"inputTokens":100,'
          + '"outputTokens":0},"cache":"fresh","evidence":{"fragments":0,"truncatedFragments":0,"denied":[],"unresolved":[],"omitted":[]}}],'
          + '"diagnostics":[]}'
        );
      },
    );

    /**
     * The trivial golden above pins the LEAST informative path: every
     * applicability answer is 0.1, so all seven dimensions are
     * `not-applicable`, the overall status is `needs-review`, and `findings`
     * is empty. That golden stays green even if level resolution, finding
     * generation, per-dimension judgment serialization, usage accumulation,
     * or status counting broke. This second golden exercises a realistic
     * mixed run: two test cases, real applicability/quality answers above
     * threshold, one dimension driven to `misleading` alongside another
     * driven to `strong` in the SAME test case (proving non-compensation end
     * to end — a strong dimension cannot cancel a misleading one), and a
     * second test case where every applicable dimension is
     * `acceptable`/`strong` (`healthy`). Different evidence bundles per test
     * case exercise the per-test `evidence` provenance lookup, and
     * `usage`/`respondedModel` prove run-level accumulation.
     *
     * Hand-derivation (shipped `CLASSIFICATION_POLICY_V2`: `applicabilityMin`
     * 0.5 — unchanged from V1 — `sideMin` 0.65, `criticalMin` 0.5,
     * `levelCutPoints` [1, 2, 3] consulted only for the acceptable/strong
     * split; `confidence` is no longer read as a gate at all, only carried
     * through for transparency):
     *
     * "misleading case" — only `falsifiability` and `behavioral-focus` are
     * applicable (noul 0.9 each, above `applicabilityMin`); the other five
     * dimensions get noul 0.1 (`not-applicable`).
     *   - `falsifiability` probabilities `{0: 0.85, 1: 0.1, 2: 0.03, 3:
     *     0.02}` → `deficientMass = 0.85 + 0.1 = 0.95` (>= `sideMin` 0.65) →
     *     deficient; `criticalMass = 0.85` (>= `criticalMin` 0.5) →
     *     `misleading`.
     *   - `behavioral-focus` probabilities `{0: 0.01, 1: 0.01, 2: 0.08, 3:
     *     0.9}` → `acceptableMass = 0.08 + 0.9 = 0.98` (>= `sideMin`) →
     *     acceptable; score 3 → `levelForScore` gives `strong`, and the
     *     acceptable-side clamp keeps `strong` (already in `{acceptable,
     *     strong}`).
     *   - `classifyOverall`: judged dimensions are [`behavioral-focus`
     *     strong, `falsifiability` misleading]; `criticalLevel` is
     *     `misleading`, and one judged dimension is at that level, so the
     *     overall status is `misleading` BEFORE anything else is inspected —
     *     `behavioral-focus`'s `strong` never gets a chance to compensate
     *     (the non-compensatory rule holds identically under V2).
     *   - `isFindingWorthy`: only the judged `misleading` `falsifiability`
     *     dimension qualifies; `strong` and `not-applicable` dimensions
     *     never do. `findings` has exactly one entry, now also carrying
     *     `probabilities`/`deficientMass`/`acceptableMass`/`criticalMass`
     *     (task C-1's per-dimension audit trail).
     *   - Evidence bundle: 1 fragment, nothing else → `evidence: {fragments:
     *     1, truncatedFragments: 0, denied: 0, unresolved: 0, omitted: 0}`.
     *   - Usage fixed at `{inputTokens: 150, outputTokens: 2}`.
     *
     * "healthy case" — only `assertion-strength` (noul 0.8) and
     * `diagnostic-quality` (noul 0.95) are applicable; the other five get
     * noul 0.1.
     *   - `assertion-strength` probabilities `{0: 0.02, 1: 0.03, 2: 0.75, 3:
     *     0.2}` → `acceptableMass = 0.75 + 0.2 = 0.95` (>= `sideMin`) →
     *     acceptable; score 2 → `levelForScore` gives `acceptable` (`2 <
     *     levelCutPoints[2]` (3)), so the clamp reports `acceptable`, not
     *     `strong`.
     *   - `diagnostic-quality` probabilities `{0: 0.01, 1: 0.01, 2: 0.08, 3:
     *     0.9}` → `acceptableMass = 0.98`; score 3 → `strong` (same
     *     distribution and reasoning as `behavioral-focus` above).
     *   - `classifyOverall`: judged dimensions are [`assertion-strength`
     *     acceptable, `diagnostic-quality` strong] — no `misleading`, no
     *     `weak`, at least one applicable dimension, none `needs-review`,
     *     `modelMatchesPin` true → `healthy`.
     *   - `isFindingWorthy`: neither judged dimension is `misleading`/`weak`,
     *     so `findings: []`.
     *   - Evidence bundle: 2 fragments (1 truncated), 1 denied, 1 unresolved,
     *     1 omitted → `evidence: {fragments: 2, truncatedFragments: 1,
     *     denied: 1, unresolved: 1, omitted: 1}`.
     *   - Usage fixed at `{inputTokens: 90, outputTokens: 1}`.
     *
     * Run-level totals: `evaluated: 2`, `failed: 0`, `usage: {inputTokens:
     * 150 + 90 = 240, outputTokens: 2 + 1 = 3}`, `statusCounts: {healthy: 1,
     * misleading: 1, weak: 0, needs-review: 0}`, `respondedModel` taken from
     * the first entry in submission order ("misleading case", index 0) —
     * `jev-1.13.0`, matching the pin, so `modelMismatches: 0`.
     *
     * Every mass and level above was independently computed by hand (see
     * this task's writer report) AND cross-checked by running this exact
     * scenario through the real, compiled `classifyEvaluation` with
     * `CLASSIFICATION_POLICY_V2` before this literal was pinned — so the
     * literal below is a verified transcription of a real run, not
     * hand-typed guesswork or a value copied from the code without
     * independently checking it against the math above.
     */
    it(
      'prints a second literal golden JSON line for a realistic mixed evaluation: one test case driven to misleading by a '
      + 'not-canceled strong dimension (non-compensation) with a finding, one test case healthy, non-zero usage, and a responded model',
      async () => {
        const misleadingCaseId = 'tc:v1:misleading-case' as TestCaseId;
        const healthyCaseId = 'tc:v1:healthy-case' as TestCaseId;
        const mixedZeroSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };

        function noul(probability: number): JevAnswer {
          return { type: 'noul', probability, raw: { type: 'noul', noul: probability } };
        }
        /**
         * `probabilities` is now an explicit parameter (task C-1): the shipped
         * `CLASSIFICATION_POLICY_V2` decides deficient/acceptable from the
         * distribution, not from `score`/`confidence` alone, so a fixture that
         * wants a specific level under V2 must supply a distribution that
         * actually clears `sideMin` (0.65) on the intended side — a single
         * fixed distribution reused for every `value` (as this fixture did
         * under V1, since V1 never reads `probabilities`) would no longer
         * produce the intended levels.
         */
        function scoreAnswer(value: number, confidence: number, probabilities: Record<string, number>): JevAnswer {
          const legend = { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' };
          return { type: 'score', score: value, legend, probabilities, confidence, raw: { type: 'score', score: value, legend, probabilities, confidence } };
        }
        const NOT_APPLICABLE = noul(0.1);
        /** Never read (every dimension using this is `not-applicable`), so its distribution is arbitrary. */
        const IRRELEVANT_SCORE = scoreAnswer(0, 0.9, { '0': 0.1, '1': 0.1, '2': 0.3, '3': 0.5 });

        function mixedAnswersGateway(): JevGatewayPort {
          return {
            async evaluate(request: JevRequest): Promise<JevEvaluation> {
              const isMisleadingCase = request.state.testCaseId === misleadingCaseId;
              const answers: Record<string, JevAnswer> = {};
              for (const questionId of Object.keys(request.questions)) {
                const [dimensionId, questionKind] = questionId.split('.');
                if (isMisleadingCase) {
                  if (dimensionId === 'falsifiability') {
                    // deficientMass 0.95 (>= sideMin 0.65), criticalMass 0.85 (>= criticalMin 0.5) -> misleading.
                    answers[questionId] = questionKind === 'applicable' ? noul(0.9) : scoreAnswer(0, 0.9, { '0': 0.85, '1': 0.1, '2': 0.03, '3': 0.02 });
                  } else if (dimensionId === 'behavioral-focus') {
                    // acceptableMass 0.98 (>= sideMin), score 3 -> strong.
                    answers[questionId] = questionKind === 'applicable' ? noul(0.9) : scoreAnswer(3, 0.9, { '0': 0.01, '1': 0.01, '2': 0.08, '3': 0.9 });
                  } else {
                    answers[questionId] = questionKind === 'applicable' ? NOT_APPLICABLE : IRRELEVANT_SCORE;
                  }
                } else if (dimensionId === 'assertion-strength') {
                  // acceptableMass 0.95 (>= sideMin), score 2 -> acceptable (not strong: score < levelCutPoints[2]).
                  answers[questionId] = questionKind === 'applicable' ? noul(0.8) : scoreAnswer(2, 0.8, { '0': 0.02, '1': 0.03, '2': 0.75, '3': 0.2 });
                } else if (dimensionId === 'diagnostic-quality') {
                  // acceptableMass 0.98 (>= sideMin), score 3 -> strong.
                  answers[questionId] = questionKind === 'applicable' ? noul(0.95) : scoreAnswer(3, 0.95, { '0': 0.01, '1': 0.01, '2': 0.08, '3': 0.9 });
                } else {
                  answers[questionId] = questionKind === 'applicable' ? NOT_APPLICABLE : IRRELEVANT_SCORE;
                }
              }
              const usage = isMisleadingCase ? { inputTokens: 150, outputTokens: 2 } : { inputTokens: 90, outputTokens: 1 };
              return { requestedModel: request.model, respondedModel: request.model, modelMatchesPin: true, answers, usage, attempts: 1 };
            },
          };
        }

        function mixedTestCase(id: TestCaseId, name: string): TestCase {
          return {
            id,
            repositoryRelativePath: 'mixed.test.ts',
            kind: 'test',
            framework: 'vitest',
            name,
            structuralAncestry: [{ kind: 'test', name, ordinal: 0 }],
            source: `test('${name}', () => {});`,
            span: mixedZeroSpan,
            modifiers: [],
            hooks: [],
            imports: [],
            mocks: [],
            assertions: [],
            parameterization: { mode: 'none', cases: [] },
            diagnostics: [],
          };
        }

        function mixedEvidenceBundleFor(testCaseId: TestCaseId): EvidenceBundle {
          if (testCaseId === misleadingCaseId) {
            return buildEvidenceBundle({
              testCaseId,
              budget: DEFAULT_EVIDENCE_BUDGET,
              fragments: [{
                kind: 'test',
                repositoryRelativePath: 'mixed.test.ts',
                span: mixedZeroSpan,
                content: 'body',
                contentHash: 'a'.repeat(64),
                selectionReason: 'test-body',
                truncation: { truncated: false, originalBytes: 4, includedBytes: 4 },
              }],
              denied: [],
              unresolved: [],
              omitted: [],
            });
          }
          return buildEvidenceBundle({
            testCaseId,
            budget: DEFAULT_EVIDENCE_BUDGET,
            fragments: [
              {
                kind: 'test',
                repositoryRelativePath: 'mixed.test.ts',
                span: mixedZeroSpan,
                content: 'body2',
                contentHash: 'b'.repeat(64),
                selectionReason: 'test-body',
                truncation: { truncated: false, originalBytes: 5, includedBytes: 5 },
              },
              {
                kind: 'helper',
                repositoryRelativePath: 'helper.ts',
                span: mixedZeroSpan,
                content: 'helper',
                contentHash: 'c'.repeat(64),
                selectionReason: 'imported-binding-referenced',
                truncation: { truncated: true, originalBytes: 100, includedBytes: 6 },
              },
            ],
            denied: [{ repositoryRelativePath: 'secret.env', rule: 'deny-list:.env*' }],
            unresolved: [{ specifier: 'left-pad', reason: 'bare-specifier' }],
            omitted: [{ repositoryRelativePath: 'big.ts', reason: 'bundle-budget-exhausted' }],
          });
        }

        function mixedPorts(evaluation: AuditEvaluationPort): AuditPorts {
          return {
            discovery: {
              discover: async () => ({
                files: [{ repositoryRelativePath: 'mixed.test.ts', framework: 'vitest', frameworkEvidence: [] }],
                excluded: [],
                diagnostics: [],
              }),
            },
            sourceReader: { read: async () => 'source' },
            extractor: {
              extract: () => ({
                testCases: [mixedTestCase(misleadingCaseId, 'misleading case'), mixedTestCase(healthyCaseId, 'healthy case')],
                dynamicMetadata: [],
                diagnostics: [],
              }),
            },
            evidence: { build: async (request) => ({ bundles: request.testCases.map((tc) => mixedEvidenceBundleFor(tc.id)), diagnostics: [] }) },
            evaluation,
          };
        }

        const output = captureOutput();
        const evaluation = createJevEvaluationPort(mixedAnswersGateway());

        const exitCode = await runCli(['audit', '--rootDir', '/workspace', '--evaluate', '--json'], output.io, {
          audit: async (request) => runAudit(request, mixedPorts(evaluation)),
        });

        expect(exitCode).toBe(0);
        expect(output.lines).toHaveLength(1);
        expect(output.lines[0]).toBe(
          '{"reportVersion":1,"rootDir":"/workspace","reportingOnly":true,"complete":true,"versions":{"storeSchema":4,"rubric":2,"policy":2},'
          + '"modelRequested":"jev-1.13.0","discovery":{"files":[{"path":"mixed.test.ts","framework":"vitest","testCaseCount":2,"dynamicMetadataCount":0,'
          + '"evidenceBundleCount":2}],"excluded":[],"totals":{"files":1,"excluded":0,"testCases":2,"dynamicMetadata":0,"diagnostics":0,'
          + '"unsupportedFrameworkFiles":0,"evidenceBundles":2,"evidenceFragments":3,"evidenceTruncatedFragments":1,"evidenceOmitted":1,'
          + '"evidenceDenied":1,"evidenceUnresolved":1}},"totals":{"evaluated":2,"cached":0,"failed":0,"skipped":{"total":0,"byReason":{"skip":0,"todo":0,'
          + '"evidence-unavailable":0}},"usage":{"inputTokens":240,"outputTokens":3},"statusCounts":{"healthy":1,"weak":0,"misleading":1,'
          + '"needs-review":0},"respondedModel":"jev-1.13.0","modelMismatches":0},"latency":{"measuredTestCases":0},'
          + '"cacheStatus":[{"testCaseId":"tc:v1:misleading-case","repositoryRelativePath":"mixed.test.ts","name":"misleading case","status":"fresh"},'
          + '{"testCaseId":"tc:v1:healthy-case","repositoryRelativePath":"mixed.test.ts","name":"healthy case","status":"fresh"}],'
          + '"classifications":[{"testCaseId":"tc:v1:misleading-case","repositoryRelativePath":"mixed.test.ts","name":"misleading case",'
          + '"status":"misleading","dimensions":[{"dimensionId":"assertion-strength","dimensionLabel":"Assertion strength","applicable":false,'
          + '"applicabilityProbability":0.1,"status":"not-applicable"},{"dimensionId":"behavioral-focus","dimensionLabel":"Behavioral focus",'
          + '"applicable":true,"applicabilityProbability":0.9,"level":"strong","score":3,"confidence":0.9,"status":"judged","probabilities":{"0":0.01,'
          + '"1":0.01,"2":0.08,"3":0.9},"deficientMass":0.02,"acceptableMass":0.98,"criticalMass":0.01},{"dimensionId":"determinism-isolation",'
          + '"dimensionLabel":"Determinism and isolation","applicable":false,"applicabilityProbability":0.1,"status":"not-applicable"},'
          + '{"dimensionId":"diagnostic-quality","dimensionLabel":"Diagnostic quality","applicable":false,"applicabilityProbability":0.1,'
          + '"status":"not-applicable"},{"dimensionId":"falsifiability","dimensionLabel":"Falsifiability","applicable":true,'
          + '"applicabilityProbability":0.9,"level":"misleading","score":0,"confidence":0.9,"status":"judged","probabilities":{"0":0.85,"1":0.1,"2":0.03,'
          + '"3":0.02},"deficientMass":0.95,"acceptableMass":0.05,"criticalMass":0.85},{"dimensionId":"refactor-resistance",'
          + '"dimensionLabel":"Refactor resistance","applicable":false,"applicabilityProbability":0.1,"status":"not-applicable"},'
          + '{"dimensionId":"test-double-quality","dimensionLabel":"Test-double quality","applicable":false,"applicabilityProbability":0.1,'
          + '"status":"not-applicable"}],"findings":[{"testCaseId":"tc:v1:misleading-case","repositoryRelativePath":"mixed.test.ts",'
          + '"name":"misleading case","dimensionId":"falsifiability","dimensionLabel":"Falsifiability","level":"misleading","score":0,"confidence":0.9,'
          + '"applicabilityProbability":0.9,"status":"judged","probabilities":{"0":0.85,"1":0.1,"2":0.03,"3":0.02},"deficientMass":0.95,'
          + '"acceptableMass":0.05,"criticalMass":0.85}],"policyVersion":2,"rubricVersion":2,"model":{"requested":"jev-1.13.0","responded":"jev-1.13.0",'
          + '"matchesPin":true},"usage":{"inputTokens":150,"outputTokens":2},"cache":"fresh","evidence":{"fragments":1,"truncatedFragments":0,"denied":[],'
          + '"unresolved":[],"omitted":[]}},{"testCaseId":"tc:v1:healthy-case","repositoryRelativePath":"mixed.test.ts","name":"healthy case",'
          + '"status":"healthy","dimensions":[{"dimensionId":"assertion-strength","dimensionLabel":"Assertion strength","applicable":true,'
          + '"applicabilityProbability":0.8,"level":"acceptable","score":2,"confidence":0.8,"status":"judged","probabilities":{"0":0.02,"1":0.03,"2":0.75,'
          + '"3":0.2},"deficientMass":0.05,"acceptableMass":0.95,"criticalMass":0.02},{"dimensionId":"behavioral-focus",'
          + '"dimensionLabel":"Behavioral focus","applicable":false,"applicabilityProbability":0.1,"status":"not-applicable"},'
          + '{"dimensionId":"determinism-isolation","dimensionLabel":"Determinism and isolation","applicable":false,"applicabilityProbability":0.1,'
          + '"status":"not-applicable"},{"dimensionId":"diagnostic-quality","dimensionLabel":"Diagnostic quality","applicable":true,'
          + '"applicabilityProbability":0.95,"level":"strong","score":3,"confidence":0.95,"status":"judged","probabilities":{"0":0.01,"1":0.01,"2":0.08,'
          + '"3":0.9},"deficientMass":0.02,"acceptableMass":0.98,"criticalMass":0.01},{"dimensionId":"falsifiability","dimensionLabel":"Falsifiability",'
          + '"applicable":false,"applicabilityProbability":0.1,"status":"not-applicable"},{"dimensionId":"refactor-resistance",'
          + '"dimensionLabel":"Refactor resistance","applicable":false,"applicabilityProbability":0.1,"status":"not-applicable"},'
          + '{"dimensionId":"test-double-quality","dimensionLabel":"Test-double quality","applicable":false,"applicabilityProbability":0.1,'
          + '"status":"not-applicable"}],"findings":[],"policyVersion":2,"rubricVersion":2,"model":{"requested":"jev-1.13.0","responded":"jev-1.13.0",'
          + '"matchesPin":true},"usage":{"inputTokens":90,"outputTokens":1},"cache":"fresh","evidence":{"fragments":2,"truncatedFragments":1,'
          + '"denied":[{"repositoryRelativePath":"secret.env","rule":"deny-list:.env*"}],"unresolved":[{"specifier":"left-pad",'
          + '"reason":"bare-specifier"}],"omitted":[{"repositoryRelativePath":"big.ts","reason":"bundle-budget-exhausted"}]}}],"diagnostics":[]}'
        );
      },
    );

    it(
      'threads a measured latency end to end through the real gateway, runEvaluation, and the canonical report — a distinct '
      + 'latencyMs/attemptLatenciesMs pair that could never be confused with this fixture\'s own usage tokens or attempt count',
      async () => {
        const output = captureOutput();
        // Deliberately non-symmetric and distinct from every other number in this fixture (usage
        // tokens 100/0, attempts 1): Phase 6 Warning — latency next to token counts is exactly the
        // adjacency that already produced one defect in this project.
        const measuredLatencyMs = 6789;
        const measuredAttemptLatenciesMs = [6789];
        const gatewayWithLatency: JevGatewayPort = {
          async evaluate(request: JevRequest): Promise<JevEvaluation> {
            const answers: Record<string, JevAnswer> = {};
            for (const questionId of Object.keys(request.questions)) {
              answers[questionId] = { type: 'noul', probability: 0.1, raw: { type: 'noul', noul: 0.1 } };
            }
            return {
              requestedModel: request.model,
              respondedModel: request.model,
              modelMatchesPin: true,
              answers,
              usage: { inputTokens: 100, outputTokens: 0 },
              attempts: 1,
              latencyMs: measuredLatencyMs,
              attemptLatenciesMs: measuredAttemptLatenciesMs,
            };
          },
        };
        const evaluation = createJevEvaluationPort(gatewayWithLatency);

        const exitCode = await runCli(['audit', '--rootDir', '/workspace', '--evaluate', '--json'], output.io, {
          audit: async (request) => runAudit(request, realPorts(evaluation)),
        });

        expect(exitCode).toBe(0);
        expect(output.lines).toHaveLength(1);
        const parsed = JSON.parse(output.lines[0] ?? '') as {
          readonly latency: { readonly measuredTestCases: number; readonly totalMs: number; readonly meanMs: number; readonly minMs: number; readonly maxMs: number };
          readonly classifications: readonly { readonly cache: string; readonly latency?: { readonly latencyMs: number; readonly attemptLatenciesMs: readonly number[] } }[];
        };

        expect(parsed.latency).toEqual({ measuredTestCases: 1, totalMs: measuredLatencyMs, meanMs: measuredLatencyMs, minMs: measuredLatencyMs, maxMs: measuredLatencyMs });
        expect(parsed.classifications[0]?.cache).toBe('fresh');
        expect(parsed.classifications[0]?.latency).toEqual({ latencyMs: measuredLatencyMs, attemptLatenciesMs: measuredAttemptLatenciesMs });
      },
    );

    it(
      'an incomplete run (discovery failed before evaluation ever started, through the real runAudit pipeline — not just a '
      + 'hand-built AuditResult) still exits 0 and is marked complete: false in the canonical report, never silently presented as finished',
      async () => {
        const output = captureOutput();
        const evaluation = createJevEvaluationPort(fixedAnswersGateway());
        const throwingDiscoveryPorts: AuditPorts = {
          ...realPorts(evaluation),
          discovery: { discover: async () => { throw new Error('EACCES: permission denied'); } },
        };

        const exitCode = await runCli(['audit', '--rootDir', '/workspace', '--evaluate', '--json'], output.io, {
          audit: async (request) => runAudit(request, throwingDiscoveryPorts),
        });

        // The hard constraint this task must not break: no infrastructure failure changes the exit
        // status — reporting-only stays reporting-only even for a run that never got off the ground.
        expect(exitCode).toBe(0);
        expect(output.lines).toHaveLength(1);
        const parsed = JSON.parse(output.lines[0] ?? '') as { readonly complete: boolean; readonly incompleteReason: string; readonly classifications: readonly unknown[] };
        expect(parsed.complete).toBe(false);
        expect(parsed.incompleteReason).toContain('discovery failed before evaluation could run');
        expect(parsed.incompleteReason).toContain('EACCES');
        expect(parsed.classifications).toEqual([]);
      },
    );

    it('never leaks the API key into an evaluation-failed diagnostic when the real gateway redacts a server-echoed key (mutation probe: leaking the key)', async () => {
      const fakeKey = 'sk-typesafe-should-never-appear-in-any-report';
      const echoingFetch = vi.fn(async () => new Response(
        JSON.stringify({ error: { field: 'model', message: `rejected for Authorization: Bearer ${fakeKey}` } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ));
      const { createJevHttpGateway } = await import('../src/adapters/jev-http-gateway.js');
      const gateway = createJevHttpGateway({ apiKey: fakeKey, fetch: echoingFetch as unknown as typeof fetch });
      const evaluation = createJevEvaluationPort(gateway);
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--evaluate', '--json'], output.io, {
        audit: async (request) => runAudit(request, realPorts(evaluation)),
      });

      expect(exitCode).toBe(0);
      expect(output.lines[0]).not.toContain(fakeKey);
      const parsed = JSON.parse(output.lines[0] ?? '') as { totals: { failed: number }; diagnostics: readonly { message: string }[] };
      expect(parsed.totals.failed).toBe(1);
      expect(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes('request'))).toBe(true);
      expect(parsed.diagnostics.every((diagnostic) => !diagnostic.message.includes(fakeKey))).toBe(true);
    });
  });

  describe('--evaluate (human-readable text)', () => {
    it('prints a terminal summary with status counts, skipped/failed, usage tokens, model, and a visible diagnostics block (never hiding a failure behind a bare count)', async () => {
      const output = captureOutput();
      const audit: AuditResult = {
        rootDir: '/workspace',
        files: [],
        excluded: [],
        diagnostics: [{
          code: 'evaluation-failed',
          message: 'Unable to evaluate test case tc:v1:x ("does x"): rate-limit: Jev rate limit exceeded (429) after 4 attempt(s).',
          severity: 'error',
          repositoryRelativePath: 'x.test.ts',
        }],
        totals: { files: 1, excluded: 0, testCases: 1, dynamicMetadata: 0, diagnostics: 1, ...zeroEvidenceTotals },
        reportingOnly: true,
        evaluation: {
          classifications: [],
          totals: {
            evaluated: 0,
            cached: 0,
            failed: 1,
            skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
            usage: { inputTokens: 0, outputTokens: 0 },
            statusCounts: { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 },
            respondedModel: undefined,
            modelMismatches: 0,
          },
          cacheStatusByTestCaseId: new Map(),
          latencyByTestCaseId: new Map(),
        },
      };

      const exitCode = await runCli(['audit', '--evaluate'], output.io, { audit: async () => audit });

      expect(exitCode).toBe(0);
      expect(output.lines).toHaveLength(1);
      const report = output.lines[0] ?? '';
      expect(report).toContain('jev-1.13.0');
      expect(report).toContain('(none — no evaluation succeeded)');
      expect(report).toContain('Evaluated: 0');
      expect(report).toContain('Failed: 1');
      expect(report).toContain('Diagnostics:');
      expect(report).toContain('evaluation-failed');
      expect(report).toContain('tc:v1:x');
    });

    it('reports "Diagnostics: none" and zeroed totals when nothing failed and nothing was evaluated', async () => {
      const output = captureOutput();
      const audit: AuditResult = {
        rootDir: '.',
        files: [],
        excluded: [],
        diagnostics: [],
        totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
        reportingOnly: true,
      };

      const exitCode = await runCli(['audit', '--evaluate'], output.io, { audit: async () => audit });

      expect(exitCode).toBe(0);
      const report = output.lines[0] ?? '';
      expect(report).toContain('Diagnostics: none');
      expect(report).toContain('Evaluated: 0');
      expect(report).toContain('Failed: 0');
    });
  });
});

/**
 * SQLite audit store wiring (Phase 5, task P5-1): the store is constructed
 * lazily, exactly like the evaluation port — only when `--evaluate` was
 * requested — and defaults to a file under the per-user config home this
 * file's `useIsolatedConfigHome()` already sandboxes away from the real
 * `~/.config`/`%APPDATA%`.
 */
describe('SQLite audit store (Phase 5, task P5-1)', () => {
  useIsolatedConfigHome();

  const mathFixtureFiles = {
    'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
  };

  function fakeEvaluationPort(): AuditEvaluationPort {
    return {
      async evaluate(request) {
        return {
          evaluation: {
            requestedModel: 'jev-1.13.0',
            respondedModel: 'jev-1.13.0',
            modelMatchesPin: true,
            answers: {},
            usage: { inputTokens: 10, outputTokens: 1 },
            attempts: 1,
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

  it('creates no database file for a plain audit (no --evaluate)', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root], output.io);

    expect(exitCode).toBe(0);
    const storePaths = resolveAuditStorePaths();
    await expect(access(storePaths.databaseFile)).rejects.toThrow();
  });

  it('creates no database file when --evaluate exits early on a missing API key', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--evaluate'], output.io);

    expect(exitCode).toBe(1);
    const storePaths = resolveAuditStorePaths();
    await expect(access(storePaths.databaseFile)).rejects.toThrow();
  });

  it('opens the SQLite store under the per-user config home when --evaluate is used, and persists the run', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate'], output.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
    });

    expect(exitCode).toBe(0);
    const storePaths = resolveAuditStorePaths();
    await expect(access(storePaths.databaseFile)).resolves.toBeUndefined();
  });

  it('a createStorePort test seam overrides store construction, records the run, and is closed once the audit completes', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();
    let workItems = 0;
    let closed = false;
    const fakeStore: AuditStorePort = {
      beginRun: async () => 'fake-run-1',
      canonicalizeRootDir: async (rootDir) => rootDir,
      recordWorkItem: async () => { workItems += 1; },
      lookup: async () => undefined,
      finishRun: async () => undefined,
      loadRunState: async () => undefined,
      close: async () => { closed = true; },
    };

    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate'], output.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
      createStorePort: () => fakeStore,
    });

    expect(exitCode).toBe(0);
    // pending + running + completed (Phase 5, task P5-3) for the fixture's one evaluable test case.
    expect(workItems).toBe(3);
    expect(closed).toBe(true);
    // The production store was never constructed, so no real database file exists.
    const storePaths = resolveAuditStorePaths();
    await expect(access(storePaths.databaseFile)).rejects.toThrow();
  });

  // P5-1 verifier finding C: `storePort = await buildStorePort()` sat outside the evaluation
  // port's own try/catch, so a store construction failure (e.g. a schema-incompatible database)
  // crashed the CLI with a raw unhandled stack trace instead of following the CLI's own
  // established convention — a named, readable message and exit code 1, no stack trace — that
  // the evaluation port build directly above it already follows.
  it('reports a named, readable error and exits 1 — no stack trace — when store construction fails', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate'], output.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
      createStorePort: () => { throw new AuditStoreSchemaVersionError(999, 1); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).toContain('999');
  });

  it('the API key never reaches the database file, exercised end-to-end through the real key resolution, gateway, and store construction', async () => {
    const root = await fixture(mathFixtureFiles);
    const canaryKey = 'sk-store-key-never-persisted-canary';
    const savedKey = process.env['TYPESAFE_API_KEY'];
    const originalFetch = globalThis.fetch;
    process.env['TYPESAFE_API_KEY'] = canaryKey;
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 },
    }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate'], output.io);

      expect(exitCode).toBe(0);
      expect(fetchSpy).toHaveBeenCalled();
      const [, requestInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      const headers = requestInit.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${canaryKey}`);

      const storePaths = resolveAuditStorePaths();
      const raw = await readFile(storePaths.databaseFile);
      const rawText = raw.toString('latin1');
      // Prove the scan is not vacuous before trusting it. Since P5-3 the store runs in WAL mode,
      // so a committed row lives in the `-wal` sidecar until the last connection closes and
      // checkpoints it into this file. `runCli` does close the store, which is exactly why this
      // assertion holds — but if that ever stops happening, the key scan below would pass against
      // a nearly empty file and prove nothing. This makes that failure visible instead of silent.
      expect(rawText).toContain('work_items');
      expect(rawText).not.toContain(canaryKey);
      // Any sidecar that survived (an uncheckpointed WAL, or its shared-memory index) is part of
      // the on-disk store too, so it is held to the same guarantee rather than left unscanned.
      for (const sidecar of [`${storePaths.databaseFile}-wal`, `${storePaths.databaseFile}-shm`]) {
        if (!existsSync(sidecar)) continue;
        expect((await readFile(sidecar)).toString('latin1')).not.toContain(canaryKey);
      }
      expect(output.lines.join('\n')).not.toContain(canaryKey);
    } finally {
      if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY']; else process.env['TYPESAFE_API_KEY'] = savedKey;
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Content-addressed caching wiring end-to-end through the real `runCli` pipeline (Phase 5, task
 * P5-2): the real `createAuditCacheKeyPort()` (not overridable — it has no I/O to fake) computes
 * an actual key from the real `math.test.ts` fixture below, and only the store is faked, so this
 * exercises the genuine wiring in `createProductionPorts`/`runCli`, not a stand-in for it.
 */
describe('content-addressed caching wiring (Phase 5, task P5-2)', () => {
  useIsolatedConfigHome();

  const mathFixtureFiles = {
    'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
  };

  function trackedEvaluationPort(onEvaluate: () => void): AuditEvaluationPort {
    return {
      async evaluate(request) {
        onEvaluate();
        return {
          evaluation: {
            requestedModel: 'jev-1.13.0',
            respondedModel: 'jev-1.13.0',
            modelMatchesPin: true,
            answers: {},
            usage: { inputTokens: 10, outputTokens: 1 },
            attempts: 1,
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

  /**
   * A stateful in-memory store, persisted ACROSS `runCli` calls by returning the same instance
   * from `createStorePort` every time — simulating what a real on-disk SQLite file would do
   * between two separate CLI invocations against the same root. Tracks each `recordWorkItem` call
   * alongside its owning `runId` (Phase 5, task P5-4) so `loadRunState` can answer per-run, exactly
   * like the real adapter's `MAX(id)`-grouped query: the LAST recorded outcome per identity within
   * that one run, filtered down to the four terminal states.
   */
  function statefulStore(): AuditStorePort {
    const workItemCalls: { readonly runId: string; readonly outcome: AuditStoreWorkItemOutcome }[] = [];
    const rootDirByRunId = new Map<string, string>();
    const finishedRunIds = new Set<string>();
    let runCount = 0;
    return {
      beginRun: async (rootDir) => {
        runCount += 1;
        const runId = `run-${runCount}`;
        rootDirByRunId.set(runId, rootDir);
        return runId;
      },
      // Identity pass-through: this fake's rootDir-identity behavior is not under test here — see
      // `test/resume-root-dir-identity.test.ts` for the real-adapter, real-filesystem coverage.
      canonicalizeRootDir: async (rootDir) => rootDir,
      recordWorkItem: async (runId, outcome) => { workItemCalls.push({ runId, outcome }); },
      lookup: async (cacheKey) => {
        for (let index = workItemCalls.length - 1; index >= 0; index -= 1) {
          const { outcome } = workItemCalls[index]!;
          if (outcome.state === 'completed' && outcome.cacheKey === cacheKey && outcome.evaluation.modelMatchesPin) {
            return { classification: outcome.classification };
          }
        }
        return undefined;
      },
      finishRun: async (runId) => { finishedRunIds.add(runId); },
      loadRunState: async (runId) => {
        const rootDir = rootDirByRunId.get(runId);
        if (rootDir === undefined) return undefined;
        const lastByIdentity = new Map<string, AuditStoreWorkItemOutcome>();
        for (const call of workItemCalls) {
          if (call.runId !== runId) continue;
          lastByIdentity.set(
            JSON.stringify([call.outcome.identity.testCaseId, call.outcome.identity.repositoryRelativePath, call.outcome.identity.name]),
            call.outcome,
          );
        }
        const terminalWorkItems = [...lastByIdentity.values()].filter(
          (outcome) => outcome.state === 'completed' || outcome.state === 'cached' || outcome.state === 'failed' || outcome.state === 'skipped',
        );
        return { rootDir, rootDirCanonical: true, finished: finishedRunIds.has(runId), terminalWorkItems };
      },
      close: async () => undefined,
    };
  }

  it('the second --evaluate run against an unchanged repository issues no provider request, and --fresh on a third run bypasses that reuse', async () => {
    const root = await fixture(mathFixtureFiles);
    let evaluateCalls = 0;
    const store = statefulStore();

    const first = await runCli(['audit', '--rootDir', root, '--evaluate'], captureOutput().io, {
      createEvaluationPort: () => trackedEvaluationPort(() => { evaluateCalls += 1; }),
      createStorePort: () => store,
    });
    expect(first).toBe(0);
    expect(evaluateCalls).toBe(1);

    const second = await runCli(['audit', '--rootDir', root, '--evaluate'], captureOutput().io, {
      createEvaluationPort: () => trackedEvaluationPort(() => { evaluateCalls += 1; }),
      createStorePort: () => store,
    });
    expect(second).toBe(0);
    expect(evaluateCalls).toBe(1); // reused from the warm cache — no new request

    const third = await runCli(['audit', '--rootDir', root, '--evaluate', '--fresh'], captureOutput().io, {
      createEvaluationPort: () => trackedEvaluationPort(() => { evaluateCalls += 1; }),
      createStorePort: () => store,
    });
    expect(third).toBe(0);
    expect(evaluateCalls).toBe(2); // --fresh bypassed the warm cache
  });
});

/**
 * `--resume <runId>` wiring end-to-end (Phase 5, task P5-4), through the real `runCli` pipeline
 * and, for the central test, the REAL `node:sqlite` adapter — not a store fake — so this exercises
 * genuine persistence and reopening, not a stand-in for it.
 */
describe('resume wiring (Phase 5, task P5-4)', () => {
  useIsolatedConfigHome();

  const twoTestFixtureFiles = {
    'math.test.ts': "import { expect, test } from 'vitest';\n"
      + "test('adds', () => { expect(1 + 1).toBe(2); });\n"
      + "test('subtracts', () => { expect(2 - 1).toBe(1); });\n",
  };

  /**
   * A deterministic evaluation port: every test case's classification is derived purely from its
   * own name (never from call count or ordering), so a baseline run and a later interrupted+resumed
   * run over the SAME fixture produce byte-identical classifications regardless of which physical
   * dispatch computed them — required for this suite's byte-for-byte report comparison.
   * `hangFor`, when given, makes that ONE test case's `evaluate()` call never resolve at all (no
   * timer, no rejection) — the closest a unit test can get to a literal SIGKILL: the provider
   * request is genuinely in flight and its answer is never received, exactly like P5-3's own
   * measured SIGKILL evidence, as opposed to a caught, terminal `failed` outcome a mere rejection
   * would produce (impossible to leave `running` for `--resume` to find — see this task's own
   * report on why a rejecting gateway can never simulate an interruption under P5-3's per-item
   * failure isolation).
   */
  function deterministicEvaluationPort(hangFor?: string, onCall?: (name: string) => void): AuditEvaluationPort {
    return {
      async evaluate(request) {
        onCall?.(request.testCase.name);
        if (request.testCase.name === hangFor) return new Promise<never>(() => {});
        const tokens = request.testCase.name.length * 10;
        return {
          evaluation: {
            requestedModel: 'jev-1.13.0',
            respondedModel: 'jev-1.13.0',
            modelMatchesPin: true,
            answers: {},
            usage: { inputTokens: tokens, outputTokens: 1 },
            attempts: 1,
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
            usage: { inputTokens: tokens, outputTokens: 1 },
          },
        };
      },
    };
  }

  async function tempDbFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'jev-resume-store-'));
    temporaryRoots.push(dir);
    return join(dir, 'audit-store.sqlite3');
  }

  /** Wraps a real store so the test can learn the `runId` `beginRun` mints, without changing the store's own behavior. */
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

  async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 10): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error('waitUntil: condition never became true');
      await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
  }

  it(
    'an in-flight request that never resolves (the closest a unit test gets to a literal SIGKILL) leaves the completed item '
    + 'committed; --resume dispatches only the outstanding item, never re-dispatches the completed one, and produces the same '
    + 'evaluation report an uninterrupted run over the same fixture would',
    async () => {
      const root = await fixture(twoTestFixtureFiles);

      // Baseline: a completely separate database AND a completely separate root (same fixture
      // content, its own fresh temp directory — feature "persisted-run-reports", task T1: a real
      // `--evaluate` run now persists its own canonical report to `<rootDir>/.jta/`, so reusing
      // `root` here would make the baseline run's own discovery see the interrupted/resumed pair's
      // `.jta/` directory as an extra excluded entry, or vice versa — never touched by the
      // interrupted/resumed pair below, so neither a warm cache nor a stray `.jta/` from an earlier
      // run can make the final comparison vacuous.
      const baselineRoot = await fixture(twoTestFixtureFiles);
      const baselineDb = await tempDbFile();
      const baselineOutput = captureOutput();
      const baselineExit = await runCli(['audit', '--rootDir', baselineRoot, '--evaluate', '--json'], baselineOutput.io, {
        createEvaluationPort: () => deterministicEvaluationPort(),
        createStorePort: () => createSqliteAuditStore({ databaseFile: baselineDb }),
      });
      expect(baselineExit).toBe(0);
      const baselineReport = JSON.parse(baselineOutput.lines[0]!) as Record<string, unknown>;

      // Interrupted attempt: 'adds' completes and commits for real; 'subtracts' is called (its
      // `running` checkpoint is written BEFORE `evaluate()` is ever invoked — see
      // `src/application/audit.ts`'s `runEvaluation`) and then hangs forever. `runCli`'s own
      // returned promise therefore never settles — it is deliberately never awaited.
      const interruptedDb = await tempDbFile();
      let capturedRunId: string | undefined;
      const subtractsCalled = { resolve: (): void => {} };
      const subtractsCalledPromise = new Promise<void>((resolve) => { subtractsCalled.resolve = resolve; });
      const interruptedStore = capturingRunId(
        await createSqliteAuditStore({ databaseFile: interruptedDb }),
        (runId) => { capturedRunId = runId; },
      );
      const interruptedEvaluation = deterministicEvaluationPort('subtracts', (name) => {
        if (name === 'subtracts') subtractsCalled.resolve();
      });
      // Deliberately not awaited — this call never resolves.
      void runCli(['audit', '--rootDir', root, '--evaluate'], captureOutput().io, {
        createEvaluationPort: () => interruptedEvaluation,
        createStorePort: () => interruptedStore,
      });

      await subtractsCalledPromise;
      if (capturedRunId === undefined) throw new Error('expected a captured run id');
      const runId = capturedRunId;
      // Poll until 'adds' has genuinely committed as `completed` — a handful of async store writes
      // happen between 'subtracts' being called and 'adds' settling; this waits for the real thing
      // rather than assuming a fixed delay.
      await waitUntil(async () => {
        const state = await interruptedStore.loadRunState(runId);
        return state !== undefined && state.terminalWorkItems.length === 1;
      });
      const interruptedState = await interruptedStore.loadRunState(runId);
      expect(interruptedState?.finished).toBe(false);
      expect(interruptedState?.terminalWorkItems.map((item) => item.identity.name)).toEqual(['adds']);
      // Close this connection cleanly before reopening it for the resume — exactly like a real
      // process restart against the same on-disk file (P5-3's own measured SIGKILL/reopen evidence).
      await interruptedStore.close();

      const dispatchedOnResume: string[] = [];
      const resumeOutput = captureOutput();
      const resumeExit = await runCli(['audit', '--rootDir', root, '--evaluate', '--json', '--resume', runId], resumeOutput.io, {
        createEvaluationPort: () => deterministicEvaluationPort(undefined, (name) => { dispatchedOnResume.push(name); }),
        createStorePort: () => createSqliteAuditStore({ databaseFile: interruptedDb }),
      });

      expect(resumeExit).toBe(0);
      // Only the outstanding item is ever dispatched — 'adds' is reused, never redispatched.
      expect(dispatchedOnResume).toEqual(['subtracts']);

      const resumedReport = JSON.parse(resumeOutput.lines[0]!) as Record<string, unknown>;
      expect(resumedReport['resume']).toEqual({ runId, outstanding: 1, reused: 1 });
      // Phase 6, task P6-2b: the resumed report's own top-level runId agrees with the id it was
      // asked to resume — the same identity `resume.runId` above already names.
      expect(resumedReport['runId']).toBe(runId);
      // The baseline run persisted to a SEPARATE database (`baselineDb`), so it minted its own,
      // genuinely different, run id — that the two differ is correct, not a bug, so both are
      // excluded from the byte-for-byte comparison below only after being verified individually.
      expect(typeof baselineReport['runId']).toBe('string');
      expect(baselineReport['runId']).not.toBe(runId);
      // Same final report as an uninterrupted run over the same fixture — everything except the
      // resume-specific metadata this task deliberately adds, each run's own distinct persisted
      // identity, and each run's own distinct temp root path, matches byte-for-byte (compared as
      // parsed objects here to isolate those intentional, documented differences).
      delete resumedReport['resume'];
      delete resumedReport['runId'];
      delete resumedReport['rootDir'];
      delete baselineReport['runId'];
      delete baselineReport['rootDir'];
      expect(resumedReport).toEqual(baselineReport);
    },
  );

  it('rejects with a named message and exit code 1 when --resume is combined with a different --rootDir than the run was recorded against', async () => {
    const rootA = await fixture(twoTestFixtureFiles);
    const rootB = await fixture(twoTestFixtureFiles);
    const db = await tempDbFile();
    let runId: string | undefined;
    const store = capturingRunId(await createSqliteAuditStore({ databaseFile: db }), (id) => { runId = id; });

    const first = await runCli(['audit', '--rootDir', rootA, '--evaluate'], captureOutput().io, {
      createEvaluationPort: () => deterministicEvaluationPort(),
      createStorePort: () => store,
    });
    expect(first).toBe(0);
    if (runId === undefined) throw new Error('expected a captured run id');

    const output = captureOutput();
    const exitCode = await runCli(['audit', '--rootDir', rootB, '--evaluate', '--resume', runId], output.io, {
      createEvaluationPort: () => deterministicEvaluationPort(),
      createStorePort: () => createSqliteAuditStore({ databaseFile: db }),
    });

    expect(exitCode).toBe(1);
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).toContain(runId);
    // The recorded side is now the CANONICAL (realpath'd) form of rootA — this fixture's own
    // `mkdtemp` result is not itself realpath'd (this dev machine's own macOS `/var` ->
    // `/private/var` layout would otherwise make a raw substring check pass by coincidence, not
    // by a robust guarantee), so compare against the same canonical form the store actually
    // persisted. The requested side stays the exact, raw string the caller typed (rootB) — see
    // `AuditResumeRootDirMismatchError`'s own doc for why the message shows what was typed, not a
    // re-derived form of it. Position-sensitive (`recorded against root "X", not "Y"`), not just
    // substring presence, so a mixed-up argument order is caught, not just a missing value.
    expect(output.lines[0]).toBe(
      `--resume ${runId}: this run was recorded against root "${await realpath(rootA)}", not "${rootB}" being audited now.`,
    );
  });

  it('a run id that was never started is a named usage error, exit code 1, no stack trace', async () => {
    const root = await fixture(twoTestFixtureFiles);
    const db = await tempDbFile();
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--resume', 'never-started-run'], output.io, {
      createEvaluationPort: () => deterministicEvaluationPort(),
      createStorePort: () => createSqliteAuditStore({ databaseFile: db }),
    });

    expect(exitCode).toBe(1);
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).toContain('never-started-run');
  });

  it('an already-finished run reports honestly that there is nothing to resume — not an error, exit code 0 — and dispatches nothing', async () => {
    const root = await fixture(twoTestFixtureFiles);
    const db = await tempDbFile();
    let runId: string | undefined;
    const store = capturingRunId(await createSqliteAuditStore({ databaseFile: db }), (id) => { runId = id; });

    const first = await runCli(['audit', '--rootDir', root, '--evaluate'], captureOutput().io, {
      createEvaluationPort: () => deterministicEvaluationPort(),
      createStorePort: () => store,
    });
    expect(first).toBe(0);
    if (runId === undefined) throw new Error('expected a captured run id');

    const dispatched: string[] = [];
    const output = captureOutput();
    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--resume', runId], output.io, {
      createEvaluationPort: () => deterministicEvaluationPort(undefined, (name) => { dispatched.push(name); }),
      createStorePort: () => createSqliteAuditStore({ databaseFile: db }),
    });

    expect(exitCode).toBe(0);
    expect(dispatched).toEqual([]);
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).toContain('Nothing to resume');
    expect(output.lines[0]).toContain(runId);
  });

  it('--resume is rejected without --evaluate', async () => {
    const root = await fixture(twoTestFixtureFiles);
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root, '--resume', 'whatever-run'], output.io);

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--resume requires --evaluate');
  });

  it('--resume with no following value is a usage error naming the missing argument', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--evaluate', '--resume'], output.io);

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--resume requires a run id');
  });
});

/**
 * Cache-aware `audit --dry-run` (Phase 5, task P5-5): consults an EXISTING audit store read-only
 * to report cache hits and a reduced billable count, but must never create, migrate, or write to
 * one. No `createStorePort`/dry-run test seam exists for this path on purpose (a dry run has no
 * writable store to hand one) — every test here uses the real default per-user store path (no
 * `--rootDir`-style override reaches `store.databasePath`, matching this phase's own documented
 * gap), which `useIsolatedConfigHome()` sandboxes per test; two separate `runCli` invocations in
 * one test therefore share the same on-disk file exactly like two real terminal commands would.
 */
describe('cache-aware --dry-run (Phase 5, task P5-5)', () => {
  useIsolatedConfigHome();

  const twoTestFixtureFiles = {
    'a.test.ts': "import { expect, test } from 'vitest';\n"
      + "test('adds', () => { expect(1 + 1).toBe(2); });\n"
      + "test('subtracts', () => { expect(2 - 1).toBe(1); });\n",
  };

  function deterministicEvaluationPort(onCall?: (name: string) => void): AuditEvaluationPort {
    return {
      async evaluate(request) {
        onCall?.(request.testCase.name);
        const tokens = request.testCase.name.length * 100;
        return {
          evaluation: {
            requestedModel: 'jev-1.13.0',
            respondedModel: 'jev-1.13.0',
            modelMatchesPin: true,
            answers: {},
            usage: { inputTokens: tokens, outputTokens: 1 },
            attempts: 1,
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
            usage: { inputTokens: tokens, outputTokens: 1 },
          },
        };
      },
    };
  }

  it(
    // A `process.emitWarning` spy is deliberately NOT used here to "prove" no ExperimentalWarning
    // fires: this file's own top-level `import { DatabaseSync } from 'node:sqlite'` (used by the
    // schema-999 test below) already loads `node:sqlite` — and Node emits that exact warning once
    // per process — before any test in this file runs at all, and `withSqliteExperimentalWarningSuppressed`
    // swaps `process.emitWarning` out during its own import besides. A spy installed inside a test
    // body would therefore stay green even if `openSqliteAuditStoreForLookup` loaded `node:sqlite`
    // unconditionally (verified: temporarily forcing that load left this exact assertion passing).
    // What actually proves the guarantee is structural, not observed here: `openSqliteAuditStoreForLookup`
    // `stat`s the file and returns before ever calling `loadSqliteModule()` when it is missing (see
    // its own doc, `src/adapters/sqlite-audit-store.ts`), mutation-tested at the adapter level
    // (`test/sqlite-audit-store.test.ts`: removing that early return turns a missing-file open into
    // a raw native failure). The one meaningful ExperimentalWarning proof needs a fresh child
    // process, immune to Node's once-per-process dedup — see `test/bin-smoke.test.ts`'s existing
    // P5-1 proof of the suppression mechanism itself, which this task's read-only path reuses
    // unchanged whenever it does load the module (a store that actually exists).
    'a cold dry run (no store file exists yet at the default path) reports every evaluable test case as billable '
    + 'and creates no file or directory of any kind',
    async () => {
      const root = await fixture(twoTestFixtureFiles);
      const storePaths = resolveAuditStorePaths();
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--rootDir', root, '--dry-run', '--json'], output.io);

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.lines[0]!) as Record<string, unknown>;
      expect(parsed['discovered']).toBe(2);
      expect(parsed['evaluable']).toBe(2);
      expect(parsed['initialCalls']).toBe(2);
      // Not consulted (no store exists yet): cacheHits is omitted entirely, never present as 0.
      expect('cacheHits' in parsed).toBe(false);
      // Explicit disclosure (orchestrator decision, 2026-09-20): cacheConsulted is always present,
      // and the specific reason is named — never left to be inferred from the missing cacheHits key.
      expect(parsed['cacheConsulted']).toBe(false);
      expect(parsed['cacheNotConsultedReason']).toBe('no-store');
      await expect(access(storePaths.databaseFile)).rejects.toThrow();
      await expect(access(storePaths.configDir)).rejects.toThrow();
    },
  );

  it(
    'a cold dry run\'s human-readable text report plainly discloses that the cache was not consulted because '
    + 'no store exists yet, and never prints a "Cache hits" line',
    async () => {
      const root = await fixture(twoTestFixtureFiles);
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--rootDir', root, '--dry-run'], output.io);

      expect(exitCode).toBe(0);
      const report = output.lines[0] ?? '';
      expect(report).toContain('not consulted');
      expect(report).toContain('no audit store exists yet');
      expect(report).not.toContain('Cache hits');
    },
  );

  it(
    'a warm dry run reports exactly the test cases already cached from a prior --evaluate as hits and the rest as billable, '
    + 'and leaves the store\'s own bytes byte-identical (same size, same hash) — T1: the read-only lookup now opens with '
    + 'mode=ro rather than immutable=1, so it may create/refresh a -wal/-shm sidecar (WAL coordination metadata, never '
    + 'written data; see openSqliteAuditStoreForLookup\'s own doc) — this test no longer asserts against that',
    async () => {
      const root = await fixture(twoTestFixtureFiles);
      const storePaths = resolveAuditStorePaths();

      // Warm-up: --evaluate over a.test.ts alone caches both of its test cases for real, under
      // their real content-addressed keys (the file's content will never change again below).
      const evaluateCalls: string[] = [];
      const warmUpExit = await runCli(['audit', '--rootDir', root, '--evaluate'], captureOutput().io, {
        createEvaluationPort: () => deterministicEvaluationPort((name) => evaluateCalls.push(name)),
      });
      expect(warmUpExit).toBe(0);
      expect(evaluateCalls).toEqual(['adds', 'subtracts']);

      // A second file, added to the SAME root AFTER the warm-up run, so its one test case was
      // never evaluated and can never be a hit — evaluable(3) != cacheHits(2) != billable(1), all
      // distinct, so a swap between "hit" and "billable" (or a silent fallback to "evaluable")
      // cannot pass unnoticed.
      await writeFile(join(root, 'b.test.ts'), "import { expect, test } from 'vitest';\ntest('multiplies', () => { expect(2 * 2).toBe(4); });\n");

      const beforeBytes = await readFile(storePaths.databaseFile);
      const beforeHash = createHash('sha256').update(beforeBytes).digest('hex');

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--dry-run', '--json'], output.io);

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.lines[0]!) as Record<string, unknown>;
      expect(parsed['discovered']).toBe(3);
      expect(parsed['evaluable']).toBe(3);
      expect(parsed['cacheHits']).toBe(2);
      expect(parsed['initialCalls']).toBe(1);
      // Explicit disclosure: consulted, and no "why not" reason since there is nothing to explain.
      expect(parsed['cacheConsulted']).toBe(true);
      expect('cacheNotConsultedReason' in parsed).toBe(false);
      // Stable key order (required verification): `cacheConsulted` sits immediately after
      // `initialCalls`, and `cacheHits` immediately after `cacheConsulted` — `dryRunJsonLine`
      // builds its own object literal separately from `DryRunEstimate`'s own field order, so this
      // is the one place a reordering there is caught.
      const keys = Object.keys(parsed);
      expect(keys.indexOf('cacheConsulted')).toBe(keys.indexOf('initialCalls') + 1);
      expect(keys.indexOf('cacheHits')).toBe(keys.indexOf('cacheConsulted') + 1);

      const afterBytes = await readFile(storePaths.databaseFile);
      const afterHash = createHash('sha256').update(afterBytes).digest('hex');
      expect(afterHash).toBe(beforeHash);
      expect(afterBytes.byteLength).toBe(beforeBytes.byteLength);
    },
  );

  it(
    'a warm dry run\'s human-readable text report keeps saying so exactly as it did before this disclosure existed '
    + '(the existing "Cache hits" line already covers the consulted case) and prints no "not consulted" wording',
    async () => {
      const root = await fixture(twoTestFixtureFiles);

      const evaluateCalls: string[] = [];
      const warmUpExit = await runCli(['audit', '--rootDir', root, '--evaluate'], captureOutput().io, {
        createEvaluationPort: () => deterministicEvaluationPort((name) => evaluateCalls.push(name)),
      });
      expect(warmUpExit).toBe(0);
      expect(evaluateCalls).toEqual(['adds', 'subtracts']);

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--dry-run'], output.io);

      expect(exitCode).toBe(0);
      const report = output.lines[0] ?? '';
      expect(report).toContain('Cache hits (served from the local audit store, zero cost, exact): 2');
      expect(report).not.toContain('not consulted');
    },
  );

  it(
    'THE central acceptance test: the billable count a warm dry run reports equals the number of requests a subsequent '
    + 'real --evaluate run actually issues over the same fixture and the same store — proved by counting real dispatches, '
    + 'never by comparing two numbers the estimator derived itself',
    async () => {
      const root = await fixture(twoTestFixtureFiles);

      const warmUpExit = await runCli(['audit', '--rootDir', root, '--evaluate'], captureOutput().io, {
        createEvaluationPort: () => deterministicEvaluationPort(),
      });
      expect(warmUpExit).toBe(0);

      await writeFile(join(root, 'b.test.ts'), "import { expect, test } from 'vitest';\ntest('multiplies', () => { expect(2 * 2).toBe(4); });\n");

      const dryRunOutput = captureOutput();
      const dryRunExit = await runCli(['audit', '--rootDir', root, '--dry-run', '--json'], dryRunOutput.io);
      expect(dryRunExit).toBe(0);
      const dryRunParsed = JSON.parse(dryRunOutput.lines[0]!) as { readonly initialCalls: number };

      const realDispatches: string[] = [];
      const realEvaluateExit = await runCli(['audit', '--rootDir', root, '--evaluate', '--json'], captureOutput().io, {
        createEvaluationPort: () => deterministicEvaluationPort((name) => realDispatches.push(name)),
      });
      expect(realEvaluateExit).toBe(0);

      expect(realDispatches).toEqual(['multiplies']);
      expect(dryRunParsed.initialCalls).toBe(realDispatches.length);
    },
  );

  it('surfaces the same named, visible error (exit 1, no stack trace) a subsequent --evaluate would also refuse with, for a store newer than this build supports', async () => {
    const root = await fixture(twoTestFixtureFiles);
    const storePaths = resolveAuditStorePaths();
    await mkdir(storePaths.configDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(storePaths.databaseFile);
    db.exec('CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL) STRICT;');
    db.exec('INSERT INTO schema_meta (id, schema_version) VALUES (1, 999)');
    db.close();
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root, '--dry-run'], output.io);

    expect(exitCode).toBe(1);
    // Exactly one line printed (the readable message) — no separate stack-trace line, matching
    // the exact same convention `--evaluate`'s own store-construction-failure test asserts.
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).toContain('999');
  });

  it(
    'a store whose recorded schema predates this build (an older version, not corrupt or unrecognized) is honestly '
    + 'reported as not consulted rather than migrated, silently treated as an all-miss cache, or refused as an error — '
    + 'exit 0, every evaluable test case billable, and the store left byte-identical with no sidecar',
    async () => {
      const root = await fixture(twoTestFixtureFiles);
      const storePaths = resolveAuditStorePaths();
      await mkdir(storePaths.configDir, { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(storePaths.databaseFile);
      db.exec('CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL) STRICT;');
      db.exec('INSERT INTO schema_meta (id, schema_version) VALUES (1, 1)');
      db.close();

      const beforeBytes = await readFile(storePaths.databaseFile);
      const beforeHash = createHash('sha256').update(beforeBytes).digest('hex');

      const jsonOutput = captureOutput();
      const jsonExitCode = await runCli(['audit', '--rootDir', root, '--dry-run', '--json'], jsonOutput.io);

      expect(jsonExitCode).toBe(0);
      const parsed = JSON.parse(jsonOutput.lines[0]!) as Record<string, unknown>;
      expect(parsed['evaluable']).toBe(2);
      // Every evaluable test case is billable — identical to a cold dry run with no store at all.
      expect(parsed['initialCalls']).toBe(2);
      expect('cacheHits' in parsed).toBe(false);
      expect(parsed['cacheConsulted']).toBe(false);
      expect(parsed['cacheNotConsultedReason']).toBe('schema-outdated');

      const textOutput = captureOutput();
      const textExitCode = await runCli(['audit', '--rootDir', root, '--dry-run'], textOutput.io);
      expect(textExitCode).toBe(0);
      const report = textOutput.lines[0] ?? '';
      expect(report).toContain('not consulted');
      expect(report).toContain('predates this build');
      expect(report).toContain('--evaluate');
      expect(report).not.toContain('Cache hits');

      // The read-only, no-write guarantee holds here too: an outdated store is never migrated,
      // never written to, and no sidecar file appears, exactly like every other --dry-run path.
      const afterBytes = await readFile(storePaths.databaseFile);
      const afterHash = createHash('sha256').update(afterBytes).digest('hex');
      expect(afterHash).toBe(beforeHash);
      expect(afterBytes.byteLength).toBe(beforeBytes.byteLength);
      await expect(access(`${storePaths.databaseFile}-wal`)).rejects.toThrow();
      await expect(access(`${storePaths.databaseFile}-shm`)).rejects.toThrow();
    },
  );

  it('an audit with neither --evaluate nor --dry-run still creates no database file or config directory, exactly as before this task (P5-1\'s own guarantee, unaffected by P5-5)', async () => {
    const root = await fixture(twoTestFixtureFiles);
    const storePaths = resolveAuditStorePaths();
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root], output.io);

    expect(exitCode).toBe(0);
    await expect(access(storePaths.databaseFile)).rejects.toThrow();
    await expect(access(storePaths.configDir)).rejects.toThrow();
  });
});

/** Isolates XDG_CONFIG_HOME/APPDATA to a fresh temp directory for one test, restoring on cleanup. Layered on top of this file's global override so every `auth`/storage-touching test gets its own clean slate. */
function useIsolatedConfigHome(): void {
  let configHome: string;
  let savedXdg: string | undefined;
  let savedAppData: string | undefined;

  beforeEach(async () => {
    configHome = await mkdtemp(join(tmpdir(), 'jev-cli-auth-isolated-'));
    savedXdg = process.env['XDG_CONFIG_HOME'];
    savedAppData = process.env['APPDATA'];
    process.env['XDG_CONFIG_HOME'] = configHome;
    process.env['APPDATA'] = configHome;
  });

  afterEach(async () => {
    if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME']; else process.env['XDG_CONFIG_HOME'] = savedXdg;
    if (savedAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = savedAppData;
    await rm(configHome, { recursive: true, force: true });
  });
}

function fakePromptOnce(value: string): () => Promise<string> {
  return async () => value;
}

function fakePromptRejecting(error: unknown): () => Promise<string> {
  return async () => { throw error; };
}

const CANARY_KEY = 'sk-canary-9999-do-not-print';

describe('auth login', () => {
  useIsolatedConfigHome();

  it('stores a key read from the prompt, writes the credentials file, and never echoes the key', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'login'], output.io, { readApiKeyFromPrompt: fakePromptOnce(CANARY_KEY) });

    expect(exitCode).toBe(0);
    const paths = resolveAuthStoragePaths();
    await expect(readStoredCredentials(paths)).resolves.toEqual({ version: 1, apiKey: CANARY_KEY });
    expect(output.lines.join('\n')).not.toContain(CANARY_KEY);
    expect(output.lines.join('\n')).toContain(paths.credentialsFile);
  });

  it('rejects a blank/whitespace-only key and writes nothing', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'login'], output.io, { readApiKeyFromPrompt: fakePromptOnce('   ') });

    expect(exitCode).toBe(1);
    expect(output.lines.join('\n')).toContain('No API key was entered');
    const paths = resolveAuthStoragePaths();
    await expect(readStoredCredentials(paths)).resolves.toBeUndefined();
  });

  it('reports cancellation (Ctrl+C) without writing anything', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'login'], output.io, {
      readApiKeyFromPrompt: fakePromptRejecting(new AuthPromptCancelledError()),
    });

    expect(exitCode).toBe(1);
    expect(output.lines.join('\n')).toContain('cancelled');
    const paths = resolveAuthStoragePaths();
    await expect(readStoredCredentials(paths)).resolves.toBeUndefined();
  });

  it('rejects the key when passed as a CLI argument, and never echoes it back', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'login', CANARY_KEY], output.io, {
      readApiKeyFromPrompt: () => { throw new Error('must not prompt when an argument was rejected'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines.join('\n')).not.toContain(CANARY_KEY);
    expect(output.lines.join('\n')).toContain('does not accept the API key as an argument');
    const paths = resolveAuthStoragePaths();
    await expect(readStoredCredentials(paths)).resolves.toBeUndefined();
  });
});

describe('auth status', () => {
  useIsolatedConfigHome();
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env['TYPESAFE_API_KEY'];
    delete process.env['TYPESAFE_API_KEY'];
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY']; else process.env['TYPESAFE_API_KEY'] = savedKey;
  });

  it('reports not configured when nothing is set anywhere', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'status'], output.io);

    expect(exitCode).toBe(0);
    const report = output.lines.join('\n');
    expect(report).toContain('not configured');
    expect(report).toContain('does not exist');
    expect(report).toContain('auth login');
  });

  it('reports configured (source: environment) when TYPESAFE_API_KEY is set, and never prints the key', async () => {
    process.env['TYPESAFE_API_KEY'] = CANARY_KEY;
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'status'], output.io);

    expect(exitCode).toBe(0);
    const report = output.lines.join('\n');
    expect(report).toContain('configured (source: environment)');
    expect(report).not.toContain(CANARY_KEY);
    expect(report).not.toContain(CANARY_KEY.slice(-4));
  });

  it('reports configured (source: stored) when only the stored file has a key', async () => {
    const paths = resolveAuthStoragePaths();
    await writeStoredCredentials(paths, CANARY_KEY);
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'status'], output.io);

    expect(exitCode).toBe(0);
    const report = output.lines.join('\n');
    expect(report).toContain('configured (source: stored)');
    expect(report).toContain('owner-only permissions: yes');
    expect(report).not.toContain(CANARY_KEY);
    expect(report).not.toContain(CANARY_KEY.slice(-4));
  });

  it.skipIf(process.platform === 'win32')('reports an insecure stored file and does not silently treat it as usable', async () => {
    const paths = resolveAuthStoragePaths();
    await writeStoredCredentials(paths, CANARY_KEY);
    await chmod(paths.credentialsFile, 0o644);
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'status'], output.io);

    expect(exitCode).toBe(0);
    const report = output.lines.join('\n');
    expect(report).toContain('not configured');
    expect(report).toContain('insecure permissions');
    expect(report).not.toContain(CANARY_KEY);
    expect(report).not.toContain(CANARY_KEY.slice(-4));
  });

  it('reports a corrupt stored file without crashing', async () => {
    const paths = resolveAuthStoragePaths();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.credentialsFile, 'not json', { mode: 0o600 });
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'status'], output.io);

    expect(exitCode).toBe(0);
    expect(output.lines.join('\n')).toContain('corrupt');
  });
});

describe('auth logout', () => {
  useIsolatedConfigHome();

  it('deletes an existing stored key and reports success', async () => {
    const paths = resolveAuthStoragePaths();
    await writeStoredCredentials(paths, CANARY_KEY);
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'logout'], output.io);

    expect(exitCode).toBe(0);
    expect(output.lines.join('\n')).toContain('deleted');
    expect(output.lines.join('\n')).not.toContain(CANARY_KEY);
    await expect(readStoredCredentials(paths)).resolves.toBeUndefined();
  });

  it('reports honestly when nothing was stored, and still exits 0', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['auth', 'logout'], output.io);

    expect(exitCode).toBe(0);
    expect(output.lines.join('\n')).toContain('nothing to delete');
  });
});

describe('--help documents auth commands', () => {
  it('lists auth login, auth status, and auth logout', async () => {
    const output = captureOutput();

    await runCli(['--help'], output.io);

    const help = output.lines.join('\n');
    expect(help).toContain('auth login');
    expect(help).toContain('auth status');
    expect(help).toContain('auth logout');
    expect(help).toContain('stdin is a TTY');
    expect(help).toContain('command-line argument');
  });
});

/**
 * Terminal progress wiring (Phase 6, task P6-3), exercised end to end through the real `runCli`
 * pipeline — `createProgressPort` is the test seam (mirroring `createEvaluationPort`/
 * `createStorePort`), and the "no seam at all" tests below prove the production default instead.
 * Every test here audits a real, explicit `--rootDir` fixture (never this repository's own working
 * directory — see this phase's own feature document for why that trap has bitten this project
 * before) with a genuinely evaluable test case, so progress actually fires; a run that produced no
 * events at all would make "stdout stayed clean" a vacuous claim.
 */
describe('terminal progress during a run (Phase 6, task P6-3)', () => {
  useIsolatedConfigHome();

  const mathFixtureFiles = {
    'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
  };

  function fakeEvaluationPort(): AuditEvaluationPort {
    return {
      async evaluate(request) {
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

  function fakeStorePort(): AuditStorePort {
    return {
      beginRun: async () => 'progress-run-1',
      canonicalizeRootDir: async (rootDir) => rootDir,
      recordWorkItem: async () => undefined,
      lookup: async () => undefined,
      finishRun: async () => undefined,
      loadRunState: async () => undefined,
      close: async () => undefined,
    };
  }

  it('attaches the createProgressPort test seam through the real pipeline: begin/report fire for the fixture\'s one evaluable test case, and stdout stays exactly the terminal summary', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();
    const beginCalls: number[] = [];
    const reportedStates: string[] = [];

    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate'], output.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
      createStorePort: () => fakeStorePort(),
      createProgressPort: () => ({
        begin: (total) => { beginCalls.push(total); },
        report: (event) => { reportedStates.push(event.state); },
      }),
    });

    expect(exitCode).toBe(0);
    expect(beginCalls).toEqual([1]);
    expect(reportedStates).toEqual(['pending', 'running', 'completed']);
    // stdout carries only the ordinary terminal report — progress went through the seam above,
    // never through `io.writeLine`.
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).toContain('Jev evaluation summary');
  });

  it('never constructs a progress port without --evaluate — an ordinary audit stays exactly as before', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root], output.io, {
      createProgressPort: () => { throw new Error('must not construct the progress port without --evaluate'); },
    });

    expect(exitCode).toBe(0);
  });

  it('--evaluate --json stays byte-clean — exactly one parseable canonical JSON line — even though progress genuinely fired', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();
    const reportedStates: string[] = [];

    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--json'], output.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
      createStorePort: () => fakeStorePort(),
      createProgressPort: () => ({
        begin: () => undefined,
        report: (event) => { reportedStates.push(event.state); },
      }),
    });

    expect(exitCode).toBe(0);
    // The trap this test exists to catch: prove progress genuinely fired before trusting that
    // stdout staying clean means anything.
    expect(reportedStates.length).toBeGreaterThan(0);
    expect(output.lines).toHaveLength(1);
    const parsed = JSON.parse(output.lines[0]!) as { reportVersion: number; rootDir: string };
    expect(parsed.reportVersion).toBe(1);
    expect(parsed.rootDir).toBe(root);
  });

  /**
   * Genuinely exercises the real key-resolution/gateway path (no `createEvaluationPort` override
   * — a stub bypasses `resolveEvaluationApiKey` entirely, which would make the "never leaks the
   * API key" assertions below pass vacuously, since the canary key would never enter the process's
   * data flow at all; this is exactly the "vacuous canary" trap this phase's own feature document
   * warns about). Only `fetch` is stubbed, mirroring the existing real-gateway canary test above
   * ("the API key never reaches the database file...") — `createStorePort` stays faked so this
   * test creates no real database file.
   */
  it('with no createProgressPort seam at all, the production default writes progress to stderr, never stdout, and never leaks the API key', async () => {
    const root = await fixture(mathFixtureFiles);
    const canaryKey = 'sk-progress-key-never-leaked-canary';
    const savedKey = process.env['TYPESAFE_API_KEY'];
    const originalFetch = globalThis.fetch;
    process.env['TYPESAFE_API_KEY'] = canaryKey;
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 },
    }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    try {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--json'], output.io, {
        createStorePort: () => fakeStorePort(),
      });

      expect(exitCode).toBe(0);
      // The real gateway was genuinely used — proves the canary key actually entered the process's
      // data flow, so the "never leaks" assertions below are not vacuous.
      expect(fetchSpy).toHaveBeenCalled();
      const [, requestInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect((requestInit.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${canaryKey}`);

      // stdout: exactly the one canonical JSON line — never corrupted by progress output sharing
      // the stream.
      expect(output.lines).toHaveLength(1);
      expect(() => JSON.parse(output.lines[0]!)).not.toThrow();
      expect(output.lines[0]).not.toContain(canaryKey);

      // The trap this test exists to catch: prove progress genuinely produced output before
      // trusting that "stdout is clean" and "no leak" mean anything.
      expect(stderrChunks.length).toBeGreaterThan(0);
      // In vitest, `process.stderr.isTTY` is falsy, so this deterministically exercises the
      // non-TTY path: one clean, newline-terminated line naming the fixture's evaluable test case.
      for (const chunk of stderrChunks) {
        expect(chunk.endsWith('\n')).toBe(true);
        expect(chunk).not.toContain(canaryKey);
      }
      expect(stderrChunks.join('')).toContain('math.test.ts');
    } finally {
      stderrSpy.mockRestore();
      globalThis.fetch = originalFetch;
      if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY']; else process.env['TYPESAFE_API_KEY'] = savedKey;
    }
  });
});

/**
 * `--html <path>` / `--open` (Phase 6, task P6-4): renders the same canonical report
 * `--evaluate --json` already prints into one self-contained offline HTML file, written only when
 * explicitly requested — preserving Phase 5's "nothing is written unless explicitly asked for"
 * guarantee for this new surface, exactly as the Phase 6 feature document requires.
 */
describe('--html and --open (Phase 6, task P6-4)', () => {
  useIsolatedConfigHome();

  const mathFixtureFiles = {
    'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
  };

  function fakeEvaluationPort(onCall?: (name: string) => void): AuditEvaluationPort {
    return {
      async evaluate(request) {
        onCall?.(request.testCase.name);
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

  function fakeStorePort(): AuditStorePort {
    return {
      beginRun: async () => 'html-run-1',
      canonicalizeRootDir: async (rootDir) => rootDir,
      recordWorkItem: async () => undefined,
      lookup: async () => undefined,
      finishRun: async () => undefined,
      loadRunState: async () => undefined,
      close: async () => undefined,
    };
  }

  describe('flag parsing and rejections', () => {
    it('documents --html and --open in --help', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['--help'], output.io);
      expect(exitCode).toBe(0);
      expect(output.lines[0]).toContain('--html [path]');
      expect(output.lines[0]).toContain('--open');
    });

    it('writes report.html into the invocation directory when --html is given without a path', async () => {
      const root = await fixture(mathFixtureFiles);
      const invocationDir = await mkdtemp(join(tmpdir(), 'jev-html-default-'));
      temporaryRoots.push(invocationDir);

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--html'], output.io, {
        createEvaluationPort: () => fakeEvaluationPort(),
        createStorePort: () => fakeStorePort(),
        cwd: () => invocationDir,
      });

      expect(exitCode).toBe(0);
      expect(await readdirSorted(invocationDir)).toEqual(['report.html']);
      expect(await readFile(join(invocationDir, 'report.html'), 'utf8')).toContain('id="jev-hero"');
    });

    it('opens the default report.html when --html without a path is followed by --open', async () => {
      const root = await fixture(mathFixtureFiles);
      const invocationDir = await mkdtemp(join(tmpdir(), 'jev-html-default-open-'));
      temporaryRoots.push(invocationDir);
      const opened: string[] = [];

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--html', '--open'], output.io, {
        createEvaluationPort: () => fakeEvaluationPort(),
        createStorePort: () => fakeStorePort(),
        cwd: () => invocationDir,
        openHtmlReport: async (path) => {
          opened.push(path);
          return { opened: true };
        },
      });

      expect(exitCode).toBe(0);
      expect(opened).toEqual([join(invocationDir, 'report.html')]);
    });

    it('still rejects a pathless --html without --evaluate', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['audit', '--html'], output.io);
      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--html requires --evaluate');
    });

    it('rejects --html without --evaluate', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['audit', '--html', 'report.html'], output.io);
      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--html requires --evaluate');
    });

    it('rejects --html combined with --dry-run', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['audit', '--dry-run', '--html', 'report.html'], output.io);
      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--html cannot be combined with --dry-run');
    });

    it('rejects --html combined with --inspect-payloads', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['audit', '--evaluate', '--inspect-payloads', '--html', 'report.html'], output.io);
      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--evaluate cannot be combined with --inspect-payloads');
    });

    it('rejects --open without --html', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['audit', '--evaluate', '--open'], output.io, {
        createEvaluationPort: () => { throw new Error('must not resolve an evaluation port for a usage error'); },
      });
      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--open requires --html');
    });

    it(
      'rejects a directory-shaped --html path as a usage error BEFORE dispatching any evaluation work (no API key resolved, no evaluation port constructed, no network)',
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'jev-html-cli-'));
        temporaryRoots.push(dir);
        const output = captureOutput();
        const exitCode = await runCli(['audit', '--evaluate', '--html', dir], output.io, {
          createEvaluationPort: () => { throw new Error('must not construct the evaluation port before the --html preflight'); },
        });
        expect(exitCode).toBe(1);
        expect(output.lines[0]).toContain('Unable to write the HTML report');
        expect(output.lines[0]).toContain(dir);
      },
    );

    it(
      'rejects an --html path whose parent directory does not exist, as a usage error, before dispatching any evaluation work',
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'jev-html-cli-'));
        temporaryRoots.push(dir);
        const target = join(dir, 'no-such-subdir', 'report.html');
        const output = captureOutput();
        const exitCode = await runCli(['audit', '--evaluate', '--html', target], output.io, {
          createEvaluationPort: () => { throw new Error('must not construct the evaluation port before the --html preflight'); },
        });
        expect(exitCode).toBe(1);
        expect(output.lines[0]).toContain('Unable to write the HTML report');
      },
    );
  });

  describe('no file without --html (Phase 5\'s guarantee, extended to this new surface)', () => {
    it('an --evaluate run with no --html writes nothing at all to an otherwise-empty output directory', async () => {
      const root = await fixture(mathFixtureFiles);
      const outputDir = await mkdtemp(join(tmpdir(), 'jev-html-no-write-'));
      temporaryRoots.push(outputDir);
      const before = await readdirSorted(outputDir);

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate'], output.io, {
        createEvaluationPort: () => fakeEvaluationPort(),
        createStorePort: () => fakeStorePort(),
      });

      expect(exitCode).toBe(0);
      expect(await readdirSorted(outputDir)).toEqual(before);
    });

    it('an --evaluate --resume run that finds nothing outstanding writes no HTML file either (no report exists to render)', async () => {
      const root = await fixture(mathFixtureFiles);
      const dir = await mkdtemp(join(tmpdir(), 'jev-html-nothing-outstanding-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'report.html');
      const finishedResult: AuditResult = {
        rootDir: root,
        files: [],
        excluded: [],
        diagnostics: [],
        totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
        reportingOnly: true,
        evaluation: {
          classifications: [],
          totals: {
            evaluated: 0, cached: 0, failed: 0,
            skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
            usage: { inputTokens: 0, outputTokens: 0 },
            statusCounts: { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 },
            respondedModel: undefined,
            modelMismatches: 0,
          },
          cacheStatusByTestCaseId: new Map(),
          latencyByTestCaseId: new Map(),
        },
        resume: { runId: 'run:v1:already-finished', outstanding: 0, reused: 0, nothingOutstanding: true },
      };

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--evaluate', '--resume', 'run:v1:already-finished', '--html', target], output.io, {
        audit: async () => finishedResult,
      });

      expect(exitCode).toBe(0);
      expect(output.lines[0]).toContain('Nothing to resume');
      await expect(access(target)).rejects.toThrow();
    });
  });

  describe('writes one genuinely self-contained file', () => {
    it('writes exactly one HTML file at the given path — a fixed-size overview, no embedded JSON, no external reference', async () => {
      const root = await fixture(mathFixtureFiles);
      const dir = await mkdtemp(join(tmpdir(), 'jev-html-write-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'report.html');

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--html', target], output.io, {
        createEvaluationPort: () => fakeEvaluationPort(),
        createStorePort: () => fakeStorePort(),
      });

      expect(exitCode).toBe(0);
      // stdout carries only the ordinary terminal report — the file lives on disk, never on stdout.
      expect(output.lines).toHaveLength(1);
      expect(output.lines[0]).toContain('Jev evaluation summary');

      const html = await readFile(target, 'utf8');
      expect(html.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
      expect(html).toContain('id="jev-hero"');
      // Per-test/canonical detail lives only in `--json`; the HTML embeds no JSON block at all.
      expect(html).not.toContain('id="jev-report-data"');
      expect(html).not.toContain('application/json');
      expect(html).not.toMatch(/<link\b/i);
      expect(html).not.toMatch(/\bsrc\s*=\s*"https?:\/\//i);
      expect(html).toContain(root);

      expect(await readdirSorted(dir)).toEqual(['report.html']);
    });

    it('--evaluate --json --html stays byte-clean on stdout (exactly one parseable canonical JSON line) even though --html also wrote a file', async () => {
      const root = await fixture(mathFixtureFiles);
      const dir = await mkdtemp(join(tmpdir(), 'jev-html-write-json-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'report.html');

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--json', '--html', target], output.io, {
        createEvaluationPort: () => fakeEvaluationPort(),
        createStorePort: () => fakeStorePort(),
      });

      expect(exitCode).toBe(0);
      expect(output.lines).toHaveLength(1);
      expect(() => JSON.parse(output.lines[0]!)).not.toThrow();
      await expect(access(target)).resolves.toBeUndefined();
    });

    it('overwrites an existing file at the same --html path, replacing its content entirely (never appending)', async () => {
      const root = await fixture(mathFixtureFiles);
      const dir = await mkdtemp(join(tmpdir(), 'jev-html-overwrite-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'report.html');
      await writeFile(target, 'stale content that must not survive');

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--html', target], output.io, {
        createEvaluationPort: () => fakeEvaluationPort(),
        createStorePort: () => fakeStorePort(),
      });

      expect(exitCode).toBe(0);
      const html = await readFile(target, 'utf8');
      expect(html).not.toContain('stale content');
      expect(html.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
    });

    it('names the write, including the overwrite, on stderr — never on stdout', async () => {
      const root = await fixture(mathFixtureFiles);
      const dir = await mkdtemp(join(tmpdir(), 'jev-html-stderr-note-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'report.html');
      await writeFile(target, 'stale');
      const stderrChunks: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });

      try {
        const output = captureOutput();
        const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--json', '--html', target], output.io, {
          createEvaluationPort: () => fakeEvaluationPort(),
          createStorePort: () => fakeStorePort(),
        });

        expect(exitCode).toBe(0);
        expect(output.lines).toHaveLength(1);
        expect(output.lines[0]).not.toContain('overwrit');
        expect(stderrChunks.join('')).toContain(target);
        expect(stderrChunks.join('').toLowerCase()).toContain('overwrit');
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe('renders from the same JSON --evaluate --json prints, with no repository content beyond what the JSON report already discloses', () => {
    it('the API key never reaches the written HTML file (mirrors the existing JSON/database canaries)', async () => {
      const root = await fixture(mathFixtureFiles);
      const dir = await mkdtemp(join(tmpdir(), 'jev-html-canary-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'report.html');
      const canaryKey = 'sk-html-key-never-leaked-canary';
      const savedKey = process.env['TYPESAFE_API_KEY'];
      const originalFetch = globalThis.fetch;
      process.env['TYPESAFE_API_KEY'] = canaryKey;
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
        model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 },
      }), { status: 200 }));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      try {
        const output = captureOutput();
        const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--html', target], output.io, {
          createStorePort: () => fakeStorePort(),
        });

        expect(exitCode).toBe(0);
        // Proves the canary key genuinely entered the process's data flow, so the assertion below
        // is not vacuous (the same discipline this phase's own history keeps re-learning).
        expect(fetchSpy).toHaveBeenCalled();
        const [, requestInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        expect((requestInit.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${canaryKey}`);

        const html = await readFile(target, 'utf8');
        expect(html).not.toContain(canaryKey);
      } finally {
        globalThis.fetch = originalFetch;
        if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY']; else process.env['TYPESAFE_API_KEY'] = savedKey;
      }
    });
  });

  describe('--open', () => {
    it('opens the file through the injected seam, with the exact path just written, only after a successful write', async () => {
      const root = await fixture(mathFixtureFiles);
      const dir = await mkdtemp(join(tmpdir(), 'jev-html-open-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'report.html');
      const openCalls: string[] = [];

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--html', target, '--open'], output.io, {
        createEvaluationPort: () => fakeEvaluationPort(),
        createStorePort: () => fakeStorePort(),
        openHtmlReport: async (path) => { openCalls.push(path); return { opened: true }; },
      });

      expect(exitCode).toBe(0);
      expect(openCalls).toEqual([target]);
    });

    it('never opens anything without --open', async () => {
      const root = await fixture(mathFixtureFiles);
      const dir = await mkdtemp(join(tmpdir(), 'jev-html-no-open-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'report.html');

      const output = captureOutput();
      const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--html', target], output.io, {
        createEvaluationPort: () => fakeEvaluationPort(),
        createStorePort: () => fakeStorePort(),
        openHtmlReport: async () => { throw new Error('must not be called without --open'); },
      });

      expect(exitCode).toBe(0);
    });

    it(
      'a failed open (no viewer installed — the common CI case) never changes the exit status, never removes the written file, and is reported on stderr only',
      async () => {
        const root = await fixture(mathFixtureFiles);
        const dir = await mkdtemp(join(tmpdir(), 'jev-html-open-fail-'));
        temporaryRoots.push(dir);
        const target = join(dir, 'report.html');
        const stderrChunks: string[] = [];
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
          stderrChunks.push(String(chunk));
          return true;
        });

        try {
          const output = captureOutput();
          const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--json', '--html', target, '--open'], output.io, {
            createEvaluationPort: () => fakeEvaluationPort(),
            createStorePort: () => fakeStorePort(),
            openHtmlReport: async () => ({ opened: false, reason: 'spawn xdg-open ENOENT' }),
          });

          expect(exitCode).toBe(0);
          expect(output.lines).toHaveLength(1);
          expect(() => JSON.parse(output.lines[0]!)).not.toThrow();
          await expect(access(target)).resolves.toBeUndefined();
          expect(stderrChunks.join('')).toContain('Unable to open the HTML report automatically');
          expect(stderrChunks.join('')).toContain('spawn xdg-open ENOENT');
        } finally {
          stderrSpy.mockRestore();
        }
      },
    );
  });
});

/**
 * Persisted run reports (feature "persisted-run-reports", `odd/tasks/persisted-run-reports.md`,
 * task T1): every `--evaluate` run writes the canonical report to `<rootDir>/.jta/`, exercised end
 * to end through the real `runCli` pipeline exactly like "terminal progress during a run" above.
 * `fakeStorePort().beginRun` returns a fixed run id, so the exact persisted filename is known ahead
 * of time.
 */
describe('persisted run reports (.jta/) — feature "persisted-run-reports", task T1', () => {
  const mathFixtureFiles = {
    'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
  };
  const FIXED_RUN_ID = 'jta-persist-run-1';

  function fakeEvaluationPort(): AuditEvaluationPort {
    return {
      async evaluate(request) {
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

  function fakeStorePort(): AuditStorePort {
    return {
      beginRun: async () => FIXED_RUN_ID,
      canonicalizeRootDir: async (rootDir) => rootDir,
      recordWorkItem: async () => undefined,
      lookup: async () => undefined,
      finishRun: async () => undefined,
      loadRunState: async () => undefined,
      close: async () => undefined,
    };
  }

  it('writes .jta/reports/<runId>.json and .jta/latest.json byte-identical to --evaluate --json stdout', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--json'], output.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
      createStorePort: () => fakeStorePort(),
    });

    expect(exitCode).toBe(0);
    expect(output.lines).toHaveLength(1);
    const stdoutJson = output.lines[0]!;
    expect(() => JSON.parse(stdoutJson)).not.toThrow();

    const runReportContent = await readFile(join(root, '.jta', 'reports', `${FIXED_RUN_ID}.json`), 'utf8');
    const latestContent = await readFile(join(root, '.jta', 'latest.json'), 'utf8');
    expect(runReportContent).toBe(stdoutJson);
    expect(latestContent).toBe(stdoutJson);
  });

  it('persists even without --json or --html', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate'], output.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
      createStorePort: () => fakeStorePort(),
    });

    expect(exitCode).toBe(0);
    const runReportContent = await readFile(join(root, '.jta', 'reports', `${FIXED_RUN_ID}.json`), 'utf8');
    const parsed = JSON.parse(runReportContent) as { runId?: string; reportVersion?: number };
    expect(parsed.runId).toBe(FIXED_RUN_ID);
    expect(parsed.reportVersion).toBe(1);
  });

  it('creates .jta/.gitignore containing "*" so the folder never gets committed', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();

    await runCli(['audit', '--rootDir', root, '--evaluate'], output.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
      createStorePort: () => fakeStorePort(),
    });

    const gitignore = await readFile(join(root, '.jta', '.gitignore'), 'utf8');
    expect(gitignore).toBe('*\n');
  });

  it(
    'a persistence write failure prints one stderr line and never changes the exit code or stdout',
    async () => {
      const root = await fixture(mathFixtureFiles);
      // A regular file where .jta needs to become a directory makes the write fail.
      await writeFile(join(root, '.jta'), 'blocking file');
      const output = captureOutput();
      const stderrChunks: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });

      try {
        const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--json'], output.io, {
          createEvaluationPort: () => fakeEvaluationPort(),
          createStorePort: () => fakeStorePort(),
        });

        expect(exitCode).toBe(0);
        expect(output.lines).toHaveLength(1);
        expect(() => JSON.parse(output.lines[0]!)).not.toThrow();
        expect(stderrChunks.join('')).toContain('Unable to persist the run report');
      } finally {
        stderrSpy.mockRestore();
      }
    },
  );

  it('skips persistence silently (no .jta/ created) when the run has no store-assigned run id', async () => {
    const root = await fixture(mathFixtureFiles);
    const output = captureOutput();
    const audit: AuditResult = {
      rootDir: root,
      files: [],
      excluded: [],
      diagnostics: [],
      totals: { files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals },
      reportingOnly: true,
      evaluation: {
        classifications: [],
        totals: {
          evaluated: 0, cached: 0, failed: 0,
          skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
          usage: { inputTokens: 0, outputTokens: 0 },
          statusCounts: { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 },
          respondedModel: undefined,
          modelMismatches: 0,
        },
        cacheStatusByTestCaseId: new Map(),
        latencyByTestCaseId: new Map(),
      },
      // No `runId` — this AuditResult never went through a store.
    };

    const exitCode = await runCli(['audit', '--evaluate', '--json'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    await expect(access(join(root, '.jta'))).rejects.toThrow();
  });
});

/**
 * `jta report` (feature "persisted-run-reports", `odd/tasks/persisted-run-reports.md`, task T2):
 * a read-only command that reads back what task T1 persisted to `<rootDir>/.jta/` — no API key, no
 * network, no store access. Exercised end to end through the real `runCli` pipeline, seeding
 * `.jta/` first with a real `audit --evaluate` call (mirroring "persisted run reports" above), then
 * exercising `report` against it.
 */
describe('jta report — feature "persisted-run-reports", task T2', () => {
  const mathFixtureFiles = {
    'math.test.ts': "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
  };
  const FIXED_RUN_ID = 'jta-report-run-1';

  function fakeEvaluationPort(): AuditEvaluationPort {
    return {
      async evaluate(request) {
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

  function fakeStorePort(runId: string): AuditStorePort {
    return {
      beginRun: async () => runId,
      canonicalizeRootDir: async (rootDir) => rootDir,
      recordWorkItem: async () => undefined,
      lookup: async () => undefined,
      finishRun: async () => undefined,
      loadRunState: async () => undefined,
      close: async () => undefined,
    };
  }

  /** Seeds `.jta/` under `root` with exactly one real, persisted run, and returns the exact canonical JSON stdout printed for it. */
  async function seedRun(root: string, runId: string = FIXED_RUN_ID): Promise<string> {
    const seedOutput = captureOutput();
    const exitCode = await runCli(['audit', '--rootDir', root, '--evaluate', '--json'], seedOutput.io, {
      createEvaluationPort: () => fakeEvaluationPort(),
      createStorePort: () => fakeStorePort(runId),
    });
    if (exitCode !== 0) throw new Error('seedRun: seeding audit --evaluate failed');
    return seedOutput.lines[0]!;
  }

  describe('no persisted reports yet', () => {
    it('exits 1 with a message suggesting "jta audit --evaluate" when .jta/ does not exist at all', async () => {
      const root = await fixture({});
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root], output.io);

      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('jta audit --evaluate');
    });
  });

  describe('--json', () => {
    it('prints the stored JSON exactly (byte-identical to the original --evaluate --json stdout)', async () => {
      const root = await fixture(mathFixtureFiles);
      const seededJson = await seedRun(root);
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root, '--json'], output.io);

      expect(exitCode).toBe(0);
      expect(output.lines).toEqual([seededJson]);
    });
  });

  describe('default output (human summary)', () => {
    it('includes the run id, the needs-a-change share and denominator, and at least one folder', async () => {
      const root = await fixture(mathFixtureFiles);
      await seedRun(root);
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root], output.io);

      expect(exitCode).toBe(0);
      const text = output.lines.join('\n');
      expect(text).toContain(FIXED_RUN_ID);
      expect(text).toContain('0/1');
      expect(text).toMatch(/math\.test\.ts|\./);
    });
  });

  describe('--run <runId>', () => {
    it('reads back the exact named run, not just the latest one', async () => {
      const root = await fixture(mathFixtureFiles);
      await seedRun(root, 'run-older');
      const newerJson = await seedRun(root, 'run-newer');
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root, '--run', 'run-older', '--json'], output.io);
      expect(exitCode).toBe(0);
      expect(output.lines[0]).not.toEqual(newerJson);
      expect(JSON.parse(output.lines[0]!).runId).toBe('run-older');

      const latestOutput = captureOutput();
      const latestExit = await runCli(['report', '--rootDir', root, '--json'], latestOutput.io);
      expect(latestExit).toBe(0);
      expect(latestOutput.lines[0]).toEqual(newerJson);
    });

    it('exits 1 and lists available run ids for an unknown run id', async () => {
      const root = await fixture(mathFixtureFiles);
      await seedRun(root, 'run-known');
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root, '--run', 'run-does-not-exist'], output.io);

      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('run-does-not-exist');
      expect(output.lines[0]).toContain('run-known');
    });

    it('rejects a path-traversal run id the same as any other unknown run id, never escaping .jta/reports/', async () => {
      const root = await fixture(mathFixtureFiles);
      await seedRun(root, 'run-known');
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root, '--run', '../../../etc/passwd'], output.io);

      expect(exitCode).toBe(1);
    });
  });

  describe('--html [path]', () => {
    it('renders the persisted report to report.html in the invocation directory by default', async () => {
      const root = await fixture(mathFixtureFiles);
      await seedRun(root);
      const invocationDir = await mkdtemp(join(tmpdir(), 'jev-report-html-default-'));
      temporaryRoots.push(invocationDir);
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root, '--html'], output.io, { cwd: () => invocationDir });

      expect(exitCode).toBe(0);
      const html = await readFile(join(invocationDir, 'report.html'), 'utf8');
      expect(html).toContain('id="jev-hero"');
    });

    it('renders the persisted report to an explicit path, and --open launches the seam', async () => {
      const root = await fixture(mathFixtureFiles);
      await seedRun(root);
      const dir = await mkdtemp(join(tmpdir(), 'jev-report-html-explicit-'));
      temporaryRoots.push(dir);
      const target = join(dir, 'out.html');
      const opened: string[] = [];
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root, '--html', target, '--open'], output.io, {
        openHtmlReport: async (path) => { opened.push(path); return { opened: true }; },
      });

      expect(exitCode).toBe(0);
      await expect(access(target)).resolves.toBeUndefined();
      expect(opened).toEqual([target]);
    });
  });

  describe('flag parsing and rejections', () => {
    it('rejects --last combined with --run', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['report', '--last', '--run', 'x'], output.io);
      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--last');
      expect(output.lines[0]).toContain('--run');
    });

    it('rejects --json combined with --html', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['report', '--json', '--html', 'x.html'], output.io);
      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--json');
      expect(output.lines[0]).toContain('--html');
    });

    it('rejects --open without --html', async () => {
      const output = captureOutput();
      const exitCode = await runCli(['report', '--open'], output.io);
      expect(exitCode).toBe(1);
      expect(output.lines[0]).toContain('--open requires --html');
    });
  });

  describe('unreadable or invalid persisted JSON', () => {
    it('exits 1 with a clear message for invalid JSON', async () => {
      const root = await fixture(mathFixtureFiles);
      await mkdir(join(root, '.jta'), { recursive: true });
      await writeFile(join(root, '.jta', 'latest.json'), 'not valid json{{{');
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root], output.io);

      expect(exitCode).toBe(1);
      expect(output.lines[0]!.toLowerCase()).toContain('json');
    });

    it('exits 1 with a clear message for schema-invalid JSON (valid JSON, wrong shape)', async () => {
      const root = await fixture(mathFixtureFiles);
      await mkdir(join(root, '.jta'), { recursive: true });
      await writeFile(join(root, '.jta', 'latest.json'), JSON.stringify({ notAReport: true }));
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root], output.io);

      expect(exitCode).toBe(1);
      expect(output.lines[0]!.toLowerCase()).toContain('schema');
    });
  });

  describe('--rootDir', () => {
    it('reads .jta/ from --rootDir, not the invocation directory', async () => {
      const root = await fixture(mathFixtureFiles);
      const seededJson = await seedRun(root);
      const invocationDir = await mkdtemp(join(tmpdir(), 'jev-report-rootdir-'));
      temporaryRoots.push(invocationDir);
      const output = captureOutput();

      const exitCode = await runCli(['report', '--rootDir', root, '--json'], output.io, { cwd: () => invocationDir });

      expect(exitCode).toBe(0);
      expect(output.lines[0]).toEqual(seededJson);
    });
  });
});
