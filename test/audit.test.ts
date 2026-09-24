import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import { computeDryRunCacheHits } from '../src/application/audit.js';
import { createAuditCacheKeyPort } from '../src/adapters/cache-key.js';
import type {
  AuditCacheKeyPort,
  AuditEvaluationPort,
  AuditEvaluationRequest,
  AuditEvidenceBuildRequest,
  AuditEvidenceBuildResult,
  AuditFileResult,
  AuditPorts,
  AuditRequest,
  AuditStorePort,
  AuditStoreWorkItemOutcome,
} from '../src/domain/audit.js';
import type { ClassificationResult, OverallClassificationStatus } from '../src/domain/classification.js';
import type { DiscoveredTestFile, DiscoveryResult } from '../src/domain/discovery.js';
import type { TestExtractionResult } from '../src/domain/extraction.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import { AuditCacheOnlyUnavailableError } from '../src/domain/audit.js';
import { JevAuthError, JevRateLimitError, type JevEvaluation } from '../src/domain/jev-gateway.js';
import type { TestCase, TestCaseId, TestModifierKind } from '../src/domain/test-understanding.js';

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
  store: {
    databasePath: undefined,
  },
  schedule: {
    requestsPerMinute: 1_200,
    tokensPerSecond: 250_000,
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

/** Duplicates one extracted test case into `count` independent ones (distinct id/name), for evaluation-wiring tests that need several evaluable test cases in one file. */
function manyTestCases(name: string, count: number): readonly TestCase[] {
  const base = extraction(name).testCases[0];
  if (base === undefined) throw new Error('expected a base test case');
  return Array.from({ length: count }, (_unused, index) => ({
    ...base,
    id: `tc:v1:${name}-${index + 1}` as TestCaseId,
    name: `${name}-${index + 1}`,
  }));
}

function testCaseWithModifiers(id: string, modifierKinds: readonly TestModifierKind[], repositoryRelativePath = 'a.test.ts'): TestCase {
  const base = extraction('modified').testCases[0];
  if (base === undefined) throw new Error('expected a base test case');
  const span = base.span;
  return {
    ...base,
    id: id as TestCaseId,
    name: id,
    repositoryRelativePath,
    modifiers: modifierKinds.map((kind) => ({ kind, span })),
  };
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
      files: 2, excluded: 2, testCases: 2, dynamicMetadata: 0, diagnostics: 0, unsupportedFrameworkFiles: 0,
      ...zeroEvidenceTotals, evidenceBundles: 2,
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
    expect(result.totals).toEqual({
      files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 1, unsupportedFrameworkFiles: 0, ...zeroEvidenceTotals,
    });
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

  it('counts files carrying an unsupported-framework diagnostic in totals.unsupportedFrameworkFiles (B-1)', async () => {
    const discovery: DiscoveryResult = {
      files: [
        discovered('bun.test.ts'),
        discovered('ok.test.ts'),
        { repositoryRelativePath: 'also-unknown.test.ts', framework: 'unknown', frameworkEvidence: [] },
      ],
      excluded: [],
      diagnostics: [],
    };
    const unsupportedFrameworkDiagnostic = {
      code: 'unsupported-framework',
      message: 'Test framework could not be attributed for this file; found test-framework-looking import(s): bun:test.',
      severity: 'warning' as const,
    };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async (path) => path,
      (path) => {
        if (path === 'ok.test.ts') return extraction(path);
        return { testCases: [], dynamicMetadata: [], diagnostics: [unsupportedFrameworkDiagnostic] };
      },
    ));

    expect(result.totals.unsupportedFrameworkFiles).toBe(2);
    expect(result.totals.diagnostics).toBe(2);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'bun.test.ts')?.diagnostics)
      .toEqual([unsupportedFrameworkDiagnostic]);
    expect(result.diagnostics).toContainEqual({ ...unsupportedFrameworkDiagnostic, repositoryRelativePath: 'bun.test.ts' });
  });

  describe('jest project-config fallback (odd/tasks/jest-ambient-globals.md)', () => {
    function portsWithJestHint(
      discovery: DiscoveryResult,
      resolveHint: (repositoryRelativePath: string) => Promise<'jest' | undefined>,
    ): AuditPorts {
      return {
        discovery: { discover: async () => discovery },
        sourceReader: { read: async () => 'source' },
        extractor: {
          extract: ({ repositoryRelativePath, frameworkHint }) => ({
            testCases: [{
              ...extraction(repositoryRelativePath).testCases[0]!,
              framework: frameworkHint ?? 'unknown',
            }],
            dynamicMetadata: [],
            diagnostics: [],
          }),
        },
        evidence: { build: defaultEvidenceBuild },
        jestFrameworkHint: { resolve: resolveHint },
      };
    }

    it('corrects discovered.framework and the extracted framework from an unknown file via the project-config hint', async () => {
      const discovery: DiscoveryResult = {
        files: [{ repositoryRelativePath: 'ambient.test.ts', framework: 'unknown', frameworkEvidence: [] }],
        excluded: [],
        diagnostics: [],
      };

      const result = await runAudit(configuration, portsWithJestHint(discovery, async () => 'jest'));

      const file = result.files.find((entry) => entry.discovered.repositoryRelativePath === 'ambient.test.ts');
      expect(file?.discovered.framework).toBe('jest');
      expect(file?.testCases[0]?.framework).toBe('jest');
    });

    it('never consults the hint port when discovery already attributed a framework from imports', async () => {
      let calls = 0;
      const discovery: DiscoveryResult = { files: [discovered('vitest-import.test.ts')], excluded: [], diagnostics: [] };

      const result = await runAudit(configuration, portsWithJestHint(discovery, async () => { calls += 1; return 'jest'; }));

      expect(calls).toBe(0);
      const file = result.files.find((entry) => entry.discovered.repositoryRelativePath === 'vitest-import.test.ts');
      expect(file?.discovered.framework).toBe('vitest');
    });

    it('leaves discovered.framework as unknown when the hint port itself finds nothing (e.g. a genuine Vitest project)', async () => {
      const discovery: DiscoveryResult = {
        files: [{ repositoryRelativePath: 'ambient.test.ts', framework: 'unknown', frameworkEvidence: [] }],
        excluded: [],
        diagnostics: [],
      };

      const result = await runAudit(configuration, portsWithJestHint(discovery, async () => undefined));

      const file = result.files.find((entry) => entry.discovered.repositoryRelativePath === 'ambient.test.ts');
      expect(file?.discovered.framework).toBe('unknown');
      expect(file?.testCases[0]?.framework).toBe('unknown');
    });

    it('behaves exactly as before when no jestFrameworkHint port is provided at all', async () => {
      const discovery: DiscoveryResult = {
        files: [{ repositoryRelativePath: 'ambient.test.ts', framework: 'unknown', frameworkEvidence: [] }],
        excluded: [],
        diagnostics: [],
      };
      const ports: AuditPorts = {
        discovery: { discover: async () => discovery },
        sourceReader: { read: async () => 'source' },
        extractor: {
          extract: ({ repositoryRelativePath, frameworkHint }) => ({
            testCases: [{ ...extraction(repositoryRelativePath).testCases[0]!, framework: frameworkHint ?? 'unknown' }],
            dynamicMetadata: [],
            diagnostics: [],
          }),
        },
        evidence: { build: defaultEvidenceBuild },
      };

      const result = await runAudit(configuration, ports);

      const file = result.files.find((entry) => entry.discovered.repositoryRelativePath === 'ambient.test.ts');
      expect(file?.discovered.framework).toBe('unknown');
      expect(file?.testCases[0]?.framework).toBe('unknown');
    });
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

// --- Evaluation wiring (Phase 4, task P4-4) --------------------------------

function classificationFor(
  testCaseId: TestCaseId,
  overrides: Partial<{
    status: OverallClassificationStatus;
    inputTokens: number;
    outputTokens: number;
    responded: string;
    matchesPin: boolean;
  }> = {},
): ClassificationResult {
  return {
    testCaseId,
    repositoryRelativePath: 'a.test.ts',
    name: String(testCaseId),
    status: overrides.status ?? 'healthy',
    dimensions: [],
    findings: [],
    policyVersion: 1,
    rubricVersion: 1,
    model: {
      requested: 'jev-1.13.0',
      responded: overrides.responded ?? 'jev-1.13.0',
      matchesPin: overrides.matchesPin ?? true,
    },
    usage: { inputTokens: overrides.inputTokens ?? 10, outputTokens: overrides.outputTokens ?? 0 },
  };
}

/**
 * A stub `AuditEvaluationPort` whose `evaluate` behavior is fully controlled
 * per test case id. Callers still hand back only a `ClassificationResult`
 * (the Phase 4 shape this test file's fixtures already build); this helper
 * synthesizes the matching raw `JevEvaluation` `AuditEvaluationPort.evaluate`
 * now also returns (Phase 5, task P5-1). By default the evaluation's
 * `requestedModel`/`respondedModel`/`modelMatchesPin`/`attempts` mirror the
 * classification's own `model` fields (and a fixed `attempts: 1`) so none of
 * this file's existing call sites need to change. `evaluationOverrides`
 * lets a test specify the raw evaluation's fields independently of the
 * classification — needed to prove (per the Phase 5 P5-1 verifier findings)
 * that `runAudit` forwards the evaluation and the classification as
 * genuinely distinct objects, rather than one being mechanically derived
 * from the other in a way that could never surface a mix-up between them.
 */
function stubEvaluationPort(
  handler: (request: AuditEvaluationRequest) => Promise<ClassificationResult>,
  evaluationOverrides: Partial<Pick<JevEvaluation, 'requestedModel' | 'respondedModel' | 'modelMatchesPin' | 'attempts' | 'answers' | 'latencyMs' | 'attemptLatenciesMs'>> = {},
): AuditEvaluationPort {
  return {
    async evaluate(request) {
      const classification = await handler(request);
      const evaluation: JevEvaluation = {
        requestedModel: evaluationOverrides.requestedModel ?? classification.model.requested,
        respondedModel: evaluationOverrides.respondedModel ?? classification.model.responded,
        modelMatchesPin: evaluationOverrides.modelMatchesPin ?? classification.model.matchesPin,
        answers: evaluationOverrides.answers ?? {},
        usage: classification.usage,
        attempts: evaluationOverrides.attempts ?? 1,
        ...(evaluationOverrides.latencyMs === undefined ? {} : { latencyMs: evaluationOverrides.latencyMs }),
        ...(evaluationOverrides.attemptLatenciesMs === undefined ? {} : { attemptLatenciesMs: evaluationOverrides.attemptLatenciesMs }),
      };
      return { classification, evaluation };
    },
  };
}

describe('evaluation wiring (--evaluate)', () => {
  it('produces no evaluation result at all when ports.evaluation is not provided (the entire opt-in gate)', async () => {
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async () => 'source',
      () => extraction('a'),
    ));

    expect(result.evaluation).toBeUndefined();
  });

  it('evaluates only evaluable test cases, matching classifyTestCase\'s skip/todo/evidence-unavailable definition exactly (shared, not duplicated)', async () => {
    const evaluableCase = testCaseWithModifiers('tc:v1:eval-1', [], 'mixed.test.ts');
    const skipCase = testCaseWithModifiers('tc:v1:skip-1', ['skip'], 'mixed.test.ts');
    const todoCase = testCaseWithModifiers('tc:v1:todo-1', ['todo'], 'mixed.test.ts');
    const missingBundleCase = testCaseWithModifiers('tc:v1:missing-1', [], 'mixed.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('mixed.test.ts')], excluded: [], diagnostics: [] };
    const evaluated: TestCaseId[] = [];
    const evaluation = stubEvaluationPort(async (request) => {
      evaluated.push(request.testCase.id);
      return classificationFor(request.testCase.id);
    });

    const result = await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: {
        extract: () => ({
          testCases: [evaluableCase, skipCase, todoCase, missingBundleCase],
          dynamicMetadata: [],
          diagnostics: [],
        }),
      },
      evidence: {
        build: async (request) => ({
          bundles: request.testCases
            .filter((testCase) => testCase.id !== missingBundleCase.id)
            .map((testCase) => emptyBundle(testCase.id)),
          diagnostics: [],
        }),
      },
      evaluation,
    });

    expect(evaluated).toEqual([evaluableCase.id]);
    expect(result.evaluation?.classifications.map((entry) => entry.testCaseId)).toEqual([evaluableCase.id]);
    expect(result.evaluation?.totals).toMatchObject({
      evaluated: 1,
      failed: 0,
      skipped: { total: 3, byReason: { skip: 1, todo: 1, 'evidence-unavailable': 1 } },
    });
  });

  it('isolates one failed evaluation to an evaluation-failed diagnostic naming the test case id and the typed error kind, produces no classification for it, and never counts it as healthy', async () => {
    const okCase = testCaseWithModifiers('tc:v1:iso-ok', [], 'iso.test.ts');
    const failingCase = testCaseWithModifiers('tc:v1:iso-fail', [], 'iso.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('iso.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => {
      if (request.testCase.id === failingCase.id) throw new JevRateLimitError(4);
      return classificationFor(request.testCase.id, { status: 'healthy' });
    });

    const result = await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [okCase, failingCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: {
        build: async (request) => ({
          bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)),
          diagnostics: [],
        }),
      },
      evaluation,
    });

    expect(result.evaluation?.classifications.map((entry) => entry.testCaseId)).toEqual([okCase.id]);
    expect(result.evaluation?.totals).toMatchObject({ evaluated: 1, failed: 1 });
    expect(result.evaluation?.totals.statusCounts).toEqual({ healthy: 1, weak: 0, misleading: 0, 'needs-review': 0 });
    const diagnostic = result.diagnostics.find((entry) => entry.code === 'evaluation-failed');
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.message).toContain(failingCase.id);
    expect(diagnostic?.message).toContain(failingCase.name);
    expect(diagnostic?.message).toContain('rate-limit');
    expect(diagnostic?.repositoryRelativePath).toBe('iso.test.ts');
    // Parity with `evidence-selection-failed`: the same diagnostic also lands in the owning file's own diagnostics.
    const file = result.files.find((entry) => entry.discovered.repositoryRelativePath === 'iso.test.ts');
    expect(file?.diagnostics).toContainEqual(expect.objectContaining({ code: 'evaluation-failed' }));
  });

  it('never fabricates a verdict on failure: a failing test case contributes zero entries to classifications and zero to statusCounts', async () => {
    const failingCase = testCaseWithModifiers('tc:v1:only-fail', [], 'fail.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('fail.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async () => { throw new Error('boom'); });

    const result = await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [failingCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
    });

    expect(result.evaluation?.classifications).toEqual([]);
    expect(result.evaluation?.totals.statusCounts).toEqual({ healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 });
    expect(result.evaluation?.totals.failed).toBe(1);
  });

  it('reports total usage input/output tokens, status counts, and a model mismatch count without letting an early success hide a later mismatch', async () => {
    const cases = manyTestCases('usage', 3);
    const discovery: DiscoveryResult = { files: [discovered('usage.test.ts')], excluded: [], diagnostics: [] };
    const responses = new Map<TestCaseId, ClassificationResult>([
      [cases[0]!.id, classificationFor(cases[0]!.id, { status: 'healthy', inputTokens: 100, outputTokens: 1, matchesPin: true, responded: 'jev-1.13.0' })],
      [cases[1]!.id, classificationFor(cases[1]!.id, { status: 'weak', inputTokens: 200, outputTokens: 2, matchesPin: false, responded: 'jev-1.14.0' })],
      [cases[2]!.id, classificationFor(cases[2]!.id, { status: 'misleading', inputTokens: 300, outputTokens: 3, matchesPin: true, responded: 'jev-1.13.0' })],
    ]);
    const evaluation = stubEvaluationPort(async (request) => {
      const response = responses.get(request.testCase.id);
      if (response === undefined) throw new Error('unexpected test case');
      return response;
    });

    const result = await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [...cases], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
    });

    expect(result.evaluation?.totals).toEqual({
      evaluated: 3,
      cached: 0,
      failed: 0,
      skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
      usage: { inputTokens: 600, outputTokens: 6 },
      statusCounts: { healthy: 1, weak: 1, misleading: 1, 'needs-review': 0 },
      respondedModel: 'jev-1.13.0',
      modelMismatches: 1,
    });
  });

  it('runs evaluation through the adaptive scheduler at a stable concurrency (from configuration.concurrency) when nothing ever throttles, keeping results in deterministic submission order and never exceeding the configured bound even when later items resolve first', async () => {
    const cases = manyTestCases('pool', 4);
    const discovery: DiscoveryResult = { files: [discovered('pool.test.ts')], excluded: [], diagnostics: [] };
    const active = { count: 0, max: 0 };
    // Deliberately staggered so the FIRST-submitted item finishes LAST and the
    // second-submitted item finishes first: a correct scheduler must still return
    // results in submission order; an unbounded implementation would start
    // all four `evaluate` calls immediately (four workers were spun up in
    // the very own author's original mutation of dropping the pool bound),
    // which `active.max` below would catch even before any timer fires. Every
    // dispatch here is a first-attempt success (`attempts` defaults to 1, never
    // retried), so the adaptive controller (Phase 5, task P5-3) never reduces —
    // this test proves the no-throttling case stays exactly as bounded as
    // Phase 4's fixed-size `runBoundedPool` was; adaptive reduction/restoration
    // itself is covered by the "adaptive scheduling" describe block below.
    const delaysMs: Record<string, number> = {
      [cases[0]!.id]: 30,
      [cases[1]!.id]: 5,
      [cases[2]!.id]: 20,
      [cases[3]!.id]: 10,
    };
    const evaluation = stubEvaluationPort(async (request) => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      try {
        await new Promise((resolve) => { setTimeout(resolve, delaysMs[request.testCase.id] ?? 0); });
        return classificationFor(request.testCase.id);
      } finally {
        active.count -= 1;
      }
    });

    const result = await runAudit({ ...configuration, concurrency: 2 }, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [...cases], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
    });

    expect(result.evaluation?.classifications.map((entry) => entry.testCaseId)).toEqual(cases.map((testCase) => testCase.id));
    expect(active.max).toBeLessThanOrEqual(2);
  });
});

