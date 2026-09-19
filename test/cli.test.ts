import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';
import type { AuditFileResult, AuditResult } from '../src/domain/audit.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import { canonicalizeEvidenceBundle } from '../src/index.js';
import type { TestCase, TestCaseId, TestModifierKind } from '../src/domain/test-understanding.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
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
    + 'tokens 726..2631, follow-up max 2631, usd 0.000030492..0.000221004 — see test/estimate.test.ts for the arithmetic)',
    async () => {
      const output = captureOutput();

      const exitCode = await runCli(['audit', '--dry-run', '--json'], output.io, { audit: async () => dryRunGoldenAudit() });

      expect(exitCode).toBe(0);
      expect(output.lines).toHaveLength(1);
      expect(output.lines[0]).toBe(
        '{"dryRun":true,"reportingOnly":true,"rootDir":"/workspace","model":"jev-1.13","snapshotVersion":1,'
        + '"asOf":"2026-09-19","discovered":4,"evaluable":1,'
        + '"skipped":{"total":3,"byReason":{"skip":1,"todo":1,"evidence-unavailable":1}},'
        + '"initialCalls":1,"followUpCalls":{"min":0,"max":1},"evidenceBytes":477,'
        + '"estimatedInputTokens":{"min":726,"max":2631},'
        + '"estimatedFollowUpInputTokens":{"min":0,"max":2631},'
        + '"estimatedUsd":{"min":0.000030492,"max":0.000221004},'
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
    expect(report).toContain('2026-09-19');
    expect(report).toContain('Discovered test cases: 4');
    expect(report).toContain('Evaluable: 1');
    expect(report).toContain('Skipped: 3 (skip: 1, todo: 1, evidence-unavailable: 1)');
    expect(report).toContain('Initial Jev calls');
    expect(report).toContain('1');
    expect(report).toContain('Evidence bytes');
    expect(report).toContain('477');
    expect(report).toContain('Estimated input tokens');
    expect(report).toContain('726 - 2631');
    expect(report).toContain('Estimated follow-up input tokens');
    expect(report).toContain('Estimated cost in USD (approximate): 0.000030492 - 0.000221004');
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
