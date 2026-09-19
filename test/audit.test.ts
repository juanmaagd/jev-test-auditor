import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import type {
  AuditEvidenceBuildRequest,
  AuditEvidenceBuildResult,
  AuditPorts,
  AuditRequest,
} from '../src/domain/audit.js';
import type { DiscoveredTestFile, DiscoveryResult } from '../src/domain/discovery.js';
import type { TestExtractionResult } from '../src/domain/extraction.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import type { TestCase, TestCaseId } from '../src/domain/test-understanding.js';

const configuration: AuditRequest = {
  rootDir: '/repo',
  include: ['**/*.test.ts'],
  exclude: [],
  concurrency: 4,
  evidence: {
    maxFragmentBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes,
    maxBundleBytes: DEFAULT_EVIDENCE_BUDGET.maxBundleBytes,
    deny: [],
  },
  reportingOnly: true,
};

function discovered(repositoryRelativePath: string): DiscoveredTestFile {
  return { repositoryRelativePath, framework: 'vitest', frameworkEvidence: [] };
}

function extraction(name: string): TestExtractionResult {
  return { testCases: [{
    id: `tc:v1:${name}`,
    repositoryRelativePath: `${name}.test.ts`,
    kind: 'test',
    framework: 'vitest',
    name,
    structuralAncestry: [{ kind: 'test', name, ordinal: 0 }],
    source: `test('${name}', () => {});`,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    modifiers: [],
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
  }], dynamicMetadata: [], diagnostics: [] };
}

/** A minimal, empty, but structurally valid bundle: no fragments, no denials, nothing omitted. A test fixture double for a *successful* selection with nothing to report — never how the production adapter represents a *failed* one (see evidence-audit-port.test.ts). */
function emptyBundle(testCaseId: TestCaseId): EvidenceBundle {
  return buildEvidenceBundle({
    testCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [],
    denied: [],
    unresolved: [],
    omitted: [],
  });
}

/** Duplicates one extracted test case into two independent ones (distinct id/name), for tests exercising per-test-case evidence outcomes within a single file. */
function twoTestCases(name: string): readonly TestCase[] {
  const base = extraction(name).testCases[0];
  if (base === undefined) throw new Error('expected a base test case');
  return [
    { ...base, id: `tc:v1:${name}-1` as TestCaseId, name: `${name}-1` },
    { ...base, id: `tc:v1:${name}-2` as TestCaseId, name: `${name}-2` },
  ];
}

/** Default evidence build: one empty bundle per test case, in order, no diagnostics. Overridable per test. */
async function defaultEvidenceBuild(request: AuditEvidenceBuildRequest): Promise<AuditEvidenceBuildResult> {
  return { bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] };
}

function portsFor(
  discovery: DiscoveryResult,
  read: (path: string) => Promise<string>,
  extract: (path: string, source: string) => TestExtractionResult,
  evidenceBuild: (request: AuditEvidenceBuildRequest) => Promise<AuditEvidenceBuildResult> = defaultEvidenceBuild,
): AuditPorts {
  return {
    discovery: { discover: async () => discovery },
    sourceReader: { read: async ({ repositoryRelativePath }) => read(repositoryRelativePath) },
    extractor: { extract: ({ repositoryRelativePath, sourceText }) => extract(repositoryRelativePath, sourceText) },
    evidence: { build: evidenceBuild },
  };
}

const zeroEvidenceTotals = {
  evidenceBundles: 0,
  evidenceFragments: 0,
  evidenceTruncatedFragments: 0,
  evidenceOmitted: 0,
  evidenceDenied: 0,
  evidenceUnresolved: 0,
};

