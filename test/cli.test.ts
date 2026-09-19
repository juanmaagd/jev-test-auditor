import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';
import type { AuditFileResult, AuditResult } from '../src/domain/audit.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import { canonicalizeEvidenceBundle } from '../src/index.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

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

describe('CLI foundation', () => {
  it('prints help from the public CLI seam, documenting --inspect-payloads', async () => {
    const output = captureOutput();

    const exitCode = await runCli(['--help'], output.io);

    expect(exitCode).toBe(0);
    expect(output.lines[0]).toContain('Usage:');
    expect(output.lines[0]).toContain('--inspect-payloads');
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
