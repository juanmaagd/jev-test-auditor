/**
 * Persists and reads back the canonical `AuditReport` JSON for every `audit --evaluate` run
 * (feature "persisted-run-reports", `odd/tasks/persisted-run-reports.md`) under
 * `<rootDir>/.jta/` — the audited project's own root, not this tool's per-user config directory
 * (user decision, 2026-09-23). This is the fs adapter: it owns every filesystem call; the retention
 * *decision* itself is the pure `src/domain/report-retention.ts`.
 *
 * Layout:
 * - `<rootDir>/.jta/reports/<runId>.json` — one file per run, byte-identical to what
 *   `--evaluate --json` prints to stdout (`src/cli/index.ts` passes the exact same
 *   `JSON.stringify(buildAuditReport(...))` string here that it writes to stdout, never a
 *   re-derived copy, so the two can never drift).
 * - `<rootDir>/.jta/latest.json` — the same content as the run just written, so a reader never has
 *   to know the run id to get the most recent report.
 * - `<rootDir>/.jta/.gitignore` containing `*`, created once if missing, so the folder — which can
 *   grow unboundedly relative to the audited project's own history — never gets committed. Created
 *   only when absent; an existing file (including a user's own edit to it) is never overwritten.
 *
 * **Retention.** `runId` (`crypto.randomUUID()`) is not time-ordered and `AuditReport` carries no
 * timestamp of its own (see `src/domain/report-retention.ts`'s own doc) — this adapter orders
 * `.jta/reports/*.json` by each file's own filesystem mtime and keeps the newest
 * `REPORT_RETENTION_LIMIT`, deleting the rest. The report this call just wrote is never a deletion
 * candidate, regardless of what mtime-based ordering says (a skewed clock or a pre-seeded fixture
 * could otherwise rank it as "oldest").
 *
 * **Never throws.** Every operation here is wrapped so a write failure (permission denied, disk
 * full, `.jta` blocked by a same-named regular file, …) becomes a typed `{ persisted: false }`
 * result — the caller (`src/cli/index.ts`) prints one stderr line and never changes the audit's own
 * exit code or stdout, exactly like every other best-effort side channel in this project
 * (`src/adapters/html-report-opener.ts`).
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { REPORT_RETENTION_LIMIT, selectReportsForRetention, type RetainedReportEntry } from '../domain/report-retention.js';

const REPORT_FILE_EXTENSION = '.json';

interface JtaPaths {
  readonly dir: string;
  readonly reportsDir: string;
  readonly gitignoreFile: string;
  readonly latestFile: string;
}

function jtaPaths(rootDir: string): JtaPaths {
  const dir = join(rootDir, '.jta');
  return { dir, reportsDir: join(dir, 'reports'), gitignoreFile: join(dir, '.gitignore'), latestFile: join(dir, 'latest.json') };
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Creates `.jta/reports/` (and therefore `.jta/`) if missing, and `.jta/.gitignore` (content `*`) only if it does not already exist — an existing file there, including a user's own edit, is never overwritten (feature document, "Authorized scope"). */
async function ensureJtaLayout(rootDir: string): Promise<JtaPaths> {
  const paths = jtaPaths(rootDir);
  await mkdir(paths.reportsDir, { recursive: true });
  if (!(await pathExists(paths.gitignoreFile))) await writeFile(paths.gitignoreFile, '*\n');
  return paths;
}

interface PersistedReportFileEntry extends RetainedReportEntry {
  readonly file: string;
}

/** Every `*.json` file directly under `reportsDir`, each with its own recorded time (`mtimeMs`) — see this module's own doc, "Retention". An unreadable `reportsDir` (does not exist yet) is treated as empty, never an error. */
async function reportFileEntries(reportsDir: string): Promise<readonly PersistedReportFileEntry[]> {
  const names = await readdir(reportsDir).catch(() => [] as readonly string[]);
  const jsonNames = names.filter((name) => name.endsWith(REPORT_FILE_EXTENSION));
  return Promise.all(jsonNames.map(async (name) => {
    const file = join(reportsDir, name);
    const info = await stat(file);
    return { id: name.slice(0, -REPORT_FILE_EXTENSION.length), recordedAtMs: info.mtimeMs, file };
  }));
}

export type PersistAuditReportResult =
  | { readonly persisted: true; readonly runReportFile: string; readonly latestFile: string; readonly removedRunIds: readonly string[] }
  | { readonly persisted: false; readonly reason: string };

