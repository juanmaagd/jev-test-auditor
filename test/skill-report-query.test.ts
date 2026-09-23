import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exampleAuditReport } from '../examples/report-fixture.js';
import { summarizeReport } from '../src/domain/report-overview.js';
import type { AuditReport, AuditReportClassification } from '../src/domain/report.js';
import type { DimensionJudgment, DimensionNeedsReviewReason } from '../src/domain/classification.js';
import type { RubricDimensionId } from '../src/domain/rubric.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

/**
 * `skills/jev-test-audit/assets/report-query.mjs` supersedes `summarize.mjs` (unreleased, no
 * back-compat): a subcommand query tool, one script for every question an agent may ask about a
 * persisted report, so the report itself never has to enter the agent's context. Every test here
 * drives the real child process — the way an agent does — asserting only on stdout/stderr/exit
 * code, exactly like `test/skill-summarize.test.ts` did before it.
 */
const SCRIPT_PATH = join(process.cwd(), 'skills', 'jev-test-audit', 'assets', 'report-query.mjs');

const temporaryRoots: string[] = [];
afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-report-query-'));
  temporaryRoots.push(dir);
  return dir;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], options: { readonly cwd?: string; readonly input?: string } = {}): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: options.cwd ?? process.cwd(),
    input: options.input,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parse<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

// -------------------------------------------------------------------------------------------
// Fixture builders — a minimal, valid AuditReport built up from explicit dimension/classification
// specs, mirroring test/report-overview.test.ts's own helpers.
// -------------------------------------------------------------------------------------------

const LABELS: readonly { readonly id: RubricDimensionId; readonly label: string }[] = [
  { id: 'falsifiability', label: 'Falsifiability' },
  { id: 'behavioral-focus', label: 'Behavioral focus' },
  { id: 'refactor-resistance', label: 'Refactor resistance' },
  { id: 'assertion-strength', label: 'Assertion strength' },
  { id: 'test-double-quality', label: 'Test-double quality' },
  { id: 'determinism-isolation', label: 'Determinism and isolation' },
  { id: 'diagnostic-quality', label: 'Diagnostic quality' },
];

interface DimensionSpec {
  readonly index?: number;
  readonly level?: 'misleading' | 'weak' | 'acceptable' | 'strong';
  readonly needsReview?: boolean;
  readonly reason?: DimensionNeedsReviewReason;
}

function dimension(spec: DimensionSpec = {}): DimensionJudgment {
  const { id, label } = LABELS[spec.index ?? 0]!;
  if (spec.needsReview) {
    return {
      dimensionId: id,
      dimensionLabel: label,
      applicable: true,
      applicabilityProbability: 0.8,
      status: 'needs-review',
      level: undefined,
      score: undefined,
      confidence: undefined,
      reason: spec.reason ?? 'boundary-straddle',
      probabilities: { '0': 0.2, '1': 0.3, '2': 0.3, '3': 0.2 },
      deficientMass: 0.5,
      acceptableMass: 0.5,
      criticalMass: 0.2,
    };
  }
  const level = spec.level ?? 'strong';
  const score = level === 'strong' ? 3 : level === 'acceptable' ? 2 : level === 'weak' ? 1 : 0;
  return {
    dimensionId: id,
    dimensionLabel: label,
    applicable: true,
    applicabilityProbability: 0.9,
    status: 'judged',
    level,
    score,
    confidence: 0.85,
    reason: undefined,
    probabilities: { '0': 0.05, '1': 0.1, '2': 0.15, '3': 0.7 },
    deficientMass: level === 'misleading' || level === 'weak' ? 0.7 : 0.1,
    acceptableMass: level === 'misleading' || level === 'weak' ? 0.3 : 0.9,
    criticalMass: level === 'misleading' ? 0.6 : 0.05,
  };
}

function isFindingWorthy(judgment: DimensionJudgment): boolean {
  if (judgment.status === 'needs-review') return true;
  return judgment.status === 'judged' && (judgment.level === 'misleading' || judgment.level === 'weak');
}

