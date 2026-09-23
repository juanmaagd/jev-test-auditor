/**
 * Pure aggregation over an already-built {@link AuditReport} (`odd/tasks/html-report-overview.md`):
 * turns a run's per-test `classifications` into the counts, shares, and small capped rankings the
 * HTML overview (`src/domain/html-report.ts`) renders — no per-test detail, only fixed-size
 * summaries whose size never grows with the number of judged tests. No I/O, no timers, no adapter
 * imports; `AuditReport` itself gains no new field and `reportVersion` is never bumped by this
 * module — `summarizeReport` is a read-only derivation a report reader could recompute from the
 * canonical JSON (`audit --evaluate --json`) at any time.
 *
 * **`needsChange` never counts `needs-review`.** A `needs-review` classification means the model
 * was uncertain about that test, never that the test is a confirmed defect (README, "`needs-review`
 * means uncertainty, not a passing or failing grade"), so it is deliberately excluded from
 * `needsChange` and every "tests needing a change" count below (`topFiles.needsChangeCount`,
 * `folderHeatmap` row `needsChangeCount`) — misleading/weak only. It is reported as its own figure,
 * {@link ReportOverview.needsReview}, over the SAME judged denominator as `needsChange`, so a reader
 * can see both without either folding into the other. The status bar (`statusBreakdown`) and the
 * per-dimension needs-review counts are unaffected — they already keep needs-review separate.
 *
 * **Denominators, precisely** (see also this task's own "Constraints": "Every percentage names its
 * denominator" / "Division by zero never renders NaN"):
 * - `needsChange.share`, `needsReview.share`, and every {@link ReportOverviewStatusEntry.share} are
 *   over JUDGED tests (`report.classifications.length`), never discovered tests
 *   (`report.discovery.totals.testCases`) — a test that was skipped, failed outright, or never
 *   evaluated is not part of this denominator.
 * - `coverage.judgedShare` is the one place discovered and judged are compared directly, as a
 *   share, so the discovered/judged gap is visible without conflating it with "needs a change".
 * - Each {@link ReportOverviewDimension}'s six shares are over that dimension's OWN total — the
 *   number of judged classifications that carried a judgment for that exact `dimensionId` (see
 *   {@link summarizeDimensions}) — not over `report.classifications.length` as a whole, because an
 *   older or newer rubric can attach a dimension label to only some classifications.
 * - Every {@link ReportOverviewFileEntry.share} is over that file's own judged test count, not the
 *   run's total.
 * - A {@link ReportOverviewHeatmapCell.share} is `undefined` — never `0` or `NaN` — when
 *   `applicableCount` is `0`: a folder/dimension pair with nothing applicable has no rate to report
 *   at all, and rendering it as `0%` would misstate "nothing was bad" as if something had been
 *   judged and cleared. Every OTHER share in this module already means "0 of N", so it stays a
 *   number even at `N = 0`; this is the one place the population itself can be empty.
 * - Every share helper routes through {@link safeShare}, which returns `0` (never `NaN`) for a
 *   zero denominator.
 *
 * **Folder grouping (`summarizeFolderHeatmap`), adaptive drill-down.** A fixed depth-two rule
 * (`src/payments`) is too coarse for a real monorepo — `backend/src`, `mobile/src`, `frontend/src`
 * carry no signal; the actual hotspots live one or two levels deeper
 * (`backend/src/modules/budgets`). `adaptiveFolderGroups` instead recurses from the root: a node
 * splits into its next REAL (non-generic) child segment only while it still holds at least
 * {@link FOLDER_DOMINANT_SHARE} of the population being grouped (tied to the row budget: a node
 * worth more than one row of a {@link HEATMAP_ROWS_LIMIT}-row grid is worth resolving further) — a
 * node below that share stops and becomes one row, even if the directory tree goes deeper. Choosing
 * the next split level SKIPS generic structural segments (`src`, `lib`, `app`, `test`, `tests`,
 * `__tests__`, `spec`, `packages`, `apps` — {@link FOLDER_GENERIC_SEGMENTS}), silently absorbing any
 * number of them in one step so `backend/src/modules` is reached in the SAME step as `backend`,
 * never stopping at a bare `backend/src` row; the row's KEY is always the real, unmodified path
 * prefix (generic segments included), never a shortened alias, so `--folder <row>`-style prefix
 * filtering elsewhere keeps working. A child candidate that would own fewer than
 * {@link HEATMAP_MIN_GROUP_SIZE} tests never becomes its own row; it folds back into the nearest
 * ancestor row that WAS established (which may be several real levels up, or the root `'.'`) along
 * with any test whose path has no further real segment to split on (recursion stops there
 * structurally, regardless of share). A file with no directory (`smoke.test.ts`) keys to `'.'`.
 * When a folder's own leftover row coexists with child rows it split into (e.g.
 * `backend/src/modules/tickets` alongside `backend/src/modules/tickets/eval`), that leftover row
 * never represents the WHOLE folder — {@link ReportOverviewHeatmapRow.isRemainder} marks it so a
 * reader is never misled into thinking a remainder row's count is the module's total.
 * Every test is accounted for in exactly one leaf row — the drill-down never drops or double-counts
 * one. Rows are then ranked by `needsChangeCount` (same "tests needing a change" ranking `topFiles`
 * uses); only the top {@link HEATMAP_ROWS_LIMIT} become their own row, and every folder past that is
 * summed into one trailing `'Other'` row so the heatmap never grows with the number of folders a run
 * touches. `report-query.mjs`'s `summarizeTopFolders` mirrors this algorithm byte-for-byte (proven
 * by `test/skill-report-query.test.ts`'s parity tests).
 */
