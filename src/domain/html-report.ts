/**
 * Self-contained offline HTML report renderer (Phase 6, task P6-4): a pure function over an
 * already-built {@link AuditReport} — the exact same JSON `buildAuditReport` produces
 * (`src/domain/report.ts`) — producing one complete HTML document as a string. No I/O, no timers,
 * no adapter imports: every style and script this page needs is a fixed, hand-authored string
 * literal in this module (`PAGE_STYLE`/`PAGE_SCRIPT` below); the only variable content is the
 * report's own data, always escaped before it is written into the page. The CLI
 * (`src/cli/index.ts`) is the only place that writes the returned string to disk (`--html <path>`)
 * or opens it in a viewer (`--open`) — see `src/adapters/html-report-writer.ts` and
 * `src/adapters/html-report-opener.ts`.
 *
 * **Rendering strategy: server-side string templating, not a client-side JS framework.** Every
 * visible element is rendered here, as a string, with every interpolated value passed through
 * {@link escapeHtml} first. The full canonical report is ALSO embedded verbatim as inert JSON data
 * (`<script type="application/json" id="jev-report-data">`, escaped only against prematurely
 * closing its own `<script>` tag — see {@link jsonScriptSafe}) — for archival/reproducibility, and
 * so "the canonical JSON ... embedded" (this task's own scope) is literally true — but the page's
 * own visible rendering never re-derives itself from that JSON at view time; the one small behavior
 * script (`PAGE_SCRIPT`) only filters and expands/collapses the `<details>` elements already
 * rendered server-side. This keeps the interactive surface tiny (no template engine embedded, no
 * innerHTML assembled from untrusted strings at runtime) and makes the whole page testable with
 * plain string assertions — no DOM, no jsdom dependency needed for this pure function.
 *
 * **Escaping.** Every value interpolated into element text content or a double-quoted attribute
 * goes through {@link escapeHtml} (`&`, `<`, `>`, `"`, `'`). This is what makes a hostile test name,
 * file path, or persisted error message — any of which can contain `<`, `&`, quotes, or a literal
 * `</script>` sequence, since P6-1 error messages now persist to disk and get rendered here — safe
 * to render as visible, inert text rather than as an injection into the page's own markup or
 * script.
 *
 * **Genuinely self-contained.** No `<link>`, no `@import`, no `url(...)` reference, no `fetch`/
 * `XMLHttpRequest`/`WebSocket`, and every `<script>` tag is inline (no `src` attribute) — enforced
 * by `test/html-report.test.ts`'s category-based "no external reference" checks, not by grepping
 * for a couple of known-bad substrings. This keeps the project's zero-runtime-dependency posture
 * and means the rendered file still works on a machine with no internet.
 *
 * **Content, deliberately excluded.** Evidence FRAGMENT source content (the audited repository's
 * own code) never appears here — only the provenance decisions and counts `AuditReport` already
 * carries (fragments/truncatedFragments counts, plus the full denied/unresolved/omitted decision
 * lists). This is the orchestrator's own resolution to a decision gap P6-2 left open: the HTML
 * report is built to be handed to someone else, and embedding fragment content by default would
 * mean sharing a report silently shares the source code it was derived from (see the Phase 6
 * feature document's "Open questions").
 *
 * **Structure: worst first.** The header is the editorial mast. One line under the title names how
 * many judged tests need a change, and the sphere follows the worst of those counts. The noul
 * matrix and the test-case list include only tests that are not healthy — healthy tests stay in
 * the count and in the embedded JSON. Open a test case for its dimensions, findings, and evidence.
 * Diagnostics render only when the run recorded some. A
 * `not-evaluated` test case gets its own block before the classification list.
 */
import type { OverallClassificationStatus } from './classification.js';
import { JEV_ESTIMATE_SNAPSHOT } from './jev-pricing.js';
import { RUBRIC_V1, RUBRIC_V2 } from './rubric.js';
import type {
  AuditReport,
  AuditReportCacheStatusEntry,
  AuditReportClassification,
  AuditReportDiscoveredFile,
  AuditReportEvidenceProvenance,
  AuditReportExcludedFile,
} from './report.js';

/**
 * Escapes the five HTML-significant characters so `value` is always safe to place inside element
 * text content or inside a double-quoted attribute value. This is the ONLY function in this module
 * that may write report data directly adjacent to markup — every render helper below routes every
 * string field through this before interpolating it into the returned HTML string.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Makes `json` safe to place as the literal text content of a `<script type="application/json">`
 * element: every `<` becomes the JSON-legal (and semantically identical, once parsed) `<`
 * escape, so a payload's own `</script>`, `<!--`, or any other `<`-led sequence can never
 * prematurely close the tag it is embedded in — the standard mitigation for embedding JSON inside
 * HTML (used by, among others, React's own server renderer). `JSON.parse` on the escaped string
 * yields the exact same value as `JSON.parse` on the original — `<` and `<` are the same
 * character to a JSON parser — so this never corrupts the embedded data, only its literal HTML
 * representation.
 */
function jsonScriptSafe(json: string): string {
  return json.replace(/</g, '\\u003c');
}

function formatNumber(value: number | undefined, digits = 2): string {
  return value === undefined ? '—' : (Number.isInteger(value) ? String(value) : value.toFixed(digits));
}

function formatBoolean(value: boolean): string {
  return value ? 'yes' : 'no';
}

const STATUS_LABEL: Readonly<Record<OverallClassificationStatus, string>> = {
  healthy: 'Healthy',
  weak: 'Weak',
  misleading: 'Misleading',
  'needs-review': 'Needs review',
};

const STATUS_CLASS: Readonly<Record<OverallClassificationStatus, string>> = {
  healthy: 'status-healthy',
  weak: 'status-weak',
  misleading: 'status-misleading',
  'needs-review': 'status-needs-review',
};

/** Severity, most-attention-needed first — see this module's own doc, "Structure: worst first." */
const STATUS_SEVERITY: Readonly<Record<OverallClassificationStatus, number>> = {
  misleading: 0,
  weak: 1,
  'needs-review': 2,
  healthy: 3,
};