function classification(
  id: string,
  path: string,
  status: AuditReportClassification['status'],
  dimensions: readonly DimensionJudgment[] = [dimension()],
  name = `test ${id}`,
): AuditReportClassification {
  const testCaseId = `tc:v1:${id}` as TestCaseId;
  const findings = dimensions.filter(isFindingWorthy).map((judgment) => ({
    testCaseId,
    repositoryRelativePath: path,
    name,
    dimensionId: judgment.dimensionId,
    dimensionLabel: judgment.dimensionLabel,
    level: judgment.level,
    score: judgment.score,
    confidence: judgment.confidence,
    applicabilityProbability: judgment.applicabilityProbability,
    status: judgment.status,
    reason: judgment.reason,
    probabilities: judgment.probabilities,
    deficientMass: judgment.deficientMass,
    acceptableMass: judgment.acceptableMass,
    criticalMass: judgment.criticalMass,
  }));
  return {
    testCaseId,
    repositoryRelativePath: path,
    name,
    status,
    dimensions,
    findings,
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 100, outputTokens: 10 },
    cache: 'fresh',
    evidence: { fragments: 1, truncatedFragments: 0, denied: [], unresolved: [], omitted: [] },
  };
}

function reportFrom(classifications: readonly AuditReportClassification[], overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    reportVersion: 1,
    rootDir: '/repo',
    runId: 'run:v1:fixture',
    reportingOnly: true,
    complete: true,
    versions: { storeSchema: 3, rubric: 2, policy: 2 },
    modelRequested: 'jev-1.13.0',
    discovery: {
      files: [],
      excluded: [],
      totals: {
        files: classifications.length,
        excluded: 0,
        testCases: classifications.length,
        dynamicMetadata: 0,
        diagnostics: 0,
        unsupportedFrameworkFiles: 0,
        evidenceBundles: classifications.length,
        evidenceFragments: classifications.length,
        evidenceTruncatedFragments: 0,
        evidenceOmitted: 0,
        evidenceDenied: 0,
        evidenceUnresolved: 0,
      },
    },
    totals: {
      evaluated: classifications.length,
      cached: 0,
      failed: 0,
      skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
      usage: { inputTokens: 0, outputTokens: 0 },
      statusCounts: { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 },
      respondedModel: 'jev-1.13.0',
      modelMismatches: 0,
    },
    latency: { measuredTestCases: 0 },
    cacheStatus: [],
    classifications,
    diagnostics: [],
    ...overrides,
  };
}

/**
 * 15 distinct top-level folders, enough to exceed `HEATMAP_ROWS_LIMIT` (12) and exercise both the
 * Other-merge and the min-group-size depth-one fold `folders`/`batches` reuse from
 * `report-overview.ts`. Each folder has a DIFFERENT first path segment so the small ones don't
 * all collapse into one shared depth-one bucket (which would never exceed the row cap).
 * - `big-0`, `big-1`: 5 tests each, depth-two ("big-N/sub") stays its own row.
 * - `small-2`..`small-14` (13 folders): 1 test each, folds to its own depth-one row ("small-N") —
 *   13 distinct rows, so together with the 2 "big-*" rows that is 15 > 12, forcing an Other row.
 */
function manyFoldersReport(): AuditReport {
  const classifications: AuditReportClassification[] = [];
  for (let folderIndex = 0; folderIndex < 2; folderIndex += 1) {
    for (let testIndex = 0; testIndex < 5; testIndex += 1) {
      const id = `big${folderIndex}t${testIndex}`;
      classifications.push(classification(
        id,
        `big-${folderIndex}/sub/file-${testIndex}.test.ts`,
        testIndex === 0 ? 'misleading' : 'healthy',
        [dimension({ index: 0, level: testIndex === 0 ? 'misleading' : 'strong' })],
      ));
    }
  }
  for (let folderIndex = 2; folderIndex < 15; folderIndex += 1) {
    classifications.push(classification(
      `small${folderIndex}`,
      `small-${folderIndex}/sub/file.test.ts`,
      'misleading',
      [dimension({ index: 0, level: 'misleading' })],
    ));
  }
  return reportFrom(classifications);
}

interface Paginated<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly omitted: number;
}