import type { ClassificationLevel, OverallClassificationStatus } from './classification.js';
import type { AuditReport } from './report.js';

/** How many entries {@link summarizeReport}'s `topFiles` ranking keeps — the whole reason this list stays fixed-size regardless of how many files a run touches. */
export const TOP_FILES_LIMIT = 10;

/** How many of the {@link summarizeFolderHeatmap} folder rows are kept individually — everything past this rank folds into one trailing `'Other'` row. */
export const HEATMAP_ROWS_LIMIT = 12;

/** The smallest candidate folder group {@link summarizeFolderHeatmap} keeps as its own row, at any depth; a smaller candidate folds up to its nearest established ancestor row — see this module's own doc, "Folder grouping". */
export const HEATMAP_MIN_GROUP_SIZE = 3;

/** Directory segments skipped when CHOOSING the next folder-grouping split level — never when naming a row (the row key is always the real, unmodified path prefix). See this module's own doc, "Folder grouping". */
const FOLDER_GENERIC_SEGMENTS: ReadonlySet<string> = new Set(['src', 'lib', 'app', 'test', 'tests', '__tests__', 'spec', 'packages', 'apps']);

/** The share of the population being grouped a folder must hold to be worth splitting into finer children — see this module's own doc, "Folder grouping". Tied to {@link HEATMAP_ROWS_LIMIT}: a folder that would take more than one row's worth of a fixed-size grid is worth resolving further; one that would not stays a single, coarser row. */
const FOLDER_DOMINANT_SHARE = 1 / HEATMAP_ROWS_LIMIT;

export interface ReportOverviewNeedsChange {
  readonly count: number;
  readonly judgedTotal: number;
  readonly share: number;
}

/** Same shape as {@link ReportOverviewNeedsChange}, over the same judged denominator — `needs-review` means the model was uncertain, never that the test is broken, so it is never folded into `needsChange`. */
export interface ReportOverviewNeedsReview {
  readonly count: number;
  readonly judgedTotal: number;
  readonly share: number;
}

export interface ReportOverviewStatusEntry {
  readonly status: OverallClassificationStatus;
  readonly count: number;
  readonly share: number;
}

export interface ReportOverviewCoverage {
  readonly discoveredTests: number;
  readonly judgedTests: number;
  readonly judgedShare: number;
  readonly cached: number;
  readonly fresh: number;
  readonly failed: number;
  readonly notEvaluated: number;
  readonly skippedTotal: number;
  readonly skippedByReason: Readonly<Record<'skip' | 'todo' | 'evidence-unavailable', number>>;
}

