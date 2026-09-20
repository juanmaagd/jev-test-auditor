/**
 * Interactive TypeSafe API key prompt (Phase 4, task P4-5) for `auth login`.
 *
 * When stdin is a TTY, reads with echo disabled (raw mode, no per-character
 * write-back) so the key is never displayed as it is typed, and restores
 * the terminal's previous raw-mode state on every exit path — success,
 * Ctrl+C, end of stream, or a stream error — so a crash or cancellation
 * never leaves the shell unusable.
 *
 * When stdin is not a TTY (piped/redirected input, CI, tests), reads one
 * trimmed line instead, so automation can still supply a key without ever
 * passing it as a CLI argument (`--help` documents this).
 *
 * The only inputs are the injected (or, by default, real `process.stdin`/
 * `process.stdout`) streams — a key is never read from `process.argv`.
 */
import { AuthPromptCancelledError } from '../domain/auth.js';

const CTRL_C = '';
const BACKSPACE = '';
const BACKSPACE_ALT = '\b';

/**
 * The narrow slice of a readable stream this module needs, deliberately not
 * the full `NodeJS.ReadableStream` shape — so a test fake can be a plain
 * object (or a real `PassThrough`) implementing just these members instead
 * of a full TTY stream.
 */
export interface AuthPromptReadable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  resume?(): void;
  pause?(): void;
  setEncoding?(encoding: 'utf8'): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): void;
  removeListener(event: 'end', listener: () => void): void;
  removeListener(event: 'error', listener: (error: unknown) => void): void;
}

export interface AuthPromptWritable {
  write(chunk: string): void;
}

export interface AuthPromptStreams {
  readonly stdin: AuthPromptReadable;
  readonly stdout: AuthPromptWritable;
}

function defaultStreams(): AuthPromptStreams {
  return { stdin: process.stdin, stdout: process.stdout };
}

/**
 * Reads one line from `stdin`. When `hideInput` is true (a real TTY),
 * suppresses echo entirely (no character is ever written back), supports
 * backspace, and treats Ctrl+C as cancellation rather than a literal
 * character. When false, every character (including control characters
 * other than the terminating newline) is taken literally — appropriate for
 * a non-interactive pipe, never a real keyboard.
 */
function readLine(stdin: AuthPromptReadable, stdout: AuthPromptWritable, hideInput: boolean): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    let settled = false;
    const wasRaw = stdin.isRaw ?? false;

    function cleanupAnd(action: () => void): void {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      if (hideInput) {
        try {
          stdin.setRawMode?.(wasRaw);
        } catch {
          // Best-effort restore: a stream that no longer supports raw mode
          // (already closed, torn down) must not turn a resolved read into
          // a crash.
        }
      }
      stdin.pause?.();
      action();
    }

    function onData(chunk: Buffer | string): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        if (hideInput && char === CTRL_C) {
          cleanupAnd(() => {
            stdout.write('\n');
            rejectPromise(new AuthPromptCancelledError());
          });
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanupAnd(() => {
            if (hideInput) stdout.write('\n');
            resolvePromise(buffer.trim());
          });
          return;
        }
        if (hideInput && (char === BACKSPACE || char === BACKSPACE_ALT)) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    }

    function onEnd(): void {
      cleanupAnd(() => resolvePromise(buffer.trim()));
    }

    function onError(error: unknown): void {
      cleanupAnd(() => rejectPromise(error));
    }

    if (hideInput) stdin.setRawMode?.(true);
    stdin.setEncoding?.('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume?.();
  });
}

/**
 * Reads the API key once. Hides input (no echo, Ctrl+C cancels cleanly)
 * only when `stdin` is a real TTY that supports raw mode; otherwise reads
 * one trimmed line, so piped/redirected input (automation, CI, tests) works
 * without ever needing a hidden-input terminal.
 */
export async function readApiKeyFromPrompt(streams: AuthPromptStreams = defaultStreams()): Promise<string> {
  const { stdin, stdout } = streams;
  const hideInput = stdin.isTTY === true && typeof stdin.setRawMode === 'function';
  return readLine(stdin, stdout, hideInput);
}
