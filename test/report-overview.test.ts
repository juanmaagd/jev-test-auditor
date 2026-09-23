import { describe, expect, it } from 'vitest';
import { HEATMAP_MIN_GROUP_SIZE, HEATMAP_ROWS_LIMIT, summarizeReport, TOP_FILES_LIMIT } from '../src/domain/report-overview.js';
import type { AuditReport } from '../src/domain/report.js';
import type { AuditReportClassification } from '../src/domain/report.js';
import type { DimensionJudgment } from '../src/domain/classification.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

function dimension(overrides: Partial<DimensionJudgment> = {}): DimensionJudgment {
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

function classification(overrides: Partial<AuditReportClassification> = {}): AuditReportClassification {
  return {
    testCaseId: 'tc:v1:healthy-1' as TestCaseId,
    repositoryRelativePath: 'a.test.ts',
    name: 'adds two numbers',
    status: 'healthy',
    dimensions: [dimension()],
    findings: [],
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 100, outputTokens: 20 },
    cache: 'fresh',
    evidence: { fragments: 1, truncatedFragments: 0, denied: [], unresolved: [], omitted: [] },
    ...overrides,
  };
}

function minimalReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    reportVersion: 1,
    rootDir: '/repo',
    reportingOnly: true,
    complete: true,
    versions: { storeSchema: 3, rubric: 2, policy: 2 },
    modelRequested: 'jev-1.13.0',
    discovery: {
      files: [{ path: 'a.test.ts', framework: 'vitest', testCaseCount: 1, dynamicMetadataCount: 0, evidenceBundleCount: 1 }],
      excluded: [],
      totals: {
        files: 1,
        excluded: 0,
        testCases: 1,
        dynamicMetadata: 0,
        diagnostics: 0,
        unsupportedFrameworkFiles: 0,
        evidenceBundles: 1,
        evidenceFragments: 1,
        evidenceTruncatedFragments: 0,
        evidenceOmitted: 0,
        evidenceDenied: 0,
        evidenceUnresolved: 0,
      },
    },
    totals: {
      evaluated: 1,
      cached: 0,
      failed: 0,
      skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
      usage: { inputTokens: 100, outputTokens: 20 },
      statusCounts: { healthy: 1, weak: 0, misleading: 0, 'needs-review': 0 },
      respondedModel: 'jev-1.13.0',
      modelMismatches: 0,
    },
    latency: { measuredTestCases: 1, totalMs: 120, meanMs: 120, minMs: 120, maxMs: 120 },
    cacheStatus: [{ testCaseId: 'tc:v1:healthy-1' as TestCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds two numbers', status: 'fresh' }],
    classifications: [classification()],
    diagnostics: [],
    ...overrides,
  };
}

describe('summarizeReport: zero denominators never produce NaN', () => {
  it('reports every share as 0, never NaN, when there is nothing judged', () => {
    const report = minimalReport({
      discovery: { ...minimalReport().discovery, totals: { ...minimalReport().discovery.totals, testCases: 0 } },
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
      cacheStatus: [],
      classifications: [],
    });
    const overview = summarizeReport(report);
    expect(overview.needsChange).toEqual({ count: 0, judgedTotal: 0, share: 0 });
    expect(overview.coverage.judgedShare).toBe(0);
    for (const entry of overview.statusBreakdown) expect(entry.share).toBe(0);
    expect(overview.dimensions).toEqual([]);
    expect(overview.topFiles).toEqual([]);
    expect(overview.diagnostics).toEqual([]);
    expect(Number.isNaN(overview.needsChange.share)).toBe(false);
  });
});