/** Every level a dimension judgment can land on, plus the two non-level statuses (`needsReview`/`notApplicable`) — one bucket shape shared by counts and shares alike. */
export interface ReportOverviewDimensionLevelCounts {
  readonly misleading: number;
  readonly weak: number;
  readonly acceptable: number;
  readonly strong: number;
  readonly needsReview: number;
  readonly notApplicable: number;
}

export interface ReportOverviewDimension {
  readonly dimensionId: string;
  readonly dimensionLabel: string;
  /** This dimension's own denominator — see this module's doc, "Denominators, precisely". */
  readonly total: number;
  readonly counts: ReportOverviewDimensionLevelCounts;
  readonly shares: ReportOverviewDimensionLevelCounts;
  /** `shares.misleading + shares.weak` — the one number a "worst first" chart ordering sorts by. */
  readonly deficientShare: number;
}

export interface ReportOverviewFileEntry {
  readonly path: string;
  readonly needsChangeCount: number;
  readonly judgedTotal: number;
  readonly share: number;
}

export interface ReportOverviewDiagnosticGroup {
  readonly code: string;
  readonly count: number;
  readonly severities: Readonly<Record<string, number>>;
}

/** One folder's rate for one dimension: `badCount` (misleading or weak) over `applicableCount` (judged or needs-review; not-applicable excluded). `share` is `undefined` exactly when `applicableCount` is `0` — see this module's own doc. */
export interface ReportOverviewHeatmapCell {
  readonly dimensionId: string;
  readonly dimensionLabel: string;
  readonly badCount: number;
  readonly applicableCount: number;
  readonly share: number | undefined;
}

export interface ReportOverviewHeatmapRow {
  readonly folder: string;
  readonly needsChangeCount: number;
  readonly judgedTotal: number;
  /** `true` only for the trailing merged row summing every folder past {@link HEATMAP_ROWS_LIMIT}. */
  readonly isOther: boolean;
  /**
   * `true` when `folder` is the LEFTOVER slice of a folder that also split into its own deeper child
   * rows (e.g. tests directly in `backend/src/modules/tickets` when `.../tickets/eval` also became
   * its own row) — see this module's own doc, "Folder grouping". `folder` itself is never suffixed; a
   * renderer that wants a human-readable distinction (e.g. `"backend/src/modules/tickets (other
   * files)"`) reads this flag. Always `false` for the merged `'Other'` row.
   */
  readonly isRemainder: boolean;
  /** One cell per {@link ReportOverviewHeatmap.dimensionOrder} entry, same order, even when this folder has no test for that dimension (then `applicableCount: 0`, `share: undefined`). */
  readonly cells: readonly ReportOverviewHeatmapCell[];
}

export interface ReportOverviewHeatmap {
  /** Ranked worst (most tests needing a change) first; capped at {@link HEATMAP_ROWS_LIMIT} real folders plus an optional trailing `'Other'` row. */
  readonly rows: readonly ReportOverviewHeatmapRow[];
  /** The column order every row's `cells` follows — the same dimensions and order as {@link ReportOverview.dimensions}. */
  readonly dimensionOrder: readonly { readonly dimensionId: string; readonly dimensionLabel: string }[];
}

