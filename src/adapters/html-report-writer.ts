/**
 * Writes the self-contained HTML report the domain renderer (`src/domain/html-report.ts`) produces
 * to an explicit, user-named path (`--html <path>`) — Phase 6, task P6-4. This is the first file the
 * tool ever writes outside the auth credentials store and the audit store (Phase 5 spent its whole
 * scope establishing that nothing is written unless explicitly asked for), so this adapter is
 * deliberately narrow: it is called only when `--html <path>` was actually given, and only after
 * evaluation has already run.
 *
 * **Overwrite decision (this task's own scope: "make each visible and named").** `--html <path>`
 * pointing at an already-existing REGULAR FILE is silently overwritten — an explicitly named output
 * path is the established CLI convention for "write the result here, every time" (`tsc --outFile`,
 * `eslint -o`, shell redirection; this project's own `auth login` already overwrites a stale stored
 * credentials file without prompting). `writeHtmlReport`'s result reports whether this specific call
 * was an overwrite (`overwrote: true`), which the CLI composition root surfaces to the user (on
 * stderr, alongside the write, never on stdout — see `src/cli/index.ts`) — visible, never silent.
 *
 * **`--html <path>` pointing at an existing DIRECTORY, or at a path whose parent does not exist, is
 * a named, visible failure (exit 1), never a silent no-op or a `mkdir -p`.** Auto-creating a missing
 * parent directory was considered and declined: unlike the tool's own config directory (created
 * owner-only under a fixed, tool-managed location), `--html <path>` is an arbitrary, user-supplied
 * filesystem path outside the tool's own state — silently creating a directory tree there on a
 * typo'd path is a surprise this tool's own "nothing happens unless explicitly asked for" posture
 * argues against. {@link checkHtmlReportPath} is the read-only preflight the CLI runs BEFORE
 * dispatching any (potentially expensive, real-money) evaluation work, so a bad path costs nothing;
 * {@link writeHtmlReport} re-derives the identical two named failures at write time (the only
 * correct behavior under the unavoidable TOCTOU race between preflight and the real write — e.g. the
 * parent directory is removed in between) and additionally reports any other filesystem failure
 * (permission denied, disk full, …) as `reason: 'write-error'`, with the underlying error's own
 * message, never a raw stack trace.
 *
 * **No restrictive permissions of its own.** Unlike `src/adapters/auth-storage.ts` (owner-only
 * `0o600`, because it holds a secret API key) or `src/adapters/sqlite-audit-store.ts` (owner-only
 * `0o700` directory, because it accumulates a run's full history), this file is born at whatever the
 * ordinary default (OS umask) permissions are — no `chmod`, no restrictive `mode` passed to the
 * underlying write. The report is explicitly built to be handed to someone else (see
 * `src/domain/html-report.ts`'s own doc); locking it down by default would only mean the very first
 * thing a user has to do with the artifact they asked for is loosen its permissions again.
 */
import { stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type HtmlReportPathProblemReason = 'is-directory' | 'parent-missing';

export interface HtmlReportPathProblem {
  readonly reason: HtmlReportPathProblemReason;
  readonly message: string;
}

export type HtmlReportWriteFailureReason = HtmlReportPathProblemReason | 'write-error';

export interface HtmlReportWriteSuccess {
  readonly written: true;
  /** Whether a file already existed at this exact path before this call overwrote it. */
  readonly overwrote: boolean;
}

export interface HtmlReportWriteFailure {
  readonly written: false;
  readonly reason: HtmlReportWriteFailureReason;
  /** A readable message naming the exact problem and path — never a raw stack trace (this project's established CLI usage-error convention). */
  readonly message: string;
}

export type HtmlReportWriteResult = HtmlReportWriteSuccess | HtmlReportWriteFailure;

/**
 * Read-only preflight: checks whether `path` COULD be written to, without writing anything. Meant
 * to run before any evaluation work is dispatched, so a usage mistake (directory, missing parent)
 * costs nothing — see this module's own doc. Returns `undefined` when there is no known problem;
 * {@link writeHtmlReport} still performs its own checks at write time, since this preflight cannot
 * rule out every race (the parent directory could be removed in between).
 */
export async function checkHtmlReportPath(path: string): Promise<HtmlReportPathProblem | undefined> {
  const targetStats = await stat(path).catch(() => undefined);
  if (targetStats?.isDirectory() === true) {
    return { reason: 'is-directory', message: `${path} is a directory.` };
  }

  const parent = dirname(path);
  const parentStats = await stat(parent).catch(() => undefined);
  if (parentStats === undefined || !parentStats.isDirectory()) {
    return { reason: 'parent-missing', message: `parent directory ${parent} does not exist.` };
  }

  return undefined;
}

/**
 * Writes `html` to `path`, overwriting an existing regular file there (see this module's own doc
 * for why). Re-runs the identical checks {@link checkHtmlReportPath} performs (never trusting a
 * preflight result that may now be stale) so the two named failures are reported the same way
 * whether they are caught early or only at write time; any other filesystem error is reported as
 * `reason: 'write-error'` with the underlying error's own message, never a raw stack trace or a
 * thrown exception.
 */
export async function writeHtmlReport(path: string, html: string): Promise<HtmlReportWriteResult> {
  const problem = await checkHtmlReportPath(path);
  if (problem !== undefined) return { written: false, ...problem };

  const existedBefore = await stat(path).then((stats) => stats.isFile(), () => false);

  try {
    await writeFile(path, html);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { written: false, reason: 'write-error', message };
  }

  return { written: true, overwrote: existedBefore };
}