describe('summarizeReport: needs-change is over judged tests, never discovered', () => {
  it('shares non-healthy count over classifications.length, not discovery.totals.testCases', () => {
    const misleading = classification({ testCaseId: 'tc:v1:m' as TestCaseId, status: 'misleading' });
    const weak = classification({ testCaseId: 'tc:v1:w' as TestCaseId, status: 'weak' });
    const healthy = classification({ testCaseId: 'tc:v1:h' as TestCaseId, status: 'healthy' });
    const report = minimalReport({
      discovery: { ...minimalReport().discovery, totals: { ...minimalReport().discovery.totals, testCases: 100 } },
      totals: {
        ...minimalReport().totals,
        statusCounts: { healthy: 1, weak: 1, misleading: 1, 'needs-review': 0 },
      },
      classifications: [misleading, weak, healthy],
    });
    const overview = summarizeReport(report);
    expect(overview.needsChange).toEqual({ count: 2, judgedTotal: 3, share: 2 / 3 });
  });
});

describe('summarizeReport: needs-review is its own figure, never folded into needs-change', () => {
  it('excludes needs-review from needsChange and reports it separately with the same judged denominator', () => {
    const misleading = classification({ testCaseId: 'tc:v1:m' as TestCaseId, status: 'misleading' });
    const needsReview = classification({ testCaseId: 'tc:v1:r' as TestCaseId, status: 'needs-review' });
    const healthy = classification({ testCaseId: 'tc:v1:h' as TestCaseId, status: 'healthy' });
    const report = minimalReport({
      totals: {
        ...minimalReport().totals,
        statusCounts: { healthy: 1, weak: 0, misleading: 1, 'needs-review': 1 },
      },
      classifications: [misleading, needsReview, healthy],
    });
    const overview = summarizeReport(report);
    expect(overview.needsChange).toEqual({ count: 1, judgedTotal: 3, share: 1 / 3 });
    expect(overview.needsReview).toEqual({ count: 1, judgedTotal: 3, share: 1 / 3 });
  });
});

describe('summarizeReport: status breakdown', () => {
  it('lists every status worst-first with count and share over judged tests', () => {
    const report = minimalReport({
      totals: {
        ...minimalReport().totals,
        statusCounts: { healthy: 3, weak: 1, misleading: 1, 'needs-review': 1 },
      },
      classifications: [
        classification({ testCaseId: 'tc:v1:1' as TestCaseId, status: 'misleading' }),
        classification({ testCaseId: 'tc:v1:2' as TestCaseId, status: 'weak' }),
        classification({ testCaseId: 'tc:v1:3' as TestCaseId, status: 'needs-review' }),
        classification({ testCaseId: 'tc:v1:4' as TestCaseId, status: 'healthy' }),
        classification({ testCaseId: 'tc:v1:5' as TestCaseId, status: 'healthy' }),
        classification({ testCaseId: 'tc:v1:6' as TestCaseId, status: 'healthy' }),
      ],
    });
    const overview = summarizeReport(report);
    expect(overview.statusBreakdown.map((entry) => entry.status)).toEqual(['misleading', 'weak', 'needs-review', 'healthy']);
    expect(overview.statusBreakdown).toEqual([
      { status: 'misleading', count: 1, share: 1 / 6 },
      { status: 'weak', count: 1, share: 1 / 6 },
      { status: 'needs-review', count: 1, share: 1 / 6 },
      { status: 'healthy', count: 3, share: 3 / 6 },
    ]);
  });
});

describe('summarizeReport: run coverage', () => {
  it('carries discovered/judged/cached/fresh/failed/not-evaluated/skipped counts', () => {
    const report = minimalReport({
      discovery: { ...minimalReport().discovery, totals: { ...minimalReport().discovery.totals, testCases: 10 } },
      totals: {
        evaluated: 3,
        cached: 2,
        failed: 1,
        skipped: { total: 2, byReason: { skip: 1, todo: 1, 'evidence-unavailable': 0 } },
        usage: { inputTokens: 100, outputTokens: 20 },
        statusCounts: { healthy: 4, weak: 1, misleading: 0, 'needs-review': 0 },
        respondedModel: 'jev-1.13.0',
        modelMismatches: 0,
      },
      cacheStatus: [
        { testCaseId: 'tc:v1:ne' as TestCaseId, repositoryRelativePath: 'b.test.ts', name: 'failed dispatch', status: 'not-evaluated' },
        ...minimalReport().cacheStatus,
      ],
      classifications: [
        classification({ testCaseId: 'tc:v1:1' as TestCaseId }),
        classification({ testCaseId: 'tc:v1:2' as TestCaseId }),
        classification({ testCaseId: 'tc:v1:3' as TestCaseId }),
        classification({ testCaseId: 'tc:v1:4' as TestCaseId }),
        classification({ testCaseId: 'tc:v1:5' as TestCaseId, status: 'weak' }),
      ],
    });
    const overview = summarizeReport(report);
    expect(overview.coverage).toEqual({
      discoveredTests: 10,
      judgedTests: 5,
      judgedShare: 0.5,
      cached: 2,
      fresh: 3,
      failed: 1,
      notEvaluated: 1,
      skippedTotal: 2,
      skippedByReason: { skip: 1, todo: 1, 'evidence-unavailable': 0 },
    });
  });
});