function statusBadge(status: OverallClassificationStatus, count?: number): string {
  const countHtml = count === undefined ? '' : `<span class="stat-count">${count}</span>`;
  const dormant = count === 0 ? ' badge-dormant' : '';
  return `<span class="badge ${STATUS_CLASS[status]}${dormant}">${escapeHtml(STATUS_LABEL[status])}${countHtml}</span>`;
}

function cacheBadge(status: 'cached' | 'fresh'): string {
  return `<span class="badge badge-cache-${status}">${status}</span>`;
}

/** The sphere is a product visual: sparks ignite only for the verdict the counts actually hold. */
function sphereKind(report: AuditReport): 'sphere-alarm' | 'sphere-review' | 'sphere-wear' | 'sphere-quiet' {
  const counts = report.totals.statusCounts;
  if (counts.misleading > 0) return 'sphere-alarm';
  if (counts['needs-review'] > 0) return 'sphere-review';
  if (counts.weak > 0) return 'sphere-wear';
  return 'sphere-quiet';
}

function judgedGaps(report: AuditReport): number {
  const counts = report.totals.statusCounts;
  return counts.misleading + counts.weak + counts['needs-review'];
}

/**
 * One proportion rule, worst-first, left to right. Widths come from integer counts via flex-grow
 * so the bar is deterministic and never interpolates a report string into CSS.
 */
function renderLedger(report: AuditReport): string {
  const counts = report.totals.statusCounts;
  const parts = [
    { key: 'misleading', count: counts.misleading },
    { key: 'weak', count: counts.weak },
    { key: 'needs-review', count: counts['needs-review'] },
    { key: 'healthy', count: counts.healthy },
  ];
  if (parts.every((part) => part.count === 0)) return '';
  const segments = parts
    .filter((part) => part.count > 0)
    .map((part) => `<span class="ledger-seg ledger-${part.key}" style="flex-grow:${part.count}"></span>`)
    .join('');
  return `<div class="ledger" aria-hidden="true">${segments}</div>`;
}

function renderDataTable(headerCells: string, bodyRows: string, tableClass?: string): string {
  const classAttr = tableClass === undefined ? '' : ` class="${tableClass}"`;
  return [
    '<div class="table-wrap">',
    `<table${classAttr}>`,
    `<thead><tr>${headerCells}</tr></thead>`,
    '<tbody>',
    bodyRows,
    '</tbody></table>',
    '</div>',
  ].join('\n');
}

/**
 * Re-sorts `classifications` worst-first: `misleading`, `weak`, `needs-review`, then `healthy`.
 * Never mutates its argument. `Array.prototype.sort` is a stable sort per the ECMAScript
 * specification (guaranteed since ES2019, and this project targets Node >=22.13.0), so classifications
 * sharing a status keep their original relative order.
 */
function sortedClassifications(classifications: readonly AuditReportClassification[]): readonly AuditReportClassification[] {
  return [...classifications].sort((left, right) => STATUS_SEVERITY[left.status] - STATUS_SEVERITY[right.status]);
}

function renderHead(report: AuditReport): string {
  const title = `Jev test audit report — ${escapeHtml(report.rootDir)}`;
  return [
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
  ].join('\n');
}

function renderMetaRow(label: string, value: string): string {
  return `<div class="meta-row"><span class="meta-label">${escapeHtml(label)}</span><span class="meta-value">${value}</span></div>`;
}

function renderMastGaps(report: AuditReport): string {
  const gaps = judgedGaps(report);
  if (gaps === 0) return '';
  const counts = report.totals.statusCounts;
  const tone = counts.misleading > 0 ? 'alarm' : counts['needs-review'] > 0 ? 'review' : 'wear';
  const sentence = gaps === 1 ? 'test needs a change' : 'tests need a change';
  return `<p class="mast-gaps"><span class="mast-gaps-num mast-gaps-${tone}">${gaps}</span> ${sentence}</p>`;
}

function renderHeader(report: AuditReport): string {
  const { statusCounts } = report.totals;
  return [
    '<header class="mast">',
    '<div class="mast-copy">',
    '<h1>Jev test audit report</h1>',
    renderMastGaps(report),
    '<p class="disclosure">This tool never executed the audited repository’s code. Classification thresholds are provisional and uncalibrated — see README.md; nothing here is a claim of validated accuracy.</p>',
    '</div>',
    `<div class="sphere ${sphereKind(report)}" aria-hidden="true"><span class="sphere-core"></span></div>`,
    renderLedger(report),
    '<div class="status-summary">',
    statusBadge('misleading', statusCounts.misleading),
    statusBadge('weak', statusCounts.weak),
    statusBadge('needs-review', statusCounts['needs-review']),
    statusBadge('healthy', statusCounts.healthy),
    '</div>',
    '<div class="meta">',
    renderMetaRow('Root', escapeHtml(report.rootDir)),
    ...(report.runId === undefined ? [] : [renderMetaRow('Run id', escapeHtml(report.runId))]),
    renderMetaRow('Report version', String(report.reportVersion)),
    renderMetaRow('Model requested', escapeHtml(report.modelRequested)),
    renderMetaRow('Model responded', report.totals.respondedModel === undefined ? '—' : escapeHtml(report.totals.respondedModel)),
    renderMetaRow('Store schema / rubric / policy versions', `${report.versions.storeSchema} / ${report.versions.rubric} / ${report.versions.policy}`),
    '</div>',
    '</header>',
  ].join('\n');
}

function renderIncompleteBanner(report: AuditReport): string {
  if (report.complete) return '';
  const reason = report.incompleteReason === undefined ? '' : `<p>${escapeHtml(report.incompleteReason)}</p>`;
  return [
    '<div class="banner banner-incomplete">',
    '<strong>This run is incomplete.</strong> Its evaluation never ran to completion; the figures below reflect only what was actually recorded.',
    reason,
    '</div>',
  ].join('\n');
}

