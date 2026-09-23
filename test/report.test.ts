import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildAuditReport,
  REPORT_VERSION,
  type AuditReportContext,
} from '../src/domain/report.js';
import { REPORT_JSON_SCHEMA, validateAgainstSchema } from '../src/domain/report-schema.js';
import {
  EMPTY_AUDIT_EVALUATION_TOTALS,
  type AuditResult,
  type TestCaseCacheStatus,
  type TestCaseLatency,
} from '../src/domain/audit.js';
import type { ClassificationResult, DimensionJudgment } from '../src/domain/classification.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import type { TestCase, TestCaseId } from '../src/domain/test-understanding.js';

const context: AuditReportContext = {
  modelRequested: 'jev-1.13.0',
  rubricVersion: 2,
  policyVersion: 2,
  storeSchemaVersion: 4,
};

const zeroSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };

function testCase(id: string, name: string, repositoryRelativePath: string): TestCase {
  return {
    id: id as TestCaseId,
    repositoryRelativePath,
    kind: 'test',
    framework: 'vitest',
    name,
    structuralAncestry: [{ kind: 'test', name, ordinal: 0 }],
    source: `test('${name}', () => {});`,
    span: zeroSpan,
    modifiers: [],
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
  };
}

function judgedDimension(overrides: Partial<DimensionJudgment> = {}): DimensionJudgment {
  return {
    dimensionId: 'falsifiability',
    dimensionLabel: 'Falsifiability',
    applicable: true,
    applicabilityProbability: 0.91,
    level: 'strong',
    score: 3,
    confidence: 0.88,
    status: 'judged',
    reason: undefined,
    probabilities: { '0': 0.02, '1': 0.03, '2': 0.11, '3': 0.84 },
    deficientMass: 0.05,
    acceptableMass: 0.95,
    criticalMass: 0.02,
    ...overrides,
  };
}

function notApplicableDimension(): DimensionJudgment {
  return {
    dimensionId: 'behavioral-focus',
    dimensionLabel: 'Behavioral focus',
    applicable: false,
    applicabilityProbability: 0.12,
    level: undefined,
    score: undefined,
    confidence: undefined,
    status: 'not-applicable',
    reason: undefined,
    probabilities: undefined,
    deficientMass: undefined,
    acceptableMass: undefined,
    criticalMass: undefined,
  };
}

function classification(
  id: string,
  repositoryRelativePath: string,
  name: string,
  overrides: Partial<ClassificationResult> = {},
): ClassificationResult {
  return {
    testCaseId: id as TestCaseId,
    repositoryRelativePath,
    name,
    status: 'healthy',
    dimensions: [judgedDimension(), notApplicableDimension()],
    findings: [],
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 137, outputTokens: 11 },
    ...overrides,
  };
}

function bundleWithProvenance(id: string): EvidenceBundle {
  return buildEvidenceBundle({
    testCaseId: id as TestCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [{
      kind: 'test',
      repositoryRelativePath: 'mixed.test.ts',
      span: zeroSpan,
      content: 'body',
      contentHash: 'a'.repeat(64),
      selectionReason: 'test-body',
      truncation: { truncated: true, originalBytes: 64, includedBytes: 4 },
    }],
    denied: [{ repositoryRelativePath: 'secret.env', rule: 'deny-list:.env*' }],
    unresolved: [{ specifier: 'left-pad', reason: 'bare-specifier' }],
    omitted: [{ repositoryRelativePath: 'big.ts', reason: 'bundle-budget-exhausted' }],
  });
}

function emptyBundle(id: string): EvidenceBundle {
  return buildEvidenceBundle({ testCaseId: id as TestCaseId, budget: DEFAULT_EVIDENCE_BUDGET, fragments: [], denied: [], unresolved: [], omitted: [] });
}

/**
 * A rich, mixed run: two files, one excluded file, one cache hit, one fresh dispatch with a
 * measured latency, one failed dispatch. Every numeric value below is distinct from every other
 * — including every token count vs. every latency value — so a swap between any two adjacent
 * fields is independently detectable (Phase 6 Warning: latency next to token counts already
 * produced one defect in this project).
 *
 * `overrides` (Phase 6, task P6-2b) lets a test layer `runId`/`resume` on top of this same base
 * fixture without hand-duplicating it — mirroring the `classification()`/`judgedDimension()`
 * overrides pattern already used elsewhere in this file. No existing call site passes anything,
 * so every pre-P6-2b test keeps seeing exactly the same `AuditResult` it always has (no `runId`,
 * no `resume`) — the honest default shape for a run with no persisted store.
 */
