import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';

function captureOutput(): { io: CliIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { writeLine: (line) => lines.push(line) }, lines };
}

describe('CLI foundation', () => {
  it('prints help from the public CLI seam', () => {
    const output = captureOutput();

    const exitCode = runCli(['--help'], output.io);

    expect(exitCode).toBe(0);
    expect(output.lines[0]).toContain('Usage:');
  });

  it('exposes resolved defaults through audit output', () => {
    const output = captureOutput();

    const exitCode = runCli(['audit'], output.io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.lines[0] ?? '')).toMatchObject({
      concurrency: 4,
      reportingOnly: true,
    });
  });
});