/**
 * Writes `reportJson` to `<rootDir>/.jta/reports/<runId>.json` and `<rootDir>/.jta/latest.json`
 * (identical content), ensures the layout and self-ignoring `.gitignore` exist, then applies
 * retention (`REPORT_RETENTION_LIMIT`, `src/domain/report-retention.ts`) over every `.json` file in
 * `.jta/reports/` — deleting the oldest-by-mtime beyond the limit, but never the report this exact
 * call just wrote, regardless of what mtime ordering alone would say. Never throws: any failure
 * (permission denied, `.jta` blocked by a same-named regular file, disk full, …) is caught and
 * returned as `{ persisted: false, reason }` — see this module's own doc.
 */
export async function persistAuditReport(rootDir: string, runId: string, reportJson: string): Promise<PersistAuditReportResult> {
  try {
    const paths = await ensureJtaLayout(rootDir);
    const runReportFile = join(paths.reportsDir, `${runId}${REPORT_FILE_EXTENSION}`);
    await writeFile(runReportFile, reportJson);
    await writeFile(paths.latestFile, reportJson);

    const entries = await reportFileEntries(paths.reportsDir);
    const { remove } = selectReportsForRetention(
      entries.map(({ id, recordedAtMs }) => ({ id, recordedAtMs })),
      REPORT_RETENTION_LIMIT,
    );
    const removeIds = new Set(remove.map((candidate) => candidate.id).filter((id) => id !== runId));

    const removedRunIds: string[] = [];
    for (const entry of entries) {
      if (!removeIds.has(entry.id)) continue;
      await rm(entry.file, { force: true });
      removedRunIds.push(entry.id);
    }

    return { persisted: true, runReportFile, latestFile: paths.latestFile, removedRunIds };
  } catch (error) {
    return { persisted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export type LoadPersistedReportResult =
  | { readonly found: true; readonly raw: string; readonly recordedAt: Date }
  | { readonly found: false; readonly reason: 'no-reports' }
  | { readonly found: false; readonly reason: 'unknown-run-id'; readonly availableRunIds: readonly string[] };

/** Every persisted run id under `reportsDir`, sorted for a deterministic, readable error listing (`jta report --run <unknown>`). */
async function availableRunIds(reportsDir: string): Promise<readonly string[]> {
  const entries = await reportFileEntries(reportsDir);
  return entries.map((entry) => entry.id).sort();
}

/**
 * Reads `<rootDir>/.jta/latest.json` back — the exact `raw` bytes last written by
 * {@link persistAuditReport} (never re-serialized), plus that file's own mtime as `recordedAt` (this
 * project's own "recorded time" convention — see `src/domain/report-retention.ts`'s own doc).
 * `found: false, reason: 'no-reports'` when no `--evaluate` run has ever persisted anything here
 * (`.jta/` missing, or `latest.json` specifically missing).
 */
export async function loadLatestPersistedReport(rootDir: string): Promise<LoadPersistedReportResult> {
  const paths = jtaPaths(rootDir);
  const info = await stat(paths.latestFile).catch(() => undefined);
  if (info === undefined) return { found: false, reason: 'no-reports' };
  const raw = await readFile(paths.latestFile, 'utf8');
  return { found: true, raw, recordedAt: new Date(info.mtimeMs) };
}

/**
 * Reads `<rootDir>/.jta/reports/<runId>.json` back — same `raw`/`recordedAt` contract as
 * {@link loadLatestPersistedReport}. `runId` is untrusted CLI input (`jta report --run <runId>`): the
 * candidate path is resolved and required to stay inside `.jta/reports/` before anything is read, so
 * a path-traversal attempt (`../../etc/passwd`) can never escape that directory — it is reported the
 * same as any other run id that does not exist, `unknown-run-id`, never a distinct error that would
 * confirm or deny a file's existence outside `.jta/`. `no-reports` (rather than `unknown-run-id` with
 * an empty list) when `.jta/reports/` holds nothing at all — the more useful message for a project
 * that has never run `--evaluate`.
 */
export async function loadPersistedReportByRunId(rootDir: string, runId: string): Promise<LoadPersistedReportResult> {
  const paths = jtaPaths(rootDir);
  const reportsDirResolved = resolve(paths.reportsDir);
  const candidate = resolve(paths.reportsDir, `${runId}${REPORT_FILE_EXTENSION}`);

  const unknownRunId = async (): Promise<LoadPersistedReportResult> => {
    const ids = await availableRunIds(paths.reportsDir);
    return ids.length === 0 ? { found: false, reason: 'no-reports' } : { found: false, reason: 'unknown-run-id', availableRunIds: ids };
  };

  if (candidate !== reportsDirResolved && !candidate.startsWith(reportsDirResolved + sep)) return unknownRunId();

  const info = await stat(candidate).catch(() => undefined);
  if (info === undefined) return unknownRunId();

  const raw = await readFile(candidate, 'utf8');
  return { found: true, raw, recordedAt: new Date(info.mtimeMs) };
}
