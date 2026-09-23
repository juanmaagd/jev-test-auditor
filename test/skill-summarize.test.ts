import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exampleAuditReport } from '../examples/report-fixture.js';
import { summarizeReport } from '../src/domain/report-overview.js';
import type { AuditReport, AuditReportClassification } from '../src/domain/report.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

/**
 * `skills/jev-test-audit/assets/summarize.mjs` ships inside the packaged agent skill (see
 * `package.json` `files`) and must stay a zero-dependency, standalone script — it is never
 * imported from a TypeScript test. These tests drive it exactly the way an agent does: as a real
 * child process, over stdin or a file path, asserting only on its stdout/stderr/exit code.
 *
 * The parity block below is the load-bearing test the feature document asks for: `summarize.mjs`
 * re-implements the same aggregation `summarizeReport` (src/domain/report-overview.ts) already
 * performs, so both must agree on the same report.
 */
const SCRIPT_PATH = join(process.cwd(), 'skills', 'jev-test-audit', 'assets', 'summarize.mjs');

const temporaryRoots: string[] = [];
afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-skill-summarize-'));
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

interface SummaryDimension {
  readonly dimensionId: string;
  readonly dimensionLabel: string;
  readonly total: number;
  readonly badCount: number;
  readonly badShare: number;
}

interface SummaryFolder {
  readonly folder: string;
  readonly needsChangeCount: number;
  readonly judgedTotal: number;
  readonly share: number;
  readonly isOther: boolean;
}

interface SummaryFile {
  readonly path: string;
  readonly needsChangeCount: number;
  readonly judgedTotal: number;
  readonly share: number;
}

interface WorklistTestDimension {
  readonly dimensionId: string;
  readonly dimensionLabel: string;
  readonly level: string;
  readonly reason: string | null;
}

interface WorklistTest {
  readonly name: string;
  readonly status: string;
  readonly dimensions: readonly WorklistTestDimension[];
}

interface WorklistFile {
  readonly path: string;
  readonly tests: readonly WorklistTest[];
}

interface Summary {
  readonly runId: string | null;
  readonly rootDir: string;
  readonly discovered: number;
  readonly judged: number;
  readonly needsChange: { readonly count: number; readonly denominator: number; readonly share: number };
  readonly statusCounts: Record<'healthy' | 'weak' | 'misleading' | 'needs-review', number>;
  readonly dimensions: readonly SummaryDimension[];
  readonly topFolders: readonly SummaryFolder[];
  readonly topFiles: readonly SummaryFile[];
  readonly worklist?: { readonly files: readonly WorklistFile[]; readonly omittedFiles: number };
}

function parseSummary(stdout: string): Summary {
  return JSON.parse(stdout) as Summary;
}

