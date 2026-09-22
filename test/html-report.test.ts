import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderAuditReportHtml } from '../src/domain/html-report.js';
import type { AuditReport, AuditReportCacheStatusEntry, AuditReportClassification } from '../src/domain/report.js';
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

/**
 * The rendered page always embeds the full report verbatim as inert JSON data (see
 * `renderAuditReportHtml`'s own doc), so a naive `html.toContain(someReportValue)` assertion is
 * satisfied by that JSON blob alone even when the VISIBLE page never renders the value anywhere —
 * a self-deceiving test that cannot fail no matter what the visible markup does. Any assertion
 * whose actual claim is "a reader can SEE this" strips the JSON data block first with this helper,
 * so it can only pass because of real, visible markup.
 */
function visibleHtml(html: string): string {
  return html.replace(/<script type="application\/json" id="jev-report-data">[\s\S]*?<\/script>/, '');
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

  it('embeds the report as one application/json script tag that round-trips through JSON.parse', () => {
    const report = minimalReport();
    const html = renderAuditReportHtml(report);
    const match = /<script type="application\/json" id="jev-report-data">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const parsed: unknown = JSON.parse(match![1]!);
    expect(parsed).toEqual(report);
  });

  it('renders identically for the same report (deterministic, no timers, no randomness)', () => {
    const report = minimalReport();
    expect(renderAuditReportHtml(report)).toBe(renderAuditReportHtml(report));
  });

  it('mentions the run\'s rootDir and reportVersion, VISIBLY (not merely inside the embedded JSON), for a reader to identify which run this is', () => {
    const html = visibleHtml(renderAuditReportHtml(minimalReport({ rootDir: '/workspace/my-repo' })));
    expect(html).toContain('/workspace/my-repo');
    expect(html).toContain('1');
  });

  it('shows the runId VISIBLY when present, and omits any runId mention from the visible page when absent', () => {
    const withRunId = visibleHtml(renderAuditReportHtml(minimalReport({ runId: 'run:v1:abc123' })));
    expect(withRunId).toContain('run:v1:abc123');

    const withoutRunId = visibleHtml(renderAuditReportHtml(minimalReport()));
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

  it('shows test count, fresh Jev calls, rubric questions, and cost once, and leaves a healthy run without a matrix', () => {
    const html = visibleHtml(renderAuditReportHtml(minimalReport()));
    expect(html).toContain('Jev test audit report');
    expect(html).toContain('sphere-quiet');
    expect(html).toContain('Tests');
    expect(html).toContain('Jev calls');
    expect(html).toContain('Questions');
    expect(html).toContain('14 per fresh call');
    expect(html).toContain('$0.0000042');
    expect(html).not.toContain('Dimension scores');
    expect(html).not.toContain('Evaluated:');
    expect(html).not.toContain('Cost this run');
    expect(html).not.toContain('Noul matrix');
    expect(html).not.toContain('class="mast-gaps"');
    expect(html).not.toContain('Probabilities (0/1/2/3)');
    expect(html).not.toContain('<h2>Diagnostics</h2>');
  });

  it('keeps the editorial header, names the gaps once, and limits the noul matrix to tests that are not healthy', () => {
    const misleading = classification({
      testCaseId: 'tc:v1:misleading' as TestCaseId,
      name: 'aa misleading test',
      status: 'misleading',
      dimensions: [dimension({ level: 'misleading', score: 0 })],
      findings: [],
    });
    const healthy = classification({ name: 'zz healthy test', status: 'healthy' });
    const html = visibleHtml(renderAuditReportHtml(minimalReport({
      totals: {
        ...minimalReport().totals,
        statusCounts: { healthy: 1, weak: 0, misleading: 1, 'needs-review': 0 },
      },
      classifications: [healthy, misleading],
    })));
    expect(html).toContain('Jev test audit report');
    expect(html).toContain('sphere-alarm');
    expect(html).toContain('mast-gaps-alarm');
    expect(html).toContain('test needs a change');
    expect(html).toContain('Noul matrix');
    expect(html).toContain('0.91');
    expect(html).toContain('Falsifiability');
    expect(html).toContain('aa misleading test');
    expect(html).not.toContain('zz healthy test');
    expect(html).not.toContain('Gaps by dimension');
    expect(html).not.toContain('class="gap-num"');
    expect(html).toContain('<h4>Findings</h4>');
    expect(html).toContain('No findings.');
    expect(html).toContain('Probabilities (0/1/2/3)');
    expect(html).toContain('Evidence provenance');
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
    const visible = visibleHtml(html);
    expect(visible).toContain('div class="banner banner-incomplete"');
    expect(visible.toLowerCase()).toContain('incomplete');
    expect(visible).toContain('discovery failed before evaluation could run: boom');
  });

  it('shows no incomplete banner markup at all when complete is true', () => {
    const html = visibleHtml(renderAuditReportHtml(minimalReport()));
    expect(html).not.toContain('div class="banner banner-incomplete"');
  });

  it('discloses the resume summary VISIBLY when present (not merely inside the embedded JSON)', () => {
    const html = visibleHtml(renderAuditReportHtml(minimalReport({ resume: { runId: 'run:v1:resumed', outstanding: 2, reused: 5 } })));
    expect(html).toContain('div class="banner banner-resume"');
    expect(html).toContain('run:v1:resumed');
    expect(html).toContain('2');
    expect(html).toContain('5');
  });

  it('shows no resume banner markup at all when resume is absent', () => {
    const html = visibleHtml(renderAuditReportHtml(minimalReport()));
    expect(html).not.toContain('div class="banner banner-resume"');
  });
});

describe('renderAuditReportHtml: worst-first structure', () => {
  it('sorts classifications misleading, weak, needs-review, then healthy, never by array order alone', () => {
    const healthy = classification({ testCaseId: 'tc:v1:healthy' as TestCaseId, name: 'zz healthy test', status: 'healthy' });
    const misleading = classification({ testCaseId: 'tc:v1:misleading' as TestCaseId, name: 'aa misleading test', status: 'misleading' });
    const weak = classification({ testCaseId: 'tc:v1:weak' as TestCaseId, name: 'mm weak test', status: 'weak' });
    const needsReview = classification({ testCaseId: 'tc:v1:needs-review' as TestCaseId, name: 'nn needs-review test', status: 'needs-review' });
    // Deliberately submitted in the OPPOSITE order the render is expected to produce, so a renderer
    // that merely preserves array order would fail this test.
    const html = visibleHtml(renderAuditReportHtml(minimalReport({ classifications: [healthy, needsReview, weak, misleading] })));

    expect(html).not.toContain(healthy.name);
    const positions = [misleading, weak, needsReview].map((entry) => html.indexOf(entry.name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('gives a not-evaluated (dispatched but failed) test case its own visible block, positioned before the ordinary classification list', () => {
    const notEvaluatedEntry: AuditReportCacheStatusEntry = {
      testCaseId: 'tc:v1:not-evaluated' as TestCaseId,
      repositoryRelativePath: 'b.test.ts',
      name: 'a dispatch that failed outright',
      status: 'not-evaluated',
    };
    const html = visibleHtml(renderAuditReportHtml(minimalReport({
      cacheStatus: [notEvaluatedEntry, ...minimalReport().cacheStatus],
    })));
    expect(html).toContain('a dispatch that failed outright');
    const notEvaluatedPosition = html.indexOf('a dispatch that failed outright');
    const classificationsHeadingPosition = html.indexOf('id="jev-classifications"');
    expect(classificationsHeadingPosition).toBeGreaterThan(0);
    expect(notEvaluatedPosition).toBeGreaterThan(0);
    expect(notEvaluatedPosition).toBeLessThan(classificationsHeadingPosition);
  });
});

describe('renderAuditReportHtml: genuinely self-contained (no external reference of any kind)', () => {
  interface ScriptBlock {
    readonly openingTag: string;
    readonly content: string;
  }

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

  function extractScriptBlocks(html: string): readonly ScriptBlock[] {
    const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    const blocks: ScriptBlock[] = [];
    let match = pattern.exec(html);
    while (match !== null) {
      blocks.push({ openingTag: match[1] ?? '', content: match[2] ?? '' });
      match = pattern.exec(html);
    }
    return blocks;
  }

  /**
   * Category checks, not a couple of known-bad substrings — but structurally precise: an actual
   * unescaped `<tag ...>` or attribute is required for the tag/attribute checks below, which
   * escaped report data (guaranteed by `escapeHtml` to contain no literal `<`, `>`, or `"`) can
   * never produce; and a CSS/JS directive (`@import`, `url(...)`, `fetch(...)`, etc.) only matters
   * where it would actually execute — inside a real `<style>` block or a real, EXECUTABLE `<script>`
   * block, never inside the inert `<script type="application/json">` data block or plain escaped
   * text content elsewhere on the page. A hostile report value containing the literal word
   * "@import" or "url(" as harmless visible text must not fail this check — that would be
   * mislabeling inert data as a live external reference; see the "hostile-value escaping" tests
   * above for the separate, correct proof that such text never leaks out of escaped form.
   */
  function assertNoExternalReferences(html: string): void {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc\s*=\s*"(?:https?:)?\/\//i);
    expect(html).not.toMatch(/\bhref\s*=\s*"(?:https?:)?\/\//i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/<embed\b/i);
    expect(html).not.toMatch(/<object\b/i);
    expect(html).not.toMatch(/\bcrossorigin\s*=/i);
    expect(html).not.toMatch(/<meta\s+http-equiv\s*=\s*"refresh"/i);

    for (const styleBlock of extractBlocks(html, 'style')) {
      expect(styleBlock).not.toMatch(/@import/i);
      expect(styleBlock).not.toMatch(/url\(\s*["']?(?!#)/i);
    }

    const scriptBlocks = extractScriptBlocks(html);
    expect(scriptBlocks.length).toBeGreaterThan(0);
    for (const script of scriptBlocks) {
      // Every <script> tag must be inline: none may carry a src attribute at all, including the
      // inert JSON data block.
      expect(script.openingTag).not.toMatch(/\bsrc\s*=/i);
      const isInertJsonData = /type\s*=\s*"application\/json"/i.test(script.openingTag);
      if (isInertJsonData) continue; // Never executed — its content is data, checked for escaping elsewhere, not for CSS/JS directives.
      expect(script.content).not.toMatch(/\bfetch\s*\(/);
      expect(script.content).not.toMatch(/XMLHttpRequest/);
      expect(script.content).not.toMatch(/WebSocket\s*\(/);
      expect(script.content).not.toMatch(/EventSource\s*\(/);
      expect(script.content).not.toMatch(/sendBeacon/);
    }
  }

  it('contains no external reference in an ordinary report', () => {
    assertNoExternalReferences(renderAuditReportHtml(minimalReport()));
  });

  it('contains no external reference even when report content tries to smuggle one in (protocol-relative URL, <link>, @import, in a diagnostic message and a test name)', () => {
    const hostileText = '//evil.cdn.example/x.js <link rel="preload" href="https://evil.example/a.css"> @import url(https://evil.example/b.css);';
    const html = renderAuditReportHtml(minimalReport({
      diagnostics: [{ code: 'evaluation-failed', message: hostileText, severity: 'error' }],
      classifications: [classification({ name: hostileText })],
    }));
    assertNoExternalReferences(html);
    // The hostile text must still be visible as inert data (escaped), never silently dropped.
    expect(html).toContain(escapeHtml(hostileText));
  });
});

describe('renderAuditReportHtml: hostile-value escaping (one fixture, every string field)', () => {
  const payload = '</script><script>alert(1)</script>"><img src=x onerror=1>&\'quoted\'';

  function hostileReport(): AuditReport {
    const hostileDimension = dimension({
      dimensionLabel: payload,
      reason: 'missing-answer',
    });
    const hostileFinding = {
      testCaseId: 'tc:v1:hostile' as TestCaseId,
      repositoryRelativePath: payload,
      name: payload,
      dimensionId: 'falsifiability' as const,
      dimensionLabel: payload,
      level: 'weak' as const,
      score: 1,
      confidence: 0.5,
      applicabilityProbability: 0.9,
      status: 'judged' as const,
      reason: undefined,
      probabilities: { '0': 0.1, '1': 0.5, '2': 0.3, '3': 0.1 },
      deficientMass: 0.6,
      acceptableMass: 0.4,
      criticalMass: 0.1,
    };
    const hostileClassification = classification({
      testCaseId: 'tc:v1:hostile' as TestCaseId,
      repositoryRelativePath: payload,
      name: payload,
      status: 'misleading',
      dimensions: [hostileDimension],
      findings: [hostileFinding],
      model: { requested: payload, responded: payload, matchesPin: false },
      evidence: {
        fragments: 1,
        truncatedFragments: 0,
        denied: [{ repositoryRelativePath: payload, rule: payload }],
        unresolved: [{ specifier: payload, reason: 'bare-specifier' }],
        omitted: [{ repositoryRelativePath: payload, symbol: payload, reason: 'bundle-budget-exhausted' }],
      },
    });
    return minimalReport({
      rootDir: payload,
      runId: payload,
      modelRequested: payload,
      discovery: {
        files: [{ path: payload, framework: payload, testCaseCount: 1, dynamicMetadataCount: 0, evidenceBundleCount: 1 }],
        excluded: [{ path: payload, reason: payload }],
        totals: minimalReport().discovery.totals,
      },
      totals: { ...minimalReport().totals, respondedModel: payload },
      cacheStatus: [{ testCaseId: 'tc:v1:hostile' as TestCaseId, repositoryRelativePath: payload, name: payload, status: 'not-evaluated' }],
      classifications: [hostileClassification],
      diagnostics: [{ code: payload, message: payload, severity: 'error', repositoryRelativePath: payload }],
      resume: { runId: payload, outstanding: 1, reused: 0 },
    });
  }

  it('never emits the raw hostile payload unescaped anywhere in the rendered HTML outside the embedded JSON data block', () => {
    const report = hostileReport();
    const html = renderAuditReportHtml(report);

    // Strip the one legitimate place the raw payload IS expected to appear literally: inside the
    // embedded JSON script tag, where it is inert string data, never interpreted as markup.
    const withoutJsonBlock = html.replace(/<script type="application\/json" id="jev-report-data">[\s\S]*?<\/script>/, '');
    expect(withoutJsonBlock).not.toContain(payload);
  });

  it('embeds the JSON script tag with a `<`-safe escape, so the payload never prematurely closes the script tag', () => {
    const html = renderAuditReportHtml(hostileReport());
    // Exactly two <script> tags authored by this renderer: the JSON data block and the one behavior
    // script. If the hostile payload's own literal `</script>` sequences leaked through unescaped,
    // this count would be higher.
    const scriptOpenCount = (html.match(/<script\b/gi) ?? []).length;
    const scriptCloseCount = (html.match(/<\/script>/gi) ?? []).length;
    expect(scriptOpenCount).toBe(2);
    expect(scriptCloseCount).toBe(2);
  });

  it('still round-trips the exact hostile report through the embedded JSON, proving escaping never corrupts the data', () => {
    const report = hostileReport();
    const html = renderAuditReportHtml(report);
    const match = /<script type="application\/json" id="jev-report-data">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const parsed: unknown = JSON.parse(match![1]!);
    expect(parsed).toEqual(report);
  });

  it('is still parseable as one HTML document (no runaway/unterminated tag from the payload)', () => {
    const html = renderAuditReportHtml(hostileReport());
    expect(html).toContain('</html>');
    expect(html.indexOf('<html')).toBeGreaterThanOrEqual(0);
  });
});

describe('renderAuditReportHtml: renders from a canonical JSON file alone (no repository, no database present)', () => {
  it('renders correctly from a report round-tripped through disk, with the audited repository genuinely absent and no extra file created as a side effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-html-report-'));
    const deletedRepoPath = join(dir, 'audited-repo-that-does-not-exist-on-this-machine');
    expect(existsSync(deletedRepoPath)).toBe(false);

    const report = minimalReport({ rootDir: deletedRepoPath, runId: 'run:v1:disk-round-trip' });
    const jsonPath = join(dir, 'report.json');
    await writeFile(jsonPath, JSON.stringify(report));

    // Nothing about rendering may depend on the repository or a database existing.
    expect(existsSync(deletedRepoPath)).toBe(false);

    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as AuditReport;
    const html = renderAuditReportHtml(parsed);

    expect(html).toContain(escapeHtml(deletedRepoPath));
    expect(html).toContain('run:v1:disk-round-trip');

    // Rendering is a pure in-memory operation: it must not have created a database file, a sidecar,
    // or any other file next to the JSON it was given.
    const entriesAfter = await readdir(dir);
    expect(entriesAfter.sort()).toEqual(['report.json']);
  });

  it('renders identically whether the report object was built directly or round-tripped through JSON.stringify/JSON.parse (proving optional-field handling never relies on `in`/live-object shape)', () => {
    const report = minimalReport();
    const direct = renderAuditReportHtml(report);
    const roundTripped = renderAuditReportHtml(JSON.parse(JSON.stringify(report)) as AuditReport);
    expect(roundTripped).toBe(direct);
  });
});
