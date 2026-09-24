import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderAuditReportHtml } from '../src/domain/html-report.js';
import type { AuditReport, AuditReportClassification } from '../src/domain/report.js';
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
    latency: { latencyMs: 120, attemptLatenciesMs: [120] },
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
    versions: { storeSchema: 4, rubric: 2, policy: 2 },
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

/**
 * Builds `count` classifications spread deterministically across a small, FIXED number of files and
 * one dimension — the shape a size-bound test needs: only the per-file/per-dimension COUNTS grow
 * with `count`, never the number of distinct rows the overview renders. `fileCount` is kept small
 * enough (5) that even the smallest fixture this module's tests use (20) puts >= `HEATMAP_MIN_GROUP_SIZE`
 * (3) tests in every folder, so the heatmap groups at the same depth — and shows the same number of
 * rows — at every fixture size; a larger `fileCount` would make the small fixture's folders fall back
 * to a coarser grouping than the large fixture's, breaking the "same shape at every size" premise the
 * size-bound test below relies on.
 */
function manyClassifications(count: number): AuditReportClassification[] {
  const fileCount = 5;
  return Array.from({ length: count }, (_, index) => {
    const fileIndex = index % fileCount;
    const status = index % 3 === 0 ? 'misleading' : index % 3 === 1 ? 'weak' : 'healthy';
    return classification({
      testCaseId: `tc:v1:${index}` as TestCaseId,
      repositoryRelativePath: `src/area-${fileIndex}/mod/file-${fileIndex}.test.ts`,
      name: `test number ${index}`,
      status,
      dimensions: [dimension({ level: status === 'healthy' ? 'strong' : status === 'weak' ? 'weak' : 'misleading', status: 'judged' })],
    });
  });
}

function bigReport(count: number): AuditReport {
  const classifications = manyClassifications(count);
  const misleading = classifications.filter((entry) => entry.status === 'misleading').length;
  const weak = classifications.filter((entry) => entry.status === 'weak').length;
  const healthy = classifications.filter((entry) => entry.status === 'healthy').length;
  return minimalReport({
    discovery: { ...minimalReport().discovery, totals: { ...minimalReport().discovery.totals, testCases: count, files: 5 } },
    totals: {
      ...minimalReport().totals,
      evaluated: count,
      statusCounts: { healthy, weak, misleading, 'needs-review': 0 },
    },
    cacheStatus: classifications.map((entry) => ({ testCaseId: entry.testCaseId, repositoryRelativePath: entry.repositoryRelativePath, name: entry.name, status: 'fresh' })),
    classifications,
    diagnostics: [{ code: 'evaluation-failed', message: 'x', severity: 'error' }],
  });
}

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`<script>&"'`)).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('adds two numbers correctly')).toBe('adds two numbers correctly');
  });
});