// --- Audit store persistence wiring (Phase 5, task P5-1) --------------------

interface FakeStoreCall {
  readonly runId: string;
  readonly outcome: AuditStoreWorkItemOutcome;
}

interface FakeStore extends AuditStorePort {
  readonly beginRunCalls: string[];
  readonly workItemCalls: FakeStoreCall[];
  readonly lookupCalls: string[];
  readonly finishRunCalls: string[];
  readonly closeCalls: number;
}

function identityKeyFor(identity: { readonly testCaseId: TestCaseId; readonly repositoryRelativePath: string; readonly name: string }): string {
  return JSON.stringify([identity.testCaseId, identity.repositoryRelativePath, identity.name]);
}

function fakeStore(): FakeStore {
  const beginRunCalls: string[] = [];
  const workItemCalls: FakeStoreCall[] = [];
  const lookupCalls: string[] = [];
  const finishRunCalls: string[] = [];
  const rootDirByRunId = new Map<string, string>();
  let closeCalls = 0;
  let nextRunId = 0;

  return {
    beginRunCalls,
    workItemCalls,
    lookupCalls,
    finishRunCalls,
    get closeCalls() { return closeCalls; },
    async beginRun(rootDir: string): Promise<string> {
      beginRunCalls.push(rootDir);
      nextRunId += 1;
      const runId = `run-${nextRunId}`;
      rootDirByRunId.set(runId, rootDir);
      return runId;
    },
    async recordWorkItem(runId: string, outcome: AuditStoreWorkItemOutcome): Promise<void> {
      workItemCalls.push({ runId, outcome });
    },
    // Mirrors the real sqlite adapter's documented lookup rule (`src/domain/audit.ts`,
    // `AuditStorePort.lookup`'s own doc): the most recent (searched backward through insertion
    // order) `completed` outcome under `cacheKey` whose evaluation's `modelMatchesPin` is `true`;
    // a `cached` outcome is never itself eligible as a source. Records every call in
    // `lookupCalls` so a test can assert `--fresh` skips the lookup entirely, not merely that it
    // ignores whatever the lookup would have returned.
    async lookup(cacheKey: string): Promise<{ readonly evaluation: JevEvaluation } | undefined> {
      lookupCalls.push(cacheKey);
      for (let index = workItemCalls.length - 1; index >= 0; index -= 1) {
        const { outcome } = workItemCalls[index]!;
        if (outcome.state === 'completed' && outcome.cacheKey === cacheKey && outcome.evaluation.modelMatchesPin) {
          return { evaluation: outcome.evaluation };
        }
      }
      return undefined;
    },
    async finishRun(runId: string): Promise<void> {
      finishRunCalls.push(runId);
    },
    // Mirrors the real sqlite adapter's `loadRunState` (Phase 5, task P5-4): `undefined` when
    // `beginRun` was never called for `runId`; otherwise the LAST recorded outcome per identity
    // (array order is insertion order, so a later `Map.set` for the same key overwrites an
    // earlier one), filtered down to the four terminal states — a `pending`/`running` last row is
    // never included, exactly like the real adapter's own `MAX(id)`-grouped query.
    async loadRunState(runId: string): Promise<{ readonly rootDir: string; readonly rootDirCanonical: boolean; readonly finished: boolean; readonly terminalWorkItems: readonly AuditStoreWorkItemOutcome[] } | undefined> {
      const rootDir = rootDirByRunId.get(runId);
      if (rootDir === undefined) return undefined;
      const lastByIdentity = new Map<string, AuditStoreWorkItemOutcome>();
      for (const call of workItemCalls) {
        if (call.runId !== runId) continue;
        lastByIdentity.set(identityKeyFor(call.outcome.identity), call.outcome);
      }
      const terminalWorkItems = [...lastByIdentity.values()].filter(
        (outcome) => outcome.state === 'completed' || outcome.state === 'cached' || outcome.state === 'failed' || outcome.state === 'skipped',
      );
      // Not exercising rootDir-identity behavior (see `test/resume.test.ts` and
      // `test/resume-root-dir-identity.test.ts` for that) — every run this fake begins is
      // considered already canonical, matching how `beginRun` is always called in production.
      return { rootDir, rootDirCanonical: true, finished: finishRunCalls.includes(runId), terminalWorkItems };
    },
    // Identity pass-through: this fake never exercises real filesystem canonicalization (see the
    // adapter-level tests in `test/sqlite-audit-store.test.ts` for that behavior itself).
    async canonicalizeRootDir(rootDir: string): Promise<string> {
      return rootDir;
    },
    async close(): Promise<void> {
      closeCalls += 1;
    },
  };
}

