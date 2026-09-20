/**
 * Opens a just-written HTML report (`--html <path> --open`, Phase 6, task P6-4) in the operating
 * system's default viewer — a visible side effect of an explicit request, never a default. `--open`
 * requires `--html` and always opens the exact file that was just written, never anything else (see
 * `src/cli/index.ts`).
 *
 * **Mechanism, per platform** ({@link viewerCommandFor}, a pure function): `open <path>` on macOS,
 * `xdg-open <path>` on Linux (and any other non-Windows, non-macOS platform, as a POSIX-reasonable
 * fallback), `explorer.exe <path>` on Windows. Windows deliberately does NOT go through
 * `cmd /c start "" <path>`: `start` is a `cmd.exe` built-in whose quoting rules (the empty `""`
 * title-argument workaround) are murky to get right through `child_process.spawn` without
 * `shell: true` — `explorer.exe <path>` opens a file with its default handler directly, with a
 * plain one-argument command line and no quoting question to get wrong. (`explorer.exe` is known to
 * sometimes report a non-zero exit code even on success — irrelevant here, since only the `spawn`/
 * `error` events, never the exit code, are consulted; see {@link openHtmlReportWithViewer}'s own
 * doc.) This win32 path is exercised only at the pure-function level in this project's own test
 * suite (`viewerCommandFor`, no Windows CI available) — disclosed here rather than left implicit,
 * the same posture this project already takes for its untested TTY redraw path
 * (`src/adapters/terminal-progress-reporter.ts`).
 *
 * **Failure is always non-fatal, and the CLI never blocks waiting for the viewer.**
 * {@link openHtmlReportWithViewer} spawns the viewer `detached`, with its own stdio ignored, and
 * `unref()`s the child the moment it is confirmed spawned — this process can exit immediately
 * without waiting for a GUI viewer window to close. Success/failure is decided from whichever of the
 * child process's own `'spawn'` (the OS successfully started the process) or `'error'` (spawning
 * itself failed — e.g. `ENOENT`, no such viewer installed) events fires first; a synchronous throw
 * from the injected `spawn` function itself is caught the same way. This deliberately does NOT wait
 * for, or interpret, the viewer's own exit code: a CI environment with no desktop is the expected,
 * common case (e.g. `xdg-open` can itself start successfully and then exit non-zero moments later
 * because no desktop session exists to hand the file to) — this function only answers "could the OS
 * even start a viewer process", not "did a human actually see a window", which no signal available
 * here can prove either way. This is a disclosed limitation, not a bug: `--open`'s own contract
 * (this task's own scope) is "never fails the run, never changes the exit status, never loses the
 * already-written file" — {@link openHtmlReportWithViewer} never throws and never rejects, only
 * ever resolves to a typed result, so the CLI composition root can report a best-effort note (on
 * stderr, never stdout) without the failure touching the exit code either way.
 */
import { spawn as nodeSpawn } from 'node:child_process';

export interface ViewerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Pure: which command opens `path` with the OS default viewer on `platform`. See this module's own doc for why each platform's mechanism was chosen. */
export function viewerCommandFor(platform: NodeJS.Platform, path: string): ViewerCommand {
  if (platform === 'darwin') return { command: 'open', args: [path] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [path] };
  return { command: 'xdg-open', args: [path] };
}

export type OpenHtmlReportResult = { readonly opened: true } | { readonly opened: false; readonly reason: string };

/**
 * The minimal surface this module actually consumes from a spawned child process — deliberately
 * narrower than the full `node:child_process.ChildProcess` shape, so a test's fake child process
 * only has to implement exactly these two members. A real `ChildProcess` satisfies this
 * structurally (it has both), so the production `spawn` binding below needs no adapter of its own.
 */
export interface MinimalSpawnedProcess {
  unref(): void;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'spawn', listener: () => void): this;
}

/** Injectable seam matching the small subset of `node:child_process`'s own `spawn` this module uses — real production wiring passes the real `spawn`; tests inject a fake child process. */
export type SpawnLike = (command: string, args: readonly string[], options: { readonly detached: true; readonly stdio: 'ignore' }) => MinimalSpawnedProcess;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens `path` in the platform's default viewer. Never throws, never rejects — always resolves to a
 * typed {@link OpenHtmlReportResult}. See this module's own doc for the full mechanism, the
 * non-blocking/detached design, and the disclosed "spawned successfully" vs. "a human actually saw
 * it" limitation. `spawn` defaults to the real `node:child_process.spawn`; tests inject a fake.
 */
export function openHtmlReportWithViewer(
  path: string,
  platform: NodeJS.Platform = process.platform,
  spawn: SpawnLike = nodeSpawn as unknown as SpawnLike,
): Promise<OpenHtmlReportResult> {
  const { command, args } = viewerCommandFor(platform, path);
  return new Promise((resolve) => {
    let child: MinimalSpawnedProcess;
    try {
      child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ opened: false, reason: errorMessage(error) });
      return;
    }
    child.once('error', (error: Error) => resolve({ opened: false, reason: errorMessage(error) }));
    child.once('spawn', () => {
      child.unref();
      resolve({ opened: true });
    });
  });
}
