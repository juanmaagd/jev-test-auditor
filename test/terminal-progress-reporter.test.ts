import { describe, expect, it } from 'vitest';
import { createTerminalProgressReporter } from '../src/adapters/terminal-progress-reporter.js';
import type { AuditPrePhaseEvent, AuditProgressEvent, AuditProgressState, AuditStoreWorkItemIdentity } from '../src/domain/audit.js';

function identity(overrides: Partial<AuditStoreWorkItemIdentity> = {}): AuditStoreWorkItemIdentity {
  return { testCaseId: 'tc:v1:example', repositoryRelativePath: 'a.test.ts', name: 'example', ...overrides } as AuditStoreWorkItemIdentity;
}

function event(state: AuditProgressState, overrides: Partial<AuditProgressEvent> = {}): AuditProgressEvent {
  return { state, identity: identity(), concurrencyLimit: 4, ...overrides };
}

function recordingWriter(): { readonly write: (chunk: string) => void; readonly chunks: string[] } {
  const chunks: string[] = [];
  return { write: (chunk: string) => { chunks.push(chunk); }, chunks };
}

describe('terminal progress reporter (Phase 6, task P6-3)', () => {
  describe('interactive terminal (isTTY: true)', () => {
    it('redraws a single carriage-return-terminated line for a non-terminal transition, never a newline', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: true });

      reporter.begin(2);
      reporter.report(event('pending'));
      reporter.report(event('running'));

      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.startsWith('\r')).toBe(true);
        expect(chunk.endsWith('\n')).toBe(false);
      }
    });

    it('terminates the final line with a newline exactly when the last item reaches a terminal state, never before', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: true });

      reporter.begin(2);
      reporter.report(event('completed', { identity: identity({ testCaseId: 'tc:v1:a' }) }));
      expect(chunks[chunks.length - 1]!.endsWith('\n')).toBe(false); // one item still outstanding

      reporter.report(event('completed', { identity: identity({ testCaseId: 'tc:v1:b' }) }));
      expect(chunks[chunks.length - 1]!.endsWith('\n')).toBe(true); // both done — the run is over
    });

    it('writes nothing at all when begin(0) is called — nothing to report', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: true });

      reporter.begin(0);

      expect(chunks).toEqual([]);
    });
  });

  describe('non-interactive output (isTTY: false — a pipe, a CI log, a file)', () => {
    it('writes one opening line naming the total when begin(total) is called with a positive total', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.begin(3);

      expect(chunks).toEqual(['Evaluating 3 test case(s)...\n']);
    });

    it('writes nothing at all for begin(0) — no lingering "evaluating 0" line', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.begin(0);

      expect(chunks).toEqual([]);
    });

    it('never writes a line for a non-terminal transition (pending/running) — only terminal transitions produce output', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.begin(1);
      chunks.length = 0; // discard the opening line — this test is about per-transition output only
      reporter.report(event('pending'));
      reporter.report(event('running'));

      expect(chunks).toEqual([]);
    });

    it('writes exactly one newline-terminated line per terminal transition, naming the state and the item', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.begin(1);
      chunks.length = 0;
      reporter.report(event('completed', { identity: identity({ repositoryRelativePath: 'sum.test.ts', name: 'adds two numbers' }) }));

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.endsWith('\n')).toBe(true);
      expect(chunks[0]).toContain('completed');
      expect(chunks[0]).toContain('sum.test.ts');
      expect(chunks[0]).toContain('adds two numbers');
    });

    it('distinguishes a cache hit from a fresh completion in both the state word and the running cached/fresh counts', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.begin(2);
      chunks.length = 0;
      reporter.report(event('completed', { identity: identity({ testCaseId: 'tc:v1:fresh-one' }) }));
      reporter.report(event('cached', { identity: identity({ testCaseId: 'tc:v1:cached-one' }) }));

      expect(chunks[0]).toContain('completed');
      expect(chunks[0]).toContain('fresh 1');
      expect(chunks[0]).toContain('cached 0');
      expect(chunks[1]).toContain('cached');
      expect(chunks[1]).toContain('fresh 1');
      expect(chunks[1]).toContain('cached 1');
    });

    it('shows fresh, cached, failed, and skipped as four independently tracked counts across a full run', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.begin(4);
      chunks.length = 0;
      reporter.report(event('completed', { identity: identity({ testCaseId: 'tc:v1:one' }) }));
      reporter.report(event('cached', { identity: identity({ testCaseId: 'tc:v1:two' }) }));
      reporter.report(event('failed', { identity: identity({ testCaseId: 'tc:v1:three' }) }));
      reporter.report(event('skipped', { identity: identity({ testCaseId: 'tc:v1:four' }) }));

      const lastLine = chunks[chunks.length - 1]!;
      expect(lastLine).toContain('4/4 done');
      expect(lastLine).toContain('fresh 1');
      expect(lastLine).toContain('cached 1');
      expect(lastLine).toContain('failed 1');
      expect(lastLine).toContain('skipped 1');
    });

    it('strips embedded carriage returns and newlines from a hostile test name, so one transition is still exactly one output line', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.begin(1);
      chunks.length = 0;
      reporter.report(event('completed', { identity: identity({ name: 'evil\r\nname\ninjection' }) }));

      expect(chunks).toHaveLength(1);
      const line = chunks[0]!;
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toMatch(/[\r\n]/); // no embedded CR/LF anywhere except the single trailing newline
    });
  });
});