// -------------------------------------------------------------------------------------------
// Global: help, unknown subcommand, input resolution, errors
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: global', () => {
  it('prints usage listing every subcommand when given no arguments', () => {
    const result = run([]);
    expect(result.status).toBe(0);
    for (const name of ['summary', 'worklist', 'file', 'test', 'folders', 'dimensions', 'batches', 'diff', 'runs']) {
      expect(result.stdout).toContain(name);
    }
  });

  it('--help prints the same usage and exits 0', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('summary');
  });

  it('exits 1 on an unknown subcommand, never a stack trace', () => {
    const result = run(['bogus']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown subcommand');
    expect(result.stderr).not.toContain('at ');
  });

  it('exits 1 with a clear message when the report file is missing', async () => {
    const dir = await tempDir();
    const result = run(['summary', join(dir, 'nonexistent.json')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });

  it('exits 1 with a clear message on invalid JSON', async () => {
    const dir = await tempDir();
    const reportPath = join(dir, 'broken.json');
    await writeFile(reportPath, '{ not valid json');
    const result = run(['summary', reportPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });

  it('reads the report from an explicit file path positional', async () => {
    const dir = await tempDir();
    const reportPath = join(dir, 'report.json');
    await writeFile(reportPath, JSON.stringify(exampleAuditReport()));
    const result = run(['summary', reportPath]);
    expect(result.status).toBe(0);
    expect(parse<{ runId: string }>(result.stdout).runId).toBe('run:v1:example');
  });

  it('reads the report from stdin when given "-"', () => {
    const result = run(['summary', '-'], { input: JSON.stringify(exampleAuditReport()) });
    expect(result.status).toBe(0);
    expect(parse<{ runId: string }>(result.stdout).runId).toBe('run:v1:example');
  });

  it('defaults to <root or cwd>/.jta/latest.json when no path is given', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.jta'), { recursive: true });
    await writeFile(join(dir, '.jta', 'latest.json'), JSON.stringify(exampleAuditReport()));
    const result = run(['summary', '--root', dir]);
    expect(result.status).toBe(0);
    expect(parse<{ runId: string }>(result.stdout).runId).toBe('run:v1:example');
  });

  it('--run <id> reads <root>/.jta/reports/<id>.json', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.jta', 'reports'), { recursive: true });
    await writeFile(join(dir, '.jta', 'reports', 'run-abc.json'), JSON.stringify(exampleAuditReport()));
    const result = run(['summary', '--root', dir, '--run', 'run-abc']);
    expect(result.status).toBe(0);
    expect(parse<{ runId: string }>(result.stdout).runId).toBe('run:v1:example');
  });
});

// -------------------------------------------------------------------------------------------
// summary: parity with summarizeReport
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: summary parity with summarizeReport', () => {
  it('matches needsChange, statusCounts, dimensions, topFolders and topFiles for the same report', () => {
    const report = exampleAuditReport();
    const overview = summarizeReport(report);

    const result = run(['summary', '-'], { input: JSON.stringify(report) });
    expect(result.status).toBe(0);
    interface Summary {
      readonly discovered: number;
      readonly judged: number;
      readonly needsChange: { readonly count: number; readonly denominator: number; readonly share: number };
      readonly statusCounts: Record<string, number>;
      readonly dimensions: readonly { readonly dimensionId: string; readonly dimensionLabel: string; readonly total: number; readonly badCount: number; readonly badShare: number }[];
      readonly topFolders: Paginated<{ readonly folder: string; readonly needsChangeCount: number; readonly judgedTotal: number; readonly isOther: boolean }>;
      readonly topFiles: Paginated<{ readonly path: string; readonly needsChangeCount: number; readonly judgedTotal: number }>;
    }
    const summary = parse<Summary>(result.stdout);

    expect(summary.discovered).toBe(overview.coverage.discoveredTests);
    expect(summary.judged).toBe(overview.coverage.judgedTests);
    expect(summary.needsChange.count).toBe(overview.needsChange.count);
    expect(summary.needsChange.denominator).toBe(overview.needsChange.judgedTotal);
    expect(summary.needsChange.share).toBeCloseTo(overview.needsChange.share, 12);

    for (const status of ['healthy', 'weak', 'misleading', 'needs-review'] as const) {
      const entry = overview.statusBreakdown.find((candidate) => candidate.status === status);
      expect(summary.statusCounts[status]).toBe(entry!.count);
    }

    expect(summary.dimensions).toHaveLength(overview.dimensions.length);
    for (const dim of overview.dimensions) {
      const found = summary.dimensions.find((candidate) => candidate.dimensionId === dim.dimensionId);
      expect(found!.total).toBe(dim.total);
      expect(found!.badCount).toBe(dim.counts.misleading + dim.counts.weak);
      expect(found!.badShare).toBeCloseTo(dim.deficientShare, 12);
    }

    const expectedFolders = overview.folderHeatmap.rows.map((row) => ({ folder: row.folder, needsChangeCount: row.needsChangeCount, judgedTotal: row.judgedTotal, isOther: row.isOther }));
    expect(summary.topFolders.items.map(({ folder, needsChangeCount, judgedTotal, isOther }) => ({ folder, needsChangeCount, judgedTotal, isOther }))).toEqual(expectedFolders);
    expect(summary.topFolders.total).toBe(overview.folderHeatmap.rows.length);

    const expectedFiles = overview.topFiles.map((file) => ({ path: file.path, needsChangeCount: file.needsChangeCount, judgedTotal: file.judgedTotal }));
    expect(summary.topFiles.items.map(({ path, needsChangeCount, judgedTotal }) => ({ path, needsChangeCount, judgedTotal }))).toEqual(expectedFiles);
  });

  it('--folder/--status/--dimension narrow the summary', () => {
    const report = exampleAuditReport();
    const expected = report.classifications.filter((c) => c.status === 'misleading' || c.status === 'weak').length;
    const result = run(['summary', '-', '--status', 'misleading,weak'], { input: JSON.stringify(report) });
    expect(result.status).toBe(0);
    expect(parse<{ judged: number }>(result.stdout).judged).toBe(expected);
  });
});

