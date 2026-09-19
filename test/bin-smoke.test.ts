import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  bin: string | Record<string, string>;
}

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest;
}

describe('installed package binary', () => {
  it('runs help through the package bin symlink', async () => {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    const manifest = await readManifest();
    const [binName, binTarget] = typeof manifest.bin === 'string'
      ? ['jev-test-auditor', manifest.bin]
      : Object.entries(manifest.bin)[0] ?? [];
    if (!binName || !binTarget) throw new Error('Package manifest does not define a binary.');

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'jev-test-auditor-bin-'));
    const binPath = join(temporaryRoot, 'node_modules', '.bin', binName);
    try {
      await mkdir(dirname(binPath), { recursive: true });
      await symlink(join(process.cwd(), binTarget), binPath);

      const help = execFileSync(process.execPath, [binPath, '--help'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });

      expect(help).toContain('Usage:');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
