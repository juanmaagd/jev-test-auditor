#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getResolvedConfiguration } from '../application/configure.js';

export interface CliIo {
  writeLine(message: string): void;
}

const HELP = `jev-test-auditor — inspect semantic test quality

Usage:
  jev-test-auditor audit [options]
  jev-test-auditor --help

Commands:
  audit       Resolve the workspace configuration (execution arrives in a later phase)

Options:
  --help      Show this help message
`;

export function runCli(args: readonly string[], io: CliIo): number {
  if (args.includes('--help') || args.length === 0) {
    io.writeLine(HELP);
    return 0;
  }

  if (args[0] === 'audit') {
    io.writeLine(JSON.stringify(getResolvedConfiguration()));
    return 0;
  }

  io.writeLine(`Unknown command: ${args[0] ?? ''}`);
  return 1;
}

function isInvokedAsPackageEntry(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;

  try {
    return realpathSync(invokedPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isInvokedAsPackageEntry()) {
  const exitCode = runCli(process.argv.slice(2), { writeLine: console.log });
  process.exitCode = exitCode;
}
