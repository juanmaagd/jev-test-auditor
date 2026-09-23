/**
 * Self-contained offline HTML report renderer (Phase 6, task P6-4; rewritten as a fixed-size visual
 * overview by `odd/tasks/html-report-overview.md`): a pure function over an already-built
 * {@link AuditReport} — the exact same JSON `buildAuditReport` produces (`src/domain/report.ts`) —
 * producing one complete HTML document as a string. No I/O, no timers, no adapter imports: every
 * style this page needs is a fixed, hand-authored string literal in this module (`PAGE_STYLE`
 * below); the only variable content is the report's own data, always escaped before it is written
 * into the page, and every chart is server-rendered inline HTML/CSS — no client script, no library,
 * no network.
 *
 * **Overview, not a per-test listing.** This renderer never walks `report.classifications` (or
 * `report.discovery.files`/`report.cacheStatus`) one entry at a time — a real run's page must stay a
 * fixed size regardless of whether it judged 20 tests or 20,000. It renders the fixed-size
 * aggregation {@link summarizeReport} (`src/domain/report-overview.ts`) already computed: a headline
 * "X% of N judged tests need a change", a status share bar, per-dimension diverging bars (worst
 * first), a folder x dimension heatmap, a capped top-files ranking, run coverage counts, and
 * diagnostics grouped by code. Per-test detail (dimension scores, findings, evidence provenance for
 * one specific test) is deliberately NOT reachable from this page at all — it lives only in
 * `audit --evaluate --json`, the canonical machine-readable report this page is derived from. This
 * page no longer embeds that canonical JSON either (Phase 6 shipped it as `#jev-report-data`; a real
 * 7,234-test run made the file weigh megabytes) — the HTML is for a glance, the JSON is for a tool.
 *
 * **Escaping.** Every value interpolated into element text content, a double-quoted attribute, or a
 * `title="…"` hover string goes through {@link escapeHtml} (`&`, `<`, `>`, `"`, `'`). This is what
 * makes a hostile test name, file path, folder name, or diagnostic message safe to render as
 * visible, inert text rather than as an injection into the page's own markup.
 *
 * **Genuinely self-contained, with zero `<script>` tags.** No `<link>`, no `@import`, no `url(...)`
 * reference, no `fetch`/`XMLHttpRequest`/`WebSocket`, and — since the old filter/expand-all behavior
 * went away with the per-test list it operated on, and the JSON data block it never touched is also
 * gone — this page ships no script at all. Hover detail comes from native `title="…"` attributes on
 * every chart mark, not a JS tooltip. Enforced by `test/html-report.test.ts`'s category-based
 * "no external reference" checks, not by grepping for a couple of known-bad substrings.
 *
 * **Charts.** Every chart is plain HTML/CSS: flex-grow-sized segments for the status share and
 * per-dimension diverging bars (never a report string interpolated into a CSS length — only a
 * number, already computed by {@link summarizeReport}, ever reaches a `style` attribute), and an
 * inline-styled `background` for the heatmap/top-files heat steps
 * ({@link heatColor}). Every mark carries a `title="…"` attribute naming its value and denominator,
 * so a reader can hover for the exact figure without a script. Status/dimension colors are the
 * report's own reserved semantic palette (ember = misleading/critical, graphite = weak, violet =
 * needs-review, stone = healthy; ash/ink extend it for acceptable/strong) — never reused for
 * unrelated series. The heatmap/top-files steps stay inside that palette: stone and ash for context,
 * ember only for a hotspot (>= 50% misleading or weak), never an invented hue.
 */
import type { OverallClassificationStatus } from './classification.js';
import { JEV_ESTIMATE_SNAPSHOT } from './jev-pricing.js';
import { RUBRIC_V1, RUBRIC_V2 } from './rubric.js';
import {
  summarizeReport,
  type ReportOverview,
  type ReportOverviewDimension,
  type ReportOverviewHeatmapRow,
  type ReportOverviewStatusEntry,
} from './report-overview.js';
import type { AuditReport } from './report.js';

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

function formatNumber(value: number | undefined, digits = 2): string {
  return value === undefined ? '—' : (Number.isInteger(value) ? String(value) : value.toFixed(digits));
}