describe('summarizeReport: per-dimension level counts', () => {
  it('buckets each dimension into misleading/weak/acceptable/strong/needsReview/notApplicable with shares over that dimension\'s total', () => {
    const report = minimalReport({
      classifications: [
        classification({ testCaseId: 'tc:v1:1' as TestCaseId, dimensions: [dimension({ level: 'misleading', status: 'judged' })] }),
        classification({ testCaseId: 'tc:v1:2' as TestCaseId, dimensions: [dimension({ level: 'weak', status: 'judged' })] }),
        classification({ testCaseId: 'tc:v1:3' as TestCaseId, dimensions: [dimension({ level: 'acceptable', status: 'judged' })] }),
        classification({ testCaseId: 'tc:v1:4' as TestCaseId, dimensions: [dimension({ level: 'strong', status: 'judged' })] }),
        classification({
          testCaseId: 'tc:v1:5' as TestCaseId,
          dimensions: [dimension({ level: undefined, status: 'needs-review', reason: 'boundary-straddle' })],
        }),
        classification({
          testCaseId: 'tc:v1:6' as TestCaseId,
          dimensions: [dimension({ level: undefined, status: 'not-applicable', applicable: false, applicabilityProbability: 0.1 })],
        }),
      ],
    });
    const overview = summarizeReport(report);
    expect(overview.dimensions).toHaveLength(1);
    const [falsifiability] = overview.dimensions;
    expect(falsifiability!.dimensionId).toBe('falsifiability');
    expect(falsifiability!.total).toBe(6);
    expect(falsifiability!.counts).toEqual({ misleading: 1, weak: 1, acceptable: 1, strong: 1, needsReview: 1, notApplicable: 1 });
    expect(falsifiability!.shares).toEqual({
      misleading: 1 / 6, weak: 1 / 6, acceptable: 1 / 6, strong: 1 / 6, needsReview: 1 / 6, notApplicable: 1 / 6,
    });
    expect(falsifiability!.deficientShare).toBeCloseTo(2 / 6, 10);
  });

  it('lists a dimension only present on some classifications with a total scoped to that dimension alone', () => {
    const report = minimalReport({
      classifications: [
        classification({ testCaseId: 'tc:v1:1' as TestCaseId, dimensions: [dimension({ dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', level: 'strong' })] }),
        classification({ testCaseId: 'tc:v1:2' as TestCaseId, dimensions: [dimension({ dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', level: 'misleading' })] }),
      ],
    });
    const overview = summarizeReport(report);
    expect(overview.dimensions).toHaveLength(1);
    expect(overview.dimensions[0]).toMatchObject({ dimensionId: 'assertion-strength', total: 2 });
  });
});

describe('summarizeReport: top files', () => {
  it('ranks files by tests needing a change, carrying that file\'s judged total and share, capped at the limit', () => {
    const files = Array.from({ length: TOP_FILES_LIMIT + 5 }, (_, index) => {
      const needsChangeCount = TOP_FILES_LIMIT + 5 - index; // descending, all distinct
      const path = `file-${index}.test.ts`;
      const classifications: AuditReportClassification[] = [];
      for (let n = 0; n < needsChangeCount; n += 1) {
        classifications.push(classification({ testCaseId: `tc:v1:${path}:${n}` as TestCaseId, repositoryRelativePath: path, status: 'weak' }));
      }
      classifications.push(classification({ testCaseId: `tc:v1:${path}:healthy` as TestCaseId, repositoryRelativePath: path, status: 'healthy' }));
      return classifications;
    }).flat();
    const report = minimalReport({ classifications: files });
    const overview = summarizeReport(report);
    expect(overview.topFiles).toHaveLength(TOP_FILES_LIMIT);
    expect(overview.topFiles[0]).toEqual({ path: 'file-0.test.ts', needsChangeCount: TOP_FILES_LIMIT + 5, judgedTotal: TOP_FILES_LIMIT + 6, share: (TOP_FILES_LIMIT + 5) / (TOP_FILES_LIMIT + 6) });
    const counts = overview.topFiles.map((entry) => entry.needsChangeCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('excludes a file whose tests all stayed healthy', () => {
    const report = minimalReport({
      classifications: [
        classification({ testCaseId: 'tc:v1:1' as TestCaseId, repositoryRelativePath: 'clean.test.ts', status: 'healthy' }),
      ],
    });
    const overview = summarizeReport(report);
    expect(overview.topFiles).toEqual([]);
  });

  it('never counts a needs-review test toward needsChangeCount, and excludes a file whose non-healthy tests are all needs-review', () => {
    const report = minimalReport({
      classifications: [
        classification({ testCaseId: 'tc:v1:1' as TestCaseId, repositoryRelativePath: 'mixed.test.ts', status: 'weak' }),
        classification({ testCaseId: 'tc:v1:2' as TestCaseId, repositoryRelativePath: 'mixed.test.ts', status: 'needs-review' }),
        classification({ testCaseId: 'tc:v1:3' as TestCaseId, repositoryRelativePath: 'uncertain-only.test.ts', status: 'needs-review' }),
      ],
    });
    const overview = summarizeReport(report);
    expect(overview.topFiles).toEqual([{ path: 'mixed.test.ts', needsChangeCount: 1, judgedTotal: 2, share: 0.5 }]);
  });
});

describe('summarizeReport: folder x dimension heatmap', () => {
  function withPathAndStatus(path: string, id: string, status: AuditReportClassification['status'], dimOverrides: Partial<DimensionJudgment> = {}) {
    return classification({
      testCaseId: `tc:v1:${id}` as TestCaseId,
      repositoryRelativePath: path,
      status,
      dimensions: [dimension(dimOverrides)],
    });
  }

  it('groups by the first two directory segments once a folder has enough tests, computing bad/applicable/share per dimension', () => {
    const classifications = [
      withPathAndStatus('src/payments/checkout.test.ts', '1', 'misleading', { level: 'misleading' }),
      withPathAndStatus('src/payments/refund.test.ts', '2', 'weak', { level: 'weak' }),
      withPathAndStatus('src/payments/invoice.test.ts', '3', 'healthy', { level: 'strong' }),
    ];
    const report = minimalReport({ classifications });
    const overview = summarizeReport(report);
    const row = overview.folderHeatmap.rows.find((entry) => entry.folder === 'src/payments');
    expect(row).toBeDefined();
    expect(row!.judgedTotal).toBe(3);
    expect(row!.needsChangeCount).toBe(2);
    expect(row!.isRemainder).toBe(false); // this folder never split into child rows
    const cell = row!.cells.find((entry) => entry.dimensionId === 'falsifiability');
    expect(cell).toEqual({ dimensionId: 'falsifiability', dimensionLabel: 'Falsifiability', badCount: 2, applicableCount: 3, share: 2 / 3 });
  });

  it('never counts a needs-review test toward a row\'s needsChangeCount', () => {
    const classifications = [
      withPathAndStatus('src/payments/checkout.test.ts', '1', 'weak', { level: 'weak' }),
      withPathAndStatus('src/payments/refund.test.ts', '2', 'needs-review', { level: undefined, status: 'needs-review', reason: 'boundary-straddle' }),
      withPathAndStatus('src/payments/invoice.test.ts', '3', 'needs-review', { level: undefined, status: 'needs-review', reason: 'boundary-straddle' }),
    ];
    const report = minimalReport({ classifications });
    const overview = summarizeReport(report);
    const row = overview.folderHeatmap.rows.find((entry) => entry.folder === 'src/payments');
    expect(row).toBeDefined();
    expect(row!.judgedTotal).toBe(3);
    expect(row!.needsChangeCount).toBe(1);
  });

  it('renders a cell with zero applicable tests as share undefined, never NaN or 0', () => {
    const classifications = [
      withPathAndStatus('src/payments/checkout.test.ts', '1', 'misleading', {
        dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', status: 'not-applicable', applicable: false, level: undefined, applicabilityProbability: 0.1,
      }),
      withPathAndStatus('src/payments/refund.test.ts', '2', 'weak', {
        dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', status: 'not-applicable', applicable: false, level: undefined, applicabilityProbability: 0.1,
      }),
      withPathAndStatus('src/payments/invoice.test.ts', '3', 'healthy', {
        dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', status: 'not-applicable', applicable: false, level: undefined, applicabilityProbability: 0.1,
      }),
    ];
    const report = minimalReport({ classifications });
    const overview = summarizeReport(report);
    const row = overview.folderHeatmap.rows.find((entry) => entry.folder === 'src/payments');
    const cell = row!.cells.find((entry) => entry.dimensionId === 'assertion-strength');
    expect(cell).toEqual({ dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', badCount: 0, applicableCount: 0, share: undefined });
  });

  it('folds a too-small candidate group up into its nearest ancestor row instead of giving it its own row', () => {
    expect(HEATMAP_MIN_GROUP_SIZE).toBeGreaterThan(1);
    const common = Array.from({ length: 6 }, (_, index) =>
      withPathAndStatus(`src/common/${index}.test.ts`, `common-${index}`, 'weak', { level: 'weak' }));
    const rare = Array.from({ length: HEATMAP_MIN_GROUP_SIZE - 1 }, (_, index) =>
      withPathAndStatus(`src/rare/${index}.test.ts`, `rare-${index}`, 'weak', { level: 'weak' }));
    const report = minimalReport({ classifications: [...common, ...rare] });
    const overview = summarizeReport(report);
    const folders = overview.folderHeatmap.rows.map((row) => row.folder);
    expect(folders).toContain('src/common');
    expect(folders).not.toContain('src/rare');
    expect(folders).not.toContain('src'); // "src" is a generic segment, never a row of its own
    // The too-small "src/rare" group folds up to the nearest ancestor row that was actually
    // established (root, "."), since "src" alone is never a candidate row.
    const root = overview.folderHeatmap.rows.find((row) => row.folder === '.');
    expect(root).toBeDefined();
    expect(root!.judgedTotal).toBe(rare.length);
  });

  it('buckets a root-level test file (no directory) under "."', () => {
    const report = minimalReport({ classifications: [withPathAndStatus('smoke.test.ts', '1', 'weak', { level: 'weak' })] });
    const overview = summarizeReport(report);
    expect(overview.folderHeatmap.rows.map((row) => row.folder)).toContain('.');
  });

  it('drills down past generic segments to module/feature level for a supermarket-pro-shaped monorepo', () => {
    const backendModules = ['budgets', 'inventory', 'orders'];
    const mobileFeatures = ['checkout', 'cart'];
    const classifications = [
      ...backendModules.flatMap((mod) => Array.from({ length: 8 }, (_, index) =>
        withPathAndStatus(`backend/src/modules/${mod}/__tests__/${mod}-${index}.spec.ts`, `${mod}-${index}`, 'weak', { level: 'weak' }))),
      ...mobileFeatures.flatMap((feature) => Array.from({ length: 6 }, (_, index) =>
        withPathAndStatus(`mobile/src/features/${feature}/${feature}-${index}.test.tsx`, `${feature}-${index}`, 'weak', { level: 'weak' }))),
    ];
    const report = minimalReport({ classifications });
    const overview = summarizeReport(report);
    const folders = overview.folderHeatmap.rows.map((row) => row.folder);
    for (const mod of backendModules) expect(folders).toContain(`backend/src/modules/${mod}`);
    for (const feature of mobileFeatures) expect(folders).toContain(`mobile/src/features/${feature}`);
    // Never a coarse stop at a bare top-level or "src" prefix — those are too coarse to be useful.
    expect(folders).not.toContain('backend');
    expect(folders).not.toContain('backend/src');
    expect(folders).not.toContain('mobile');
    expect(folders).not.toContain('mobile/src');
    // Every test is accounted for somewhere — the drill-down never silently drops a test.
    const total = overview.folderHeatmap.rows.reduce((sum, row) => sum + row.judgedTotal, 0);
    expect(total).toBe(classifications.length);
  });

  it('marks a split folder\'s own leftover row as isRemainder, distinct from its child rows, without touching the plain "folder" path', () => {
    const classifications = [
      ...['eval', 'services', 'extraction'].flatMap((sub) => Array.from({ length: 5 }, (_, index) =>
        withPathAndStatus(`backend/src/modules/tickets/${sub}/${sub}-${index}.test.ts`, `${sub}-${index}`, 'weak', { level: 'weak' }))),
      // Tests directly in "tickets", with no further real segment — these are the remainder.
      ...Array.from({ length: 4 }, (_, index) =>
        withPathAndStatus(`backend/src/modules/tickets/direct-${index}.test.ts`, `direct-${index}`, 'weak', { level: 'weak' })),
    ];
    const report = minimalReport({ classifications });
    const overview = summarizeReport(report);
    const rows = overview.folderHeatmap.rows;

    const evalRow = rows.find((row) => row.folder === 'backend/src/modules/tickets/eval');
    expect(evalRow).toBeDefined();
    expect(evalRow!.isRemainder).toBe(false);

    const remainderRow = rows.find((row) => row.folder === 'backend/src/modules/tickets');
    expect(remainderRow).toBeDefined();
    expect(remainderRow!.isRemainder).toBe(true);
    expect(remainderRow!.judgedTotal).toBe(4);
  });

  it('caps rows at the limit, folding the remaining folders into one "Other" row summing their counts', () => {
    const perFolder = HEATMAP_MIN_GROUP_SIZE;
    const folderCount = HEATMAP_ROWS_LIMIT + 3;
    const classifications = Array.from({ length: folderCount }, (_, folderIndex) =>
      Array.from({ length: perFolder }, (_, testIndex) =>
        withPathAndStatus(`area-${folderIndex}/mod/${testIndex}.test.ts`, `f${folderIndex}-${testIndex}`, 'weak', { level: 'weak' }))).flat();
    const report = minimalReport({ classifications });
    const overview = summarizeReport(report);
    expect(overview.folderHeatmap.rows).toHaveLength(HEATMAP_ROWS_LIMIT + 1);
    const other = overview.folderHeatmap.rows[overview.folderHeatmap.rows.length - 1]!;
    expect(other.folder).toBe('Other');
    expect(other.isOther).toBe(true);
    expect(other.judgedTotal).toBe(3 * perFolder);
    expect(other.needsChangeCount).toBe(3 * perFolder);
  });
});

describe('summarizeReport: diagnostics grouped by code', () => {
  it('groups by code with a total count and a per-severity breakdown', () => {
    const report = minimalReport({
      diagnostics: [
        { code: 'evaluation-failed', message: 'a', severity: 'error' },
        { code: 'evaluation-failed', message: 'b', severity: 'error' },
        { code: 'evaluation-failed', message: 'c', severity: 'warning' },
        { code: 'unsupported-framework', message: 'd', severity: 'warning' },
      ],
    });
    const overview = summarizeReport(report);
    expect(overview.diagnostics).toEqual([
      { code: 'evaluation-failed', count: 3, severities: { error: 2, warning: 1 } },
      { code: 'unsupported-framework', count: 1, severities: { warning: 1 } },
    ]);
  });
});