describe('renderAuditReportHtml: document shape', () => {
  it('renders one complete, well-formed HTML document', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toMatch(/<html[^>]*>/);
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
    expect(html).toMatch(/<meta charset="utf-8">/i);
  });

  it('puts the run metadata at the bottom, after every data section and right before the footer', () => {
    const html = renderAuditReportHtml(minimalReport({ runId: 'run-meta-1' }));
    const mast = html.slice(html.indexOf('<header class="mast">'), html.indexOf('</header>'));
    expect(mast).not.toContain('Run id');
    const metaAt = html.indexOf('id="jev-run-details"');
    expect(metaAt).toBeGreaterThan(html.indexOf('id="jev-coverage"'));
    expect(metaAt).toBeLessThan(html.indexOf('<footer>'));
    expect(html.slice(metaAt, html.indexOf('<footer>'))).toContain('run-meta-1');
  });

  it('embeds no canonical JSON data block at all — per-test/canonical detail lives only in `audit --evaluate --json`', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).not.toContain('application/json');
    expect(html).not.toContain('jev-report-data');
  });

  it('ships no <script> tag at all — no filter/expand behavior remains once the per-test list is gone', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).not.toMatch(/<script\b/i);
  });

  it('renders identically for the same report (deterministic, no timers, no randomness)', () => {
    const report = minimalReport();
    expect(renderAuditReportHtml(report)).toBe(renderAuditReportHtml(report));
  });

  it('renders identically whether the report object was built directly or round-tripped through JSON.stringify/JSON.parse (optional-field handling never relies on `in`/live-object shape)', () => {
    const report = minimalReport();
    const direct = renderAuditReportHtml(report);
    const roundTripped = renderAuditReportHtml(JSON.parse(JSON.stringify(report)) as AuditReport);
    expect(roundTripped).toBe(direct);
  });

  it('mentions the run\'s rootDir and reportVersion, for a reader to identify which run this is', () => {
    const html = renderAuditReportHtml(minimalReport({ rootDir: '/workspace/my-repo' }));
    expect(html).toContain('/workspace/my-repo');
    expect(html).toContain('1');
  });

  it('shows the runId when present, and omits any runId mention when absent', () => {
    const withRunId = renderAuditReportHtml(minimalReport({ runId: 'run:v1:abc123' }));
    expect(withRunId).toContain('run:v1:abc123');

    const withoutRunId = renderAuditReportHtml(minimalReport());
    expect(withoutRunId).not.toContain('run:v1:');
  });

  it('states the classification thresholds are provisional and uncalibrated, never claiming accuracy', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html.toLowerCase()).toContain('provisional');
    expect(html.toLowerCase()).not.toContain('calibrated accuracy');
  });

  it('paints the page with the warm editorial palette, and lights violet and ember only as data marks', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).toContain('#fdfcfc');
    expect(html).toContain('#f5f3f1');
    expect(html).toContain('#0447ff');
    expect(html).toContain('#ff4704');
    expect(html).not.toContain('#1e7e34');
    expect(html).not.toContain('#c62828');
    expect(html).not.toContain('#14161a');
  });

  it('points a reader to `audit --evaluate --json` for per-test detail', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).toContain('audit --evaluate --json');
  });
});

describe('renderAuditReportHtml: headline percentage', () => {
  it('shows "X% of N judged tests need a change" naming its own denominator', () => {
    const misleading = classification({ testCaseId: 'tc:v1:m' as TestCaseId, status: 'misleading' });
    const weak = classification({ testCaseId: 'tc:v1:w' as TestCaseId, status: 'weak' });
    const healthy = classification({ testCaseId: 'tc:v1:h' as TestCaseId, status: 'healthy' });
    const html = renderAuditReportHtml(minimalReport({
      totals: { ...minimalReport().totals, statusCounts: { healthy: 1, weak: 1, misleading: 1, 'needs-review': 0 } },
      classifications: [misleading, weak, healthy],
    }));
    expect(html).toContain('67%');
    expect(html).toContain('of 3 judged tests need a change');
    expect(html).toContain('2 of 3 judged tests are misleading or weak');
  });

  it('excludes needs-review from the headline share and shows it as a separate, secondary figure over the same denominator', () => {
    const misleading = classification({ testCaseId: 'tc:v1:m' as TestCaseId, status: 'misleading' });
    const needsReview = classification({ testCaseId: 'tc:v1:r' as TestCaseId, status: 'needs-review' });
    const healthy = classification({ testCaseId: 'tc:v1:h' as TestCaseId, status: 'healthy' });
    const html = renderAuditReportHtml(minimalReport({
      totals: { ...minimalReport().totals, statusCounts: { healthy: 1, weak: 0, misleading: 1, 'needs-review': 1 } },
      classifications: [misleading, needsReview, healthy],
    }));
    // Headline share is 1/3 (misleading only), never 2/3 (which would fold needs-review in).
    expect(html).toContain('33%');
    expect(html).toContain('of 3 judged tests need a change');
    expect(html).not.toContain('67%');
    // Secondary needs-review figure, same judged denominator, visually distinct markup.
    expect(html).toContain('class="hero-secondary"');
    expect(html).toContain('of 3 judged tests need review');
  });

  it('never renders NaN anywhere, even for a report with zero judged tests', () => {
    const html = renderAuditReportHtml(minimalReport({
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
    }));
    expect(html).not.toContain('NaN');
    expect(html).toContain('0%');
    expect(html).toContain('of 0 judged tests need a change');
  });
});

