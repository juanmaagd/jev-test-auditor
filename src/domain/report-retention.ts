/**
 * Pure retention selection for persisted run reports (feature "persisted-run-reports",
 * `odd/tasks/persisted-run-reports.md`). No I/O: the caller (`src/adapters/persisted-report-store.ts`)
 * supplies each persisted report's identity and a recorded time, and this module decides which of
 * them the caller should keep vs. remove — it never touches the filesystem itself.
 *
 * **Why "recorded time", not `runId`.** `runId` (`crypto.randomUUID()`,
 * `src/adapters/sqlite-audit-store.ts`'s `beginRun`) is a random UUID, not a time-ordered
 * identifier — sorting by it would not sort by recency. `AuditReport` (`src/domain/report.ts`)
 * carries no timestamp of its own either. The feature document's own decision (2026-09-23,
 * "Authorized scope": "Ordering must be deterministic... not filename alone if run ids are not
 * time-ordered") is to order by "recorded run time in the report or file metadata" instead — this
 * project's adapter uses each persisted file's own mtime, so `recordedAtMs` here is simply whatever
 * monotonic-enough number the adapter derives; this module never interprets it beyond comparing two
 * of them.
 */

export interface RetainedReportEntry {
  readonly id: string;
  readonly recordedAtMs: number;
}

export interface ReportRetentionSelection {
  readonly retain: readonly RetainedReportEntry[];
  readonly remove: readonly RetainedReportEntry[];
}

/** Feature document decision, 2026-09-23: keep the 5 most recent run reports in `.jta/reports/`. */
export const REPORT_RETENTION_LIMIT = 5;

/**
 * Splits `entries` into the newest `limit` (kept, newest first) and everything past it (removed,
 * newest-of-the-removed first) — ranked by `recordedAtMs` descending, ties broken by `id`
 * descending (lexicographic) so two entries recorded at the identical instant (e.g. a coarse
 * filesystem mtime clock, or two entries built in the same test) still resolve deterministically
 * rather than depending on `entries`' incoming order. Never mutates `entries`.
 */
export function selectReportsForRetention(
  entries: readonly RetainedReportEntry[],
  limit: number = REPORT_RETENTION_LIMIT,
): ReportRetentionSelection {
  const sorted = [...entries].sort((left, right) => (right.recordedAtMs - left.recordedAtMs) || right.id.localeCompare(left.id));
  return { retain: sorted.slice(0, limit), remove: sorted.slice(limit) };
}
