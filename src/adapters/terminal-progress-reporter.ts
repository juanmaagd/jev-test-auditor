import type { AuditPrePhaseEvent, AuditProgressEvent, AuditProgressPort, AuditProgressState } from '../domain/audit.js';

/**
 * Terminal-progress reporting (Phase 6, task P6-3): the adapter that actually writes anywhere for
 * an {@link AuditProgressPort} — the domain and application layers only ever see the port
 * interface (`src/domain/audit.ts`); this module is the one place a real byte gets written.
 *
 * `write`/`isTTY` are both injected rather than read from `process.stderr` directly, so this
 * adapter is testable with a plain recording function and never touches a real stream on its own
 * — the CLI composition root (`src/cli/index.ts`) is the only place that binds them to the real
 * `process.stderr`.
 */
export interface TerminalProgressReporterOptions {
  /**
   * Where every chunk this reporter produces is written, verbatim, with no implied trailing
   * newline of its own — an interactive redraw ends in a bare `\r`, a finished or non-interactive
   * line ends in `\n` (see this module's own non-TTY/TTY docs below). The CLI's own production
   * wiring binds this to `process.stderr.write`, never `process.stdout` — this tool's one
   * canonical machine output (`--evaluate --json`'s single report line) is printed to stdout, and
   * progress must never share that stream, on a TTY or off one.
   */
  readonly write: (chunk: string) => void;
  /**
   * Whether the destination stream is an interactive terminal. `true` selects a single,
   * repeatedly-redrawn status line (a bare `\r` between updates, a trailing `\n` only once the run
   * is over) — the live, human-friendly behavior. `false` (a pipe, a CI log, a redirected file —
   * anywhere a `\r` redraw would just accumulate as garbage, one stale line on top of another)
   * selects one clean, `\n`-terminated line per TERMINAL transition instead, naming the item and
   * the state it reached; a non-terminal checkpoint (`pending`/`running`) produces no line at all
   * in this mode, since it carries no new terminal information a log reader needs.
   */
  readonly isTTY: boolean;
}

const TERMINAL_STATES: ReadonlySet<AuditProgressState> = new Set(['completed', 'cached', 'not-cached', 'failed', 'skipped']);

/**
 * Replaces every embedded carriage return or newline with a plain space. Applied to
 * `identity.repositoryRelativePath`/`.name` before they are ever written: both are user-authored
 * source text this tool never controls, and the non-TTY contract above ("one clean line per
 * transition") only holds if a hostile or merely unlucky test name cannot inject an extra line
 * break into the middle of it.
 */
function sanitizeForSingleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/**
 * One human-readable line for a pre-dispatch phase event (T3, `odd/tasks/audit-run-responsiveness.md`)
 * — no trailing newline or carriage return of its own; the caller (`phase` below) adds whichever
 * one fits its TTY/non-TTY rendering.
 */
function phaseLine(event: AuditPrePhaseEvent): string {
  if (event.phase === 'discovering') return 'Discovering test files...';
  if (event.phase === 'checking-cache') return 'Checking cache...';
  return `Extracting test cases: ${event.done}/${event.total} files (${event.testCases} test case(s) found)...`;
}

/**
 * Builds a real {@link AuditProgressPort}. Tracks five independently counted terminal outcomes —
 * a genuinely fresh dispatch (`completed`), a cache hit (`cached`), a `--cache-only` miss
 * (`not-cached`; `odd/tasks/cache-only-evaluation.md` — never dispatched, never a failure), a
 * failure (`failed`), and a static skip (`skipped`) — against the `total` {@link AuditProgressPort.begin}
 * names, so the rendered line always distinguishes "served from cache" from "actually dispatched"
 * (materially different to a user watching provider cost accrue) and always shows the adaptive
 * scheduler's current concurrency limit (P5-3 makes it change mid-run — see `AuditProgressEvent`'s
 * own doc).
 */