describe('renderAuditReportHtml: status share', () => {
  it('shows every status worst-first (misleading, weak, needs-review, healthy) with count and percent', () => {
    const html = renderAuditReportHtml(minimalReport({
      totals: { ...minimalReport().totals, statusCounts: { healthy: 3, weak: 1, misleading: 1, 'needs-review': 1 } },
      classifications: [
        classification({ testCaseId: 'tc:v1:1' as TestCaseId, status: 'misleading' }),
        classification({ testCaseId: 'tc:v1:2' as TestCaseId, status: 'weak' }),
        classification({ testCaseId: 'tc:v1:3' as TestCaseId, status: 'needs-review' }),
        classification({ testCaseId: 'tc:v1:4' as TestCaseId, status: 'healthy' }),
        classification({ testCaseId: 'tc:v1:5' as TestCaseId, status: 'healthy' }),
        classification({ testCaseId: 'tc:v1:6' as TestCaseId, status: 'healthy' }),
      ],
    }));
    const positions = ['Misleading', 'Weak', 'Needs review', 'Healthy'].map((label) => html.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('17%'); // 1/6, rounded
  });
});

describe('renderAuditReportHtml: coverage', () => {
  it('shows discovered/judged with a share, plus cached/failed/not-evaluated/skipped counts', () => {
    const report = minimalReport({
      discovery: { ...minimalReport().discovery, totals: { ...minimalReport().discovery.totals, testCases: 10, files: 4, excluded: 2 } },
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
    const html = renderAuditReportHtml(report);
    expect(html).toContain('Judged 5 of 10 discovered tests (50%)');
    expect(html).toContain('4 file(s) discovered, 2 excluded');
    expect(html).toContain('Cached: 2');
    expect(html).toContain('Failed: 1');
    expect(html).toContain('Dispatched but not evaluated: 1');
    expect(html).toContain('Skipped: 2 (skip: 1, todo: 1, evidence-unavailable: 0)');
  });
});

describe('renderAuditReportHtml: per-dimension bars', () => {
  it('orders dimensions worst (highest misleading+weak share) first, and lists needs-review/not-applicable separately', () => {
    const worseDim = classification({
      testCaseId: 'tc:v1:worse' as TestCaseId,
      dimensions: [dimension({ dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', level: 'misleading', status: 'judged' })],
    });
    const betterDim = classification({
      testCaseId: 'tc:v1:better' as TestCaseId,
      dimensions: [dimension({ dimensionId: 'falsifiability', dimensionLabel: 'Falsifiability', level: 'strong', status: 'judged' })],
    });
    const html = renderAuditReportHtml(minimalReport({ classifications: [betterDim, worseDim] }));
    const assertPos = html.indexOf('Assert.');
    const falsPos = html.indexOf('Fals.');
    expect(assertPos).toBeGreaterThan(0);
    expect(falsPos).toBeGreaterThan(0);
    expect(assertPos).toBeLessThan(falsPos);
  });

  it('shows a needs-review dimension\'s count separately from the diverging misleading/weak/acceptable/strong bar', () => {
    const html = renderAuditReportHtml(minimalReport({
      classifications: [classification({ dimensions: [dimension({ level: undefined, status: 'needs-review', reason: 'boundary-straddle' })] })],
    }));
    expect(html).toContain('1 needs review');
  });

  it('never renders the removed noul matrix or per-test filter toolbar', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).not.toContain('Noul matrix');
    expect(html).not.toContain('jev-filter');
    expect(html).not.toContain('jev-expand-all');
    expect(html).not.toContain('jev-collapse-all');
    expect(html).not.toContain('class="toolbar"');
  });
});

describe('renderAuditReportHtml: folder x dimension heatmap', () => {
  it('shows a folder row, a short dimension column header, and a percent cell with bad/applicable in its title', () => {
    const classifications = [
      classification({ testCaseId: 'tc:v1:1' as TestCaseId, repositoryRelativePath: 'src/payments/checkout.test.ts', status: 'misleading', dimensions: [dimension({ level: 'misleading' })] }),
      classification({ testCaseId: 'tc:v1:2' as TestCaseId, repositoryRelativePath: 'src/payments/refund.test.ts', status: 'weak', dimensions: [dimension({ level: 'weak' })] }),
      classification({ testCaseId: 'tc:v1:3' as TestCaseId, repositoryRelativePath: 'src/payments/invoice.test.ts', status: 'healthy', dimensions: [dimension({ level: 'strong' })] }),
    ];
    const html = renderAuditReportHtml(minimalReport({ classifications }));
    expect(html).toContain('src/payments');
    expect(html).toContain('Fals.');
    expect(html).toContain('src/payments · Falsifiability: 67% (2/3)');
  });

  it('renders a cell with zero applicable tests as "n/a", never "NaN" or a misleading "0%"', () => {
    const classifications = [
      classification({ testCaseId: 'tc:v1:1' as TestCaseId, repositoryRelativePath: 'src/payments/checkout.test.ts', status: 'misleading', dimensions: [dimension({ dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', status: 'not-applicable', applicable: false, level: undefined, applicabilityProbability: 0.1 })] }),
      classification({ testCaseId: 'tc:v1:2' as TestCaseId, repositoryRelativePath: 'src/payments/refund.test.ts', status: 'weak', dimensions: [dimension({ dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', status: 'not-applicable', applicable: false, level: undefined, applicabilityProbability: 0.1 })] }),
      classification({ testCaseId: 'tc:v1:3' as TestCaseId, repositoryRelativePath: 'src/payments/invoice.test.ts', status: 'healthy', dimensions: [dimension({ dimensionId: 'assertion-strength', dimensionLabel: 'Assertion strength', status: 'not-applicable', applicable: false, level: undefined, applicabilityProbability: 0.1 })] }),
    ];
    const html = renderAuditReportHtml(minimalReport({ classifications }));
    expect(html).toContain('n/a');
    expect(html).not.toContain('NaN');
    expect(html).toContain('src/payments · Assertion strength: n/a (0 applicable)');
  });

  it('paints context cells in the palette neutrals and only hotspots (>= 50% misleading or weak) in ember', () => {
    const inFolder = (folder: string, levels: readonly ('misleading' | 'weak' | 'strong')[]) => levels.map((level, index) => classification({
      testCaseId: `tc:v1:${folder}-${index}` as TestCaseId,
      repositoryRelativePath: `src/${folder}/case-${index}.test.ts`,
      status: level === 'strong' ? 'healthy' : level,
      dimensions: [dimension({ level })],
    }));
    const classifications = [
      ...inFolder('hot', ['misleading', 'weak', 'strong']),
      ...inFolder('warm', ['weak', 'strong', 'strong']),
      ...inFolder('cold', ['strong', 'strong', 'strong']),
    ];
    const html = renderAuditReportHtml(minimalReport({ classifications }));
    const cellBackground = (folder: string) => new RegExp(`style="background:(#[0-9a-f]{6})[^"]*" title="src/${folder} · `).exec(html)?.[1];
    expect(cellBackground('hot')).toBe('#ff4704');
    expect(cellBackground('warm')).toBe('#a59f97');
    expect(cellBackground('cold')).toBe('#ebe8e4');
    const inlineBackgrounds = new Set([...html.matchAll(/style="[^"]*background:(#[0-9a-f]{6})/g)].map((match) => match[1]));
    expect([...inlineBackgrounds].every((color) => ['#ebe8e4', '#a59f97', '#ff4704'].includes(color ?? ''))).toBe(true);
    expect(html).toContain('≥ 50%');
  });

  it('carries a legend naming every heat step, hotspot included', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).toContain('heat-legend');
    expect(html).toContain('0–24%');
    expect(html).toContain('25–49%');
    expect(html).toContain('≥ 50% hotspot');
  });

  it('labels a split folder\'s own leftover row "(other files)" so it is never mistaken for the whole folder', () => {
    const direct = Array.from({ length: 4 }, (_, index) => classification({
      testCaseId: `tc:v1:direct-${index}` as TestCaseId,
      repositoryRelativePath: `backend/src/modules/tickets/direct-${index}.test.ts`,
      status: 'weak',
      dimensions: [dimension({ level: 'weak' })],
    }));
    const evalTests = Array.from({ length: 5 }, (_, index) => classification({
      testCaseId: `tc:v1:eval-${index}` as TestCaseId,
      repositoryRelativePath: `backend/src/modules/tickets/eval/eval-${index}.test.ts`,
      status: 'weak',
      dimensions: [dimension({ level: 'weak' })],
    }));
    const html = renderAuditReportHtml(minimalReport({ classifications: [...direct, ...evalTests] }));
    expect(html).toContain('backend/src/modules/tickets (other files)');
    expect(html).toContain('backend/src/modules/tickets/eval');
    // The child row's own name never carries the suffix.
    expect(html).not.toContain('backend/src/modules/tickets/eval (other files)');
  });
});

describe('renderAuditReportHtml: top files', () => {
  it('ranks files by tests needing a change, worst first, each with its own share', () => {
    const many = classification({ testCaseId: 'tc:v1:m1' as TestCaseId, repositoryRelativePath: 'many.test.ts', status: 'misleading' });
    const many2 = classification({ testCaseId: 'tc:v1:m2' as TestCaseId, repositoryRelativePath: 'many.test.ts', status: 'weak' });
    const few = classification({ testCaseId: 'tc:v1:f1' as TestCaseId, repositoryRelativePath: 'few.test.ts', status: 'weak' });
    const html = renderAuditReportHtml(minimalReport({ classifications: [few, many, many2] }));
    const manyPos = html.indexOf('many.test.ts');
    const fewPos = html.indexOf('few.test.ts');
    expect(manyPos).toBeGreaterThan(0);
    expect(fewPos).toBeGreaterThan(0);
    expect(manyPos).toBeLessThan(fewPos);
    expect(html).toContain('2/2 · 100%');
    expect(html).toContain('1/1 · 100%');
  });

  it('omits the top-files section entirely when nothing needs a change', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).not.toContain('id="jev-top-files"');
  });
});

describe('renderAuditReportHtml: diagnostics grouped by code', () => {
  it('groups by code with a total count and a severity breakdown, never one row per diagnostic', () => {
    const html = renderAuditReportHtml(minimalReport({
      diagnostics: [
        { code: 'evaluation-failed', message: 'a', severity: 'error' },
        { code: 'evaluation-failed', message: 'b', severity: 'error' },
        { code: 'evaluation-failed', message: 'c', severity: 'warning' },
        { code: 'unsupported-framework', message: 'd', severity: 'warning' },
      ],
    }));
    expect(html).toContain('evaluation-failed');
    expect(html).toContain('unsupported-framework');
    expect((html.match(/evaluation-failed/g) ?? []).length).toBe(1);
    expect(html).toContain('error: 2, warning: 1');
    expect(html).not.toContain(' a<'); // the raw per-diagnostic message never renders
  });

  it('shows no diagnostics section at all when there are none', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).not.toContain('<h2>Diagnostics</h2>');
  });
});

describe('renderAuditReportHtml: incomplete and resume disclosure', () => {
  it('shows a prominent incomplete banner with the reason when complete is false', () => {
    const html = renderAuditReportHtml(minimalReport({
      complete: false,
      incompleteReason: 'discovery failed before evaluation could run: boom',
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
    }));
    expect(html).toContain('div class="banner banner-incomplete"');
    expect(html.toLowerCase()).toContain('incomplete');
    expect(html).toContain('discovery failed before evaluation could run: boom');
  });

  it('shows no incomplete banner markup at all when complete is true', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).not.toContain('div class="banner banner-incomplete"');
  });

  it('discloses the resume summary when present', () => {
    const html = renderAuditReportHtml(minimalReport({ resume: { runId: 'run:v1:resumed', outstanding: 2, reused: 5 } }));
    expect(html).toContain('div class="banner banner-resume"');
    expect(html).toContain('run:v1:resumed');
  });

  it('shows no resume banner markup at all when resume is absent', () => {
    const html = renderAuditReportHtml(minimalReport());
    expect(html).not.toContain('div class="banner banner-resume"');
  });
});

describe('renderAuditReportHtml: genuinely self-contained (no external reference of any kind)', () => {
  function extractBlocks(html: string, tagName: string): readonly string[] {
    const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    const blocks: string[] = [];
    let match = pattern.exec(html);
    while (match !== null) {
      blocks.push(match[1] ?? '');
      match = pattern.exec(html);
    }
    return blocks;
  }

  function assertNoExternalReferences(html: string): void {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc\s*=\s*"(?:https?:)?\/\//i);
    expect(html).not.toMatch(/\bhref\s*=\s*"(?:https?:)?\/\//i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/<embed\b/i);
    expect(html).not.toMatch(/<object\b/i);
    expect(html).not.toMatch(/\bcrossorigin\s*=/i);
    expect(html).not.toMatch(/<meta\s+http-equiv\s*=\s*"refresh"/i);
    expect(html).not.toMatch(/<script\b/i);

    for (const styleBlock of extractBlocks(html, 'style')) {
      expect(styleBlock).not.toMatch(/@import/i);
      expect(styleBlock).not.toMatch(/url\(\s*["']?(?!#)/i);
    }
  }

  it('contains no external reference in an ordinary report', () => {
    assertNoExternalReferences(renderAuditReportHtml(minimalReport()));
  });

  it('contains no external reference even when report content tries to smuggle one in (protocol-relative URL, <link>, @import, in a diagnostic message, a file path, and a dimension label)', () => {
    const hostileText = '//evil.cdn.example/x.js <link rel="preload" href="https://evil.example/a.css"> @import url(https://evil.example/b.css);';
    const html = renderAuditReportHtml(minimalReport({
      diagnostics: [{ code: 'evaluation-failed', message: hostileText, severity: 'error' }],
      classifications: [classification({
        repositoryRelativePath: `${hostileText}/x.test.ts`,
        status: 'weak',
        dimensions: [dimension({ dimensionLabel: hostileText, level: 'weak' })],
      })],
    }));
    assertNoExternalReferences(html);
    expect(html).toContain(escapeHtml(hostileText));
  });
});

describe('renderAuditReportHtml: hostile-value escaping (one fixture, every string field this renderer still shows)', () => {
  const payload = '</script><script>alert(1)</script>"><img src=x onerror=1>&\'quoted\'';

  it('never emits the raw hostile payload unescaped anywhere in the rendered HTML', () => {
    const hostileClassification = classification({
      repositoryRelativePath: `${payload}/x.test.ts`,
      status: 'misleading',
      dimensions: [dimension({ dimensionLabel: payload, level: 'misleading' })],
    });
    const html = renderAuditReportHtml(minimalReport({
      rootDir: payload,
      runId: payload,
      modelRequested: payload,
      totals: { ...minimalReport().totals, respondedModel: payload, statusCounts: { healthy: 0, weak: 0, misleading: 1, 'needs-review': 0 } },
      diagnostics: [{ code: payload, message: payload, severity: 'error', repositoryRelativePath: payload }],
      classifications: [hostileClassification],
      resume: { runId: payload, outstanding: 1, reused: 0 },
    }));
    expect(html).not.toContain(payload);
    expect(html).toContain('</html>');
  });
});

describe('renderAuditReportHtml: fixed-size overview (visible size never grows with the number of judged tests)', () => {
  it('renders a 20-test and a 2,000-test fixture of the same shape to nearly the same byte length', () => {
    const small = renderAuditReportHtml(bigReport(20));
    const large = renderAuditReportHtml(bigReport(2000));
    expect(Math.abs(large.length - small.length)).toBeLessThan(400);
    expect(large.length).toBeLessThan(60_000);
  });

  it('never renders per-test markup even at 2,000 judged tests', () => {
    const html = renderAuditReportHtml(bigReport(2000));
    expect(html).not.toContain('jev-tc-');
    expect(html).not.toContain('jev-filter');
    expect(html).not.toContain('Noul matrix');
  });

  it('caps the top-files ranking and the heatmap rows regardless of how many distinct files a run touches', () => {
    const html = renderAuditReportHtml(bigReport(2000));
    const fileRowCount = (html.match(/class="file-row"/g) ?? []).length;
    expect(fileRowCount).toBeLessThanOrEqual(10);
    const heatmapRowCount = (html.match(/class="heat-folder-name"/g) ?? []).length;
    expect(heatmapRowCount).toBeLessThanOrEqual(13);
  });
});

describe('renderAuditReportHtml: renders from a canonical report alone (no repository, no database present)', () => {
  it('is a pure in-memory operation: rendering never creates a file as a side effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-html-report-'));
    const deletedRepoPath = join(dir, 'audited-repo-that-does-not-exist-on-this-machine');
    expect(existsSync(deletedRepoPath)).toBe(false);

    const report = minimalReport({ rootDir: deletedRepoPath, runId: 'run:v1:disk-round-trip' });
    const html = renderAuditReportHtml(report);

    expect(existsSync(deletedRepoPath)).toBe(false);
    expect(html).toContain(escapeHtml(deletedRepoPath));
    expect(html).toContain('run:v1:disk-round-trip');

    const entriesAfter = await readdir(dir);
    expect(entriesAfter).toEqual([]);
  });
});