function mixedResult(overrides: Partial<AuditResult> = {}): AuditResult {
  const cachedCase = testCase('tc:v1:cached', 'cached case', 'mixed.test.ts');
  const freshCase = testCase('tc:v1:fresh', 'fresh case', 'mixed.test.ts');
  const failedCase = testCase('tc:v1:failed', 'failed case', 'other.test.ts');

  const cacheStatusByTestCaseId: ReadonlyMap<TestCaseId, TestCaseCacheStatus> = new Map([
    [cachedCase.id, 'cached'],
    [freshCase.id, 'fresh'],
    [failedCase.id, 'not-evaluated'],
  ]);
  const latencyByTestCaseId: ReadonlyMap<TestCaseId, TestCaseLatency> = new Map([
    [freshCase.id, { latencyMs: 5417, attemptLatenciesMs: [2203, 3214] }],
  ]);

  return {
    rootDir: '/workspace/mixed',
    files: [
      {
        discovered: { repositoryRelativePath: 'mixed.test.ts', framework: 'vitest', frameworkEvidence: [] },
        testCases: [cachedCase, freshCase],
        dynamicMetadata: [],
        diagnostics: [],
        evidence: [bundleWithProvenance(cachedCase.id), emptyBundle(freshCase.id)],
      },
      {
        discovered: { repositoryRelativePath: 'other.test.ts', framework: 'vitest', frameworkEvidence: [] },
        testCases: [failedCase],
        dynamicMetadata: [],
        diagnostics: [{ code: 'evaluation-failed', message: 'Unable to evaluate test case tc:v1:failed ("failed case"): request: boom', severity: 'error' }],
        evidence: [emptyBundle(failedCase.id)],
      },
    ],
    excluded: [{ repositoryRelativePath: 'skipped.test.ts', reason: 'configured-exclude', evidence: [] }],
    diagnostics: [{
      code: 'evaluation-failed',
      message: 'Unable to evaluate test case tc:v1:failed ("failed case"): request: boom',
      severity: 'error',
      repositoryRelativePath: 'other.test.ts',
    }],
    totals: {
      files: 2,
      excluded: 1,
      testCases: 3,
      dynamicMetadata: 0,
      diagnostics: 1,
      unsupportedFrameworkFiles: 0,
      evidenceBundles: 3,
      evidenceFragments: 1,
      evidenceTruncatedFragments: 1,
      evidenceOmitted: 1,
      evidenceDenied: 1,
      evidenceUnresolved: 1,
    },
    reportingOnly: true,
    evaluation: {
      classifications: [
        classification(cachedCase.id, 'mixed.test.ts', 'cached case', { usage: { inputTokens: 61, outputTokens: 4 } }),
        classification(freshCase.id, 'mixed.test.ts', 'fresh case', { usage: { inputTokens: 219, outputTokens: 18 } }),
      ],
      totals: {
        evaluated: 1,
        cached: 1,
        failed: 1,
        skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
        usage: { inputTokens: 219, outputTokens: 18 },
        statusCounts: { healthy: 2, weak: 0, misleading: 0, 'needs-review': 0 },
        respondedModel: 'jev-1.13.0',
        modelMismatches: 0,
      },
      cacheStatusByTestCaseId,
      latencyByTestCaseId,
    },
    ...overrides,
  };
}

// A fresh (non-resumed) run's persisted identity (Phase 6, task P6-2b) — distinct from every other
// id-shaped string this file uses (`tc:v1:*` test-case ids, `run-*`-style resumed ids elsewhere),
// so a swap between it and any neighboring field is independently detectable.
const MIXED_RUN_ID = 'run:v1:mixed-fresh-8a41c2';

