import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  bin: string | Record<string, string>;
  types?: string;
  exports?: {
    '.': {
      types: string;
      import: string;
    };
  };
}

interface InstalledBinInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

function installedBinInvocation(
  binPath: string,
  args: readonly string[],
  platform = process.platform,
): InstalledBinInvocation {
  if (platform === 'win32') {
    const quote = (value: string): string => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', [binPath, ...args].map(quote).join(' ')],
    };
  }
  return { command: binPath, args: [...args] };
}

function execInstalledBin(binPath: string, args: readonly string[], cwd: string): string {
  const invocation = installedBinInvocation(binPath, args);
  return execFileSync(invocation.command, [...invocation.args], { cwd, encoding: 'utf8' });
}

function installedBinStatus(binPath: string, args: readonly string[], cwd: string): number | null {
  const invocation = installedBinInvocation(binPath, args);
  return spawnSync(invocation.command, [...invocation.args], { cwd, encoding: 'utf8' }).status;
}

function installedBinRun(binPath: string, args: readonly string[], cwd: string): { readonly status: number | null; readonly stdout: string } {
  const invocation = installedBinInvocation(binPath, args);
  const result = spawnSync(invocation.command, [...invocation.args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function readManifest(path = join(process.cwd(), 'package.json')): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
}

describe('package metadata', () => {
  it('publishes the ESM root API and declaration entry without changing the CLI bin', async () => {
    const manifest = await readManifest();

    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    });
    expect(manifest.bin).toEqual({ 'jev-test-auditor': 'dist/cli/index.js' });
  });

  it('uses cmd.exe without a shell for Windows .cmd bin scripts', () => {
    expect(installedBinInvocation('C:\\consumer\\node_modules\\.bin\\jev-test-auditor.cmd', ['--help'], 'win32'))
      .toEqual({
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', '"C:\\consumer\\node_modules\\.bin\\jev-test-auditor.cmd" "--help"'],
      });
    expect(installedBinInvocation('/tmp/consumer/node_modules/.bin/jev-test-auditor', ['audit'], 'linux'))
      .toEqual({ command: '/tmp/consumer/node_modules/.bin/jev-test-auditor', args: ['audit'] });
  });
});