function renderResumeNote(report: AuditReport): string {
  if (report.resume === undefined) return '';
  const { runId, outstanding, reused } = report.resume;
  return [
    '<div class="banner banner-resume">',
    `<strong>Resumed run ${escapeHtml(runId)}.</strong> Reused ${reused} already-completed item(s); dispatched ${outstanding} outstanding item(s) this invocation.`,
    '</div>',
  ].join('\n');
}

/** Applicability plus quality, for a rubric this build still ships. Unknown versions stay blank rather than inventing a count. */
function questionsPerCall(rubricVersion: number): number | undefined {
  const rubric = rubricVersion === RUBRIC_V1.version ? RUBRIC_V1 : rubricVersion === RUBRIC_V2.version ? RUBRIC_V2 : undefined;
  if (rubric === undefined) return undefined;
  return rubric.dimensions.length * 2;
}

/**
 * USD for this run's billed input tokens at the versioned Jev price. Output tokens are unbilled.
 * The rate is a provider price, not a byte-to-token guess.
 */
function formatRunCost(inputTokens: number): string {
  const usd = (inputTokens * JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens) / 1_000_000;
  if (usd === 0) return '$0.00';
  const decimals = usd >= 1 ? 2 : usd >= 0.01 ? 4 : 8;
  const text = usd.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
  return `$${text}`;
}

function renderFigure(value: string, label: string, note: string): string {
  return [
    '<div class="figure">',
    `<span class="figure-value">${value}</span>`,
    `<span class="figure-label">${escapeHtml(label)}</span>`,
    `<span class="figure-note">${escapeHtml(note)}</span>`,
    '</div>',
  ].join('');
}

/** Rubric order first, then any label a classification used that this rubric does not name. */
function matrixDimensionLabels(report: AuditReport): readonly string[] {
  const rubric = report.versions.rubric === RUBRIC_V1.version ? RUBRIC_V1 : RUBRIC_V2;
  const preferred = rubric.dimensions.map((dimension) => dimension.label);
  const seen = new Set(preferred);
  const extra: string[] = [];
  for (const classification of report.classifications) {
    for (const dimension of classification.dimensions) {
      if (seen.has(dimension.dimensionLabel)) continue;
      seen.add(dimension.dimensionLabel);
      extra.push(dimension.dimensionLabel);
    }
  }
  return [...preferred, ...extra];
}

const SHORT_DIMENSION_LABEL: Readonly<Record<string, string>> = {
  'Falsifiability': 'Fals.',
  'Behavioral focus': 'Behav.',
  'Refactor resistance': 'Refac.',
  'Assertion strength': 'Assert.',
  'Test-double quality': 'Double',
  'Determinism and isolation': 'Determ.',
  'Diagnostic quality': 'Diagn.',
};

function shortDimensionLabel(label: string): string {
  return SHORT_DIMENSION_LABEL[label] ?? (label.length > 8 ? `${label.slice(0, 7)}.` : label);
}

function noulCell(dimension: AuditReportClassification['dimensions'][number] | undefined): string {
  if (dimension === undefined || dimension.applicabilityProbability === undefined) {
    return '<span class="cell cell-empty">—</span>';
  }
  const probability = formatNumber(dimension.applicabilityProbability);
  if (!dimension.applicable || dimension.status === 'not-applicable') {
    return `<span class="cell cell-na" title="Not applicable">${probability}</span>`;
  }
  if (dimension.status === 'needs-review') {
    return `<span class="cell cell-review" title="Needs review">${probability}</span>`;
  }
  const level = dimension.level ?? 'judged';
  const levelClass = level === 'misleading' || level === 'weak' || level === 'acceptable' || level === 'strong'
    ? ` cell-${level}`
    : '';
  return `<span class="cell${levelClass}" title="${escapeHtml(level)}">${probability}</span>`;
}

/** One row per test that is not healthy. Healthy rows are the count in the header, not a second copy. */
function renderNoulMatrix(report: AuditReport): string {
  const classifications = sortedClassifications(report.classifications).filter((classification) => classification.status !== 'healthy');
  if (classifications.length === 0) return '';
  const labels = matrixDimensionLabels(report);
  const head = labels.map((label) => `<th title="${escapeHtml(label)}">${escapeHtml(shortDimensionLabel(label))}</th>`).join('');
  const rows = classifications.map((classification) => {
    const byLabel = new Map(classification.dimensions.map((dimension) => [dimension.dimensionLabel, dimension]));
    const cells = labels.map((label) => `<td>${noulCell(byLabel.get(label))}</td>`).join('');
    return [
      '<tr>',
      `<th scope="row" class="noul-name">${escapeHtml(classification.name)}<span class="noul-path">${escapeHtml(classification.repositoryRelativePath)}</span></th>`,
      cells,
      '</tr>',
    ].join('');
  }).join('\n');
  return [
    '<h3>Noul matrix</h3>',
    '<p class="chart-note">Applicability of each dimension, from 0 to 1, for tests that need a change. The mark is the quality level.</p>',
    '<p class="noul-key"><span class="cell cell-misleading">Misleading</span><span class="cell cell-weak">Weak</span><span class="cell cell-acceptable">Acceptable</span><span class="cell cell-strong">Strong</span><span class="cell cell-review">Needs review</span><span class="cell cell-na">Not applicable</span></p>',
    '<div class="table-wrap">',
    '<table class="noul">',
    `<thead><tr><th class="noul-test"></th>${head}</tr></thead>`,
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</div>',
  ].join('\n');
}