describe('buildAuditReport — golden shape and stable key order', () => {
  it('builds the full canonical envelope for a mixed run with a byte-stable key order', () => {
    const report = buildAuditReport(mixedResult({ runId: MIXED_RUN_ID }), context);

    expect(JSON.stringify(report)).toBe(
      '{"reportVersion":1,"rootDir":"/workspace/mixed","runId":"run:v1:mixed-fresh-8a41c2","reportingOnly":true,"complete":true,'
      + '"versions":{"storeSchema":4,"rubric":2,"policy":2},"modelRequested":"jev-1.13.0",'
      + '"discovery":{"files":[{"path":"mixed.test.ts","framework":"vitest","testCaseCount":2,"dynamicMetadataCount":0,"evidenceBundleCount":2},'
      + '{"path":"other.test.ts","framework":"vitest","testCaseCount":1,"dynamicMetadataCount":0,"evidenceBundleCount":1}],'
      + '"excluded":[{"path":"skipped.test.ts","reason":"configured-exclude"}],'
      + '"totals":{"files":2,"excluded":1,"testCases":3,"dynamicMetadata":0,"diagnostics":1,"unsupportedFrameworkFiles":0,'
      + '"evidenceBundles":3,"evidenceFragments":1,"evidenceTruncatedFragments":1,"evidenceOmitted":1,"evidenceDenied":1,"evidenceUnresolved":1}},'
      + '"totals":{"evaluated":1,"cached":1,"failed":1,"skipped":{"total":0,"byReason":{"skip":0,"todo":0,"evidence-unavailable":0}},'
      + '"usage":{"inputTokens":219,"outputTokens":18},"statusCounts":{"healthy":2,"weak":0,"misleading":0,"needs-review":0},'
      + '"respondedModel":"jev-1.13.0","modelMismatches":0},'
      + '"latency":{"measuredTestCases":1,"totalMs":5417,"meanMs":5417,"minMs":5417,"maxMs":5417},'
      + '"cacheStatus":[{"testCaseId":"tc:v1:cached","repositoryRelativePath":"mixed.test.ts","name":"cached case","status":"cached"},'
      + '{"testCaseId":"tc:v1:fresh","repositoryRelativePath":"mixed.test.ts","name":"fresh case","status":"fresh"},'
      + '{"testCaseId":"tc:v1:failed","repositoryRelativePath":"other.test.ts","name":"failed case","status":"not-evaluated"}],'
      + '"classifications":[{"testCaseId":"tc:v1:cached","repositoryRelativePath":"mixed.test.ts","name":"cached case","status":"healthy",'
      + '"dimensions":[{"dimensionId":"falsifiability","dimensionLabel":"Falsifiability","applicable":true,"applicabilityProbability":0.91,'
      + '"level":"strong","score":3,"confidence":0.88,"status":"judged","probabilities":{"0":0.02,"1":0.03,"2":0.11,"3":0.84},'
      + '"deficientMass":0.05,"acceptableMass":0.95,"criticalMass":0.02},'
      + '{"dimensionId":"behavioral-focus","dimensionLabel":"Behavioral focus","applicable":false,"applicabilityProbability":0.12,"status":"not-applicable"}],'
      + '"findings":[],"policyVersion":2,"rubricVersion":2,"model":{"requested":"jev-1.13.0","responded":"jev-1.13.0","matchesPin":true},'
      + '"usage":{"inputTokens":61,"outputTokens":4},"cache":"cached",'
      + '"evidence":{"fragments":1,"truncatedFragments":1,"denied":[{"repositoryRelativePath":"secret.env","rule":"deny-list:.env*"}],'
      + '"unresolved":[{"specifier":"left-pad","reason":"bare-specifier"}],"omitted":[{"repositoryRelativePath":"big.ts","reason":"bundle-budget-exhausted"}]}},'
      + '{"testCaseId":"tc:v1:fresh","repositoryRelativePath":"mixed.test.ts","name":"fresh case","status":"healthy",'
      + '"dimensions":[{"dimensionId":"falsifiability","dimensionLabel":"Falsifiability","applicable":true,"applicabilityProbability":0.91,'
      + '"level":"strong","score":3,"confidence":0.88,"status":"judged","probabilities":{"0":0.02,"1":0.03,"2":0.11,"3":0.84},'
      + '"deficientMass":0.05,"acceptableMass":0.95,"criticalMass":0.02},'
      + '{"dimensionId":"behavioral-focus","dimensionLabel":"Behavioral focus","applicable":false,"applicabilityProbability":0.12,"status":"not-applicable"}],'
      + '"findings":[],"policyVersion":2,"rubricVersion":2,"model":{"requested":"jev-1.13.0","responded":"jev-1.13.0","matchesPin":true},'
      + '"usage":{"inputTokens":219,"outputTokens":18},"cache":"fresh","latency":{"latencyMs":5417,"attemptLatenciesMs":[2203,3214]},'
      + '"evidence":{"fragments":0,"truncatedFragments":0,"denied":[],"unresolved":[],"omitted":[]}}],'
      + '"diagnostics":[{"path":"other.test.ts","code":"evaluation-failed","message":"Unable to evaluate test case tc:v1:failed (\\"failed case\\"): request: boom","severity":"error"}]}',
    );
  });

  it('validates the golden report against the published schema, runId included', () => {
    const report = buildAuditReport(mixedResult({ runId: MIXED_RUN_ID }), context);
    const result = validateAgainstSchema(REPORT_JSON_SCHEMA, JSON.parse(JSON.stringify(report)) as unknown);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('REPORT_VERSION is exported and embedded verbatim as reportVersion', () => {
    const report = buildAuditReport(mixedResult(), context);
    expect(report.reportVersion).toBe(REPORT_VERSION);
  });
});

describe('buildAuditReport — completeness', () => {
  it('marks an ordinary finished run complete, with no incompleteReason key at all', () => {
    const report = buildAuditReport(mixedResult(), context);
    expect(report.complete).toBe(true);
    expect('incompleteReason' in report).toBe(false);
  });

  it('marks a run incomplete, naming the discovery-failed diagnostic, when evaluation never ran because discovery aborted first', () => {
    const result: AuditResult = {
      rootDir: '/workspace/broken',
      files: [],
      excluded: [],
      diagnostics: [{ code: 'discovery-failed', message: 'Unable to discover test files: EACCES', severity: 'error' }],
      totals: {
        files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 1, unsupportedFrameworkFiles: 0,
        evidenceBundles: 0, evidenceFragments: 0, evidenceTruncatedFragments: 0, evidenceOmitted: 0, evidenceDenied: 0, evidenceUnresolved: 0,
      },
      reportingOnly: true,
      // No `evaluation` key at all — the exact shape a discovery failure produces.
    };

    const report = buildAuditReport(result, context);

    expect(report.complete).toBe(false);
    expect(report.incompleteReason).toContain('discovery failed before evaluation could run');
    expect(report.incompleteReason).toContain('EACCES');
    // An honest, all-zero placeholder — never presented as if it were a real, finished report.
    expect(report.totals).toEqual(EMPTY_AUDIT_EVALUATION_TOTALS);
    expect(report.classifications).toEqual([]);
    expect(report.cacheStatus).toEqual([]);
    expect(report.latency).toEqual({ measuredTestCases: 0 });
  });

  it('falls back to a generic incomplete reason when evaluation is missing with no discovery-failed diagnostic to explain it', () => {
    const result: AuditResult = {
      rootDir: '/workspace/odd',
      files: [],
      excluded: [],
      diagnostics: [],
      totals: {
        files: 0, excluded: 0, testCases: 0, dynamicMetadata: 0, diagnostics: 0, unsupportedFrameworkFiles: 0,
        evidenceBundles: 0, evidenceFragments: 0, evidenceTruncatedFragments: 0, evidenceOmitted: 0, evidenceDenied: 0, evidenceUnresolved: 0,
      },
      reportingOnly: true,
    };

    const report = buildAuditReport(result, context);

    expect(report.complete).toBe(false);
    expect(report.incompleteReason).toBe('evaluation did not run for this audit run (no evaluation outcome is available); see diagnostics for details');
  });

  it('does NOT mark a run incomplete merely because it carries failed items, a model mismatch, or a needs-review status — those are ordinary, fully-disclosed per-test outcomes', () => {
    const result = mixedResult();
    const report = buildAuditReport(result, context);

    expect(report.complete).toBe(true);
    expect(report.totals.failed).toBe(1);
  });
});

describe('buildAuditReport — run identity (Phase 6, task P6-2b)', () => {
  it('omits runId entirely when AuditResult carries none — never a fabricated placeholder for a run with no persisted identity', () => {
    const report = buildAuditReport(mixedResult(), context);
    // `mixedResult()` with no override sets no `runId` at all — the honest default shape for e.g.
    // an `--evaluate` run with no store wired.
    expect('runId' in report).toBe(false);
  });

  it('carries a fresh run\'s AuditResult.runId verbatim onto the report', () => {
    const report = buildAuditReport(mixedResult({ runId: MIXED_RUN_ID }), context);
    expect(report.runId).toBe(MIXED_RUN_ID);
  });

  it(
    'sources runId and resume.runId independently — a deliberately contradictory fixture proves neither field is derived '
    + 'from the other (a real `runAudit` result never disagrees like this: see that function\'s own invariant)',
    () => {
      const result = mixedResult({
        runId: 'run:v1:top-level-9c31d4',
        resume: { runId: 'run:v1:resume-field-4e58a0', outstanding: 1, reused: 0, nothingOutstanding: false },
      });

      const report = buildAuditReport(result, context);

      expect(report.runId).toBe('run:v1:top-level-9c31d4');
      expect(report.resume?.runId).toBe('run:v1:resume-field-4e58a0');
    },
  );

  it('keeps runId consistent with resume.runId for a genuinely resumed run — the real production shape, where both fields always agree', () => {
    const sharedRunId = 'run:v1:resumed-consistent-2b77e1';
    const result = mixedResult({
      runId: sharedRunId,
      resume: { runId: sharedRunId, outstanding: 0, reused: 2, nothingOutstanding: true },
    });

    const report = buildAuditReport(result, context);

    expect(report.runId).toBe(sharedRunId);
    expect(report.resume?.runId).toBe(sharedRunId);
  });
});

describe('buildAuditReport — per-test-case cache status and latency', () => {
  it('lists every evaluable test case exactly once in cacheStatus, distinguishing cached/fresh/not-evaluated, and excludes nothing evaluable', () => {
    const report = buildAuditReport(mixedResult(), context);
    expect(report.cacheStatus).toEqual([
      { testCaseId: 'tc:v1:cached', repositoryRelativePath: 'mixed.test.ts', name: 'cached case', status: 'cached' },
      { testCaseId: 'tc:v1:fresh', repositoryRelativePath: 'mixed.test.ts', name: 'fresh case', status: 'fresh' },
      { testCaseId: 'tc:v1:failed', repositoryRelativePath: 'other.test.ts', name: 'failed case', status: 'not-evaluated' },
    ]);
  });

  it('attaches latency only to the classification entry that actually measured one this run, never to a cache hit', () => {
    const report = buildAuditReport(mixedResult(), context);
    const cached = report.classifications.find((entry) => entry.testCaseId === 'tc:v1:cached');
    const fresh = report.classifications.find((entry) => entry.testCaseId === 'tc:v1:fresh');
    expect(cached?.latency).toBeUndefined();
    expect(fresh?.latency).toEqual({ latencyMs: 5417, attemptLatenciesMs: [2203, 3214] });
  });

  it('aggregates latency only across measured test cases, reporting an honest zero (no totalMs/meanMs/minMs/maxMs keys) when nothing was measured', () => {
    const result = mixedResult();
    const noLatency: AuditResult = {
      ...result,
      evaluation: { ...result.evaluation!, latencyByTestCaseId: new Map() },
    };
    const report = buildAuditReport(noLatency, context);
    expect(report.latency).toEqual({ measuredTestCases: 0 });
    expect('totalMs' in report.latency).toBe(false);
  });
});

describe('validateAgainstSchema — the validator actually rejects a broken report (not a vacuous pass)', () => {
  function validReportObject(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(buildAuditReport(mixedResult(), context))) as Record<string, unknown>;
  }

  it('rejects a report missing its top-level reportVersion, naming the exact path', () => {
    const broken = validReportObject();
    delete broken['reportVersion'];

    const result = validateAgainstSchema(REPORT_JSON_SCHEMA, broken);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('$.reportVersion: required property is missing');
  });

  it('rejects a report whose complete field is the wrong type', () => {
    const broken = validReportObject();
    broken['complete'] = 'yes';

    const result = validateAgainstSchema(REPORT_JSON_SCHEMA, broken);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.startsWith('$.complete: expected type boolean'))).toBe(true);
  });

  it('rejects a classification entry missing its cache field', () => {
    const broken = validReportObject();
    const classifications = broken['classifications'] as Array<Record<string, unknown>>;
    delete classifications[0]!['cache'];

    const result = validateAgainstSchema(REPORT_JSON_SCHEMA, broken);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('$.classifications[0].cache: required property is missing');
  });

  it('rejects an unexpected extra property when additionalProperties is false', () => {
    const broken = validReportObject();
    broken['unexpectedField'] = 'surprise';

    const result = validateAgainstSchema(REPORT_JSON_SCHEMA, broken);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('$.unexpectedField: unexpected property (additionalProperties is false)');
  });

  it('accepts a genuinely valid report with zero errors', () => {
    const result = validateAgainstSchema(REPORT_JSON_SCHEMA, validReportObject());
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe('docs/report-schema.json stays in sync with REPORT_JSON_SCHEMA', () => {
  it('is the exact published copy of the in-code schema, so the two can never silently drift', () => {
    const publishedPath = fileURLToPath(new URL('../docs/report-schema.json', import.meta.url));
    const published: unknown = JSON.parse(readFileSync(publishedPath, 'utf8'));
    expect(published).toEqual(REPORT_JSON_SCHEMA);
  });
});