describe('audit application', () => {
  it('sorts files and exclusions, reads and extracts each file once, and aggregates results', async () => {
    const reads: string[] = [];
    const extracts: string[] = [];
    const discovery: DiscoveryResult = {
      files: [discovered('z.test.ts'), discovered('a.test.ts')],
      excluded: [
        { repositoryRelativePath: 'z.skip.ts', reason: 'configured-exclude', evidence: [] },
        { repositoryRelativePath: 'a.skip.ts', reason: 'default-exclude', evidence: [] },
      ],
      diagnostics: [],
    };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async (path) => { reads.push(path); return `source:${path}`; },
      (path) => { extracts.push(path); return extraction(path); },
    ));

    expect(reads).toEqual(['a.test.ts', 'z.test.ts']);
    expect(extracts).toEqual(['a.test.ts', 'z.test.ts']);
    expect(result.files.map((file) => file.discovered.repositoryRelativePath)).toEqual(['a.test.ts', 'z.test.ts']);
    expect(result.excluded.map((file) => file.repositoryRelativePath)).toEqual(['a.skip.ts', 'z.skip.ts']);
    expect(result.totals).toEqual({
      files: 2, excluded: 2, testCases: 2, dynamicMetadata: 0, diagnostics: 0, ...zeroEvidenceTotals, evidenceBundles: 2,
    });
    expect(result.reportingOnly).toBe(true);
    expect(result.files.every((file) => file.evidence.length === 1)).toBe(true);
  });

  it('keeps going after deterministic read and extraction failures', async () => {
    const discovery: DiscoveryResult = {
      files: [discovered('extract.test.ts'), discovered('read.test.ts'), discovered('ok.test.ts')],
      excluded: [],
      diagnostics: [],
    };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async (path) => {
        if (path === 'read.test.ts') throw new Error('read boom');
        return path;
      },
      (path) => {
        if (path === 'extract.test.ts') throw new Error('extract boom');
        return extraction(path);
      },
    ));

    expect(result.files.map((file) => file.discovered.repositoryRelativePath)).toEqual([
      'extract.test.ts', 'ok.test.ts', 'read.test.ts',
    ]);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'read.test.ts')?.diagnostics).toEqual([
      { code: 'source-read-failed', message: 'Unable to read read.test.ts: read boom', severity: 'error' },
    ]);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'extract.test.ts')?.diagnostics).toEqual([
      { code: 'extraction-failed', message: 'Unable to extract extract.test.ts: extract boom', severity: 'error' },
    ]);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'ok.test.ts')?.testCases).toHaveLength(1);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'read.test.ts')?.evidence).toEqual([]);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'extract.test.ts')?.evidence).toEqual([]);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'ok.test.ts')?.evidence).toHaveLength(1);
    expect(result.totals.diagnostics).toBe(2);
  });

  it('preserves discovery diagnostics and returns an empty reporting-only result on discovery failure', async () => {
    const result = await runAudit(configuration, {
      discovery: { discover: async () => { throw new Error('discovery boom'); } },
      sourceReader: { read: async () => '' },
      extractor: { extract: () => ({ testCases: [], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: defaultEvidenceBuild },
    });

    expect(result.files).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'discovery-failed', message: 'Unable to discover test files: discovery boom', severity: 'error' },
    ]);
    expect(result.totals).toEqual({ files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 1, ...zeroEvidenceTotals });
    expect(result.reportingOnly).toBe(true);
  });

  it('preserves discovery exclusions and root diagnostics on a successful scan', async () => {
    const discovery: DiscoveryResult = {
      files: [],
      excluded: [{ repositoryRelativePath: 'ignored.test.ts', reason: 'e2e-v1', evidence: ['e2e-path-segment'] }],
      diagnostics: [{ code: 'package-json-invalid', message: 'package warning', severity: 'warning' }],
    };

    const result = await runAudit(configuration, portsFor(discovery, async () => '', () => ({
      testCases: [], dynamicMetadata: [], diagnostics: [],
    })));

    expect(result.excluded).toEqual(discovery.excluded);
    expect(result.diagnostics).toEqual(discovery.diagnostics);
    expect(result.totals.diagnostics).toBe(1);
  });

  it('never calls the evidence port for a file with no extracted test cases', async () => {
    let calls = 0;
    const discovery: DiscoveryResult = {
      files: [discovered('dynamic-only.test.ts')],
      excluded: [],
      diagnostics: [],
    };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async () => 'source',
      () => ({ testCases: [], dynamicMetadata: [], diagnostics: [] }),
      async (request) => { calls += 1; return { bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }; },
    ));

    expect(calls).toBe(0);
    expect(result.files[0]?.evidence).toEqual([]);
    expect(result.totals.evidenceBundles).toBe(0);
  });

  it('isolates an evidence-build failure to its own file: emits one evidence-failed diagnostic with the file path, empties that file\'s evidence, and leaves its test cases and every other file untouched', async () => {
    const discovery: DiscoveryResult = {
      files: [discovered('broken-evidence.test.ts'), discovered('ok.test.ts')],
      excluded: [],
      diagnostics: [],
    };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async (path) => path,
      (path) => extraction(path),
      async (request) => {
        if (request.repositoryRelativePath === 'broken-evidence.test.ts') throw new Error('evidence boom');
        return { bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] };
      },
    ));

    const broken = result.files.find((file) => file.discovered.repositoryRelativePath === 'broken-evidence.test.ts');
    const ok = result.files.find((file) => file.discovered.repositoryRelativePath === 'ok.test.ts');

    expect(broken?.evidence).toEqual([]);
    expect(broken?.testCases).toHaveLength(1);
    expect(ok?.evidence).toHaveLength(1);
    expect(result.diagnostics).toContainEqual({
      code: 'evidence-failed',
      message: 'Unable to build evidence for broken-evidence.test.ts: evidence boom',
      severity: 'error',
      repositoryRelativePath: 'broken-evidence.test.ts',
    });
    expect(result.totals.evidenceBundles).toBe(1);
  });

  it('aggregates fragment, truncation, omission, denial, and unresolved totals across every file\'s bundles', async () => {
    const discovery: DiscoveryResult = {
      files: [discovered('a.test.ts')],
      excluded: [],
      diagnostics: [],
    };

    const richBundle = buildEvidenceBundle({
      testCaseId: 'tc:v1:a.test.ts' as TestCaseId,
      budget: DEFAULT_EVIDENCE_BUDGET,
      fragments: [{
        kind: 'test',
        repositoryRelativePath: 'a.test.ts',
        span: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
        content: 'body',
        contentHash: 'x'.repeat(64),
        selectionReason: 'test-body',
        truncation: { truncated: true, originalBytes: 10, includedBytes: 4 },
      }],
      denied: [{ repositoryRelativePath: 'a/.env', rule: 'deny-list:.env*' }],
      unresolved: [{ specifier: 'left-pad', reason: 'bare-specifier' }],
      omitted: [{ repositoryRelativePath: 'a/big.ts', reason: 'bundle-budget-exhausted' }],
    });

    const result = await runAudit(configuration, portsFor(
      discovery,
      async (path) => path,
      (path) => extraction(path),
      async () => ({ bundles: [richBundle], diagnostics: [] }),
    ));

    expect(result.totals).toMatchObject({
      evidenceBundles: 1,
      evidenceFragments: 1,
      evidenceTruncatedFragments: 1,
      evidenceOmitted: 1,
      evidenceDenied: 1,
      evidenceUnresolved: 1,
    });
  });

  it('merges a per-test-case evidence-selection-failed diagnostic into file and root diagnostics, keeping only the bundle for the succeeding test case (never a placeholder for the failed one)', async () => {
    const discovery: DiscoveryResult = {
      files: [discovered('multi.test.ts')],
      excluded: [],
      diagnostics: [],
    };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async (path) => path,
      () => ({ testCases: twoTestCases('multi.test.ts'), dynamicMetadata: [], diagnostics: [] }),
      async (request) => {
        const [first, second] = request.testCases;
        if (first === undefined || second === undefined) throw new Error('expected two test cases');
        return {
          bundles: [emptyBundle(first.id)],
          diagnostics: [{
            code: 'evidence-selection-failed',
            message: `Unable to select evidence for test case ${second.id} ("${second.name}"): selection boom`,
            severity: 'error',
          }],
        };
      },
    ));

    const file = result.files.find((entry) => entry.discovered.repositoryRelativePath === 'multi.test.ts');
    expect(file?.testCases).toHaveLength(2);
    expect(file?.evidence).toHaveLength(1);
    expect(file?.evidence[0]?.testCaseId).toBe(twoTestCases('multi.test.ts')[0]?.id);
    expect(file?.diagnostics).toContainEqual(expect.objectContaining({
      code: 'evidence-selection-failed',
      severity: 'error',
      message: expect.stringContaining('multi.test.ts-2') as unknown as string,
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'evidence-selection-failed',
      repositoryRelativePath: 'multi.test.ts',
    }));
    expect(result.totals.evidenceBundles).toBe(1);
  });
});