function renderSummarySection(report: AuditReport): string {
  const { totals, latency } = report;
  const perCall = questionsPerCall(report.versions.rubric);
  const questions = perCall === undefined ? undefined : totals.evaluated * perCall;
  const questionsText = questions === undefined ? '—' : String(questions);
  const questionsNote = perCall === undefined ? 'rubric question count unknown' : `${perCall} per fresh call`;
  const cost = formatRunCost(totals.usage.inputTokens);
  const latencyLine = latency.measuredTestCases === 0
    ? 'No fresh dispatch’s latency was measured this run.'
    : `${latency.measuredTestCases} test case(s) measured — total ${formatNumber(latency.totalMs, 0)}ms, mean ${formatNumber(latency.meanMs, 1)}ms, min ${formatNumber(latency.minMs, 0)}ms, max ${formatNumber(latency.maxMs, 0)}ms.`;
  return [
    '<section id="jev-summary">',
    '<h2>Summary</h2>',
    '<div class="figures">',
    renderFigure(String(report.discovery.totals.testCases), 'Tests', 'discovered'),
    renderFigure(String(totals.evaluated), 'Jev calls', 'fresh, billed'),
    renderFigure(questionsText, 'Questions', questionsNote),
    renderFigure(cost, 'Cost', `$${JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens} / 1M input tokens`),
    '</div>',
    renderNoulMatrix(report),
    '<ul class="summary-list">',
    ...(totals.cached === 0 ? [] : [`<li>Cached: ${totals.cached}</li>`]),
    ...(totals.failed === 0 ? [] : [`<li>Failed: ${totals.failed}</li>`]),
    ...(totals.skipped.total === 0 ? [] : [`<li>Skipped: ${totals.skipped.total} (skip: ${totals.skipped.byReason.skip}, todo: ${totals.skipped.byReason.todo}, evidence-unavailable: ${totals.skipped.byReason['evidence-unavailable']})</li>`]),
    ...(totals.modelMismatches === 0 ? [] : [`<li>Model mismatches: ${totals.modelMismatches}</li>`]),
    ...(totals.usage.outputTokens === 0 ? [] : [`<li>Output tokens: ${totals.usage.outputTokens}, not billed</li>`]),
    `<li>Latency: ${latencyLine}</li>`,
    '</ul>',
    '</section>',
  ].join('\n');
}

function renderNotEvaluatedSection(entries: readonly AuditReportCacheStatusEntry[]): string {
  const notEvaluated = entries.filter((entry) => entry.status === 'not-evaluated');
  if (notEvaluated.length === 0) return '';
  const rows = notEvaluated.map((entry) => [
    '<tr>',
    `<td>${escapeHtml(entry.repositoryRelativePath)}</td>`,
    `<td>${escapeHtml(entry.name)}</td>`,
    '</tr>',
  ].join('')).join('\n');
  return [
    '<section id="jev-not-evaluated" class="banner banner-not-evaluated">',
    `<h2>Not evaluated (dispatched, but the request failed) — ${notEvaluated.length}</h2>`,
    '<p>These test cases were dispatched but never produced a judgment; see Diagnostics below for why.</p>',
    renderDataTable('<th>Path</th><th>Name</th>', rows),
    '</section>',
  ].join('\n');
}

function renderDiscoveredFileRow(file: AuditReportDiscoveredFile): string {
  return [
    '<tr>',
    `<td>${escapeHtml(file.path)}</td>`,
    `<td>${escapeHtml(file.framework)}</td>`,
    `<td>${file.testCaseCount}</td>`,
    `<td>${file.dynamicMetadataCount}</td>`,
    `<td>${file.evidenceBundleCount}</td>`,
    '</tr>',
  ].join('');
}

function renderExcludedFileRow(file: AuditReportExcludedFile): string {
  return `<tr><td>${escapeHtml(file.path)}</td><td>${escapeHtml(file.reason)}</td></tr>`;
}

function renderDiscoverySection(report: AuditReport): string {
  const { discovery } = report;
  const excludedTable = discovery.excluded.length === 0
    ? '<p>No files were excluded.</p>'
    : renderDataTable('<th>Path</th><th>Reason</th>', discovery.excluded.map(renderExcludedFileRow).join('\n'));
  return [
    '<section id="jev-discovery">',
    '<h2>Discovery</h2>',
    `<p>${discovery.totals.files} file(s) discovered, ${discovery.totals.testCases} test case(s), ${discovery.totals.excluded} excluded, ${discovery.totals.unsupportedFrameworkFiles} unattributable-framework file(s).</p>`,
    renderDataTable(
      '<th>Path</th><th>Framework</th><th>Test cases</th><th>Dynamic metadata</th><th>Evidence bundles</th>',
      discovery.files.map(renderDiscoveredFileRow).join('\n'),
    ),
    '<h3>Excluded</h3>',
    excludedTable,
    '</section>',
  ].join('\n');
}

function renderDiagnosticsSection(report: AuditReport): string {
  if (report.diagnostics.length === 0) return '';
  const rows = report.diagnostics.map((diagnostic) => {
    const path = typeof diagnostic['path'] === 'string' ? diagnostic['path'] : undefined;
    const code = typeof diagnostic['code'] === 'string' ? diagnostic['code'] : '';
    const message = typeof diagnostic['message'] === 'string' ? diagnostic['message'] : '';
    const severity = typeof diagnostic['severity'] === 'string' ? diagnostic['severity'] : '';
    const severityClass = severity === 'error' || severity === 'warning' ? ` class="sev sev-${severity}"` : '';
    return [
      '<tr>',
      `<td${severityClass}>${escapeHtml(severity)}</td>`,
      `<td>${escapeHtml(code)}</td>`,
      `<td>${path === undefined ? '—' : escapeHtml(path)}</td>`,
      `<td>${escapeHtml(message)}</td>`,
      '</tr>',
    ].join('');
  }).join('\n');
  return [
    '<section id="jev-diagnostics">',
    '<h2>Diagnostics</h2>',
    renderDataTable('<th>Severity</th><th>Code</th><th>Path</th><th>Message</th>', rows),
    '</section>',
  ].join('\n');
}