describe('audit store persistence wiring (Phase 5, task P5-1)', () => {
  it('never touches the store when ports.evaluation is absent (offline audit), even if a store port is supplied', async () => {
    const store = fakeStore();
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };

    await runAudit(configuration, { ...portsFor(discovery, async () => 'source', () => extraction('a')), store });

    expect(store.beginRunCalls).toEqual([]);
    expect(store.workItemCalls).toEqual([]);
    expect(store.finishRunCalls).toEqual([]);
  });

  it('begins one run, persists a completed work item with its raw evaluation and classification, and finishes the run', async () => {
    const store = fakeStore();
    const evaluableCase = testCaseWithModifiers('tc:v1:store-ok', [], 'store.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('store.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id, { status: 'healthy' }));

    const result = await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
    });

    expect(store.beginRunCalls).toEqual(['/repo']);
    // Phase 5, task P5-3: a `pending` checkpoint recorded up front, then `running` once the
    // scheduler picks the item up, then the terminal `completed` record — all three for the
    // exact same run and identity, in that order.
    expect(store.workItemCalls).toHaveLength(3);
    const identity = { testCaseId: evaluableCase.id, repositoryRelativePath: 'store.test.ts', name: evaluableCase.name };
    expect(store.workItemCalls[0]).toEqual({ runId: 'run-1', outcome: { state: 'pending', identity } });
    expect(store.workItemCalls[1]).toEqual({ runId: 'run-1', outcome: { state: 'running', identity } });
    const { runId, outcome } = store.workItemCalls[2]!;
    expect(runId).toBe('run-1');
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') throw new Error('unreachable');
    expect(outcome.identity).toEqual(identity);
    expect(outcome.classification.status).toBe('healthy');
    expect(outcome.evaluation.requestedModel).toBe('jev-1.13.0');
    expect(outcome.evaluation.attempts).toBe(1);
    expect(store.finishRunCalls).toEqual(['run-1']);
    expect(result.evaluation?.classifications.map((entry) => entry.testCaseId)).toEqual([evaluableCase.id]);
  });

  it('persists the raw evaluation\'s own requestedModel, respondedModel, and attempts count independently of the classification\'s fields (P5-1 verifier finding A)', async () => {
    const store = fakeStore();
    const evaluableCase = testCaseWithModifiers('tc:v1:store-distinct', [], 'store-distinct.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('store-distinct.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(
      async (request) => classificationFor(request.testCase.id, { responded: 'classification-responded-model' }),
      { requestedModel: 'evaluation-requested-model', respondedModel: 'evaluation-responded-model', attempts: 4 },
    );

    await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
    });

    // pending, running, completed (Phase 5, task P5-3) — see the previous test's own comment.
    expect(store.workItemCalls).toHaveLength(3);
    const { outcome } = store.workItemCalls[2]!;
    expect(outcome.state).toBe('completed');
    if (outcome.state !== 'completed') throw new Error('unreachable');
    // The evaluation's model fields are distinct from the classification's own model fields —
    // a mix-up between the two objects would fail exactly one of these four assertions.
    expect(outcome.evaluation.requestedModel).toBe('evaluation-requested-model');
    expect(outcome.evaluation.respondedModel).toBe('evaluation-responded-model');
    expect(outcome.evaluation.attempts).toBe(4);
    expect(outcome.classification.model.responded).toBe('classification-responded-model');
  });

  it('persists a failed work item with the same typed error kind and message as its evaluation-failed diagnostic', async () => {
    const store = fakeStore();
    const failingCase = testCaseWithModifiers('tc:v1:store-fail', [], 'store-fail.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('store-fail.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async () => { throw new JevRateLimitError(3); });

    await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [failingCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
    });

    // pending, running, failed (Phase 5, task P5-3) — see the earlier "begins one run" test.
    expect(store.workItemCalls).toHaveLength(3);
    const { outcome } = store.workItemCalls[2]!;
    expect(outcome.state).toBe('failed');
    if (outcome.state !== 'failed') throw new Error('unreachable');
    expect(outcome.identity.testCaseId).toBe(failingCase.id);
    expect(outcome.errorKind).toBe('rate-limit');
    expect(outcome.errorMessage).toContain('Jev rate limit exceeded');
  });

  it('persists one skipped work item per skipped test case, with its reason', async () => {
    const store = fakeStore();
    const skipCase = testCaseWithModifiers('tc:v1:store-skip', ['skip'], 'store-skip.test.ts');
    const todoCase = testCaseWithModifiers('tc:v1:store-todo', ['todo'], 'store-skip.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('store-skip.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [skipCase, todoCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
    });

    expect(store.workItemCalls).toHaveLength(2);
    const outcomesByTestCaseId = new Map(store.workItemCalls.map(({ outcome }) => [outcome.identity.testCaseId, outcome]));
    const skipOutcome = outcomesByTestCaseId.get(skipCase.id);
    const todoOutcome = outcomesByTestCaseId.get(todoCase.id);
    expect(skipOutcome?.state).toBe('skipped');
    expect(todoOutcome?.state).toBe('skipped');
    if (skipOutcome?.state !== 'skipped' || todoOutcome?.state !== 'skipped') throw new Error('unreachable');
    expect(skipOutcome.reason).toBe('skip');
    expect(todoOutcome.reason).toBe('todo');
  });

  it('records every already-terminal work item even when a later one in the same run fails', async () => {
    const store = fakeStore();
    const okCase = testCaseWithModifiers('tc:v1:store-mixed-ok', [], 'store-mixed.test.ts');
    const failingCase = testCaseWithModifiers('tc:v1:store-mixed-fail', [], 'store-mixed.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('store-mixed.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => {
      if (request.testCase.id === failingCase.id) throw new Error('boom');
      return classificationFor(request.testCase.id);
    });

    await runAudit({ ...configuration, concurrency: 1 }, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [okCase, failingCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
    });

    const states = new Map(store.workItemCalls.map(({ outcome }) => [outcome.identity.testCaseId, outcome.state]));
    expect(states.get(okCase.id)).toBe('completed');
    expect(states.get(failingCase.id)).toBe('failed');
  });

  it('records a pending checkpoint for every evaluable item up front, before the scheduler dispatches anything at all', async () => {
    const store = fakeStore();
    const first = testCaseWithModifiers('tc:v1:checkpoint-a', [], 'checkpoint.test.ts');
    const second = testCaseWithModifiers('tc:v1:checkpoint-b', [], 'checkpoint.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('checkpoint.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    // concurrency: 1 makes the whole sequence fully deterministic: item B cannot start until item
    // A has completely finished, so the ordering below is the ONLY possible ordering — not one of
    // several plausible ones a race could reorder.
    await runAudit({ ...configuration, concurrency: 1 }, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [first, second], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
    });

    expect(store.workItemCalls.map(({ outcome }) => `${outcome.state}:${outcome.identity.testCaseId}`)).toEqual([
      `pending:${first.id}`,
      `pending:${second.id}`,
      `running:${first.id}`,
      `completed:${first.id}`,
      `running:${second.id}`,
      `completed:${second.id}`,
    ]);
  });

  it('records pending, then running, then the terminal outcome for a cache hit, exactly like a fresh dispatch', async () => {
    const store = fakeStore();
    const cacheKey = createAuditCacheKeyPort();
    const evaluableCase = testCaseWithModifiers('tc:v1:checkpoint-cached', [], 'checkpoint-cached.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('checkpoint-cached.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));
    const portsForRun: AuditPorts = {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
      cacheKey,
    };

    await runAudit(configuration, portsForRun); // warms the cache
    const secondRunCallsBefore = store.workItemCalls.length;
    await runAudit(configuration, portsForRun); // served from cache

    const secondRunCalls = store.workItemCalls.slice(secondRunCallsBefore);
    expect(secondRunCalls.map(({ outcome }) => outcome.state)).toEqual(['pending', 'running', 'cached']);
  });
});