describe('packed installed package', () => {
  it('runs the real packed API and binary against a fixture without executing source', async () => {
    execFileSync(npmCommand(), ['run', 'build'], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'jev-test-auditor-packed-'));
    const consumerRoot = join(temporaryRoot, 'consumer');
    const fixtureRoot = join(consumerRoot, 'fixture');
    try {
      const tarballName = execFileSync(npmCommand(), ['pack', '--silent', '--pack-destination', temporaryRoot], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim();
      await mkdir(consumerRoot, { recursive: true });
      execFileSync(npmCommand(), ['init', '-y'], { cwd: consumerRoot, stdio: 'pipe' });
      execFileSync(npmCommand(), [
        'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temporaryRoot, tarballName),
      ], { cwd: consumerRoot, stdio: 'pipe' });

      const installedRoot = join(consumerRoot, 'node_modules', 'jev-test-auditor');
      const installedManifest = await readManifest(join(installedRoot, 'package.json'));
      await expect(access(join(installedRoot, 'dist', 'index.js'))).resolves.toBeUndefined();
      await expect(access(join(installedRoot, 'dist', 'index.d.ts'))).resolves.toBeUndefined();
      expect(installedManifest.exports).toEqual({
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      });
      expect(installedManifest.bin).toEqual({ 'jev-test-auditor': 'dist/cli/index.js' });

      const apiSmoke = execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        "import('jev-test-auditor').then(({ discoverTestFiles, extractTestCases }) => { if (typeof discoverTestFiles !== 'function' || typeof extractTestCases !== 'function') process.exit(1); console.log('api-ok'); })",
      ], { cwd: consumerRoot, encoding: 'utf8' });
      expect(apiSmoke.trim()).toBe('api-ok');

      await mkdir(fixtureRoot, { recursive: true });
      // `shared.ts` is a production module reached only through the helper
      // (basename contains "helper"), exercising evidence resolution's
      // hop-1 (helper) -> hop-2 (production-seam) expansion through the
      // packed, installed build.
      await writeFile(join(fixtureRoot, 'shared.ts'), 'export function add(a, b) {\n  return a + b;\n}\n');
      await writeFile(
        join(fixtureRoot, 'shared.helper.ts'),
        "import { add } from './shared.js';\nexport function helperAdd(a, b) {\n  return add(a, b);\n}\n",
      );
      await writeFile(
        join(fixtureRoot, 'packed.test.ts'),
        "import { expect, test } from 'vitest';\nimport { helperAdd } from './shared.helper.js';\ntest('packed', () => { expect(helperAdd(1, 2)).toBe(3); });",
      );
      await writeFile(join(fixtureRoot, 'broken.test.ts'), 'const = ;');
      await writeFile(join(fixtureRoot, 'canary.spec.ts'), "import { writeFileSync } from 'node:fs'; writeFileSync('executed.marker', 'bad');");

      const binPath = join(
        consumerRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'jev-test-auditor.cmd' : 'jev-test-auditor',
      );
      const help = execInstalledBin(binPath, ['--help'], fixtureRoot);
      expect(help).toContain('Usage:');
      expect(help).toContain('--inspect-payloads');

      const output = execInstalledBin(binPath, ['audit'], fixtureRoot);
      const lines = output.trim().split(/\r?\n/u);
      interface Summary {
        readonly reportingOnly: boolean;
        readonly files: readonly {
          readonly path: string;
          readonly framework: string;
          readonly testCaseCount: number;
          readonly dynamicMetadataCount: number;
          readonly evidenceBundleCount: number;
        }[];
        readonly totals: {
          readonly files: number;
          readonly testCases: number;
          readonly diagnostics: number;
          readonly evidenceBundles: number;
          readonly evidenceFragments: number;
          readonly evidenceTruncatedFragments: number;
          readonly evidenceOmitted: number;
          readonly evidenceDenied: number;
          readonly evidenceUnresolved: number;
        };
      }
      const summary = JSON.parse(lines[0] ?? '') as Summary;
      expect(lines).toHaveLength(1);
      expect(summary.reportingOnly).toBe(true);
      expect(summary.files).toEqual([
        { path: 'broken.test.ts', framework: 'unknown', testCaseCount: 0, dynamicMetadataCount: 0, evidenceBundleCount: 0 },
        { path: 'canary.spec.ts', framework: 'unknown', testCaseCount: 0, dynamicMetadataCount: 0, evidenceBundleCount: 0 },
        { path: 'packed.test.ts', framework: 'vitest', testCaseCount: 1, dynamicMetadataCount: 0, evidenceBundleCount: 1 },
      ]);
      expect(summary.totals).toMatchObject({
        files: 3,
        testCases: 1,
        diagnostics: 1,
        evidenceBundles: 1,
        evidenceDenied: 0,
      });
      expect(summary.totals.evidenceFragments).toBeGreaterThanOrEqual(2); // at least the test body and the resolved `add` production seam
      expect(installedBinStatus(binPath, ['invalid'], fixtureRoot)).toBe(1);
      await expect(access(join(fixtureRoot, 'executed.marker'))).rejects.toThrow();

      const inspectOutput = execInstalledBin(binPath, ['audit', '--inspect-payloads'], fixtureRoot);
      const inspectLines = inspectOutput.trim().split(/\r?\n/u);
      const inspectSummary = JSON.parse(inspectLines[0] ?? '') as Summary;
      expect(inspectSummary.totals.evidenceBundles).toBe(1);
      // Exactly one bundle line, following the summary line, for the one test case packed.test.ts contains.
      expect(inspectLines).toHaveLength(1 + inspectSummary.totals.evidenceBundles);

      interface BundleLine {
        readonly version: 1;
        readonly testCaseId: string;
        readonly budget: { readonly maxFragmentBytes: number; readonly maxBundleBytes: number };
        readonly totals: { readonly fragments: number; readonly includedBytes: number; readonly truncatedFragments: number };
        readonly fragments: readonly {
          readonly kind: string;
          readonly repositoryRelativePath: string;
          readonly content: string;
          readonly contentHash: string;
          readonly selectionReason: string;
          readonly truncation: { readonly truncated: boolean; readonly originalBytes: number; readonly includedBytes: number };
        }[];
        readonly denied: readonly unknown[];
        readonly unresolved: readonly { readonly specifier: string; readonly reason: string }[];
        readonly omitted: readonly unknown[];
      }
      const bundle = JSON.parse(inspectLines[1] ?? '') as BundleLine;
      expect(bundle.version).toBe(1);
      expect(bundle.testCaseId).toMatch(/^tc:v1:/u);
      expect(bundle.fragments.map((fragment) => fragment.kind).sort()).toEqual(['helper', 'production-seam', 'test']);
      expect(bundle.fragments.find((fragment) => fragment.kind === 'production-seam')?.repositoryRelativePath).toBe('shared.ts');
      expect(bundle.fragments.find((fragment) => fragment.kind === 'helper')?.repositoryRelativePath).toBe('shared.helper.ts');
      expect(bundle.unresolved).toEqual([{ specifier: 'vitest', reason: 'bare-specifier' }]);
      expect(bundle.denied).toEqual([]);
      await expect(access(join(fixtureRoot, 'executed.marker'))).rejects.toThrow();

      // `--dry-run --json` on the same fixture: packed.test.ts contributes the only
      // discovered/evaluable test case (broken.test.ts and canary.spec.ts extract no
      // test cases at all), so counts are exact; `evidenceBytes` is cross-checked
      // exactly against the canonical bundle line captured above rather than
      // hand-duplicating evidence resolution/selection in this test.
      const dryRunOutput = execInstalledBin(binPath, ['audit', '--dry-run', '--json'], fixtureRoot);
      const dryRunLines = dryRunOutput.trim().split(/\r?\n/u);
      expect(dryRunLines).toHaveLength(1);

      interface DryRunSummary {
        readonly dryRun: true;
        readonly reportingOnly: true;
        readonly model: string;
        readonly snapshotVersion: number;
        readonly asOf: string;
        readonly discovered: number;
        readonly evaluable: number;
        readonly skipped: { readonly total: number; readonly byReason: Record<string, number> };
        readonly initialCalls: number;
        readonly followUpCalls: { readonly min: number; readonly max: number };
        readonly evidenceBytes: number;
        readonly estimatedInputTokens: { readonly min: number; readonly max: number };
        readonly estimatedFollowUpInputTokens: { readonly min: number; readonly max: number };
        readonly estimatedUsd: { readonly min: number; readonly max: number };
        readonly bundlesOverCeiling: number;
        readonly requestTokenCeiling: number;
        readonly networkCalls: number;
        readonly filesWritten: number;
      }
      const dryRunSummary = JSON.parse(dryRunLines[0] ?? '') as DryRunSummary;
      expect(dryRunSummary.dryRun).toBe(true);
      expect(dryRunSummary.reportingOnly).toBe(true);
      expect(dryRunSummary.discovered).toBe(1);
      expect(dryRunSummary.evaluable).toBe(1);
      expect(dryRunSummary.skipped).toEqual({ total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } });
      expect(dryRunSummary.initialCalls).toBe(1);
      expect(dryRunSummary.followUpCalls).toEqual({ min: 0, max: 1 });
      expect(dryRunSummary.bundlesOverCeiling).toBe(0);
      expect(dryRunSummary.networkCalls).toBe(0);
      expect(dryRunSummary.filesWritten).toBe(0);
      expect(dryRunSummary.evidenceBytes).toBe(Buffer.byteLength(inspectLines[1] ?? '', 'utf8'));
      expect(dryRunSummary.estimatedInputTokens.min).toBeLessThanOrEqual(dryRunSummary.estimatedInputTokens.max);
      expect(dryRunSummary.estimatedUsd.min).toBeGreaterThan(0);
      expect(dryRunSummary.estimatedUsd.min).toBeLessThanOrEqual(dryRunSummary.estimatedUsd.max);

      // Flag-combination usage errors: --json without --dry-run/--evaluate, --dry-run with --inspect-payloads,
      // --dry-run with --evaluate, and --evaluate with --inspect-payloads.
      expect(installedBinStatus(binPath, ['audit', '--json'], fixtureRoot)).toBe(1);
      expect(installedBinStatus(binPath, ['audit', '--dry-run', '--inspect-payloads'], fixtureRoot)).toBe(1);
      expect(installedBinStatus(binPath, ['audit', '--dry-run', '--evaluate'], fixtureRoot)).toBe(1);
      expect(installedBinStatus(binPath, ['audit', '--evaluate', '--inspect-payloads'], fixtureRoot)).toBe(1);
      await expect(access(join(fixtureRoot, 'executed.marker'))).rejects.toThrow();

      // Offline default and --evaluate's key requirement, run through the installed binary itself
      // (Phase 4, task P4-4). TYPESAFE_API_KEY is deleted from THIS process before spawning so the
      // child, which inherits process.env by default, never sees a real key — a missed delete here
      // would risk a real billed network call from this suite.
      const savedKey = process.env['TYPESAFE_API_KEY'];
      delete process.env['TYPESAFE_API_KEY'];
      try {
        const plainAudit = execInstalledBin(binPath, ['audit'], fixtureRoot);
        expect(JSON.parse(plainAudit.trim().split(/\r?\n/u)[0] ?? '')).toMatchObject({ reportingOnly: true });

        const evaluateWithoutKey = installedBinRun(binPath, ['audit', '--evaluate'], fixtureRoot);
        expect(evaluateWithoutKey.status).toBe(1);
        expect(evaluateWithoutKey.stdout).toContain('--evaluate');
        expect(evaluateWithoutKey.stdout).toContain('TYPESAFE_API_KEY');

        const evaluateJsonWithoutKey = installedBinRun(binPath, ['audit', '--evaluate', '--json'], fixtureRoot);
        expect(evaluateJsonWithoutKey.status).toBe(1);
        expect(evaluateJsonWithoutKey.stdout).toContain('TYPESAFE_API_KEY');
      } finally {
        if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY']; else process.env['TYPESAFE_API_KEY'] = savedKey;
      }
      await expect(access(join(fixtureRoot, 'executed.marker'))).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