function renderDimensionsTable(dimensions: AuditReportClassification['dimensions']): string {
  const rows = dimensions.map((dimension) => {
    const probabilities = dimension.probabilities === undefined
      ? '—'
      : `0: ${formatNumber(dimension.probabilities['0'])}, 1: ${formatNumber(dimension.probabilities['1'])}, 2: ${formatNumber(dimension.probabilities['2'])}, 3: ${formatNumber(dimension.probabilities['3'])}`;
    return [
      '<tr>',
      `<td>${escapeHtml(dimension.dimensionLabel)}</td>`,
      `<td>${escapeHtml(dimension.status)}</td>`,
      `<td>${dimension.applicable ? formatNumber(dimension.applicabilityProbability) : 'not applicable'}</td>`,
      `<td>${dimension.level === undefined ? '—' : escapeHtml(dimension.level)}</td>`,
      `<td>${formatNumber(dimension.score)}</td>`,
      `<td>${formatNumber(dimension.confidence)}</td>`,
      `<td>${dimension.reason === undefined ? '—' : escapeHtml(dimension.reason)}</td>`,
      `<td>${probabilities}</td>`,
      '</tr>',
    ].join('');
  }).join('\n');
  return renderDataTable(
    '<th>Dimension</th><th>Status</th><th>Applicability</th><th>Level</th><th>Score</th><th>Confidence</th><th>Reason</th><th>Probabilities (0/1/2/3)</th>',
    rows,
    'dimensions',
  );
}

function renderEvidenceProvenance(evidence: AuditReportEvidenceProvenance): string {
  const deniedList = evidence.denied.length === 0
    ? ''
    : `<li>Denied: ${evidence.denied.map((entry) => `${escapeHtml(entry.repositoryRelativePath)} (${escapeHtml(entry.rule)})`).join(', ')}</li>`;
  const unresolvedList = evidence.unresolved.length === 0
    ? ''
    : `<li>Unresolved: ${evidence.unresolved.map((entry) => `${escapeHtml(entry.specifier)} (${escapeHtml(entry.reason)})`).join(', ')}</li>`;
  const omittedList = evidence.omitted.length === 0
    ? ''
    : `<li>Omitted: ${evidence.omitted.map((entry) => `${escapeHtml(entry.repositoryRelativePath)}${entry.symbol === undefined ? '' : ` (${escapeHtml(entry.symbol)})`} — ${escapeHtml(entry.reason)}`).join(', ')}</li>`;
  return [
    '<div class="evidence">',
    '<strong>Evidence provenance</strong>',
    '<ul>',
    `<li>Fragments: ${evidence.fragments} (${evidence.truncatedFragments} truncated)</li>`,
    deniedList,
    unresolvedList,
    omittedList,
    '</ul>',
    '<p class="fragment-notice">Fragment source content is never included in this report — only these provenance decisions and counts.</p>',
    '</div>',
  ].join('\n');
}

function renderClassificationDetail(classification: AuditReportClassification, position: number): string {
  const latencyText = classification.latency === undefined
    ? ''
    : `<span class="tc-latency">— ${formatNumber(classification.latency.latencyMs, 0)}ms</span>`;
  const findingsList = classification.findings.length === 0
    ? '<p>No findings.</p>'
    : [
      '<ul class="findings">',
      classification.findings.map((finding) => `<li>${escapeHtml(finding.dimensionLabel)}: ${finding.level === undefined ? '—' : escapeHtml(finding.level)}${finding.reason === undefined ? '' : ` (${escapeHtml(finding.reason)})`}</li>`).join('\n'),
      '</ul>',
    ].join('\n');
  return [
    `<details id="jev-tc-${position}" class="case">`,
    '<summary>',
    statusBadge(classification.status),
    cacheBadge(classification.cache),
    latencyText,
    `<span class="tc-name">${escapeHtml(classification.name)}</span>`,
    `<span class="tc-path">${escapeHtml(classification.repositoryRelativePath)}</span>`,
    '</summary>',
    '<div class="tc-body">',
    renderMetaRow('Model requested / responded / matches pin', `${escapeHtml(classification.model.requested)} / ${escapeHtml(classification.model.responded)} / ${formatBoolean(classification.model.matchesPin)}`),
    renderMetaRow('Policy / rubric version', `${classification.policyVersion} / ${classification.rubricVersion}`),
    renderMetaRow('Usage', `${classification.usage.inputTokens} input token(s), ${classification.usage.outputTokens} output token(s)`),
    '<h4>Dimensions</h4>',
    renderDimensionsTable(classification.dimensions),
    '<h4>Findings</h4>',
    findingsList,
    renderEvidenceProvenance(classification.evidence),
    '</div>',
    '</details>',
  ].join('\n');
}

function renderClassificationsSection(report: AuditReport): string {
  const sorted = sortedClassifications(report.classifications).filter((classification) => classification.status !== 'healthy');
  const healthy = report.totals.statusCounts.healthy;
  const omitted = sorted.length === 0 || healthy === 0 ? '' : `<p class="omitted">${healthy} healthy test(s) are not listed.</p>`;
  if (sorted.length === 0) {
    const empty = report.classifications.length === 0
      ? '<p>No test case was evaluated this run.</p>'
      : '<p>No judged test needs a change.</p>';
    return ['<section id="jev-classifications">', '<h2>Test cases</h2>', omitted, empty, '</section>'].join('\n');
  }
  return [
    '<section id="jev-classifications">',
    '<h2>Test cases</h2>',
    omitted,
    '<div class="toolbar">',
    '<input type="text" id="jev-filter" placeholder="Filter by name, path, or status…" aria-label="Filter test cases">',
    '<button type="button" id="jev-expand-all">Expand all</button>',
    '<button type="button" id="jev-collapse-all">Collapse all</button>',
    '</div>',
    '<p id="jev-filter-empty" hidden>No test case matches that filter.</p>',
    sorted.map((classification, index) => renderClassificationDetail(classification, index)).join('\n'),
    '</section>',
  ].join('\n');
}

function renderFooter(report: AuditReport): string {
  return `<footer><p>Generated by jev-test-auditor from report version ${report.reportVersion}. Reporting-only: nothing here executed the audited repository’s code.</p></footer>`;
}