// -------------------------------------------------------------------------------------------
// worklist: files (misleading/weak) split from needsReview (dimension reason codes)
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: worklist', () => {
  function fixture(): AuditReport {
    return reportFrom([
      classification('a', 'src/a.test.ts', 'misleading', [dimension({ index: 0, level: 'misleading' })]),
      classification('b', 'src/a.test.ts', 'needs-review', [
        dimension({ index: 0, level: 'strong' }),
        dimension({ index: 1, needsReview: true, reason: 'missing-answer' }),
      ]),
      classification('c', 'src/b.test.ts', 'healthy', [dimension({ index: 0, level: 'strong' })]),
    ]);
  }

  it('groups misleading/weak tests in files, never a healthy test', () => {
    const result = run(['worklist', '-'], { input: JSON.stringify(fixture()) });
    expect(result.status).toBe(0);
    interface Worklist {
      readonly files: Paginated<{ readonly path: string; readonly tests: readonly { readonly name: string; readonly status: string; readonly dimensions: readonly { readonly dimensionId: string; readonly level: string }[] }[] }>;
      readonly needsReview: Paginated<{ readonly path: string; readonly tests: readonly { readonly name: string; readonly dimensionId: string; readonly reason: string }[] }>;
    }
    const worklist = parse<Worklist>(result.stdout);
    const allTests = worklist.files.items.flatMap((file) => file.tests);
    expect(allTests.every((test) => test.status !== 'healthy')).toBe(true);
    const misleadingTest = allTests.find((test) => test.status === 'misleading');
    expect(misleadingTest!.dimensions).toEqual([{ dimensionId: 'falsifiability', level: 'misleading' }]);
  });

  it('surfaces needs-review dimensions with their reason codes in a separate group', () => {
    const result = run(['worklist', '-'], { input: JSON.stringify(fixture()) });
    expect(result.status).toBe(0);
    interface Worklist {
      readonly needsReview: Paginated<{ readonly path: string; readonly tests: readonly { readonly name: string; readonly dimensionId: string; readonly reason: string }[] }>;
    }
    const worklist = parse<Worklist>(result.stdout);
    expect(worklist.needsReview.items).toHaveLength(1);
    const [file] = worklist.needsReview.items;
    expect(file!.path).toBe('src/a.test.ts');
    expect(file!.tests).toEqual([{ name: 'test b', dimensionId: 'behavioral-focus', reason: 'missing-answer' }]);
  });

  it('--limit/--offset cap the files group and report total/omitted', () => {
    const classifications = Array.from({ length: 5 }, (_, index) => classification(`m${index}`, `src/file-${index}.test.ts`, 'misleading', [dimension({ level: 'misleading' })]));
    const result = run(['worklist', '-', '--limit', '2'], { input: JSON.stringify(reportFrom(classifications)) });
    expect(result.status).toBe(0);
    interface Worklist { readonly files: Paginated<unknown> }
    const worklist = parse<Worklist>(result.stdout);
    expect(worklist.files.items).toHaveLength(2);
    expect(worklist.files.total).toBe(5);
    expect(worklist.files.omitted).toBe(3);
  });
});