describe('summarize.mjs: reading input', () => {
  it('reads the report from an explicit file path', async () => {
    const dir = await tempDir();
    const reportPath = join(dir, 'report.json');
    await writeFile(reportPath, JSON.stringify(exampleAuditReport()));

    const result = run([reportPath]);

    expect(result.status).toBe(0);
    expect(parseSummary(result.stdout).runId).toBe('run:v1:example');
  });

  it('reads the report from stdin when given "-"', () => {
    const result = run(['-'], { input: JSON.stringify(exampleAuditReport()) });

    expect(result.status).toBe(0);
    expect(parseSummary(result.stdout).runId).toBe('run:v1:example');
  });

  it('defaults to <root or cwd>/.jta/latest.json when no path is given', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.jta'), { recursive: true });
    await writeFile(join(dir, '.jta', 'latest.json'), JSON.stringify(exampleAuditReport()));

    const result = run(['--root', dir]);

    expect(result.status).toBe(0);
    expect(parseSummary(result.stdout).runId).toBe('run:v1:example');
  });

  it('exits 1 with a clear message when the report file is missing', async () => {
    const dir = await tempDir();

    const result = run([join(dir, 'nonexistent.json')]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Error:');
  });

  it('exits 1 with a clear message when no report has ever been persisted at the default path', async () => {
    const dir = await tempDir();

    const result = run(['--root', dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });

  it('exits 1 with a clear message on invalid JSON', async () => {
    const dir = await tempDir();
    const reportPath = join(dir, 'broken.json');
    await writeFile(reportPath, '{ not valid json');

    const result = run([reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });

  it('exits 1 with a clear message when the JSON is not a valid AuditReport', async () => {
    const dir = await tempDir();
    const reportPath = join(dir, 'shape.json');
    await writeFile(reportPath, JSON.stringify({ foo: 'bar' }));

    const result = run([reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });

  it('exits 1 on an unknown option, never printing a stack trace', () => {
    const result = run(['--nope']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option');
    expect(result.stderr).not.toContain('at ');
  });

  it('--help prints usage and exits 0', () => {
    const result = run(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });
});

describe('summarize.mjs: parity with summarizeReport (src/domain/report-overview.ts)', () => {
  it('matches needsChange, statusCounts, dimension bad counts/shares, topFolders and topFiles for the same report', () => {
    const report = exampleAuditReport();
    const overview = summarizeReport(report);

    const result = run(['-'], { input: JSON.stringify(report) });

    expect(result.status).toBe(0);
    const summary = parseSummary(result.stdout);

    expect(summary.discovered).toBe(overview.coverage.discoveredTests);
    expect(summary.judged).toBe(overview.coverage.judgedTests);
    expect(summary.needsChange.count).toBe(overview.needsChange.count);
    expect(summary.needsChange.denominator).toBe(overview.needsChange.judgedTotal);
    expect(summary.needsChange.share).toBeCloseTo(overview.needsChange.share, 12);

    for (const status of ['healthy', 'weak', 'misleading', 'needs-review'] as const) {
      const entry = overview.statusBreakdown.find((candidate) => candidate.status === status);
      expect(entry).toBeDefined();
      expect(summary.statusCounts[status]).toBe(entry!.count);
    }

    expect(summary.dimensions).toHaveLength(overview.dimensions.length);
    for (const dimension of overview.dimensions) {
      const found = summary.dimensions.find((candidate) => candidate.dimensionId === dimension.dimensionId);
      expect(found).toBeDefined();
      expect(found!.dimensionLabel).toBe(dimension.dimensionLabel);
      expect(found!.total).toBe(dimension.total);
      expect(found!.badCount).toBe(dimension.counts.misleading + dimension.counts.weak);
      expect(found!.badShare).toBeCloseTo(dimension.deficientShare, 12);
    }

    const expectedFolders = overview.folderHeatmap.rows.map((row) => ({
      folder: row.folder,
      needsChangeCount: row.needsChangeCount,
      judgedTotal: row.judgedTotal,
      isOther: row.isOther,
    }));
    const actualFolders = summary.topFolders.map(({ folder, needsChangeCount, judgedTotal, isOther }) => ({
      folder,
      needsChangeCount,
      judgedTotal,
      isOther,
    }));
    expect(actualFolders).toEqual(expectedFolders);

    const expectedFiles = overview.topFiles.map((file) => ({ path: file.path, needsChangeCount: file.needsChangeCount, judgedTotal: file.judgedTotal }));
    const actualFiles = summary.topFiles.map(({ path, needsChangeCount, judgedTotal }) => ({ path, needsChangeCount, judgedTotal }));
    expect(actualFiles).toEqual(expectedFiles);
  });
});

describe('summarize.mjs: filters', () => {
  it('--folder restricts judged/needsChange to paths under that prefix', () => {
    const report = exampleAuditReport();
    const expectedJudged = report.classifications.filter((classification) => classification.repositoryRelativePath.startsWith('src/invoice')).length;

    const result = run(['-', '--folder', 'src/invoice'], { input: JSON.stringify(report) });

    expect(result.status).toBe(0);
    expect(parseSummary(result.stdout).judged).toBe(expectedJudged);
    expect(expectedJudged).toBeGreaterThan(0);
  });

  it('--status narrows to the given status(es)', () => {
    const report = exampleAuditReport();
    const expectedJudged = report.classifications.filter((classification) => classification.status === 'misleading' || classification.status === 'weak').length;

    const result = run(['-', '--status', 'misleading,weak'], { input: JSON.stringify(report) });

    expect(result.status).toBe(0);
    const summary = parseSummary(result.stdout);
    expect(summary.judged).toBe(expectedJudged);
    expect(summary.statusCounts.healthy).toBe(0);
    expect(summary.statusCounts['needs-review']).toBe(0);
  });

  it('--status rejects an unknown status value', () => {
    const result = run(['-', '--status', 'bogus'], { input: JSON.stringify(exampleAuditReport()) });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--status');
  });

  it('--dimension restricts to classifications carrying that dimension id', () => {
    const report = exampleAuditReport();

    const result = run(['-', '--dimension', 'falsifiability'], { input: JSON.stringify(report) });

    expect(result.status).toBe(0);
    // Every classification in the fixture carries the falsifiability dimension.
    expect(parseSummary(result.stdout).judged).toBe(report.classifications.length);
  });
});

describe('summarize.mjs: --worklist', () => {
  it('groups non-healthy tests by file with name, status, and only their misleading/weak dimensions', () => {
    const report = exampleAuditReport();

    const result = run(['-', '--worklist'], { input: JSON.stringify(report) });

    expect(result.status).toBe(0);
    const summary = parseSummary(result.stdout);
    expect(summary.worklist).toBeDefined();
    const files = summary.worklist!.files;
    expect(files.every((file) => file.tests.every((test) => test.status !== 'healthy'))).toBe(true);

    const misleadingFile = files.find((file) => file.tests.some((test) => test.status === 'misleading'));
    expect(misleadingFile).toBeDefined();
    const misleadingTest = misleadingFile!.tests.find((test) => test.status === 'misleading')!;
    expect(misleadingTest.dimensions.length).toBeGreaterThan(0);
    expect(misleadingTest.dimensions.every((dimension) => dimension.level === 'misleading' || dimension.level === 'weak')).toBe(true);
  });

  it('caps the number of files by --limit and reports how many were omitted', () => {
    const classifications = Array.from({ length: 5 }, (_, index) => minimalClassification(`m${index}`, `src/file-${index}.test.ts`, 'misleading'));
    const report = reportFrom(classifications);

    const result = run(['-', '--worklist', '--limit', '2'], { input: JSON.stringify(report) });

    expect(result.status).toBe(0);
    const summary = parseSummary(result.stdout);
    expect(summary.worklist!.files).toHaveLength(2);
    expect(summary.worklist!.omittedFiles).toBe(3);
  });

  it('never lists a healthy test, and omits an empty summary field when --worklist is not given', () => {
    const result = run(['-'], { input: JSON.stringify(exampleAuditReport()) });

    expect(result.status).toBe(0);
    expect(parseSummary(result.stdout).worklist).toBeUndefined();
  });
});

describe('summarize.mjs: determinism', () => {
  it('produces byte-identical output for the same input, run twice', () => {
    const report = exampleAuditReport();

    const first = run(['-'], { input: JSON.stringify(report) });
    const second = run(['-'], { input: JSON.stringify(report) });

    expect(first.stdout).toBe(second.stdout);
  });
});

function minimalClassification(id: string, path: string, status: AuditReportClassification['status']): AuditReportClassification {
  const level = status === 'misleading' ? 'misleading' as const : status === 'weak' ? 'weak' as const : 'strong' as const;
  const isNeedsReview = status === 'needs-review';
  const dimensionStatus = isNeedsReview ? ('needs-review' as const) : ('judged' as const);
  return {
    testCaseId: `tc:v1:${id}` as TestCaseId,
    repositoryRelativePath: path,
    name: `test ${id}`,
    status,
    dimensions: [
      {
        dimensionId: 'falsifiability',
        dimensionLabel: 'Falsifiability',
        applicable: true,
        applicabilityProbability: 0.9,
        status: dimensionStatus,
        level: isNeedsReview ? undefined : level,
        score: isNeedsReview ? undefined : (level === 'strong' ? 3 : level === 'weak' ? 1 : 0),
        confidence: isNeedsReview ? undefined : 0.8,
        reason: isNeedsReview ? 'boundary-straddle' : undefined,
        probabilities: { '0': 0.05, '1': 0.1, '2': 0.15, '3': 0.7 },
        deficientMass: 0.3,
        acceptableMass: 0.7,
        criticalMass: 0.1,
      },
    ],
    findings: status === 'healthy'
      ? []
      : [
        {
          testCaseId: `tc:v1:${id}` as TestCaseId,
          repositoryRelativePath: path,
          name: `test ${id}`,
          dimensionId: 'falsifiability',
          dimensionLabel: 'Falsifiability',
          level: isNeedsReview ? undefined : level,
          score: isNeedsReview ? undefined : (level === 'strong' ? 3 : level === 'weak' ? 1 : 0),
          confidence: isNeedsReview ? undefined : 0.8,
          applicabilityProbability: 0.9,
          status: dimensionStatus,
          reason: isNeedsReview ? 'boundary-straddle' : undefined,
          probabilities: { '0': 0.05, '1': 0.1, '2': 0.15, '3': 0.7 },
          deficientMass: 0.3,
          acceptableMass: 0.7,
          criticalMass: 0.1,
        },
      ],
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 100, outputTokens: 10 },
    cache: 'fresh',
    evidence: { fragments: 1, truncatedFragments: 0, denied: [], unresolved: [], omitted: [] },
  };
}

function reportFrom(classifications: readonly AuditReportClassification[]): AuditReport {
  return {
    reportVersion: 1,
    rootDir: '/repo',
    runId: 'run:v1:worklist-limit',
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
      statusCounts: { healthy: 0, weak: 0, misleading: classifications.length, 'needs-review': 0 },
      respondedModel: 'jev-1.13.0',
      modelMismatches: 0,
    },
    latency: { measuredTestCases: 0 },
    cacheStatus: [],
    classifications,
    diagnostics: [],
  };
}