export function createTerminalProgressReporter(options: TerminalProgressReporterOptions): AuditProgressPort {
  const { write, isTTY } = options;
  let total = 0;
  let doneCount = 0;
  let cachedCount = 0;
  let notCachedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  // T3, TTY only: `true` while the most recent write was an un-terminated `\r` phase redraw (a
  // `phase()` call, before `begin`/`report` ever fired). `report`'s own redraw always ends the run
  // with a trailing `\n` once every work item is done — but a run with zero evaluable/skippable
  // items never calls `report` at all, so without this, a phase line's bare `\r` redraw would leave
  // the cursor stranded mid-line forever. `begin` closes it below, whether or not `total` turns out
  // to be positive.
  let phaseLineOpen = false;
  // T3, TTY only: the widest phase line written so far this run, reset alongside `phaseLineOpen` in
  // `begin`. `\r` returns the cursor to column 0 but never erases what was already there — a
  // shorter later phase line (e.g. `Checking cache...`, 18 chars) redrawn over a longer earlier one
  // (e.g. a large `Extracting test cases: ...` line) would otherwise leave that longer line's own
  // trailing characters visible on screen, permanently, once `begin` appends its closing `\n`.
  // Padding every phase line to the widest one seen so far (with trailing spaces, never a
  // terminal-specific escape like `\x1b[K` — this stays plain-text and testable with a dumb
  // recording writer) is what keeps every redraw fully overwriting the one before it.
  let maxPhaseLineWidth = 0;

  function statusLine(concurrencyLimit: number): string {
    const freshCount = doneCount - cachedCount - notCachedCount - failedCount - skippedCount;
    return `${doneCount}/${total} done (fresh ${freshCount}, cached ${cachedCount}, not cached ${notCachedCount}, `
      + `failed ${failedCount}, skipped ${skippedCount}, limit ${concurrencyLimit})`;
  }

  return {
    begin(newTotal: number): void {
      total = newTotal;
      doneCount = 0;
      cachedCount = 0;
      notCachedCount = 0;
      failedCount = 0;
      skippedCount = 0;
      if (isTTY && phaseLineOpen) {
        write('\n');
        phaseLineOpen = false;
        maxPhaseLineWidth = 0;
      }
      // Nothing to report for a run with no evaluable or skippable items at all: no work items will
      // ever reach `report`, so an opening line here would be the only line this run ever prints,
      // for a run that never actually evaluated anything.
      if (total === 0) return;
      // TTY: the redraw itself (below, in `report`) fires on the very first transition, which
      // follows `begin` almost immediately — a separate opening line here would just be redrawn
      // over instantly, so it is skipped in this mode.
      if (!isTTY) write(`Evaluating ${total} test case(s)...\n`);
    },
    report(event: AuditProgressEvent): void {
      const terminal = TERMINAL_STATES.has(event.state);
      if (terminal) {
        doneCount += 1;
        if (event.state === 'cached') cachedCount += 1;
        else if (event.state === 'not-cached') notCachedCount += 1;
        else if (event.state === 'failed') failedCount += 1;
        else if (event.state === 'skipped') skippedCount += 1;
      }

      if (isTTY) {
        // Once every work item this run named in `begin` has reached a terminal state, `doneCount`
        // can never advance again — see `AuditProgressPort.begin`'s own doc — so this is guaranteed
        // to be the chronologically LAST write this run ever makes; a trailing `\n` here, and only
        // here, is what leaves the cursor on its own line instead of stuck mid-redraw.
        const finished = doneCount >= total;
        write(`\r${statusLine(event.concurrencyLimit)}${finished ? '\n' : ''}`);
        return;
      }

      // Non-TTY: a non-terminal checkpoint (`pending`/`running`) carries no new terminal
      // information a log reader needs and is deliberately silent — see `isTTY`'s own doc.
      if (!terminal) return;
      const label = `${sanitizeForSingleLine(event.identity.repositoryRelativePath)} :: ${sanitizeForSingleLine(event.identity.name)}`;
      write(`${event.state} ${label} — ${statusLine(event.concurrencyLimit)}\n`);
    },
    // T3 (`odd/tasks/audit-run-responsiveness.md`): pre-dispatch phase milestones, called zero or
    // more times before `begin`. TTY: the same single-rewritten-line convention `report` uses (a
    // bare `\r`, no trailing `\n` — `begin` closes it, see `phaseLineOpen`'s own doc above).
    // Non-TTY: one clean `\n`-terminated line per call — `runAudit`'s own throttling already
    // bounds this to a small, fixed number of lines regardless of suite size, so no further
    // rate-limiting belongs here.
    phase(event: AuditPrePhaseEvent): void {
      const line = phaseLine(event);
      if (isTTY) {
        maxPhaseLineWidth = Math.max(maxPhaseLineWidth, line.length);
        write(`\r${line.padEnd(maxPhaseLineWidth)}`);
        phaseLineOpen = true;
        return;
      }
      write(`${line}\n`);
    },
  };
}
