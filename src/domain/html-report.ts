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
 * **Structure: worst first.** `classifications` are re-sorted (a stable sort; never mutating the
 * caller's array) `misleading` → `weak` → `needs-review` → `healthy`, and a `not-evaluated` test
 * case (dispatched but never produced a judgment — see {@link AuditReportCacheStatusEntry}'s own
 * doc) gets its own small, visible block positioned BEFORE the ordinary classification list. A
 * reader opening this report is deciding what needs attention, and a failed dispatch is unknown,
 * not healthy — it must not sit below the fold under a page of healthy verdicts.
 */
import type { OverallClassificationStatus } from './classification.js';
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

function statusBadge(status: OverallClassificationStatus): string {
  return `<span class="badge ${STATUS_CLASS[status]}">${escapeHtml(STATUS_LABEL[status])}</span>`;
}

function cacheBadge(status: 'cached' | 'fresh'): string {
  return `<span class="badge badge-cache-${status}">${status}</span>`;
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

function renderHeader(report: AuditReport): string {
  const { statusCounts } = report.totals;
  return [
    '<header>',
    '<h1>Jev test audit report</h1>',
    '<div class="meta">',
    renderMetaRow('Root', escapeHtml(report.rootDir)),
    ...(report.runId === undefined ? [] : [renderMetaRow('Run id', escapeHtml(report.runId))]),
    renderMetaRow('Report version', String(report.reportVersion)),
    renderMetaRow('Model requested', escapeHtml(report.modelRequested)),
    renderMetaRow('Model responded', report.totals.respondedModel === undefined ? '—' : escapeHtml(report.totals.respondedModel)),
    renderMetaRow('Store schema / rubric / policy versions', `${report.versions.storeSchema} / ${report.versions.rubric} / ${report.versions.policy}`),
    '</div>',
    '<div class="status-summary">',
    statusBadge('misleading'), ` ${statusCounts.misleading}&nbsp;&nbsp;`,
    statusBadge('weak'), ` ${statusCounts.weak}&nbsp;&nbsp;`,
    statusBadge('needs-review'), ` ${statusCounts['needs-review']}&nbsp;&nbsp;`,
    statusBadge('healthy'), ` ${statusCounts.healthy}`,
    '</div>',
    '<p class="disclosure">This tool never executed the audited repository’s code. Classification thresholds are provisional and uncalibrated — see README.md; nothing here is a claim of validated accuracy.</p>',
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

function renderSummarySection(report: AuditReport): string {
  const { totals, latency } = report;
  const latencyLine = latency.measuredTestCases === 0
    ? 'No fresh dispatch’s latency was measured this run.'
    : `${latency.measuredTestCases} test case(s) measured — total ${formatNumber(latency.totalMs, 0)}ms, mean ${formatNumber(latency.meanMs, 1)}ms, min ${formatNumber(latency.minMs, 0)}ms, max ${formatNumber(latency.maxMs, 0)}ms.`;
  return [
    '<section id="jev-summary">',
    '<h2>Summary</h2>',
    '<ul class="summary-list">',
    `<li>Evaluated: ${totals.evaluated}</li>`,
    `<li>Cached: ${totals.cached}</li>`,
    `<li>Failed: ${totals.failed}</li>`,
    `<li>Skipped: ${totals.skipped.total} (skip: ${totals.skipped.byReason.skip}, todo: ${totals.skipped.byReason.todo}, evidence-unavailable: ${totals.skipped.byReason['evidence-unavailable']})</li>`,
    `<li>Model mismatches: ${totals.modelMismatches}</li>`,
    `<li>Usage this run: ${totals.usage.inputTokens} input token(s), ${totals.usage.outputTokens} output token(s)</li>`,
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
    '<table><thead><tr><th>Path</th><th>Name</th></tr></thead><tbody>',
    rows,
    '</tbody></table>',
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
    : [
      '<table><thead><tr><th>Path</th><th>Reason</th></tr></thead><tbody>',
      discovery.excluded.map(renderExcludedFileRow).join('\n'),
      '</tbody></table>',
    ].join('\n');
  return [
    '<section id="jev-discovery">',
    '<h2>Discovery</h2>',
    `<p>${discovery.totals.files} file(s) discovered, ${discovery.totals.testCases} test case(s), ${discovery.totals.excluded} excluded, ${discovery.totals.unsupportedFrameworkFiles} unattributable-framework file(s).</p>`,
    '<table><thead><tr><th>Path</th><th>Framework</th><th>Test cases</th><th>Dynamic metadata</th><th>Evidence bundles</th></tr></thead><tbody>',
    discovery.files.map(renderDiscoveredFileRow).join('\n'),
    '</tbody></table>',
    '<h3>Excluded</h3>',
    excludedTable,
    '</section>',
  ].join('\n');
}

function renderDiagnosticsSection(report: AuditReport): string {
  if (report.diagnostics.length === 0) {
    return '<section id="jev-diagnostics"><h2>Diagnostics</h2><p>None.</p></section>';
  }
  const rows = report.diagnostics.map((diagnostic) => {
    const path = typeof diagnostic['path'] === 'string' ? diagnostic['path'] : undefined;
    const code = typeof diagnostic['code'] === 'string' ? diagnostic['code'] : '';
    const message = typeof diagnostic['message'] === 'string' ? diagnostic['message'] : '';
    const severity = typeof diagnostic['severity'] === 'string' ? diagnostic['severity'] : '';
    return [
      '<tr>',
      `<td>${escapeHtml(severity)}</td>`,
      `<td>${escapeHtml(code)}</td>`,
      `<td>${path === undefined ? '—' : escapeHtml(path)}</td>`,
      `<td>${escapeHtml(message)}</td>`,
      '</tr>',
    ].join('');
  }).join('\n');
  return [
    '<section id="jev-diagnostics">',
    '<h2>Diagnostics</h2>',
    '<table><thead><tr><th>Severity</th><th>Code</th><th>Path</th><th>Message</th></tr></thead><tbody>',
    rows,
    '</tbody></table>',
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
  return [
    '<table class="dimensions"><thead><tr>',
    '<th>Dimension</th><th>Status</th><th>Applicability</th><th>Level</th><th>Score</th><th>Confidence</th><th>Reason</th><th>Probabilities (0/1/2/3)</th>',
    '</tr></thead><tbody>',
    rows,
    '</tbody></table>',
  ].join('\n');
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
  const latencyText = classification.latency === undefined ? '' : ` — ${formatNumber(classification.latency.latencyMs, 0)}ms`;
  const findingsList = classification.findings.length === 0
    ? '<p>No findings.</p>'
    : [
      '<ul class="findings">',
      classification.findings.map((finding) => `<li>${escapeHtml(finding.dimensionLabel)}: ${finding.level === undefined ? '—' : escapeHtml(finding.level)}${finding.reason === undefined ? '' : ` (${escapeHtml(finding.reason)})`}</li>`).join('\n'),
      '</ul>',
    ].join('\n');
  return [
    `<details id="jev-tc-${position}">`,
    '<summary>',
    statusBadge(classification.status),
    ' ',
    cacheBadge(classification.cache),
    latencyText,
    ` <span class="tc-name">${escapeHtml(classification.name)}</span>`,
    ` <span class="tc-path">${escapeHtml(classification.repositoryRelativePath)}</span>`,
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
  const sorted = sortedClassifications(report.classifications);
  if (sorted.length === 0) {
    return '<section id="jev-classifications"><h2>Test cases</h2><p>No test case was evaluated this run.</p></section>';
  }
  return [
    '<section id="jev-classifications">',
    '<h2>Test cases</h2>',
    '<div class="toolbar">',
    '<input type="text" id="jev-filter" placeholder="Filter by name, path, or status…" aria-label="Filter test cases">',
    '<button type="button" id="jev-expand-all">Expand all</button>',
    '<button type="button" id="jev-collapse-all">Collapse all</button>',
    '</div>',
    sorted.map((classification, index) => renderClassificationDetail(classification, index)).join('\n'),
    '</section>',
  ].join('\n');
}

function renderFooter(report: AuditReport): string {
  return `<footer><p>Generated by jev-test-auditor from report version ${report.reportVersion}. Reporting-only: nothing here executed the audited repository’s code.</p></footer>`;
}

const PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #5f6368;
  --border: #d7dbe0;
  --surface: #f6f7f9;
  --healthy: #1e7e34;
  --weak: #b8860b;
  --misleading: #c62828;
  --needs-review: #455a64;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #e8e9ec;
    --muted: #a0a4ab;
    --border: #33363c;
    --surface: #1d2024;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 1.5rem;
  max-width: 72rem;
  margin-inline: auto;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.5;
}
h1, h2, h3, h4 { line-height: 1.2; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; font-size: 0.9rem; }
th, td { border: 1px solid var(--border); padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
th { background: var(--surface); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 1rem; margin: 0.75rem 0; font-size: 0.9rem; }
.meta-row { display: contents; }
.meta-label { color: var(--muted); }
.status-summary { margin: 0.75rem 0; }
.badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; color: #fff; }
.status-healthy { background: var(--healthy); }
.status-weak { background: var(--weak); }
.status-misleading { background: var(--misleading); }
.status-needs-review { background: var(--needs-review); }
.badge-cache-cached { background: var(--muted); }
.badge-cache-fresh { background: #37474f; }
.disclosure { color: var(--muted); font-size: 0.85rem; }
.banner { border: 1px solid var(--border); border-radius: 0.4rem; padding: 0.75rem 1rem; margin: 1rem 0; }
.banner-incomplete { border-color: var(--misleading); background: color-mix(in srgb, var(--misleading) 10%, transparent); }
.banner-resume { border-color: var(--needs-review); background: color-mix(in srgb, var(--needs-review) 10%, transparent); }
.banner-not-evaluated { border-color: var(--misleading); }
.summary-list { padding-left: 1.1rem; }
.toolbar { display: flex; gap: 0.5rem; margin: 0.75rem 0; flex-wrap: wrap; }
.toolbar input { flex: 1 1 16rem; padding: 0.35rem 0.5rem; }
.toolbar button { padding: 0.35rem 0.75rem; }
details { border: 1px solid var(--border); border-radius: 0.4rem; margin-bottom: 0.5rem; padding: 0.5rem 0.75rem; }
summary { cursor: pointer; }
.tc-name { font-weight: 600; }
.tc-path { color: var(--muted); font-size: 0.85rem; }
.tc-body { margin-top: 0.5rem; }
.findings { padding-left: 1.1rem; }
.evidence { margin-top: 0.75rem; font-size: 0.9rem; }
.fragment-notice { color: var(--muted); font-size: 0.8rem; }
footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
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
  var detailsEls = Array.prototype.slice.call(document.querySelectorAll('#jev-classifications details'));
  function applyFilter() {
    var needle = (filterInput && filterInput.value ? filterInput.value : '').toLowerCase();
    detailsEls.forEach(function (element) {
      var text = element.textContent ? element.textContent.toLowerCase() : '';
      var visible = needle.length === 0 || text.indexOf(needle) !== -1;
      element.style.display = visible ? '' : 'none';
    });
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
    renderHeader(report),
    renderIncompleteBanner(report),
    renderResumeNote(report),
    renderSummarySection(report),
    renderNotEvaluatedSection(report.cacheStatus),
    renderDiscoverySection(report),
    renderDiagnosticsSection(report),
    renderClassificationsSection(report),
    renderFooter(report),
    `<script type="application/json" id="jev-report-data">${reportJson}</script>`,
    `<script>${PAGE_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