const PAGE_STYLE = `
:root {
  color-scheme: light;
  --eggshell: #fdfcfc;
  --taupe: #f5f3f1;
  --stone: #ebe8e4;
  --ink: #000000;
  --graphite: #44403b;
  --smoke: #777169;
  --ash: #a59f97;
  --violet: #0447ff;
  --ember: #ff4704;
  --line: #e5e5e5;
  --font-display: Waldenburg, Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-text: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
  --shadow-whisper: rgba(0, 0, 0, 0.4) 0px 0px 1px 0px, rgba(0, 0, 0, 0.04) 0px 1px 1px 0px, rgba(0, 0, 0, 0.04) 0px 2px 4px 0px;
  --focus: 2px solid var(--ink);
}
* { box-sizing: border-box; }
html { scrollbar-color: var(--stone) var(--eggshell); }
::selection { background: var(--stone); color: var(--ink); }
body {
  margin: 0;
  background: var(--eggshell);
  color: var(--ink);
  font-family: var(--font-text);
  font-weight: 400;
  font-size: 16px;
  line-height: 1.5;
  letter-spacing: 0.16px;
}
.page {
  max-width: 1280px;
  margin: 0 auto;
  padding: 64px 64px 96px;
}
h1, h2, h3, h4 { font-weight: 300; margin: 0; text-wrap: balance; }
h1 {
  font-family: var(--font-display);
  font-size: 48px;
  line-height: 1.08;
  letter-spacing: -0.96px;
  max-width: 11em;
}
h2 {
  font-family: var(--font-display);
  font-size: 32px;
  line-height: 1.13;
  letter-spacing: -0.64px;
  margin-bottom: 20px;
}
h3 {
  font-family: var(--font-text);
  font-size: 20px;
  font-weight: 500;
  line-height: 1.35;
  margin: 36px 0 12px;
}
h4 {
  font-family: var(--font-text);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.14px;
  line-height: 1.4;
  margin: 28px 0 10px;
  color: var(--graphite);
}
p { margin: 0 0 16px; }
.mast {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 200px;
  grid-template-areas:
    "copy sphere"
    "ledger ledger"
    "status status"
    "meta meta";
  column-gap: 48px;
  row-gap: 28px;
  align-items: center;
  padding-bottom: 8px;
}
.mast-copy { grid-area: copy; }
.mast-gaps {
  margin: 16px 0 0;
  font-size: 20px;
  font-weight: 500;
  letter-spacing: 0.2px;
}
.mast-gaps-num { font-variant-numeric: tabular-nums; }
.mast-gaps-alarm { color: #ff4704; }
.mast-gaps-wear { color: #44403b; }
.mast-gaps-review { color: #0447ff; }
.disclosure {
  margin: 16px 0 0;
  max-width: 42rem;
  color: var(--smoke);
  font-size: 16px;
  line-height: 1.5;
  letter-spacing: 0.16px;
}
.sphere {
  grid-area: sphere;
  justify-self: end;
  width: 200px;
  height: 200px;
  position: relative;
}
.sphere-core {
  position: absolute;
  inset: -8%;
  border-radius: 9999px;
  filter: blur(10px);
}
.sphere-quiet .sphere-core {
  background:
    radial-gradient(circle at 40% 36%, var(--eggshell) 0%, rgba(253, 252, 252, 0) 28%),
    radial-gradient(circle at 50% 50%, var(--stone) 0%, rgba(235, 232, 228, 0.35) 46%, rgba(253, 252, 252, 0) 72%);
}
.sphere-wear .sphere-core {
  background:
    radial-gradient(circle at 36% 34%, var(--ember) 0%, rgba(255, 71, 4, 0) 46%),
    radial-gradient(circle at 62% 66%, var(--stone) 0%, rgba(253, 252, 252, 0) 68%);
}
.sphere-review .sphere-core {
  background:
    radial-gradient(circle at 34% 32%, var(--eggshell) 0%, rgba(253, 252, 252, 0) 18%),
    radial-gradient(circle at 46% 42%, var(--violet) 0%, rgba(4, 71, 255, 0.45) 32%, rgba(4, 71, 255, 0) 62%),
    radial-gradient(circle at 68% 70%, var(--stone) 0%, rgba(235, 232, 228, 0) 52%);
}
.sphere-alarm .sphere-core {
  background:
    radial-gradient(circle at 32% 30%, var(--ember) 0%, rgba(255, 71, 4, 0.45) 28%, rgba(255, 71, 4, 0) 56%),
    radial-gradient(circle at 70% 66%, var(--violet) 0%, rgba(4, 71, 255, 0.55) 30%, rgba(4, 71, 255, 0) 60%),
    radial-gradient(circle at 50% 78%, var(--taupe) 0%, rgba(245, 243, 241, 0) 44%);
}
@media (prefers-reduced-motion: no-preference) {
  .sphere-wear .sphere-core,
  .sphere-review .sphere-core,
  .sphere-alarm .sphere-core {
    animation: sphere-drift 22s ease-in-out infinite alternate;
  }
}
@keyframes sphere-drift {
  from { transform: translate3d(-3%, -2%, 0) scale(1.02); }
  to { transform: translate3d(3%, 2%, 0) scale(1.08); }
}
.ledger {
  grid-area: ledger;
  display: flex;
  height: 12px;
  border-radius: 9999px;
  overflow: hidden;
  background: var(--taupe);
  box-shadow: inset 0 0 0 1px var(--stone);
}
.ledger-seg { flex-basis: 0; min-width: 4px; }
.ledger-misleading { background: #ff4704; }
.ledger-weak { background: #44403b; }
.ledger-needs-review { background: #0447ff; }
.ledger-healthy { background: #ebe8e4; }
.status-summary {
  grid-area: status;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
}
.stat-count {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.status-misleading .stat-count { color: #ff4704; }
.status-weak .stat-count { color: #44403b; }
.status-needs-review .stat-count { color: #0447ff; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 10px;
  border-radius: 9999px;
  border: 1px solid var(--line);
  background: var(--eggshell);
  color: var(--ink);
  font-family: var(--font-text);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
  letter-spacing: 0.14px;
}
.badge::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  flex: none;
  background: var(--stone);
}
.status-misleading::before { background: #ff4704; }
.status-weak::before { background: #44403b; }
.status-needs-review::before { background: #0447ff; }
.status-healthy::before { background: #ebe8e4; box-shadow: inset 0 0 0 1px #d9d3cc; }
.badge-dormant::before { background: var(--stone); box-shadow: none; }
.badge-cache-cached::before { background: var(--ash); }
.badge-cache-fresh::before { background: var(--ink); }
.meta {
  grid-area: meta;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px 32px;
  margin: 8px 0 0;
  padding-top: 28px;
  border-top: 1px solid var(--stone);
}
.meta-row { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.meta-label {
  color: var(--smoke);
  font-size: 12px;
  line-height: 1.4;
  letter-spacing: 0.01em;
}
.meta-value {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.69;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}
.banner {
  border-radius: 20px;
  padding: 28px 32px 28px 56px;
  margin: 28px 0 0;
  background: var(--taupe);
  color: var(--ink);
}
.banner-incomplete {
  background:
    radial-gradient(circle at 32px 38px, #ff4704 0 5px, transparent 5.5px),
    var(--taupe);
}
.banner-resume {
  background:
    radial-gradient(circle at 32px 38px, #0447ff 0 5px, transparent 5.5px),
    var(--taupe);
}
.banner-not-evaluated {
  background:
    radial-gradient(circle at 32px 42px, #ff4704 0 5px, transparent 5.5px),
    var(--taupe);
}
section.banner { margin-top: 72px; }
.banner strong { font-weight: 500; }
.banner p:last-child { margin-bottom: 0; }
section { margin-top: 72px; }
section > p { max-width: 68ch; color: var(--graphite); }
.figures {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 28px 32px;
  margin: 8px 0 8px;
}
.figure { min-width: 0; }
.figure-value {
  display: block;
  font-family: var(--font-display);
  font-weight: 300;
  font-size: 36px;
  line-height: 1.17;
  letter-spacing: -0.72px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.figure-label {
  display: block;
  margin-top: 8px;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.14px;
}
.figure-note {
  display: block;
  margin-top: 4px;
  color: var(--smoke);
  font-size: 12px;
  line-height: 1.4;
}
.chart-note { margin-bottom: 8px; }
.noul {
  width: max-content;
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 8px 8px;
  margin: 0 0 28px;
}
.noul th, .noul td {
  border: 0;
  background: transparent;
  padding: 0;
  vertical-align: middle;
}
.noul thead th {
  font-size: 12px;
  font-weight: 500;
  color: var(--graphite);
  text-align: center;
  padding: 0 4px 4px;
}
.noul-key {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
}
.noul-key .cell { min-width: 0; font-family: var(--font-text); font-size: 12px; letter-spacing: 0.12px; }
.noul-test { text-align: left; }
.noul th.noul-name {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--eggshell);
  text-align: left;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.14px;
  color: var(--ink);
  padding-right: 16px;
  max-width: 16rem;
}
.noul-path {
  display: block;
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.4;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--smoke);
}
.cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 4.6rem;
  padding: 7px 10px;
  border-radius: 9999px;
  background: var(--taupe);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.2;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.cell::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  flex: none;
  background: var(--ink);
}
.cell-misleading::before { background: #ff4704; }
.cell-weak::before { background: #44403b; }
.cell-acceptable::before { background: transparent; box-shadow: inset 0 0 0 1.5px #000000; }
.cell-strong::before { background: #000000; }
.cell-review::before { background: #0447ff; }
.cell-na { color: var(--smoke); }
.cell-na::before { background: transparent; box-shadow: inset 0 0 0 1px var(--smoke); }
.cell-empty { color: var(--smoke); }
.cell-empty::before { background: transparent; }
.omitted { color: var(--graphite); }
.summary-list {
  list-style: none;
  margin: 0;
  padding: 8px 32px;
  background: var(--taupe);
  border-radius: 20px;
}
.summary-list li {
  padding: 16px 0;
  border-bottom: 1px solid var(--stone);
  font-size: 16px;
  letter-spacing: 0.16px;
}
.summary-list li:last-child { border-bottom: 0; }
.table-wrap { overflow-x: auto; margin: 8px 0 8px; }
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 14px;
  line-height: 1.5;
  letter-spacing: 0.14px;
}
th, td {
  border: 0;
  border-bottom: 1px solid var(--stone);
  padding: 12px 10px;
  text-align: left;
  vertical-align: top;
}
th {
  font-weight: 500;
  font-size: 12px;
  color: var(--graphite);
  background: transparent;
}
tr:last-child td { border-bottom: 0; }
.dimensions td:nth-child(5),
.dimensions td:nth-child(6),
.dimensions td:nth-child(8) {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.69;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.sev { font-weight: 500; }
.sev-error {
  background-image: radial-gradient(circle, #ff4704 0 4px, transparent 4.5px);
  background-repeat: no-repeat;
  background-position: left 0.45em;
  padding-left: 22px;
}
.sev-warning {
  background-image: radial-gradient(circle, #44403b 0 4px, transparent 4.5px);
  background-repeat: no-repeat;
  background-position: left 0.45em;
  padding-left: 22px;
}
.toolbar {
  display: flex;
  gap: 8px;
  margin: 0 0 16px;
  flex-wrap: wrap;
  align-items: center;
}
.toolbar input {
  flex: 1 1 16rem;
  min-width: 0;
  padding: 10px 14px;
  border-radius: 4px;
  border: 1px solid var(--stone);
  background: var(--eggshell);
  color: var(--ink);
  font: 400 14px/1.5 var(--font-text);
  letter-spacing: 0.14px;
  caret-color: var(--ink);
}
.toolbar input::placeholder { color: var(--smoke); }
.toolbar button {
  font: 500 14px/1.2 var(--font-text);
  letter-spacing: 0.14px;
  border-radius: 9999px;
  padding: 10px 16px;
  border: 1px solid var(--line);
  cursor: pointer;
}
#jev-expand-all { background: var(--ink); color: var(--eggshell); }
#jev-collapse-all { background: var(--eggshell); color: var(--ink); }
#jev-expand-all:hover { background: var(--graphite); }
#jev-collapse-all:hover { background: var(--taupe); }
button:focus-visible,
input:focus-visible,
summary:focus-visible {
  outline: var(--focus);
  outline-offset: 3px;
}
#jev-filter-empty {
  margin: 0 0 16px;
  color: var(--graphite);
}
.case {
  background: var(--taupe);
  border-radius: 20px;
  margin: 0 0 12px;
  padding: 16px 24px 18px;
}
.case[open] {
  background: var(--eggshell);
  box-shadow: var(--shadow-whisper);
}
summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  cursor: pointer;
  list-style: none;
}
summary::-webkit-details-marker { display: none; }
summary::after {
  content: "";
  width: 7px;
  height: 7px;
  margin-left: auto;
  border-right: 1.5px solid var(--ink);
  border-bottom: 1.5px solid var(--ink);
  transform: rotate(45deg) translateY(-2px);
  flex: none;
}
.case[open] summary::after { transform: rotate(-135deg) translateY(-1px); }
.tc-name { font-weight: 500; font-size: 16px; letter-spacing: 0.16px; }
.tc-path {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.69;
  letter-spacing: 0;
  color: var(--smoke);
  overflow-wrap: anywhere;
}
.tc-latency {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.69;
  letter-spacing: 0;
  color: var(--graphite);
  font-variant-numeric: tabular-nums;
}
.tc-body { margin-top: 8px; }
.tc-body > .meta-row { margin-top: 14px; }
.findings, .evidence ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.findings li, .evidence li {
  padding: 10px 0;
  border-bottom: 1px solid var(--stone);
}
.findings li:last-child, .evidence li:last-child { border-bottom: 0; }
.evidence {
  margin-top: 28px;
  padding: 20px 24px;
  background: var(--taupe);
  border-radius: 16px;
}
.evidence strong { font-weight: 500; }
.fragment-notice {
  margin: 12px 0 0;
  color: var(--smoke);
  font-size: 14px;
  letter-spacing: 0.14px;
}
footer {
  margin-top: 96px;
  padding-top: 24px;
  border-top: 1px solid var(--stone);
  color: var(--smoke);
  font-size: 14px;
  letter-spacing: 0.14px;
}
footer p { margin: 0; max-width: 62ch; }
@media (max-width: 800px) {
  .page { padding: 32px 20px 64px; }
  h1 { font-size: 32px; letter-spacing: -0.64px; line-height: 1.13; }
  .mast {
    grid-template-columns: 1fr;
    grid-template-areas:
      "copy"
      "sphere"
      "ledger"
      "status"
      "meta";
    row-gap: 24px;
  }
  .sphere { justify-self: start; width: 140px; height: 140px; }
  .meta { grid-template-columns: 1fr; }
  .figures { grid-template-columns: 1fr 1fr; }
  .figure-value { font-size: 22px; letter-spacing: -0.44px; line-height: 1.15; }
  .noul th.noul-name { max-width: 9rem; }
  .banner, .summary-list { padding-right: 20px; }
  .summary-list { padding-left: 20px; }
  .banner { padding-left: 48px; }
}
@media print {
  .sphere-core, .mast-gaps-num, .ledger-seg, .badge::before, .banner { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .case { break-inside: avoid; }
}
`;

