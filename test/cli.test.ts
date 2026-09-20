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

    const exitCode = await runCli(['audit'], output.io, { audit: async () => audit });

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

    const exitCode = await runCli(['audit'], output.io, { audit: async () => audit });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output.lines[0] ?? '') as { totals: { unsupportedFrameworkFiles: number } };
    expect(parsed.totals.unsupportedFrameworkFiles).toBe(1);
  });

  it('returns zero for audit diagnostics and one for usage errors', async () => {
    const diagnosticOutput = captureOutput();
    const diagnosticExitCode = await runCli(['audit'], diagnosticOutput.io, {
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

describe('--dry-run usage errors', () => {
  it('rejects --json without --dry-run as a usage error and never runs the audit seam', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--json'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--json');
    expect(output.lines[0]).toContain('--dry-run');
  });

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

  it('rejects --json without --dry-run or --evaluate as a usage error', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['audit', '--json'], output.io, {
      audit: async () => { throw new Error('must not run'); },
    });

    expect(exitCode).toBe(1);
    expect(output.lines[0]).toContain('--dry-run');
    expect(output.lines[0]).toContain('--evaluate');
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

      const exitCode = await runCli(['audit', '--rootDir', root], output.io);

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
          '{"reportVersion":1,"rootDir":"/workspace","reportingOnly":true,"complete":true,"versions":{"storeSchema":3,"rubric":2,"policy":2},'
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
          '{"reportVersion":1,"rootDir":"/workspace","reportingOnly":true,"complete":true,"versions":{"storeSchema":3,"rubric":2,"policy":2},'
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

      // Baseline: a completely separate database, never touched by the interrupted/resumed pair
      // below, so a warm cache can never make the final comparison vacuous.
      const baselineDb = await tempDbFile();
      const baselineOutput = captureOutput();
      const baselineExit = await runCli(['audit', '--rootDir', root, '--evaluate', '--json'], baselineOutput.io, {
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
      // resume-specific metadata this task deliberately adds, and each run's own distinct persisted
      // identity, matches byte-for-byte (compared as parsed objects here to isolate those two
      // intentional, documented differences).
      delete resumedReport['resume'];
      delete resumedReport['runId'];
      delete baselineReport['runId'];
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
    + 'and leaves the store byte-identical (same size, same hash) with no new sidecar file',
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
      const sidecarsBefore = [`${storePaths.databaseFile}-wal`, `${storePaths.databaseFile}-shm`].filter((path) => existsSync(path));

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
      const sidecarsAfter = [`${storePaths.databaseFile}-wal`, `${storePaths.databaseFile}-shm`].filter((path) => existsSync(path));
      expect(sidecarsAfter).toEqual(sidecarsBefore);
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