export interface ReportOverview {
  readonly needsChange: ReportOverviewNeedsChange;
  /** `needs-review` counted on its own — uncertain, never a confirmed defect. Same judged denominator as {@link ReportOverview.needsChange}; the two never overlap and never double-count a test. */
  readonly needsReview: ReportOverviewNeedsReview;
  /** Worst-first: `misleading`, `weak`, `needs-review`, `healthy` — matches the report's own established ordering (`src/domain/html-report.ts`'s `STATUS_SEVERITY`). */
  readonly statusBreakdown: readonly ReportOverviewStatusEntry[];
  readonly coverage: ReportOverviewCoverage;
  /** Canonical order: first-seen across `classifications` in file-then-test-case order, deterministic for a given report. The renderer chooses its own display order (e.g. worst-`deficientShare`-first). */
  readonly dimensions: readonly ReportOverviewDimension[];
  /** Capped at {@link TOP_FILES_LIMIT}, worst (most tests needing a change) first; a file with zero tests needing a change is never listed. */
  readonly topFiles: readonly ReportOverviewFileEntry[];
  /** Folder x dimension "where is this bad" grid — see this module's own doc, "Folder grouping". */
  readonly folderHeatmap: ReportOverviewHeatmap;
  /** Worst (most frequent) code first. */
  readonly diagnostics: readonly ReportOverviewDiagnosticGroup[];
}