// -------------------------------------------------------------------------------------------
// file <path>
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: file <path>', () => {
  it('returns every judged test in that file with per-dimension level and status', () => {
    const report = exampleAuditReport();
    const result = run(['file', 'src/billing.test.ts', '-'], { input: JSON.stringify(report) });
    expect(result.status).toBe(0);
    interface FileResult {
      readonly path: string;
      readonly tests: Paginated<{ readonly name: string; readonly status: string; readonly dimensions: readonly { readonly dimensionId: string; readonly status: string; readonly level: string | undefined }[] }>;
    }
    const fileResult = parse<FileResult>(result.stdout);
    expect(fileResult.path).toBe('src/billing.test.ts');
    const expectedCount = report.classifications.filter((c) => c.repositoryRelativePath === 'src/billing.test.ts').length;
    expect(fileResult.tests.total).toBe(expectedCount);
    expect(fileResult.tests.items[0]!.dimensions).toHaveLength(7);
  });

  it('exits 1 with a clear message when no judged test matches that file', () => {
    const result = run(['file', 'src/nope.test.ts', '-'], { input: JSON.stringify(exampleAuditReport()) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });

  it('exits 1 when the file path argument is missing', () => {
    const result = run(['file'], { input: JSON.stringify(exampleAuditReport()) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });
});

// -------------------------------------------------------------------------------------------
// test <name|testCaseId>
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: test <name-substring|testCaseId>', () => {
  it('matches by case-insensitive name substring, with full per-dimension detail', () => {
    const report = exampleAuditReport();
    const result = run(['test', 'DOUBLE CHARGES', '-'], { input: JSON.stringify(report) });
    expect(result.status).toBe(0);
    interface TestResult {
      readonly matches: Paginated<{
        readonly testCaseId: string;
        readonly name: string;
        readonly dimensions: readonly { readonly dimensionId: string; readonly level: string | undefined; readonly confidence: number | undefined; readonly applicabilityProbability: number | undefined; readonly probabilities: unknown }[];
      }>;
    }
    const testResult = parse<TestResult>(result.stdout);
    expect(testResult.matches.items).toHaveLength(1);
    expect(testResult.matches.items[0]!.name).toBe('never double charges');
    expect(testResult.matches.items[0]!.dimensions[0]).toHaveProperty('confidence');
    expect(testResult.matches.items[0]!.dimensions[0]).toHaveProperty('probabilities');
  });

  it('matches by exact testCaseId', () => {
    const report = exampleAuditReport();
    const targetId = report.classifications[0]!.testCaseId;
    const result = run(['test', targetId, '-'], { input: JSON.stringify(report) });
    expect(result.status).toBe(0);
    interface TestResult { readonly matches: Paginated<{ readonly testCaseId: string }> }
    const testResult = parse<TestResult>(result.stdout);
    expect(testResult.matches.items.map((m) => m.testCaseId)).toContain(targetId);
  });
});

// -------------------------------------------------------------------------------------------
// folders / dimensions: ranked aggregates
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: folders', () => {
  it('folds small folders up and merges the rest into an Other row, worst-first', () => {
    const report = manyFoldersReport();
    const overview = summarizeReport(report);

    const result = run(['folders', '-'], { input: JSON.stringify(report) });
    expect(result.status).toBe(0);
    interface FoldersResult { readonly folders: Paginated<{ readonly folder: string; readonly needsChangeCount: number; readonly judgedTotal: number; readonly isOther: boolean }> }
    const foldersResult = parse<FoldersResult>(result.stdout);

    const expected = overview.folderHeatmap.rows.map((row) => ({ folder: row.folder, needsChangeCount: row.needsChangeCount, judgedTotal: row.judgedTotal, isOther: row.isOther }));
    expect(foldersResult.folders.items.map(({ folder, needsChangeCount, judgedTotal, isOther }) => ({ folder, needsChangeCount, judgedTotal, isOther }))).toEqual(expected);
    expect(foldersResult.folders.items.some((row) => row.isOther)).toBe(true);
  });
});