/**
 * A share (0..1) as a display string. Never `NaN`: `summarizeReport` already guarantees every share
 * it hands this renderer is a finite number in `[0, 1]`. Rounds to the nearest whole percent, with
 * two honest edge cases: a genuinely nonzero share that rounds to `0` reads `<1%` (never a silent
 * `0%`, which would misstate "some" as "none"), and a share below `1` that rounds to `100` reads
 * `>99%` (never a silent `100%`, which would misstate "almost all" as "all").
 */
function formatPercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  if (share >= 1) return '100%';
  if (share < 0.005) return '<1%';
  if (share > 0.995) return '>99%';
  return `${Math.round(share * 100)}%`;
}

/** A share (0..1) as a CSS length percentage — e.g. `12.5%` — for a `style="width:…"`/`flex` value. Never rounded (visual precision), and never the same string as {@link formatPercent} (display rounding): this is the one place a share reaches a `style` attribute, always as a plain number, never a report string. */
function widthPercent(share: number): string {
  return `${Math.max(0, Math.min(1, share)) * 100}%`;
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

/** The sphere is a product visual: sparks ignite only for the verdict the counts actually hold. */
function sphereKind(report: AuditReport): 'sphere-alarm' | 'sphere-review' | 'sphere-wear' | 'sphere-quiet' {
  const counts = report.totals.statusCounts;
  if (counts.misleading > 0) return 'sphere-alarm';
  if (counts['needs-review'] > 0) return 'sphere-review';
  if (counts.weak > 0) return 'sphere-wear';
  return 'sphere-quiet';
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
  return [
    '<header class="mast">',
    '<div class="mast-copy">',
    '<h1>Jev test audit report</h1>',
    '<p class="disclosure">This tool never executed the audited repository’s code. Classification thresholds are provisional and uncalibrated — see README.md; nothing here is a claim of validated accuracy.</p>',
    '</div>',
    `<div class="sphere ${sphereKind(report)}" aria-hidden="true"><span class="sphere-core"></span></div>`,
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

function statusChip(entry: ReportOverviewStatusEntry): string {
  const dormant = entry.count === 0 ? ' badge-dormant' : '';
  return [
    `<span class="badge ${STATUS_CLASS[entry.status]}${dormant}">`,
    escapeHtml(STATUS_LABEL[entry.status]),
    `<span class="stat-count">${entry.count}</span>`,
    `<span class="stat-share">${formatPercent(entry.share)}</span>`,
    '</span>',
  ].join('');
}

/** One horizontal bar, worst-first, direct-labeled below with count and share — see this module's own doc, "Charts". */
function renderStatusStack(overview: ReportOverview): string {
  const entries = overview.statusBreakdown;
  const present = entries.filter((entry) => entry.count > 0);
  const bar = present.length === 0 ? '' : [
    '<div class="stack-bar" role="img" aria-label="Status share of judged tests">',
    present.map((entry) => `<span class="stack-seg ${STATUS_CLASS[entry.status]}" style="flex-grow:${entry.count}" title="${escapeHtml(STATUS_LABEL[entry.status])}: ${entry.count} (${formatPercent(entry.share)})"></span>`).join(''),
    '</div>',
  ].join('');
  return [
    '<div class="status-stack">',
    bar,
    `<div class="status-summary">${entries.map(statusChip).join('')}</div>`,
    '</div>',
  ].join('\n');
}

function renderHero(overview: ReportOverview): string {
  const { needsChange } = overview;
  const judgedWord = needsChange.judgedTotal === 1 ? 'judged test needs' : 'judged tests need';
  return [
    '<section id="jev-hero" class="hero">',
    '<p class="hero-figure">',
    `<span class="hero-value">${formatPercent(needsChange.share)}</span>`,
    `<span class="hero-label">of ${needsChange.judgedTotal} ${judgedWord} a change</span>`,
    '</p>',
    `<p class="hero-note">${needsChange.count} of ${needsChange.judgedTotal} judged tests are misleading, weak, or need review.</p>`,
    renderStatusStack(overview),
    '</section>',
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

/** Run coverage: discovered -> judged as a labeled bar, plus fixed-size counts — see this module's own doc. Replaces Phase 6's per-file discovery table and per-test not-evaluated block, keeping only the counts (Authorized scope: "counts for discovery... not-evaluated, and diagnostics"). */
function renderCoverageSection(report: AuditReport, overview: ReportOverview): string {
  const { coverage } = overview;
  const perCall = questionsPerCall(report.versions.rubric);
  const questions = perCall === undefined ? undefined : coverage.fresh * perCall;
  const questionsText = questions === undefined ? '—' : String(questions);
  const questionsNote = perCall === undefined ? 'rubric question count unknown' : `${perCall} per fresh call`;
  const cost = formatRunCost(report.totals.usage.inputTokens);

  const funnel = coverage.discoveredTests === 0 ? '' : [
    '<div class="funnel">',
    '<div class="funnel-track">',
    `<span class="funnel-fill" style="width:${widthPercent(coverage.judgedShare)}"></span>`,
    '</div>',
    `<p class="funnel-label">Judged ${coverage.judgedTests} of ${coverage.discoveredTests} discovered tests (${formatPercent(coverage.judgedShare)}).</p>`,
    '</div>',
  ].join('\n');

  const extra: string[] = [];
  const unsupported = report.discovery.totals.unsupportedFrameworkFiles === 0
    ? ''
    : `, ${report.discovery.totals.unsupportedFrameworkFiles} unattributable-framework file(s)`;
  extra.push(`<li>${report.discovery.totals.files} file(s) discovered, ${report.discovery.totals.excluded} excluded${unsupported}.</li>`);
  if (coverage.cached > 0) extra.push(`<li>Cached: ${coverage.cached}</li>`);
  if (coverage.failed > 0) extra.push(`<li>Failed: ${coverage.failed}</li>`);
  if (coverage.notEvaluated > 0) extra.push(`<li>Dispatched but not evaluated: ${coverage.notEvaluated}</li>`);
  if (coverage.skippedTotal > 0) {
    extra.push(`<li>Skipped: ${coverage.skippedTotal} (skip: ${coverage.skippedByReason.skip}, todo: ${coverage.skippedByReason.todo}, evidence-unavailable: ${coverage.skippedByReason['evidence-unavailable']})</li>`);
  }
  if (report.totals.modelMismatches > 0) extra.push(`<li>Model mismatches: ${report.totals.modelMismatches}</li>`);
  if (report.totals.usage.outputTokens > 0) extra.push(`<li>Output tokens: ${report.totals.usage.outputTokens}, not billed</li>`);
  if (report.latency.measuredTestCases > 0) {
    extra.push(`<li>Latency: ${report.latency.measuredTestCases} test case(s) measured — total ${formatNumber(report.latency.totalMs, 0)}ms, mean ${formatNumber(report.latency.meanMs, 1)}ms, min ${formatNumber(report.latency.minMs, 0)}ms, max ${formatNumber(report.latency.maxMs, 0)}ms.</li>`);
  }

  return [
    '<section id="jev-coverage">',
    '<h2>Coverage</h2>',
    '<div class="figures">',
    renderFigure(String(coverage.discoveredTests), 'Tests', 'discovered'),
    renderFigure(String(coverage.fresh), 'Jev calls', 'fresh, billed'),
    renderFigure(questionsText, 'Questions', questionsNote),
    renderFigure(cost, 'Cost', `$${JEV_ESTIMATE_SNAPSHOT.usdPerMillionInputTokens} / 1M input tokens`),
    '</div>',
    funnel,
    '<ul class="summary-list">',
    extra.join('\n'),
    '</ul>',
    '</section>',
  ].join('\n');
}

const DIMENSION_LEGEND_HTML = [
  { cls: 'div-misleading', label: 'Misleading' },
  { cls: 'div-weak', label: 'Weak' },
  { cls: 'div-acceptable', label: 'Acceptable' },
  { cls: 'div-strong', label: 'Strong' },
].map((entry) => `<span class="legend-chip"><span class="legend-dot ${entry.cls}"></span>${escapeHtml(entry.label)}</span>`).join('');

function divergingSegment(className: string, share: number, count: number, title: string): string {
  if (count === 0) return '';
  return `<span class="div-seg ${className}" style="flex:0 0 ${widthPercent(share)}" title="${escapeHtml(title)}"></span>`;
}

function renderDimensionRow(dimension: ReportOverviewDimension): string {
  const { shares, counts, dimensionLabel } = dimension;
  const left = [
    divergingSegment('div-misleading', shares.misleading, counts.misleading, `${dimensionLabel} — Misleading: ${counts.misleading} (${formatPercent(shares.misleading)})`),
    divergingSegment('div-weak', shares.weak, counts.weak, `${dimensionLabel} — Weak: ${counts.weak} (${formatPercent(shares.weak)})`),
  ].join('');
  const right = [
    divergingSegment('div-acceptable', shares.acceptable, counts.acceptable, `${dimensionLabel} — Acceptable: ${counts.acceptable} (${formatPercent(shares.acceptable)})`),
    divergingSegment('div-strong', shares.strong, counts.strong, `${dimensionLabel} — Strong: ${counts.strong} (${formatPercent(shares.strong)})`),
  ].join('');
  const asideParts: string[] = [];
  if (counts.needsReview > 0) asideParts.push(`${counts.needsReview} needs review`);
  if (counts.notApplicable > 0) asideParts.push(`${counts.notApplicable} n/a`);
  const aside = asideParts.length === 0 ? '<span class="div-aside"></span>' : `<span class="div-aside">${escapeHtml(asideParts.join(' · '))}</span>`;
  return [
    '<div class="diverging-row">',
    `<span class="div-label" title="${escapeHtml(dimensionLabel)}">${escapeHtml(shortDimensionLabel(dimensionLabel))}</span>`,
    `<span class="div-left">${left}</span>`,
    '<span class="div-axis" aria-hidden="true"></span>',
    `<span class="div-right">${right}</span>`,
    aside,
    '</div>',
  ].join('');
}

/** Per-dimension diverging bars, worst (highest misleading+weak share) first — see the Authorized scope: "ordered misleading→weak | acceptable→strong, not-applicable separate". */
function renderDimensionsSection(overview: ReportOverview): string {
  const dimensions = [...overview.dimensions].sort(
    (left, right) => right.deficientShare - left.deficientShare || left.dimensionLabel.localeCompare(right.dimensionLabel),
  );
  if (dimensions.length === 0) return '';
  return [
    '<section id="jev-dimensions">',
    '<h2>Dimensions</h2>',
    '<p>Share of each dimension’s own judged tests — misleading/weak on the left, acceptable/strong on the right, worst dimension first. Needs-review and not-applicable are counted separately, to the right of each bar.</p>',
    `<div class="diverging-legend">${DIMENSION_LEGEND_HTML}</div>`,
    '<div class="diverging-list">',
    dimensions.map(renderDimensionRow).join('\n'),
    '</div>',
    '</section>',
  ].join('\n');
}

/**
 * Heat steps for magnitude (heatmap cells, top-files bars), drawn only from the page palette: the
 * neutrals `--stone` and `--ash` carry context, and `--ember` marks a hotspot — a share of misleading
 * or weak at or above {@link HEAT_HOTSPOT_SHARE}. This is the dataviz "emphasis" form (the one thing
 * that matters in the accent hue, the rest in gray) rather than a continuous ramp: `--ember` alone
 * has too little lightness range for a readable sequential scale (validated: its tints sit at
 * ~1.2:1 against the surface and its dark steps collapse together). Ink text clears contrast on every
 * step, and every cell also prints its percentage, so the value never rests on color alone.
 */
const HEAT_HOTSPOT_SHARE = 0.5;
const HEAT_STEPS: readonly { readonly from: number; readonly color: string; readonly label: string }[] = [
  { from: 0, color: '#ebe8e4', label: '0–24%' },
  { from: 0.25, color: '#a59f97', label: '25–49%' },
  { from: HEAT_HOTSPOT_SHARE, color: '#ff4704', label: '≥ 50% hotspot' },
];

function heatColor(share: number): string {
  let color = HEAT_STEPS[0]?.color ?? '';
  for (const step of HEAT_STEPS) if (share >= step.from) color = step.color;
  return color;
}

function renderHeatmapRow(row: ReportOverviewHeatmapRow): string {
  const cells = row.cells.map((cell) => {
    if (cell.share === undefined) {
      return `<td><span class="heat-cell heat-cell-na" title="${escapeHtml(row.folder)} · ${escapeHtml(cell.dimensionLabel)}: n/a (0 applicable)">n/a</span></td>`;
    }
    const percent = formatPercent(cell.share);
    const style = `background:${heatColor(cell.share)};color:#000000`;
    const title = `${escapeHtml(row.folder)} · ${escapeHtml(cell.dimensionLabel)}: ${percent} (${cell.badCount}/${cell.applicableCount})`;
    return `<td><span class="heat-cell" style="${style}" title="${title}">${percent}</span></td>`;
  }).join('');
  const rowClass = row.isOther ? ' class="heat-other"' : '';
  return `<tr${rowClass}><th scope="row" class="heat-folder-name">${escapeHtml(row.folder)}</th>${cells}</tr>`;
}

/** Folder x dimension heatmap — see the Authorized scope addition (2026-09-23): palette neutrals with ember hotspots, a legend naming the steps, a printed percentage where it fits, and a `<title>` per cell. A cell with zero applicable tests reads `n/a`, never `NaN` or a misleading `0%`. */
function renderHeatmapSection(overview: ReportOverview): string {
  const { rows, dimensionOrder } = overview.folderHeatmap;
  if (rows.length === 0 || dimensionOrder.length === 0) return '';
  const head = dimensionOrder.map((dimension) => `<th title="${escapeHtml(dimension.dimensionLabel)}">${escapeHtml(shortDimensionLabel(dimension.dimensionLabel))}</th>`).join('');
  const legend = HEAT_STEPS.map((step) => [
    `<span class="heat-legend-swatch" style="background:${step.color}" aria-hidden="true"></span>`,
    `<span class="heat-legend-label">${step.label}</span>`,
  ].join('')).join('');
  return [
    '<section id="jev-heatmap">',
    '<h2>Where the changes are</h2>',
    '<p>Share of each folder’s own applicable tests that are misleading or weak, per dimension. A folder groups by its first one or two path segments; folders too small to be meaningful on their own fold into their parent, and the smallest-ranked folders fold into “Other”.</p>',
    `<div class="heat-legend">${legend}</div>`,
    renderDataTable(`<th class="heat-folder"></th>${head}`, rows.map(renderHeatmapRow).join('\n'), 'heatmap'),
    '</section>',
  ].join('\n');
}

/** Top files by tests needing a change, capped — see this module's own doc. Bars on the same palette heat steps as the heatmap (ember only for a hotspot), each direct-labeled with its own count and share. */
function renderTopFilesSection(overview: ReportOverview): string {
  const files = overview.topFiles;
  if (files.length === 0) return '';
  const rows = files.map((file) => {
    const percent = formatPercent(file.share);
    const title = `${escapeHtml(file.path)}: ${file.needsChangeCount}/${file.judgedTotal} (${percent})`;
    return [
      '<div class="file-row">',
      `<span class="file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span>`,
      '<span class="file-bar-track">',
      `<span class="file-bar-fill" style="width:${widthPercent(file.share)};background:${heatColor(file.share)}" title="${title}"></span>`,
      '</span>',
      `<span class="file-bar-value">${file.needsChangeCount}/${file.judgedTotal} · ${percent}</span>`,
      '</div>',
    ].join('');
  }).join('\n');
  return [
    '<section id="jev-top-files">',
    '<h2>Top files</h2>',
    `<p>Files ranked by tests needing a change, each against its own judged test count — top ${files.length}.</p>`,
    `<div class="file-list">${rows}</div>`,
    '</section>',
  ].join('\n');
}

/** Diagnostics grouped by code — see the Authorized scope: "diagnostics grouped by code". Bounded by the number of distinct diagnostic codes a run can produce, never by how many diagnostics fired. */
function renderDiagnosticsSection(overview: ReportOverview): string {
  if (overview.diagnostics.length === 0) return '';
  const rows = overview.diagnostics.map((group) => {
    const severities = Object.entries(group.severities).map(([severity, count]) => `${severity}: ${count}`).join(', ');
    return [
      '<tr>',
      `<td>${escapeHtml(group.code)}</td>`,
      `<td>${group.count}</td>`,
      `<td>${escapeHtml(severities)}</td>`,
      '</tr>',
    ].join('');
  }).join('\n');
  return [
    '<section id="jev-diagnostics">',
    '<h2>Diagnostics</h2>',
    renderDataTable('<th>Code</th><th>Count</th><th>Severities</th>', rows),
    '</section>',
  ].join('\n');
}

function renderFooter(report: AuditReport): string {
  return `<footer><p>Generated by jev-test-auditor from report version ${report.reportVersion}. Reporting-only: nothing here executed the audited repository’s code. Per-test detail is available via <code>audit --evaluate --json</code>.</p></footer>`;
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
  margin-bottom: 12px;
}
p { margin: 0 0 16px; }
.mast {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 200px;
  grid-template-areas:
    "copy sphere"
    "meta meta";
  column-gap: 48px;
  row-gap: 28px;
  align-items: center;
  padding-bottom: 8px;
}
.mast-copy { grid-area: copy; }
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
.status-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
}
.stat-count {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.stat-share {
  font-variant-numeric: tabular-nums;
  color: var(--smoke);
  font-size: 12px;
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
.banner strong { font-weight: 500; }
.banner p:last-child { margin-bottom: 0; }
section { margin-top: 72px; }
section > p { max-width: 68ch; color: var(--graphite); }
.hero { margin-top: 56px; }
.hero-figure { display: flex; align-items: baseline; gap: 20px; flex-wrap: wrap; margin: 0 0 8px; }
.hero-value {
  font-family: var(--font-display);
  font-weight: 300;
  font-size: 112px;
  line-height: 1;
  letter-spacing: -2.24px;
  font-variant-numeric: proportional-nums;
}
.hero-label {
  font-size: 20px;
  font-weight: 500;
  letter-spacing: 0.2px;
  max-width: 34ch;
}
.hero-note { color: var(--smoke); margin: 0 0 24px; }
.status-stack { display: flex; flex-direction: column; gap: 16px; }
.stack-bar {
  display: flex;
  height: 32px;
  border-radius: 9999px;
  overflow: hidden;
  gap: 2px;
  background: var(--taupe);
}
.stack-seg { flex-basis: 0; min-width: 6px; }
.stack-seg.status-misleading { background: #ff4704; }
.stack-seg.status-weak { background: #44403b; }
.stack-seg.status-needs-review { background: #0447ff; }
.stack-seg.status-healthy { background: #ebe8e4; }
.figures {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 28px 32px;
  margin: 8px 0 32px;
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
.funnel { margin: 0 0 24px; }
.funnel-track {
  height: 10px;
  border-radius: 9999px;
  background: var(--taupe);
  overflow: hidden;
}
.funnel-fill { display: block; height: 100%; background: var(--ink); border-radius: 9999px; }
.funnel-label { margin: 8px 0 0; color: var(--graphite); }
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
.diverging-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin: 0 0 20px;
}
.legend-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--graphite);
}
.legend-dot { width: 10px; height: 10px; border-radius: 9999px; flex: none; }
.legend-dot.div-misleading { background: #ff4704; }
.legend-dot.div-weak { background: #44403b; }
.legend-dot.div-acceptable { background: #a59f97; }
.legend-dot.div-strong { background: #000000; }
.diverging-list { display: flex; flex-direction: column; gap: 14px; }
.diverging-row {
  display: grid;
  grid-template-columns: 5.5rem 1fr 2px 1fr auto;
  align-items: center;
  gap: 10px;
  min-height: 24px;
}
.div-label {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.13px;
  color: var(--graphite);
}
.div-left, .div-right {
  display: flex;
  height: 16px;
  gap: 2px;
}
.div-left { justify-content: flex-end; }
.div-right { justify-content: flex-start; }
.div-seg { display: block; height: 100%; }
.div-seg.div-misleading { background: #ff4704; }
.div-seg.div-weak { background: #44403b; }
.div-seg.div-acceptable { background: #a59f97; }
.div-seg.div-strong { background: #000000; }
.div-left .div-seg:first-child { border-top-left-radius: 4px; border-bottom-left-radius: 4px; }
.div-right .div-seg:last-child { border-top-right-radius: 4px; border-bottom-right-radius: 4px; }
.div-axis { width: 2px; height: 22px; background: var(--stone); justify-self: center; }
.div-aside { font-size: 12px; color: var(--smoke); white-space: nowrap; }
.heat-legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 16px;
  padding: 8px 14px;
  background: var(--taupe);
  border-radius: 9999px;
}
.heat-legend-swatch { width: 14px; height: 14px; border-radius: 4px; flex: none; }
.heat-legend-label { font-size: 12px; color: var(--graphite); margin-right: 8px; font-variant-numeric: tabular-nums; }
.heat-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3.4rem;
  padding: 6px 8px;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.heat-cell-na { background: var(--taupe); color: var(--smoke); }
.heat-other .heat-folder-name { font-style: italic; color: var(--smoke); }
.heat-folder-name {
  text-align: left;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
}
.file-list { display: flex; flex-direction: column; gap: 10px; }
.file-row {
  display: grid;
  grid-template-columns: minmax(0, 18rem) 1fr auto;
  align-items: center;
  gap: 14px;
}
.file-path {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--graphite);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-bar-track { height: 10px; border-radius: 9999px; background: var(--taupe); overflow: hidden; }
.file-bar-fill { display: block; height: 100%; border-radius: 9999px; min-width: 3px; }
.file-bar-value {
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--graphite);
  white-space: nowrap;
}
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
  vertical-align: middle;
}
th {
  font-weight: 500;
  font-size: 12px;
  color: var(--graphite);
  background: transparent;
}
tr:last-child td { border-bottom: 0; }
table.heatmap th.heat-folder { min-width: 8rem; }
footer {
  margin-top: 96px;
  padding-top: 24px;
  border-top: 1px solid var(--stone);
  color: var(--smoke);
  font-size: 14px;
  letter-spacing: 0.14px;
}
footer code { font-family: var(--font-mono); }
footer p { margin: 0; max-width: 62ch; }
@media (max-width: 800px) {
  .page { padding: 32px 20px 64px; }
  h1 { font-size: 32px; letter-spacing: -0.64px; line-height: 1.13; }
  .mast {
    grid-template-columns: 1fr;
    grid-template-areas:
      "copy"
      "sphere"
      "meta";
    row-gap: 24px;
  }
  .sphere { justify-self: start; width: 140px; height: 140px; }
  .meta { grid-template-columns: 1fr; }
  .hero-value { font-size: 64px; letter-spacing: -1.28px; }
  .figures { grid-template-columns: 1fr 1fr; }
  .figure-value { font-size: 22px; letter-spacing: -0.44px; line-height: 1.15; }
  .diverging-row { grid-template-columns: 4.5rem 1fr 2px 1fr; }
  .div-aside { grid-column: 1 / -1; }
  .file-row { grid-template-columns: 1fr; row-gap: 6px; }
  .banner, .summary-list { padding-right: 20px; }
  .summary-list { padding-left: 20px; }
  .banner { padding-left: 48px; }
}
@media print {
  .sphere-core, .stack-seg, .div-seg, .heat-cell, .badge::before, .banner { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/**
 * Renders `report` as one complete, self-contained HTML document: a fixed-size visual overview, not
 * a per-test listing — see this module's own doc for the rendering strategy, escaping discipline,
 * self-containment guarantee, and what moved to `audit --evaluate --json`. Pure: no I/O, no timers,
 * no randomness — the identical `report` always produces byte-identical output.
 */
export function renderAuditReportHtml(report: AuditReport): string {
  const overview = summarizeReport(report);
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    renderHead(report),
    '<body>',
    '<main class="page">',
    renderHeader(report),
    renderIncompleteBanner(report),
    renderResumeNote(report),
    renderHero(overview),
    renderCoverageSection(report, overview),
    renderDimensionsSection(overview),
    renderHeatmapSection(overview),
    renderTopFilesSection(overview),
    renderDiagnosticsSection(overview),
    renderFooter(report),
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}