/**
 * The one behavior script this page ships: a fixed string literal, never interpolated with any
 * report data (all report data lives only in the JSON data block or in the server-rendered markup
 * above, both already escaped) — filters and expands/collapses the `<details>` elements the server
 * already rendered. No re-render from the embedded JSON, no third-party library, no network call.
 */
const PAGE_SCRIPT = `
(function () {
  var filterInput = document.getElementById('jev-filter');
  var emptyNote = document.getElementById('jev-filter-empty');
  var detailsEls = Array.prototype.slice.call(document.querySelectorAll('#jev-classifications details'));
  function applyFilter() {
    var needle = (filterInput && filterInput.value ? filterInput.value : '').toLowerCase();
    var shown = 0;
    detailsEls.forEach(function (element) {
      var text = element.textContent ? element.textContent.toLowerCase() : '';
      var visible = needle.length === 0 || text.indexOf(needle) !== -1;
      element.style.display = visible ? '' : 'none';
      if (visible) shown += 1;
    });
    if (emptyNote) emptyNote.hidden = shown !== 0;
  }
  if (filterInput) filterInput.addEventListener('input', applyFilter);
  var expandAll = document.getElementById('jev-expand-all');
  var collapseAll = document.getElementById('jev-collapse-all');
  if (expandAll) expandAll.addEventListener('click', function () { detailsEls.forEach(function (element) { element.open = true; }); });
  if (collapseAll) collapseAll.addEventListener('click', function () { detailsEls.forEach(function (element) { element.open = false; }); });
})();
`;

/**
 * Renders `report` as one complete, self-contained HTML document. Pure: no I/O, no timers, no
 * randomness — the identical `report` always produces byte-identical output. See this module's own
 * doc for the rendering strategy, escaping discipline, self-containment guarantee, and the
 * worst-first structure.
 */
export function renderAuditReportHtml(report: AuditReport): string {
  const reportJson = jsonScriptSafe(JSON.stringify(report));
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    renderHead(report),
    '<body>',
    '<main class="page">',
    renderHeader(report),
    renderIncompleteBanner(report),
    renderResumeNote(report),
    renderSummarySection(report),
    renderNotEvaluatedSection(report.cacheStatus),
    renderDiscoverySection(report),
    renderDiagnosticsSection(report),
    renderClassificationsSection(report),
    renderFooter(report),
    '</main>',
    `<script type="application/json" id="jev-report-data">${reportJson}</script>`,
    `<script>${PAGE_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