describe('report-query.mjs: dimensions', () => {
  it('ranks dimensions worst-first by bad share', () => {
    const report = exampleAuditReport();
    const result = run(['dimensions', '-'], { input: JSON.stringify(report) });
    expect(result.status).toBe(0);
    interface DimensionsResult { readonly dimensions: Paginated<{ readonly dimensionId: string; readonly badShare: number }> }
    const dimensionsResult = parse<DimensionsResult>(result.stdout);
    const shares = dimensionsResult.dimensions.items.map((d) => d.badShare);
    const sorted = [...shares].sort((a, b) => b - a);
    expect(shares).toEqual(sorted);
  });
});

// -------------------------------------------------------------------------------------------
// batches
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: batches', () => {
  it('--by file makes one batch per file, never combining two files', () => {
    const classifications = Array.from({ length: 3 }, (_, index) => classification(`m${index}`, `src/file-${index}.test.ts`, 'misleading', [dimension({ level: 'misleading' })]));
    const result = run(['batches', '--by', 'file', '-'], { input: JSON.stringify(reportFrom(classifications)) });
    expect(result.status).toBe(0);
    interface BatchesResult { readonly batches: Paginated<{ readonly key: string; readonly files: readonly string[]; readonly testCount: number }> }
    const batchesResult = parse<BatchesResult>(result.stdout);
    expect(batchesResult.batches.items).toHaveLength(3);
    expect(batchesResult.batches.items.every((batch) => batch.files.length === 1)).toBe(true);
  });

  it('--by folder --max-tests chunks a folder across batches at file boundaries', () => {
    const classifications = Array.from({ length: 5 }, (_, index) => classification(`m${index}`, `src/area/file-${index}.test.ts`, 'misleading', [dimension({ level: 'misleading' })]));
    const result = run(['batches', '--by', 'folder', '--max-tests', '2', '-'], { input: JSON.stringify(reportFrom(classifications)) });
    expect(result.status).toBe(0);
    interface BatchesResult { readonly batches: Paginated<{ readonly key: string; readonly files: readonly string[]; readonly testCount: number }> }
    const batchesResult = parse<BatchesResult>(result.stdout);
    expect(batchesResult.batches.items.length).toBeGreaterThan(1);
    for (const batch of batchesResult.batches.items) expect(batch.testCount).toBeLessThanOrEqual(2);
    const allFiles = batchesResult.batches.items.flatMap((batch) => batch.files);
    expect(new Set(allFiles).size).toBe(allFiles.length); // no file split across batches, none repeated
  });

  it('--exclude-needs-review drops needs-review tests from batch counts', () => {
    const classifications = [
      classification('m1', 'src/x.test.ts', 'misleading', [dimension({ level: 'misleading' })]),
      classification('r1', 'src/x.test.ts', 'needs-review', [dimension({ needsReview: true })]),
    ];
    const result = run(['batches', '--by', 'file', '--exclude-needs-review', '-'], { input: JSON.stringify(reportFrom(classifications)) });
    expect(result.status).toBe(0);
    interface BatchesResult { readonly batches: Paginated<{ readonly testCount: number }> }
    const batchesResult = parse<BatchesResult>(result.stdout);
    expect(batchesResult.batches.items[0]!.testCount).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// diff
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: diff', () => {
  it('reports per-status/per-dimension before/after and improved/regressed/unchanged tests, matched by testCaseId', async () => {
    const before = reportFrom([
      classification('shared-improve', 'src/a.test.ts', 'misleading', [dimension({ level: 'misleading' })]),
      classification('shared-regress', 'src/a.test.ts', 'healthy', [dimension({ level: 'strong' })]),
      classification('shared-same', 'src/a.test.ts', 'weak', [dimension({ level: 'weak' })]),
      classification('removed-one', 'src/a.test.ts', 'healthy', [dimension({ level: 'strong' })]),
    ], { runId: 'run:v1:before' });
    const after = reportFrom([
      classification('shared-improve', 'src/a.test.ts', 'healthy', [dimension({ level: 'strong' })]),
      classification('shared-regress', 'src/a.test.ts', 'misleading', [dimension({ level: 'misleading' })]),
      classification('shared-same', 'src/a.test.ts', 'weak', [dimension({ level: 'weak' })]),
      classification('added-one', 'src/a.test.ts', 'healthy', [dimension({ level: 'strong' })]),
    ], { runId: 'run:v1:after' });

    const dir = await tempDir();
    const beforePath = join(dir, 'before.json');
    const afterPath = join(dir, 'after.json');
    await writeFile(beforePath, JSON.stringify(before));
    await writeFile(afterPath, JSON.stringify(after));

    const result = run(['diff', beforePath, afterPath]);
    expect(result.status).toBe(0);
    interface DiffResult {
      readonly matched: number;
      readonly added: number;
      readonly removed: number;
      readonly improved: Paginated<{ readonly testCaseId: string; readonly before: string; readonly after: string }>;
      readonly regressed: Paginated<{ readonly testCaseId: string }>;
      readonly unchanged: Paginated<{ readonly testCaseId: string }>;
    }
    const diffResult = parse<DiffResult>(result.stdout);
    expect(diffResult.matched).toBe(3);
    expect(diffResult.added).toBe(1);
    expect(diffResult.removed).toBe(1);
    expect(diffResult.improved.items.map((i) => i.testCaseId)).toEqual(['tc:v1:shared-improve']);
    expect(diffResult.regressed.items.map((i) => i.testCaseId)).toEqual(['tc:v1:shared-regress']);
    expect(diffResult.unchanged.items.map((i) => i.testCaseId)).toEqual(['tc:v1:shared-same']);
  });

  it('resolves run ids under <root>/.jta/reports/, defaulting "after" to the latest', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.jta', 'reports'), { recursive: true });
    const before = reportFrom([classification('a', 'x.test.ts', 'misleading', [dimension({ level: 'misleading' })])], { runId: 'run:v1:r1' });
    const latest = reportFrom([classification('a', 'x.test.ts', 'healthy', [dimension({ level: 'strong' })])], { runId: 'run:v1:r2' });
    await writeFile(join(dir, '.jta', 'reports', 'r1.json'), JSON.stringify(before));
    await writeFile(join(dir, '.jta', 'latest.json'), JSON.stringify(latest));

    const result = run(['diff', 'r1', '--root', dir]);
    expect(result.status).toBe(0);
    interface DiffResult { readonly improved: Paginated<{ readonly testCaseId: string }> }
    const diffResult = parse<DiffResult>(result.stdout);
    expect(diffResult.improved.items.map((i) => i.testCaseId)).toEqual(['tc:v1:a']);
  });
});