// --- Adaptive scheduling and checkpoints (Phase 5, task P5-3) --------------

describe('adaptive scheduling (Phase 5, task P5-3)', () => {
  /** A promise this test settles by hand (`resolve`/`reject`), so a scenario can control the exact
   * order dispatches complete in — never a race against real timer delays. */
  function deferredGate(): { readonly promise: Promise<void>; readonly resolve: () => void; readonly reject: (error: unknown) => void } {
    let resolveFn!: () => void;
    let rejectFn!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    return { promise, resolve: resolveFn, reject: rejectFn };
  }

  /** Drains the microtask queue: a `setTimeout` callback only fires once every already-queued
   * microtask (including ones newly enqueued by resolving a promise) has run, so this reliably
   * waits for a `waitForCapacity()`/`evaluate()` chain to progress as far as it currently can,
   * without ever depending on the real clock's actual duration. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }

  /** `count` evaluable test cases in one file, each gated on its own `deferredGate`, so a test
   * fully controls dispatch completion order. `attemptsByIndex` overrides a successful dispatch's
   * `attempts` (default `1`); settling a gate with `.reject(error)` instead of `.resolve()` makes
   * that dispatch fail with `error` rather than succeed. `snapshots[i]` records how many dispatches
   * (including this one) were concurrently inside `evaluate` the instant item `i` started. */
  function gatedScheduling(count: number, attemptsByIndex: Readonly<Record<number, number>> = {}): {
    readonly cases: readonly TestCase[];
    readonly gates: readonly ReturnType<typeof deferredGate>[];
    readonly active: { count: number; max: number };
    readonly snapshots: number[];
    readonly evaluation: AuditEvaluationPort;
  } {
    const cases = manyTestCases('scheduled', count);
    const gates = cases.map(() => deferredGate());
    const active = { count: 0, max: 0 };
    const snapshots: number[] = new Array(count).fill(0);
    const evaluation: AuditEvaluationPort = {
      async evaluate(request) {
        const index = cases.findIndex((testCase) => testCase.id === request.testCase.id);
        active.count += 1;
        active.max = Math.max(active.max, active.count);
        snapshots[index] = active.count;
        try {
          await gates[index]!.promise;
        } finally {
          active.count -= 1;
        }
        return {
          evaluation: {
            requestedModel: 'jev-1.13.0',
            respondedModel: 'jev-1.13.0',
            modelMatchesPin: true,
            answers: {},
            usage: { inputTokens: 10, outputTokens: 0 },
            attempts: attemptsByIndex[index] ?? 1,
          },
          classification: classificationFor(request.testCase.id),
        };
      },
    };
    return { cases, gates, active, snapshots, evaluation };
  }

  function portsFor2(discovery: DiscoveryResult, cases: readonly TestCase[], evaluation: AuditEvaluationPort): AuditPorts {
    return {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [...cases], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
    };
  }

  it('a successful dispatch that needed internal retries (attempts > 1) reduces concurrency for later dispatches, never above the configured ceiling', async () => {
    const discovery: DiscoveryResult = { files: [discovered('scheduled.test.ts')], excluded: [], diagnostics: [] };
    const { cases, gates, active, snapshots, evaluation } = gatedScheduling(4, { 0: 4 });

    const auditPromise = runAudit({ ...configuration, concurrency: 2 }, portsFor2(discovery, cases, evaluation));

    await flush();
    expect(active.max).toBe(2); // the ceiling: items 0 and 1 dispatched together

    gates[0]!.resolve(); // the throttled dispatch settles first
    await flush();
    gates[1]!.resolve();
    await flush();
    expect(snapshots[2]).toBe(1); // reduced to 1: item 2 could only start alone

    gates[2]!.resolve();
    await flush();
    expect(snapshots[3]).toBe(1); // still reduced: item 3 also started alone

    gates[3]!.resolve();
    const result = await auditPromise;

    expect(result.evaluation?.totals.evaluated).toBe(4);
  });

  it('a rate-limit failure reduces concurrency exactly like a successful-but-retried dispatch', async () => {
    const discovery: DiscoveryResult = { files: [discovered('scheduled.test.ts')], excluded: [], diagnostics: [] };
    const { cases, gates, snapshots, evaluation } = gatedScheduling(3);

    const auditPromise = runAudit({ ...configuration, concurrency: 2 }, portsFor2(discovery, cases, evaluation));

    await flush();
    gates[0]!.reject(new JevRateLimitError(4));
    await flush();
    gates[1]!.resolve();
    await flush();
    expect(snapshots[2]).toBe(1); // reduced to 1 by the rate-limit failure: item 2 started alone

    gates[2]!.resolve();
    const result = await auditPromise;

    expect(result.evaluation?.totals).toMatchObject({ evaluated: 2, failed: 1 });
  });

  it('a non-throttle failure (e.g. an auth error) does not reduce concurrency the way a throttled dispatch would', async () => {
    const discovery: DiscoveryResult = { files: [discovered('scheduled.test.ts')], excluded: [], diagnostics: [] };
    const { cases, gates, snapshots, evaluation } = gatedScheduling(3);

    const auditPromise = runAudit({ ...configuration, concurrency: 2 }, portsFor2(discovery, cases, evaluation));

    await flush();
    gates[0]!.reject(new JevAuthError(1));
    await flush();
    gates[1]!.resolve();
    await flush();
    // Unaffected: the ceiling (2) is still fully available, so item 2 dispatches alongside item 1
    // (still in flight) at the moment it starts — a throttled item 0 would have forced this to 1
    // instead (see the "rate-limit failure" test above).
    expect(snapshots[2]).toBe(2);

    gates[2]!.resolve();
    const result = await auditPromise;

    expect(result.evaluation?.totals).toMatchObject({ evaluated: 2, failed: 1 });
  });

  it('a non-throttle failure does not count toward the clean-window restore streak either — only a genuinely clean dispatch does', async () => {
    const discovery: DiscoveryResult = { files: [discovered('scheduled.test.ts')], excluded: [], diagnostics: [] };
    // item 0 throttled (limit -> 1); item 1 a non-throttle failure (must NOT progress the streak);
    // items 2-5 clean (4 of them — one short of DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW's 5 if
    // item 1 correctly contributed nothing); items 6-7 clean, dispatched only once restoration has
    // actually happened. If item 1 wrongly counted as clean, restoration would land one dispatch
    // EARLIER than this test expects, and items 6+7 would start together instead of items 7 alone
    // after item 6 already finished — see the two possible `snapshots[7]` values below.
    const { cases, gates, snapshots, evaluation } = gatedScheduling(8, { 0: 4 });

    const auditPromise = runAudit({ ...configuration, concurrency: 2 }, portsFor2(discovery, cases, evaluation));

    await flush();
    gates[0]!.resolve(); // throttled -> limit 2 -> 1, streak reset to 0
    await flush();
    gates[1]!.reject(new JevAuthError(1)); // neutral: must leave the streak at 0, not 1
    await flush();
    expect(snapshots[2]).toBe(1); // item 2 starts alone either way (limit is still 1 here)

    gates[2]!.resolve(); // clean 1/5 (if item 1 correctly contributed 0) or 2/5 (if it wrongly did)
    await flush();
    gates[3]!.resolve(); // clean 2/5 or 3/5
    await flush();
    gates[4]!.resolve(); // clean 3/5 or 4/5
    await flush();
    gates[5]!.resolve(); // clean 4/5 (correct: no restore yet) or 5/5 (buggy: restores here already)
    await flush();
    expect(snapshots[6]).toBe(1); // item 6 always starts alone at this point either way

    gates[6]!.resolve(); // clean 5/5 under correct behavior -> restores now; already-restored under the bug
    await flush();

    // Correct: restoration happens exactly here (after item 6), so item 7 — the last item — starts
    // alone, with nothing left to pair with. Buggy (item 1 wrongly counted as clean): restoration
    // already happened one step earlier, so items 6 and 7 would have started TOGETHER instead, and
    // this assertion (checked after item 6 already resolved) would see item 7 with no live sibling
    // either way from THIS test alone — the earlier `snapshots[6]` capture is what a premature
    // restore cannot fake, since it is asserted before item 6 even starts either way. The
    // decisive difference is `snapshots[7]`: under the bug, item 7 was already dispatched (and
    // recorded) back when item 6 started — its snapshot would be `2` at that earlier moment. Under
    // correct behavior it is dispatched only now, alone.
    expect(snapshots[7]).toBe(1);

    gates[7]!.resolve();
    const result = await auditPromise;

    expect(result.evaluation?.totals).toMatchObject({ evaluated: 7, failed: 1 });
  });

  it('a cache hit does not count toward the clean-window restore streak either — it made no provider request at all', async () => {
    const discovery: DiscoveryResult = { files: [discovered('cache-neutral.test.ts')], excluded: [], diagnostics: [] };
    // Same shape as the two discriminator tests above: item 0 throttled (limit -> 1); item 1 a
    // cache hit (must contribute nothing to the streak); items 2-6 clean (5 of them); item 7 clean,
    // dispatched only once restoration has actually happened. A cache hit wrongly counted as
    // 'clean' would restore one dispatch earlier, exactly like the auth-error case above.
    const cases = manyTestCases('cache-neutral', 8);
    const cachedCase = cases[1]!;
    const sourceText = 'source';
    const bundleFor = (testCase: TestCase): EvidenceBundle => emptyBundle(testCase.id);
    const cacheKeyPort = createAuditCacheKeyPort();
    const cachedKey = cacheKeyPort.computeKey({ testCase: cachedCase, bundle: bundleFor(cachedCase) }, sourceText);

    const baseStore = fakeStore();
    await baseStore.recordWorkItem('seed-run', {
      state: 'completed',
      identity: { testCaseId: cachedCase.id, repositoryRelativePath: cachedCase.repositoryRelativePath, name: cachedCase.name },
      cacheKey: cachedKey,
      evaluation: {
        requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true,
        answers: {}, usage: { inputTokens: 5, outputTokens: 0 }, attempts: 1,
      },
      classification: classificationFor(cachedCase.id, { status: 'healthy' }),
    });
    const cacheHitGate = deferredGate();
    const store: AuditStorePort = {
      ...baseStore,
      async lookup(key: string) {
        if (key === cachedKey) await cacheHitGate.promise;
        return baseStore.lookup(key);
      },
    };

    const gates = cases.map((testCase) => (testCase.id === cachedCase.id ? undefined : deferredGate()));
    const active = { count: 0, max: 0 };
    const snapshots: number[] = new Array(cases.length).fill(0);
    let evaluateCallsForCachedCase = 0;
    const evaluation: AuditEvaluationPort = {
      async evaluate(request) {
        if (request.testCase.id === cachedCase.id) evaluateCallsForCachedCase += 1;
        const index = cases.findIndex((testCase) => testCase.id === request.testCase.id);
        active.count += 1;
        active.max = Math.max(active.max, active.count);
        snapshots[index] = active.count;
        try {
          await gates[index]!.promise;
        } finally {
          active.count -= 1;
        }
        return {
          evaluation: {
            requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true,
            answers: {}, usage: { inputTokens: 10, outputTokens: 0 }, attempts: index === 0 ? 4 : 1,
          },
          classification: classificationFor(request.testCase.id),
        };
      },
    };

    const auditPromise = runAudit({ ...configuration, concurrency: 2 }, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => sourceText },
      extractor: { extract: () => ({ testCases: [...cases], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => bundleFor(testCase)), diagnostics: [] }) },
      evaluation,
      store,
      cacheKey: cacheKeyPort,
    });

    await flush();
    gates[0]!.resolve(); // throttled -> limit 2 -> 1, streak reset to 0
    await flush();
    cacheHitGate.resolve(); // cache hit settles: must leave the streak at 0, not 1
    await flush();
    expect(evaluateCallsForCachedCase).toBe(0); // never dispatched to the provider at all
    expect(snapshots[2]).toBe(1); // item 2 starts alone either way (limit is still 1 here)

    gates[2]!.resolve(); // clean 1/5 (correct) or 2/5 (buggy)
    await flush();
    gates[3]!.resolve(); // clean 2/5 or 3/5
    await flush();
    gates[4]!.resolve(); // clean 3/5 or 4/5
    await flush();
    gates[5]!.resolve(); // clean 4/5 (correct: no restore yet) or 5/5 (buggy: restores here already)
    await flush();
    expect(snapshots[6]).toBe(1); // item 6 always starts alone at this point either way

    gates[6]!.resolve(); // clean 5/5 under correct behavior -> restores now
    await flush();
    // Decisive: under the bug, item 7 was already dispatched (paired with item 6, back when item 6
    // started) with a recorded snapshot of 2; under correct behavior it only dispatches now, alone.
    expect(snapshots[7]).toBe(1);

    gates[7]!.resolve();
    const result = await auditPromise;

    expect(result.evaluation?.totals).toMatchObject({ evaluated: 7, cached: 1, failed: 0 });
  });

  it('a clean window of consecutive non-throttled dispatches restores concurrency back to the configured ceiling, never above it', async () => {
    const discovery: DiscoveryResult = { files: [discovered('scheduled.test.ts')], excluded: [], diagnostics: [] };
    // item 0 throttled, items 1-5 clean (exactly DEFAULT_ADAPTIVE_CONCURRENCY_RESTORE_WINDOW),
    // items 6-7 clean, dispatched only once restoration has already happened.
    const { cases, gates, active, snapshots, evaluation } = gatedScheduling(8, { 0: 4 });

    const auditPromise = runAudit({ ...configuration, concurrency: 2 }, portsFor2(discovery, cases, evaluation));

    await flush();
    expect(active.max).toBe(2); // initial ceiling reached

    gates[0]!.resolve(); // throttled -> limit drops to 1
    await flush();
    gates[1]!.resolve(); // clean streak 1/5 -> item 2 starts alone
    await flush();
    expect(snapshots[2]).toBe(1);
    gates[2]!.resolve(); // clean streak 2/5 -> item 3 starts alone
    await flush();
    expect(snapshots[3]).toBe(1);
    gates[3]!.resolve(); // clean streak 3/5 -> item 4 starts alone
    await flush();
    expect(snapshots[4]).toBe(1);
    gates[4]!.resolve(); // clean streak 4/5 -> item 5 starts alone
    await flush();
    expect(snapshots[5]).toBe(1);
    gates[5]!.resolve(); // clean streak 5/5 -> RESTORED to the ceiling (2); items 6 and 7 both start
    await flush();
    expect(snapshots[6]).toBe(1);
    expect(snapshots[7]).toBe(2); // item 7 joined item 6 — full ceiling reused, never exceeded

    gates[6]!.resolve();
    gates[7]!.resolve();
    const result = await auditPromise;

    expect(result.evaluation?.totals.evaluated).toBe(8);
    expect(active.max).toBe(2); // the ceiling was reduced, then restored — never exceeded
  });

  // --- Request/token budget wiring --------------------------------------

  function fakeSchedulerTimers(startAt = 1_000_000): { readonly clock: () => number; readonly sleep: (ms: number) => Promise<void>; readonly sleepCalls: number[] } {
    let current = startAt;
    const sleepCalls: number[] = [];
    return {
      clock: () => current,
      sleep: async (ms: number) => { sleepCalls.push(ms); current += ms; },
      sleepCalls,
    };
  }

  it('observes the configured request budget: dispatching beyond requestsPerMinute waits on the injected clock/sleep seam, never the real clock', async () => {
    const discovery: DiscoveryResult = { files: [discovered('budget.test.ts')], excluded: [], diagnostics: [] };
    const cases = manyTestCases('budget', 3);
    let evaluateCalls = 0;
    const evaluation = stubEvaluationPort(async (request) => { evaluateCalls += 1; return classificationFor(request.testCase.id); });
    const { clock, sleep, sleepCalls } = fakeSchedulerTimers();

    const result = await runAudit(
      { ...configuration, concurrency: 3, schedule: { requestsPerMinute: 2, tokensPerSecond: 1_000_000 } },
      portsFor2(discovery, cases, evaluation),
      { clock, sleep },
    );

    expect(evaluateCalls).toBe(3);
    expect(result.evaluation?.totals.evaluated).toBe(3);
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls.some((ms) => ms > 0)).toBe(true);
  });

  it('folds a retried dispatch\'s real attempt count into the request budget, not just the one slot reserved before dispatch', async () => {
    const discovery: DiscoveryResult = { files: [discovered('retry-budget.test.ts')], excluded: [], diagnostics: [] };
    const cases = manyTestCases('retry-budget', 2);
    // concurrency 1 keeps this fully sequential: item 0 dispatches first (reserving 1 request
    // slot), reports 3 attempts (2 retried internally by the gateway before it succeeded), then
    // item 1 dispatches. requestsPerMinute is 2: if the 2 extra retried attempts were silently
    // dropped, only 1 request would ever be recorded and item 1 would sail through unblocked.
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id), { attempts: 3 });
    const { clock, sleep, sleepCalls } = fakeSchedulerTimers(3_000_000);

    const result = await runAudit(
      { ...configuration, concurrency: 1, schedule: { requestsPerMinute: 2, tokensPerSecond: 1_000_000 } },
      portsFor2(discovery, cases, evaluation),
      { clock, sleep },
    );

    expect(result.evaluation?.totals.evaluated).toBe(2);
    // Item 0 alone (1 reserved + 2 extra retried = 3) already exceeds the budget of 2, so item 1
    // must wait — this can only be true if the retried attempts were actually folded in.
    expect(sleepCalls.length).toBeGreaterThan(0);
  });

  it('observes the configured token budget: once already-recorded usage meets tokensPerSecond, the next dispatch waits on the injected seam', async () => {
    const discovery: DiscoveryResult = { files: [discovered('token-budget.test.ts')], excluded: [], diagnostics: [] };
    const cases = manyTestCases('token-budget', 2);
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id, { inputTokens: 100, outputTokens: 0 }));
    const { clock, sleep, sleepCalls } = fakeSchedulerTimers(2_000_000);

    const result = await runAudit(
      { ...configuration, concurrency: 1, schedule: { requestsPerMinute: 1_000, tokensPerSecond: 100 } },
      portsFor2(discovery, cases, evaluation),
      { clock, sleep },
    );

    expect(result.evaluation?.totals.evaluated).toBe(2);
    expect(sleepCalls.length).toBeGreaterThan(0);
  });

  it('never touches the real clock/sleep when RunAuditOptions omits them (production default), and stays fast because the default schedule budget is never exceeded by a small run', async () => {
    const discovery: DiscoveryResult = { files: [discovered('default-clock.test.ts')], excluded: [], diagnostics: [] };
    const cases = manyTestCases('default-clock', 2);
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    const result = await runAudit({ ...configuration, concurrency: 2 }, portsFor2(discovery, cases, evaluation));

    expect(result.evaluation?.totals.evaluated).toBe(2);
  });
});

