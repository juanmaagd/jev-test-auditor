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
      await writeFile(join(fixtureRoot, 'packed.test.ts'), "import { test } from 'vitest'; test('packed', () => {});");
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

      const output = execInstalledBin(binPath, ['audit'], fixtureRoot);
      const lines = output.trim().split(/\r?\n/u);
      const summary = JSON.parse(lines[0] ?? '') as {
        readonly reportingOnly: boolean;
        readonly files: readonly { readonly path: string; readonly framework: string; readonly testCaseCount: number; readonly dynamicMetadataCount: number }[];
        readonly totals: { readonly files: number; readonly testCases: number; readonly diagnostics: number };
      };
      expect(lines).toHaveLength(1);
      expect(summary.reportingOnly).toBe(true);
      expect(summary.files).toEqual([
        { path: 'broken.test.ts', framework: 'unknown', testCaseCount: 0, dynamicMetadataCount: 0 },
        { path: 'canary.spec.ts', framework: 'unknown', testCaseCount: 0, dynamicMetadataCount: 0 },
        { path: 'packed.test.ts', framework: 'vitest', testCaseCount: 1, dynamicMetadataCount: 0 },
      ]);
      expect(summary.totals).toMatchObject({ files: 3, testCases: 1, diagnostics: 1 });
      expect(installedBinStatus(binPath, ['invalid'], fixtureRoot)).toBe(1);
      await expect(access(join(fixtureRoot, 'executed.marker'))).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