/** `numerator / denominator`, or `0` — never `NaN` — when `denominator` is `0`. The one division helper every share in this module goes through. */
function safeShare(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

const STATUS_ORDER: readonly OverallClassificationStatus[] = ['misleading', 'weak', 'needs-review', 'healthy'];

/** `needs-review` is deliberately excluded — see this module's own doc, "Denominators, precisely". */
function summarizeNeedsChange(report: AuditReport): ReportOverviewNeedsChange {
  const judgedTotal = report.classifications.length;
  const counts = report.totals.statusCounts;
  const count = counts.misleading + counts.weak;
  return { count, judgedTotal, share: safeShare(count, judgedTotal) };
}

function summarizeNeedsReview(report: AuditReport): ReportOverviewNeedsReview {
  const judgedTotal = report.classifications.length;
  const count = report.totals.statusCounts['needs-review'];
  return { count, judgedTotal, share: safeShare(count, judgedTotal) };
}

function summarizeStatusBreakdown(report: AuditReport): readonly ReportOverviewStatusEntry[] {
  const judgedTotal = report.classifications.length;
  const counts = report.totals.statusCounts;
  return STATUS_ORDER.map((status) => ({ status, count: counts[status], share: safeShare(counts[status], judgedTotal) }));
}

function summarizeCoverage(report: AuditReport): ReportOverviewCoverage {
  const discoveredTests = report.discovery.totals.testCases;
  const judgedTests = report.classifications.length;
  const notEvaluated = report.cacheStatus.filter((entry) => entry.status === 'not-evaluated').length;
  return {
    discoveredTests,
    judgedTests,
    judgedShare: safeShare(judgedTests, discoveredTests),
    cached: report.totals.cached,
    fresh: report.totals.evaluated,
    failed: report.totals.failed,
    notEvaluated,
    skippedTotal: report.totals.skipped.total,
    skippedByReason: report.totals.skipped.byReason,
  };
}

interface MutableLevelCounts {
  misleading: number;
  weak: number;
  acceptable: number;
  strong: number;
  needsReview: number;
  notApplicable: number;
}

function emptyLevelCounts(): MutableLevelCounts {
  return { misleading: 0, weak: 0, acceptable: 0, strong: 0, needsReview: 0, notApplicable: 0 };
}

const LEVEL_KEYS: ReadonlySet<ClassificationLevel> = new Set(['misleading', 'weak', 'acceptable', 'strong']);

function summarizeDimensions(report: AuditReport): readonly ReportOverviewDimension[] {
  const order: string[] = [];
  const labels = new Map<string, string>();
  const buckets = new Map<string, MutableLevelCounts>();

  for (const classification of report.classifications) {
    for (const dim of classification.dimensions) {
      let bucket = buckets.get(dim.dimensionId);
      if (bucket === undefined) {
        bucket = emptyLevelCounts();
        buckets.set(dim.dimensionId, bucket);
        labels.set(dim.dimensionId, dim.dimensionLabel);
        order.push(dim.dimensionId);
      }
      if (dim.status === 'not-applicable') {
        bucket.notApplicable += 1;
      } else if (dim.status === 'needs-review') {
        bucket.needsReview += 1;
      } else if (dim.level !== undefined && LEVEL_KEYS.has(dim.level)) {
        bucket[dim.level] += 1;
      }
    }
  }

  return order.map((dimensionId) => {
    const counts = buckets.get(dimensionId)!;
    const total = counts.misleading + counts.weak + counts.acceptable + counts.strong + counts.needsReview + counts.notApplicable;
    const shares: ReportOverviewDimensionLevelCounts = {
      misleading: safeShare(counts.misleading, total),
      weak: safeShare(counts.weak, total),
      acceptable: safeShare(counts.acceptable, total),
      strong: safeShare(counts.strong, total),
      needsReview: safeShare(counts.needsReview, total),
      notApplicable: safeShare(counts.notApplicable, total),
    };
    return {
      dimensionId,
      dimensionLabel: labels.get(dimensionId)!,
      total,
      counts: { ...counts },
      shares,
      deficientShare: shares.misleading + shares.weak,
    };
  });
}

interface MutableFileTally {
  needsChange: number;
  total: number;
}

function summarizeTopFiles(report: AuditReport): readonly ReportOverviewFileEntry[] {
  const byPath = new Map<string, MutableFileTally>();
  for (const classification of report.classifications) {
    const tally = byPath.get(classification.repositoryRelativePath) ?? { needsChange: 0, total: 0 };
    tally.total += 1;
    if (classification.status === 'misleading' || classification.status === 'weak') tally.needsChange += 1;
    byPath.set(classification.repositoryRelativePath, tally);
  }
  return [...byPath.entries()]
    .map(([path, tally]): ReportOverviewFileEntry => ({
      path,
      needsChangeCount: tally.needsChange,
      judgedTotal: tally.total,
      share: safeShare(tally.needsChange, tally.total),
    }))
    .filter((entry) => entry.needsChangeCount > 0)
    .sort((left, right) => right.needsChangeCount - left.needsChangeCount || right.share - left.share || left.path.localeCompare(right.path))
    .slice(0, TOP_FILES_LIMIT);
}

function directorySegments(path: string): readonly string[] {
  return path.split('/').slice(0, -1);
}

/**
 * The next real (non-generic) directory-segment boundary past `fromIndex`, silently absorbing any
 * generic segments along the way — or `undefined` when nothing but generic segments (or nothing at
 * all) remains, meaning this path has no further real segment to split on. See this module's own
 * doc, "Folder grouping".
 */
function nextFolderBoundary(dirs: readonly string[], fromIndex: number): number | undefined {
  let index = fromIndex;
  while (index < dirs.length && FOLDER_GENERIC_SEGMENTS.has(dirs[index]!)) index += 1;
  return index < dirs.length ? index + 1 : undefined;
}

interface AdaptiveFolderItem {
  readonly index: number;
  readonly dirs: readonly string[];
}

interface AdaptiveFolderGroup {
  readonly folder: string;
  readonly indices: readonly number[];
  /**
   * `true` exactly when this row is the LEFTOVER slice of a folder that also split into its own
   * deeper child rows — e.g. tests directly in `backend/src/modules/tickets` when
   * `backend/src/modules/tickets/eval` etc. also became their own rows below it. Without this flag a
   * reader sees a `backend/src/modules/tickets` row and assumes it is the WHOLE module, missing the
   * tests that live in its sibling child rows. `false` for a folder that never split (its row already
   * represents everything under it) and for the row-cap's merged `'Other'` row (an aggregate of many
   * unrelated folders, not one folder's own leftover). `folder` itself is deliberately left
   * untouched here — see this module's own doc, "Folder grouping" — the caller decides how to label
   * a remainder row for a human reader.
   */
  readonly isRemainder: boolean;
}

/**
 * Deterministic adaptive folder split — see this module's own doc, "Folder grouping". Recurses from
 * `prefix`/`prefixDepth` (a real path prefix and its segment count): while this node holds at least
 * {@link FOLDER_DOMINANT_SHARE} of `grandTotal`, it splits into its next real (non-generic) child
 * segments; a child under {@link HEATMAP_MIN_GROUP_SIZE} folds back into `prefix`'s own row instead
 * of becoming its own. Returns leaf groups only, ready for the caller's own tallying/ranking. Every
 * item passed in appears in EXACTLY one returned group's `indices` — the drill-down never drops or
 * double-counts one.
 */
function adaptiveFolderGroups(items: readonly AdaptiveFolderItem[], prefix: string, prefixDepth: number, grandTotal: number): AdaptiveFolderGroup[] {
  if (items.length === 0) return [];
  if (items.length / grandTotal < FOLDER_DOMINANT_SHARE) return [{ folder: prefix, indices: items.map((item) => item.index), isRemainder: false }];

  const buckets = new Map<string, AdaptiveFolderItem[]>();
  const leftover: AdaptiveFolderItem[] = [];
  for (const item of items) {
    const newDepth = nextFolderBoundary(item.dirs, prefixDepth);
    if (newDepth === undefined) {
      leftover.push(item);
      continue;
    }
    const key = item.dirs.slice(0, newDepth).join('/');
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }

  const childGroups: AdaptiveFolderGroup[] = [];
  for (const [key, bucketItems] of buckets) {
    if (bucketItems.length < HEATMAP_MIN_GROUP_SIZE) {
      leftover.push(...bucketItems);
      continue;
    }
    childGroups.push(...adaptiveFolderGroups(bucketItems, key, key.split('/').length, grandTotal));
  }
  const groups = childGroups;
  if (leftover.length > 0) groups.push({ folder: prefix, indices: leftover.map((item) => item.index), isRemainder: childGroups.length > 0 });
  return groups;
}

interface HeatmapCellTally {
  bad: number;
  applicable: number;
}

interface HeatmapFolderTally {
  needsChange: number;
  total: number;
  isRemainder: boolean;
  cells: Map<string, HeatmapCellTally>;
}

function emptyHeatmapFolderTally(): HeatmapFolderTally {
  return { needsChange: 0, total: 0, isRemainder: false, cells: new Map() };
}

function heatmapCells(
  tally: HeatmapFolderTally,
  dimensionOrder: readonly { readonly dimensionId: string; readonly dimensionLabel: string }[],
): readonly ReportOverviewHeatmapCell[] {
  return dimensionOrder.map(({ dimensionId, dimensionLabel }) => {
    const cell = tally.cells.get(dimensionId);
    const badCount = cell?.bad ?? 0;
    const applicableCount = cell?.applicable ?? 0;
    return { dimensionId, dimensionLabel, badCount, applicableCount, share: applicableCount === 0 ? undefined : badCount / applicableCount };
  });
}

function addHeatmapCellTally(tally: HeatmapFolderTally, dimensionId: string, judgment: { readonly status: string; readonly level: ClassificationLevel | undefined }): void {
  if (judgment.status === 'not-applicable') return;
  const cell = tally.cells.get(dimensionId) ?? { bad: 0, applicable: 0 };
  cell.applicable += 1;
  if (judgment.status === 'judged' && (judgment.level === 'misleading' || judgment.level === 'weak')) cell.bad += 1;
  tally.cells.set(dimensionId, cell);
}

/**
 * Folder x dimension "where is this bad" grid — see this module's own doc, "Folder grouping", for
 * the adaptive drill-down and the row cap. `dimensionOrder` (the same order {@link summarizeDimensions}
 * already produced) fixes every row's column order, so a folder that never saw a given dimension
 * still emits a `share: undefined` cell rather than omitting the column entirely.
 */
function summarizeFolderHeatmap(
  report: AuditReport,
  dimensionOrder: readonly { readonly dimensionId: string; readonly dimensionLabel: string }[],
): ReportOverviewHeatmap {
  const items: AdaptiveFolderItem[] = report.classifications.map((classification, index) => ({
    index,
    dirs: directorySegments(classification.repositoryRelativePath),
  }));
  const groups = adaptiveFolderGroups(items, '.', 0, report.classifications.length);

  const folders = new Map<string, HeatmapFolderTally>();
  for (const group of groups) {
    const tally = emptyHeatmapFolderTally();
    tally.isRemainder = group.isRemainder;
    for (const index of group.indices) {
      const classification = report.classifications[index]!;
      tally.total += 1;
      if (classification.status === 'misleading' || classification.status === 'weak') tally.needsChange += 1;
      for (const dim of classification.dimensions) addHeatmapCellTally(tally, dim.dimensionId, dim);
    }
    folders.set(group.folder, tally);
  }

  const ranked = [...folders.entries()].sort(
    ([leftKey, left], [rightKey, right]) => right.needsChange - left.needsChange || right.total - left.total || leftKey.localeCompare(rightKey),
  );
  const kept = ranked.slice(0, HEATMAP_ROWS_LIMIT);
  const overflow = ranked.slice(HEATMAP_ROWS_LIMIT);

  const rows: ReportOverviewHeatmapRow[] = kept.map(([folder, tally]) => ({
    folder,
    needsChangeCount: tally.needsChange,
    judgedTotal: tally.total,
    isOther: false,
    isRemainder: tally.isRemainder,
    cells: heatmapCells(tally, dimensionOrder),
  }));

  if (overflow.length > 0) {
    const merged = emptyHeatmapFolderTally();
    for (const [, tally] of overflow) {
      merged.needsChange += tally.needsChange;
      merged.total += tally.total;
      for (const [dimensionId, cell] of tally.cells) {
        const existing = merged.cells.get(dimensionId) ?? { bad: 0, applicable: 0 };
        existing.bad += cell.bad;
        existing.applicable += cell.applicable;
        merged.cells.set(dimensionId, existing);
      }
    }
    rows.push({ folder: 'Other', needsChangeCount: merged.needsChange, judgedTotal: merged.total, isOther: true, isRemainder: false, cells: heatmapCells(merged, dimensionOrder) });
  }

  return { rows, dimensionOrder };
}

function diagnosticCode(diagnostic: Readonly<Record<string, unknown>>): string {
  return typeof diagnostic['code'] === 'string' ? diagnostic['code'] : 'unknown';
}

function diagnosticSeverity(diagnostic: Readonly<Record<string, unknown>>): string {
  return typeof diagnostic['severity'] === 'string' ? diagnostic['severity'] : 'unknown';
}

function summarizeDiagnostics(report: AuditReport): readonly ReportOverviewDiagnosticGroup[] {
  const order: string[] = [];
  const groups = new Map<string, { count: number; severities: Map<string, number> }>();
  for (const diagnostic of report.diagnostics) {
    const code = diagnosticCode(diagnostic);
    const severity = diagnosticSeverity(diagnostic);
    let group = groups.get(code);
    if (group === undefined) {
      group = { count: 0, severities: new Map() };
      groups.set(code, group);
      order.push(code);
    }
    group.count += 1;
    group.severities.set(severity, (group.severities.get(severity) ?? 0) + 1);
  }
  return order
    .map((code): ReportOverviewDiagnosticGroup => {
      const group = groups.get(code)!;
      return { code, count: group.count, severities: Object.fromEntries(group.severities) };
    })
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

/**
 * Builds the fixed-size overview {@link renderAuditReportHtml} renders from — see this module's own
 * doc for exactly which population each share's denominator counts. Pure and deterministic: the
 * identical `report` always produces byte-for-byte-identical `ReportOverview` field values (object
 * identity aside).
 */
export function summarizeReport(report: AuditReport): ReportOverview {
  const dimensions = summarizeDimensions(report);
  const dimensionOrder = dimensions.map(({ dimensionId, dimensionLabel }) => ({ dimensionId, dimensionLabel }));
  return {
    needsChange: summarizeNeedsChange(report),
    needsReview: summarizeNeedsReview(report),
    statusBreakdown: summarizeStatusBreakdown(report),
    coverage: summarizeCoverage(report),
    dimensions,
    topFiles: summarizeTopFiles(report),
    folderHeatmap: summarizeFolderHeatmap(report, dimensionOrder),
    diagnostics: summarizeDiagnostics(report),
  };
}
