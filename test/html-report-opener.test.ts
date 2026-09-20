import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { openHtmlReportWithViewer, viewerCommandFor } from '../src/adapters/html-report-opener.js';

describe('viewerCommandFor: pure per-platform viewer command selection', () => {
  it('uses `open` on darwin', () => {
    expect(viewerCommandFor('darwin', '/tmp/report.html')).toEqual({ command: 'open', args: ['/tmp/report.html'] });
  });

  it('uses `xdg-open` on linux', () => {
    expect(viewerCommandFor('linux', '/tmp/report.html')).toEqual({ command: 'xdg-open', args: ['/tmp/report.html'] });
  });

  it('uses `explorer.exe` (no shell, no title-argument quoting quirk) on win32', () => {
    expect(viewerCommandFor('win32', 'C:\\reports\\report.html')).toEqual({ command: 'explorer.exe', args: ['C:\\reports\\report.html'] });
  });

  it('falls back to `xdg-open` for any other POSIX-like platform', () => {
    expect(viewerCommandFor('freebsd', '/tmp/report.html')).toEqual({ command: 'xdg-open', args: ['/tmp/report.html'] });
  });

  it('passes the exact path given, never a different file', () => {
    const hostile = '/tmp/some path with spaces & "quotes".html';
    expect(viewerCommandFor('darwin', hostile).args).toEqual([hostile]);
  });
});

interface FakeChildProcess extends EventEmitter {
  unref(): void;
}

function fakeChildProcess(): FakeChildProcess {
  const emitter = new EventEmitter() as FakeChildProcess;
  emitter.unref = vi.fn();
  return emitter;
}

describe('openHtmlReportWithViewer: launches the platform viewer, never blocks, never throws', () => {
  it('reports opened: true once the injected spawn function signals a successful spawn, and detaches the child (unref) so the CLI never waits for it', async () => {
    const child = fakeChildProcess();
    const spawnSpy = vi.fn(() => child);
    const resultPromise = openHtmlReportWithViewer('/tmp/report.html', 'darwin', spawnSpy);
    child.emit('spawn');
    const result = await resultPromise;
    expect(result).toEqual({ opened: true });
    expect(spawnSpy).toHaveBeenCalledWith('open', ['/tmp/report.html'], expect.objectContaining({ detached: true }));
    expect(child.unref).toHaveBeenCalled();
  });

  it('reports opened: false with a reason when the injected spawn function signals an error (e.g. no viewer installed — the common CI case)', async () => {
    const child = fakeChildProcess();
    const spawnSpy = vi.fn(() => child);
    const resultPromise = openHtmlReportWithViewer('/tmp/report.html', 'linux', spawnSpy);
    child.emit('error', new Error('spawn xdg-open ENOENT'));
    const result = await resultPromise;
    expect(result).toEqual({ opened: false, reason: 'spawn xdg-open ENOENT' });
  });

  it('reports opened: false, never throws, when the injected spawn function itself throws synchronously', async () => {
    const spawnSpy = vi.fn(() => {
      throw new Error('synchronous spawn failure');
    });
    const result = await openHtmlReportWithViewer('/tmp/report.html', 'darwin', spawnSpy);
    expect(result).toEqual({ opened: false, reason: 'synchronous spawn failure' });
  });

  it('never rejects — always resolves to a typed result, so a failed open can never change the CLI exit status', async () => {
    const child = fakeChildProcess();
    const spawnSpy = vi.fn(() => child);
    const resultPromise = openHtmlReportWithViewer('/tmp/report.html', 'linux', spawnSpy);
    child.emit('error', new Error('boom'));
    await expect(resultPromise).resolves.not.toThrow();
  });
});