// -------------------------------------------------------------------------------------------
// runs
// -------------------------------------------------------------------------------------------

describe('report-query.mjs: runs', () => {
  it('lists persisted run ids newest-first with recordedAt and needs-change share', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.jta', 'reports'), { recursive: true });
    const older = reportFrom([classification('a', 'x.test.ts', 'misleading', [dimension({ level: 'misleading' })])], { runId: 'run:v1:older' });
    const newer = reportFrom([classification('a', 'x.test.ts', 'healthy', [dimension({ level: 'strong' })])], { runId: 'run:v1:newer' });
    await writeFile(join(dir, '.jta', 'reports', 'older.json'), JSON.stringify(older));
    await writeFile(join(dir, '.jta', 'reports', 'newer.json'), JSON.stringify(newer));
    const oldTime = new Date('2020-01-01T00:00:00Z');
    const newTime = new Date('2024-01-01T00:00:00Z');
    await utimes(join(dir, '.jta', 'reports', 'older.json'), oldTime, oldTime);
    await utimes(join(dir, '.jta', 'reports', 'newer.json'), newTime, newTime);

    const result = run(['runs', '--root', dir]);
    expect(result.status).toBe(0);
    interface RunsResult { readonly runs: Paginated<{ readonly runId: string; readonly needsChange: { readonly count: number; readonly denominator: number; readonly share: number } }> }
    const runsResult = parse<RunsResult>(result.stdout);
    expect(runsResult.runs.items.map((r) => r.runId)).toEqual(['newer', 'older']);
    const olderEntry = runsResult.runs.items.find((r) => r.runId === 'older')!;
    expect(olderEntry.needsChange).toEqual({ count: 1, denominator: 1, share: 1 });
  });

  it('exits 1 with a clear message when there is no .jta/reports directory', async () => {
    const dir = await tempDir();
    const result = run(['runs', '--root', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });
});