// --- Content-addressed caching (Phase 5, task P5-2) -------------------------

describe('content-addressed caching (Phase 5, task P5-2)', () => {
  /**
   * The real cache-key port's `computeKey`, with a `classifyCached` that replays the verdict
   * stamped into the stored evaluation's `outputTokens`. These tests pin cache mechanics (no
   * provider request, newest completed row wins); a hit's re-derivation under the real policy is
   * covered end to end by `test/policy-free-cache.test.ts`.
   */
  const STATUS_BY_OUTPUT_TOKENS: Readonly<Record<number, OverallClassificationStatus>> = { 1: 'healthy', 2: 'weak' };
  function statusReplayingCacheKeyPort(): AuditCacheKeyPort {
    const real = createAuditCacheKeyPort();
    return {
      computeKey: (request, fullTestSource) => real.computeKey(request, fullTestSource),
      classifyCached: (request, evaluation) => classificationFor(request.testCase.id, {
        status: STATUS_BY_OUTPUT_TOKENS[evaluation.usage.outputTokens] ?? 'needs-review',
        inputTokens: evaluation.usage.inputTokens,
        outputTokens: evaluation.usage.outputTokens,
      }),
    };
  }

  it('the second of two identical evaluations issues no provider request and reuses the same judgment via a cached work item', async () => {
    const store = fakeStore();
    const cacheKey = statusReplayingCacheKeyPort();
    const evaluableCase = testCaseWithModifiers('tc:v1:cache-warm', [], 'cache-warm.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('cache-warm.test.ts')], excluded: [], diagnostics: [] };
    let evaluateCalls = 0;
    const evaluation = stubEvaluationPort(async (request) => {
      evaluateCalls += 1;
      return classificationFor(request.testCase.id, { status: 'healthy', outputTokens: 1 });
    });

    const portsForRun: AuditPorts = {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
      cacheKey,
    };

    const first = await runAudit(configuration, portsForRun);
    expect(evaluateCalls).toBe(1);
    expect(first.evaluation?.classifications.map((entry) => entry.testCaseId)).toEqual([evaluableCase.id]);
    expect(first.evaluation?.totals).toMatchObject({ evaluated: 1, cached: 0, failed: 0 });

    const second = await runAudit(configuration, portsForRun);
    expect(evaluateCalls).toBe(1); // no new provider request on the warm second run
    expect(second.evaluation?.classifications.map((entry) => entry.testCaseId)).toEqual([evaluableCase.id]);
    expect(second.evaluation?.classifications[0]).toEqual(first.evaluation?.classifications[0]);
    expect(second.evaluation?.totals).toMatchObject({ evaluated: 0, cached: 1, failed: 0 });
    // A cache hit spends zero tokens this run: the reused classification's own `usage` (from
    // `classificationFor`'s default `inputTokens: 10`) must NOT be folded into this run's totals.
    expect(second.evaluation?.totals.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    const cachedCall = store.workItemCalls.find(({ outcome }) => outcome.state === 'cached');
    expect(cachedCall).toBeDefined();
    expect(cachedCall?.outcome.state === 'cached' && cachedCall.outcome.classification.status).toBe('healthy');
  });

  it('never attempts a cache lookup, and issues a provider request every time, when ports.cacheKey is not provided — even with a store present (backward compatible with pre-P5-2 callers)', async () => {
    const store = fakeStore();
    const evaluableCase = testCaseWithModifiers('tc:v1:cache-absent-port', [], 'cache-absent.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('cache-absent.test.ts')], excluded: [], diagnostics: [] };
    let evaluateCalls = 0;
    const evaluation = stubEvaluationPort(async (request) => { evaluateCalls += 1; return classificationFor(request.testCase.id); });

    const portsForRun: AuditPorts = {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
    };

    await runAudit(configuration, portsForRun);
    await runAudit(configuration, portsForRun);

    expect(evaluateCalls).toBe(2);
    // pending + running + completed per run (Phase 5, task P5-3), so 2 runs of 1 item each is 6
    // calls total — but exactly 2 of them (one per run) are the terminal `completed` outcome, and
    // both carry no cache key at all (never even a `cacheKey: undefined` field observed elsewhere).
    const completedOutcomes = store.workItemCalls.filter(({ outcome }) => outcome.state === 'completed');
    expect(completedOutcomes).toHaveLength(2);
    expect(completedOutcomes.every(({ outcome }) => outcome.state === 'completed' && outcome.cacheKey === undefined)).toBe(true);
  });

  it('--fresh bypasses lookup and issues a new provider request despite a warm cache, appending a new immutable completed result without altering the prior one; a later plain run then reuses the newest, not the older, judgment', async () => {
    const store = fakeStore();
    const cacheKey = statusReplayingCacheKeyPort();
    const evaluableCase = testCaseWithModifiers('tc:v1:cache-fresh', [], 'cache-fresh.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('cache-fresh.test.ts')], excluded: [], diagnostics: [] };
    let evaluateCalls = 0;
    const evaluation = stubEvaluationPort(async (request) => {
      evaluateCalls += 1;
      return classificationFor(request.testCase.id, evaluateCalls === 1 ? { status: 'healthy', outputTokens: 1 } : { status: 'weak', outputTokens: 2 });
    });

    const portsForRun: AuditPorts = {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
      cacheKey,
    };

    await runAudit(configuration, portsForRun);
    expect(evaluateCalls).toBe(1);

    const lookupCallsBeforeFresh = store.lookupCalls.length;
    const second = await runAudit(configuration, portsForRun, { fresh: true });
    expect(evaluateCalls).toBe(2);
    expect(second.evaluation?.classifications[0]?.status).toBe('weak');
    expect(second.evaluation?.totals).toMatchObject({ evaluated: 1, cached: 0 });
    // --fresh skips the lookup call itself, not merely its result: a later reordering to
    // "look up, then ignore the result when fresh" would leave this assertion RED even though
    // evaluateCalls above would still (correctly) read 2.
    expect(store.lookupCalls.length).toBe(lookupCallsBeforeFresh);

    const completedOutcomes = store.workItemCalls.filter(({ outcome }) => outcome.state === 'completed');
    expect(completedOutcomes).toHaveLength(2);
    expect(completedOutcomes[0]?.outcome.state === 'completed' ? completedOutcomes[0].outcome.classification.status : undefined).toBe('healthy');
    expect(completedOutcomes[1]?.outcome.state === 'completed' ? completedOutcomes[1].outcome.classification.status : undefined).toBe('weak');

    // A later plain (non-fresh) run must reuse the NEWEST completed judgment, never the older one
    // that predates the --fresh dispatch.
    const third = await runAudit(configuration, portsForRun);
    expect(evaluateCalls).toBe(2); // still no new request
    expect(third.evaluation?.classifications[0]?.status).toBe('weak');
    expect(third.evaluation?.totals).toMatchObject({ evaluated: 0, cached: 1 });
  });
});

// --- Cache-only evaluation (odd/tasks/cache-only-evaluation.md) -------------

describe('cache-only evaluation (--cache-only, odd/tasks/cache-only-evaluation.md)', () => {
  it(
    'serves a warm cache hit and reports a cold miss as notCached — never calling an evaluation port that would '
    + 'succeed, never counting the miss as failed, re-classifying the hit under the current policy, and persisting '
    + 'no pending/running/failed row for the miss (only the served hit gets a store row)',
    async () => {
      const store = fakeStore();
      // A locally-scoped cache-key port, deliberately distinct from the SEEDED work item's own
      // `classification` below (`status: 'healthy'`): `classifyCached` here always answers `'weak'`
      // instead, so the assertion below can only pass if the hit's reported classification was
      // genuinely RE-DERIVED through `classifyCached` (must-prove 4), never merely echoed back from
      // the stored row — real key computation (`createAuditCacheKeyPort().computeKey`, so the
      // lookup can actually find the seeded row), fabricated re-classification.
      const cacheKeyPort: AuditCacheKeyPort = {
        computeKey: (request, fullTestSource) => createAuditCacheKeyPort().computeKey(request, fullTestSource),
        classifyCached: (request, evaluation) => classificationFor(request.testCase.id, {
          status: 'weak', inputTokens: evaluation.usage.inputTokens, outputTokens: evaluation.usage.outputTokens,
        }),
      };
      const hitCase = testCaseWithModifiers('tc:v1:co-hit', [], 'co.test.ts');
      const missCase = testCaseWithModifiers('tc:v1:co-miss', [], 'co.test.ts');
      const discovery: DiscoveryResult = { files: [discovered('co.test.ts')], excluded: [], diagnostics: [] };
      const sourceText = 'source';
      const hitKey = cacheKeyPort.computeKey({ testCase: hitCase, bundle: emptyBundle(hitCase.id) }, sourceText);

      // Pre-seed a completed judgment under the hit case's exact key, with `classification.status`
      // deliberately different (`healthy`) from what `classifyCached` above will answer (`weak`).
      await store.recordWorkItem('seed-run', {
        state: 'completed',
        identity: { testCaseId: hitCase.id, repositoryRelativePath: hitCase.repositoryRelativePath, name: hitCase.name },
        cacheKey: hitKey,
        evaluation: {
          requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true,
          answers: {}, usage: { inputTokens: 5, outputTokens: 0 }, attempts: 1,
        },
        classification: classificationFor(hitCase.id, { status: 'healthy', outputTokens: 1 }),
      });

      let evaluateCalls = 0;
      const evaluation = stubEvaluationPort(async (request) => {
        evaluateCalls += 1;
        return classificationFor(request.testCase.id, { status: 'healthy' });
      });

      const result = await runAudit(configuration, {
        discovery: { discover: async () => discovery },
        sourceReader: { read: async () => sourceText },
        extractor: { extract: () => ({ testCases: [hitCase, missCase], dynamicMetadata: [], diagnostics: [] }) },
        evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
        evaluation,
        store,
        cacheKey: cacheKeyPort,
      }, { cacheOnly: true });

      // (1) An evaluation port that would succeed is never called.
      expect(evaluateCalls).toBe(0);
      // (3) The miss is not counted as failed and appears under the new not-in-cache count.
      expect(result.evaluation?.totals).toMatchObject({ evaluated: 0, cached: 1, notCached: 1, failed: 0 });
      expect(result.evaluation?.classifications.map((entry) => entry.testCaseId)).toEqual([hitCase.id]);
      // Genuinely re-derived through `classifyCached`, not the seeded row's own `status: 'healthy'`.
      expect(result.evaluation?.classifications[0]?.status).toBe('weak');
      expect(result.evaluation?.cacheStatusByTestCaseId.get(hitCase.id)).toBe('cached');
      expect(result.evaluation?.cacheStatusByTestCaseId.get(missCase.id)).toBe('not-cached');
      // Two genuine lookups happened — the miss was not skipped, it was looked up and missed.
      expect(store.lookupCalls.length).toBe(2);

      const thisRunCalls = store.workItemCalls.filter(({ runId }) => runId === result.runId);
      const missCalls = thisRunCalls.filter(({ outcome }) => outcome.identity.testCaseId === missCase.id);
      expect(missCalls).toEqual([]);
      const hitCalls = thisRunCalls.filter(({ outcome }) => outcome.identity.testCaseId === hitCase.id);
      expect(hitCalls.map(({ outcome }) => outcome.state)).toEqual(['cached']);
    },
  );

  it('throws AuditCacheOnlyUnavailableError when --cache-only is requested but no store/cache-key port is wired', async () => {
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    await expect(runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => extraction('a') },
      evidence: { build: defaultEvidenceBuild },
      evaluation,
    }, { cacheOnly: true })).rejects.toThrow(AuditCacheOnlyUnavailableError);
  });

  it('a run with nothing at all in the cache reports every evaluable test case as notCached, still evaluates zero and fails zero', async () => {
    const store = fakeStore();
    const cacheKeyPort = createAuditCacheKeyPort();
    const coldCase = testCaseWithModifiers('tc:v1:co-cold', [], 'cold.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('cold.test.ts')], excluded: [], diagnostics: [] };
    let evaluateCalls = 0;
    const evaluation = stubEvaluationPort(async (request) => { evaluateCalls += 1; return classificationFor(request.testCase.id); });

    const result = await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [coldCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
      store,
      cacheKey: cacheKeyPort,
    }, { cacheOnly: true });

    expect(evaluateCalls).toBe(0);
    expect(result.evaluation?.totals).toMatchObject({ evaluated: 0, cached: 0, notCached: 1, failed: 0 });
    expect(result.evaluation?.classifications).toEqual([]);
  });
});

describe('per-test-case cache status and latency (Phase 6, task P6-2)', () => {
  it(
    'records exactly cached/fresh/not-evaluated per evaluable test case in cacheStatusByTestCaseId, and only the fresh '
    + 'item\'s measured latency in latencyByTestCaseId — never fabricating latency for a cache hit or a failure',
    async () => {
      const store = fakeStore();
      const cacheKeyPort = createAuditCacheKeyPort();
      const cachedCase = testCaseWithModifiers('tc:v1:pc-cached', [], 'pc.test.ts');
      const freshCase = testCaseWithModifiers('tc:v1:pc-fresh', [], 'pc.test.ts');
      const failedCase = testCaseWithModifiers('tc:v1:pc-failed', [], 'pc.test.ts');
      const discovery: DiscoveryResult = { files: [discovered('pc.test.ts')], excluded: [], diagnostics: [] };
      const sourceText = 'source';
      const bundleFor = (testCase: TestCase): EvidenceBundle => emptyBundle(testCase.id);
      const cachedKey = cacheKeyPort.computeKey({ testCase: cachedCase, bundle: bundleFor(cachedCase) }, sourceText);

      // Pre-seed a completed judgment under the cached case's exact key, so the real dispatch path
      // finds a hit and never calls the provider for it.
      await store.recordWorkItem('seed-run', {
        state: 'completed',
        identity: { testCaseId: cachedCase.id, repositoryRelativePath: cachedCase.repositoryRelativePath, name: cachedCase.name },
        cacheKey: cachedKey,
        evaluation: {
          requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true,
          answers: {}, usage: { inputTokens: 5, outputTokens: 0 }, attempts: 1,
        },
        classification: classificationFor(cachedCase.id, { status: 'healthy' }),
      });

      // Distinct from every token count, attempt count, and other latency value in this fixture
      // (Phase 6 Warning: latency sits next to token counts, the exact adjacency that already
      // produced one defect in this project) — a swap between `latencyMs` and any nearby number
      // must be individually detectable.
      const freshLatencyMs = 4321;
      const freshAttemptLatenciesMs = [777, 4321 - 777];

      const evaluation = stubEvaluationPort(
        async (request) => {
          if (request.testCase.id === failedCase.id) throw new Error('boom');
          return classificationFor(request.testCase.id, { status: 'healthy', inputTokens: 42, outputTokens: 9 });
        },
        { latencyMs: freshLatencyMs, attemptLatenciesMs: freshAttemptLatenciesMs },
      );

      const result = await runAudit(configuration, {
        discovery: { discover: async () => discovery },
        sourceReader: { read: async () => sourceText },
        extractor: { extract: () => ({ testCases: [cachedCase, freshCase, failedCase], dynamicMetadata: [], diagnostics: [] }) },
        evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => bundleFor(testCase)), diagnostics: [] }) },
        evaluation,
        store,
        cacheKey: cacheKeyPort,
      });

      expect(result.evaluation?.totals).toMatchObject({ evaluated: 1, cached: 1, failed: 1 });

      const cacheStatuses = result.evaluation?.cacheStatusByTestCaseId;
      expect(cacheStatuses?.get(cachedCase.id)).toBe('cached');
      expect(cacheStatuses?.get(freshCase.id)).toBe('fresh');
      expect(cacheStatuses?.get(failedCase.id)).toBe('not-evaluated');

      const latencies = result.evaluation?.latencyByTestCaseId;
      expect(latencies?.get(freshCase.id)).toEqual({ latencyMs: freshLatencyMs, attemptLatenciesMs: freshAttemptLatenciesMs });
      // A cache hit made no provider request this run: never a fabricated latency.
      expect(latencies?.has(cachedCase.id)).toBe(false);
      // A failed dispatch produced no successful evaluation to measure: never a fabricated latency.
      expect(latencies?.has(failedCase.id)).toBe(false);
    },
  );
});