describe('pre-dispatch phase rendering (T3, odd/tasks/audit-run-responsiveness.md)', () => {
  describe('interactive terminal (isTTY: true)', () => {
    it('redraws a single carriage-return-terminated line for a phase event, never a newline', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: true });

      reporter.phase!({ phase: 'discovering' });
      reporter.phase!({ phase: 'extracting', done: 3, total: 10, testCases: 12 });

      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.startsWith('\r')).toBe(true);
        expect(chunk.endsWith('\n')).toBe(false);
      }
    });

    it('closes an open phase redraw with a trailing newline once begin(0) is called — otherwise a run with nothing to evaluate leaves the cursor stranded mid-line forever', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: true });

      reporter.phase!({ phase: 'discovering' });
      expect(chunks[chunks.length - 1]!.endsWith('\n')).toBe(false);

      reporter.begin(0); // nothing evaluable/skippable — report() will never fire to close the line itself

      expect(chunks[chunks.length - 1]).toBe('\n');
    });

    it('closes an open phase redraw with a trailing newline before a positive begin(total) too, so the phase line and the dispatch line never run together', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: true });

      reporter.phase!({ phase: 'extracting', done: 1, total: 1, testCases: 1 });
      const phaseChunkCount = chunks.length;
      reporter.begin(2);

      expect(chunks.length).toBeGreaterThan(phaseChunkCount);
      expect(chunks[phaseChunkCount]).toBe('\n');
    });

    it('never writes a closing newline from begin() when no phase line was ever open — unchanged from before this task', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: true });

      reporter.begin(0);

      expect(chunks).toEqual([]); // exactly the pre-existing "writes nothing at all when begin(0) is called" behavior
    });

    it(
      'pads a shorter phase redraw to the width of the longest one seen so far, so a short line (e.g. "Checking cache...") '
      + 'after a long one (e.g. a large "Extracting..." line) never leaves that longer line\'s trailing characters on screen — '
      + '\\r returns to column 0 but never erases, so an unpadded shorter write leaves stale characters visible',
      () => {
        const { write, chunks } = recordingWriter();
        const reporter = createTerminalProgressReporter({ write, isTTY: true });

        reporter.phase!({ phase: 'extracting', done: 100, total: 100, testCases: 7260 });
        const longLineLength = chunks[chunks.length - 1]!.length - 1; // minus the leading \r
        reporter.phase!({ phase: 'checking-cache' });
        const shortChunk = chunks[chunks.length - 1]!;

        expect(shortChunk.length - 1).toBeGreaterThanOrEqual(longLineLength); // padded, not left short
        expect(shortChunk.slice(1).trimEnd()).toBe('Checking cache...'); // the visible text itself is unchanged, only trailing padding was added
      },
    );
  });

  describe('non-interactive output (isTTY: false — a pipe, a CI log, a file)', () => {
    it('writes one newline-terminated line per phase call — never a bare carriage return', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.phase!({ phase: 'discovering' });
      reporter.phase!({ phase: 'extracting', done: 3, total: 10, testCases: 12 });
      reporter.phase!({ phase: 'checking-cache' });

      expect(chunks).toHaveLength(3);
      for (const chunk of chunks) {
        expect(chunk.endsWith('\n')).toBe(true);
        expect(chunk.slice(0, -1)).not.toMatch(/[\r\n]/);
      }
    });

    it('names the phase and its known counts in the line', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.phase!({ phase: 'extracting', done: 3, total: 10, testCases: 12 } satisfies AuditPrePhaseEvent);

      expect(chunks[0]).toContain('3');
      expect(chunks[0]).toContain('10');
      expect(chunks[0]).toContain('12');
    });

    it('begin() is unaffected by a prior phase call — still writes exactly its own opening/nothing line, no extra newline from the phase tracking TTY uses', () => {
      const { write, chunks } = recordingWriter();
      const reporter = createTerminalProgressReporter({ write, isTTY: false });

      reporter.phase!({ phase: 'discovering' });
      chunks.length = 0;
      reporter.begin(3);

      expect(chunks).toEqual(['Evaluating 3 test case(s)...\n']);
    });
  });
});