describe('run identity threaded onto AuditResult (Phase 6, task P6-2b)', () => {
  it(
    'threads the store-minted runId onto AuditResult.runId for a fresh (non-resumed) run — captured live from the '
    + 'store\'s own beginRun return value, never a hardcoded coincidence (Phase 6 Warning 2)',
    async () => {
      const baseStore = fakeStore();
      let mintedRunId: string | undefined;
      const store: AuditStorePort = {
        ...baseStore,
        async beginRun(rootDir: string): Promise<string> {
          const runId = await baseStore.beginRun(rootDir);
          mintedRunId = runId;
          return runId;
        },
      };
      const evaluableCase = testCaseWithModifiers('tc:v1:id-fresh', [], 'id.test.ts');
      const discovery: DiscoveryResult = { files: [discovered('id.test.ts')], excluded: [], diagnostics: [] };
      const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id, { status: 'healthy' }));

      const result = await runAudit(configuration, {
        discovery: { discover: async () => discovery },
        sourceReader: { read: async () => 'source' },
        extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
        evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
        evaluation,
        store,
      });

      expect(mintedRunId).toBeDefined();
      // Compared against the value THIS test captured directly from the store's own return, not
      // against a value typed into this test — the exact provenance check Warning 2 calls for.
      expect(result.runId).toBe(mintedRunId);
    },
  );

  it('has no runId when ports.evaluation is present but ports.store is absent — a run with no store has no persisted identity to report', async () => {
    const evaluableCase = testCaseWithModifiers('tc:v1:id-no-store', [], 'id-no-store.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('id-no-store.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id, { status: 'healthy' }));

    const result = await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
    });

    expect(result.runId).toBeUndefined();
  });

  it('has no runId for an offline audit (no --evaluate at all), even though a store port happens to be supplied', async () => {
    const store = fakeStore();
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };

    const result = await runAudit(configuration, { ...portsFor(discovery, async () => 'source', () => extraction('a')), store });

    expect(result.runId).toBeUndefined();
    expect(store.beginRunCalls).toEqual([]);
  });
});

describe('sourceTextByPath exposure (Phase 5, task P5-5)', () => {
  it('exposes each file\'s full raw source text on the result when retainSourceText is true', async () => {
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts'), discovered('b.test.ts')], excluded: [], diagnostics: [] };
    const sources: Record<string, string> = { 'a.test.ts': 'source-a', 'b.test.ts': 'source-b' };

    const result = await runAudit(
      configuration,
      portsFor(
        discovery,
        async (path) => sources[path] ?? '',
        (path) => extraction(path.replace('.test.ts', '')),
      ),
      { retainSourceText: true },
    );

    expect(result.sourceTextByPath?.get('a.test.ts')).toBe('source-a');
    expect(result.sourceTextByPath?.get('b.test.ts')).toBe('source-b');
  });

  it('omits sourceTextByPath entirely (undefined) when retainSourceText is not set — no behavior change for an ordinary offline audit', async () => {
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };

    const result = await runAudit(configuration, portsFor(discovery, async () => 'source', () => extraction('a')));

    expect(result.sourceTextByPath).toBeUndefined();
  });

  it(
    'still omits sourceTextByPath from the result during --evaluate when retainSourceText is not set, even though the map is '
    + 'genuinely built and non-empty internally for the evaluation port\'s own cache-key lookups — the exposure gate is independent '
    + 'of whether the map happens to exist, not merely "is it undefined"',
    async () => {
      const evaluableCase = testCaseWithModifiers('tc:v1:hidden', [], 'hidden.test.ts');
      const discovery: DiscoveryResult = { files: [discovered('hidden.test.ts')], excluded: [], diagnostics: [] };
      const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

      const result = await runAudit(configuration, {
        discovery: { discover: async () => discovery },
        sourceReader: { read: async () => 'internal-only-source' },
        extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
        evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
        evaluation,
      }); // no retainSourceText

      expect(result.sourceTextByPath).toBeUndefined();
    },
  );

  it('also exposes sourceTextByPath during --evaluate when retainSourceText is explicitly requested, independent of the evaluation port', async () => {
    const evaluableCase = testCaseWithModifiers('tc:v1:retain', [], 'retain.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('retain.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    const result = await runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'evaluate-source' },
      extractor: { extract: () => ({ testCases: [evaluableCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
      evaluation,
    }, { retainSourceText: true });

    expect(result.sourceTextByPath?.get('retain.test.ts')).toBe('evaluate-source');
  });
});

describe('computeDryRunCacheHits (Phase 5, task P5-5)', () => {
  it(
    'reports exactly the currently evaluable test cases whose real cache key already has a stored judgment, '
    + 'using the same AuditCacheKeyPort/AuditStorePort.lookup a real dispatch would use',
    async () => {
      const store = fakeStore();
      const cacheKeyPort = createAuditCacheKeyPort();
      const testCaseA = testCaseWithModifiers('tc:v1:hits-a', [], 'hits.test.ts');
      const testCaseB: TestCase = { ...testCaseA, id: 'tc:v1:hits-b' as TestCaseId, name: 'hits-b' };
      const discovery: DiscoveryResult = { files: [discovered('hits.test.ts')], excluded: [], diagnostics: [] };
      const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

      // A real --evaluate pass populates the store for testCaseA only.
      await runAudit(configuration, {
        discovery: { discover: async () => discovery },
        sourceReader: { read: async () => 'shared-source' },
        extractor: { extract: () => ({ testCases: [testCaseA], dynamicMetadata: [], diagnostics: [] }) },
        evidence: { build: async (request) => ({ bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] }) },
        evaluation,
        store,
        cacheKey: cacheKeyPort,
      }, { retainSourceText: true });

      // A dry-run-style pass discovers BOTH testCaseA (already cached) and testCaseB (never
      // evaluated) over the exact same source text and store.
      const dryRunResult = await runAudit(configuration, portsFor(
        discovery,
        async () => 'shared-source',
        () => ({ testCases: [testCaseA, testCaseB], dynamicMetadata: [], diagnostics: [] }),
      ), { retainSourceText: true });

      const hits = await computeDryRunCacheHits(
        dryRunResult.files,
        dryRunResult.sourceTextByPath ?? new Map(),
        cacheKeyPort,
        store.lookup,
      );

      expect(hits.has(testCaseA.id)).toBe(true);
      expect(hits.has(testCaseB.id)).toBe(false);
      expect(hits.size).toBe(1);
    },
  );

  it('never counts a hit for a test case whose file source is missing from the map (defensive; mirrors runEvaluation\'s own "believed unreachable" gap)', async () => {
    const store = fakeStore();
    const cacheKeyPort = createAuditCacheKeyPort();
    const testCase = testCaseWithModifiers('tc:v1:no-source', [], 'no-source.test.ts');
    const files: readonly AuditFileResult[] = [{
      discovered: discovered('no-source.test.ts'),
      testCases: [testCase],
      dynamicMetadata: [],
      diagnostics: [],
      evidence: [emptyBundle(testCase.id)],
    }];

    const hits = await computeDryRunCacheHits(files, new Map(), cacheKeyPort, store.lookup);

    expect(hits.size).toBe(0);
    expect(store.lookupCalls).toEqual([]);
  });

  it('never calls lookup for a skipped test case (only evaluable items are candidates)', async () => {
    const store = fakeStore();
    const cacheKeyPort = createAuditCacheKeyPort();
    const skipCase = testCaseWithModifiers('tc:v1:skip-only', ['skip'], 'skip-only.test.ts');
    const files: readonly AuditFileResult[] = [{
      discovered: discovered('skip-only.test.ts'),
      testCases: [skipCase],
      dynamicMetadata: [],
      diagnostics: [],
      evidence: [],
    }];
    const sourceTextByPath = new Map([['skip-only.test.ts', 'source']]);

    const hits = await computeDryRunCacheHits(files, sourceTextByPath, cacheKeyPort, store.lookup);

    expect(hits.size).toBe(0);
    expect(store.lookupCalls).toEqual([]);
  });
});
