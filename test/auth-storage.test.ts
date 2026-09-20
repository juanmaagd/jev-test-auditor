import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthBlankKeyError,
  AuthCorruptCredentialsError,
  AuthInsecurePermissionsError,
  AuthPromptCancelledError,
  resolveApiKey,
  type StoredCredentials,
} from '../src/domain/auth.js';
import {
  deleteStoredCredentials,
  readStoredCredentials,
  resolveAuthStoragePaths,
  statStoredCredentialsFile,
  writeStoredCredentials,
  type AuthStorageFsOps,
  type AuthStoragePaths,
} from '../src/adapters/auth-storage.js';
import { readApiKeyFromPrompt, type AuthPromptReadable } from '../src/adapters/auth-prompt.js';

const CANARY_SECRET = 'sk-canary-topsecret-9999';

// #region resolveApiKey (pure precedence policy)

describe('resolveApiKey precedence policy', () => {
  it('prefers a non-blank environment key over a stored one', () => {
    const stored: StoredCredentials = { version: 1, apiKey: 'stored-key' };

    expect(resolveApiKey({ environmentApiKey: 'env-key', stored })).toEqual({ apiKey: 'env-key', source: 'environment' });
  });

  it('mutation probe target: falls back to the stored key only when the environment key is unset (never the reverse precedence)', () => {
    const stored: StoredCredentials = { version: 1, apiKey: 'stored-key' };

    expect(resolveApiKey({ environmentApiKey: undefined, stored })).toEqual({ apiKey: 'stored-key', source: 'stored' });
  });

  it('falls back to the stored key when the environment key is blank or whitespace-only', () => {
    const stored: StoredCredentials = { version: 1, apiKey: 'stored-key' };

    expect(resolveApiKey({ environmentApiKey: '   ', stored })).toEqual({ apiKey: 'stored-key', source: 'stored' });
  });

  it('ignores a stored key that is blank or whitespace-only', () => {
    const stored: StoredCredentials = { version: 1, apiKey: '   ' };

    expect(resolveApiKey({ environmentApiKey: undefined, stored })).toBeUndefined();
  });

  it('returns undefined when neither an environment key nor a stored key is available', () => {
    expect(resolveApiKey({ environmentApiKey: undefined, stored: undefined })).toBeUndefined();
  });

  it('trims whitespace around a resolved key', () => {
    expect(resolveApiKey({ environmentApiKey: '  env-key  ', stored: undefined })).toEqual({ apiKey: 'env-key', source: 'environment' });
  });
});

// #endregion

// #region resolveAuthStoragePaths

describe('resolveAuthStoragePaths', () => {
  it('uses XDG_CONFIG_HOME on POSIX when set', () => {
    const paths = resolveAuthStoragePaths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/custom/config' }, homedir: '/home/user' });

    expect(paths.configDir).toBe(join('/custom/config', 'jev-test-auditor'));
    expect(paths.credentialsFile).toBe(join('/custom/config', 'jev-test-auditor', 'credentials.json'));
  });

  it('falls back to ~/.config on POSIX when XDG_CONFIG_HOME is unset', () => {
    const paths = resolveAuthStoragePaths({ platform: 'darwin', env: {}, homedir: '/home/user' });

    expect(paths.configDir).toBe(join('/home/user', '.config', 'jev-test-auditor'));
  });

  it('uses APPDATA on Windows when set', () => {
    const paths = resolveAuthStoragePaths({ platform: 'win32', env: { APPDATA: 'C:\\Users\\user\\AppData\\Roaming' }, homedir: 'C:\\Users\\user' });

    expect(paths.configDir).toBe(join('C:\\Users\\user\\AppData\\Roaming', 'jev-test-auditor'));
  });

  it('falls back to homedir/AppData/Roaming on Windows when APPDATA is unset', () => {
    const paths = resolveAuthStoragePaths({ platform: 'win32', env: {}, homedir: 'C:\\Users\\user' });

    expect(paths.configDir).toBe(join('C:\\Users\\user', 'AppData', 'Roaming', 'jev-test-auditor'));
  });
});

// #endregion

// #region on-disk storage (real temp directories only — never the real home directory)

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempPaths(): Promise<AuthStoragePaths> {
  const root = await mkdtemp(join(tmpdir(), 'jev-auth-storage-'));
  temporaryRoots.push(root);
  const configDir = join(root, 'jev-test-auditor');
  return { configDir, credentialsFile: join(configDir, 'credentials.json') };
}

describe('writeStoredCredentials / readStoredCredentials round trip (real temp directory)', () => {
  it.skipIf(process.platform === 'win32')('creates the config directory with mode 0700 and the file with mode 0600', async () => {
    const paths = await tempPaths();

    await writeStoredCredentials(paths, CANARY_SECRET);

    const dirStat = await stat(paths.configDir);
    const fileStat = await stat(paths.credentialsFile);
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it('round-trips a stored API key', async () => {
    const paths = await tempPaths();

    await writeStoredCredentials(paths, CANARY_SECRET);

    await expect(readStoredCredentials(paths)).resolves.toEqual({ version: 1, apiKey: CANARY_SECRET });
  });

  it('returns undefined when no file exists at all (never logged in)', async () => {
    const paths = await tempPaths();

    await expect(readStoredCredentials(paths)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('refuses to read a file with permissions more permissive than owner-only', async () => {
    const paths = await tempPaths();
    await writeStoredCredentials(paths, CANARY_SECRET);
    await chmod(paths.credentialsFile, 0o644);

    await expect(readStoredCredentials(paths)).rejects.toBeInstanceOf(AuthInsecurePermissionsError);
  });

  it.skipIf(process.platform === 'win32')('mutation probe target: never falls back to reading an over-permissive file anyway', async () => {
    const paths = await tempPaths();
    await writeStoredCredentials(paths, CANARY_SECRET);
    await chmod(paths.credentialsFile, 0o666);

    await expect(readStoredCredentials(paths)).rejects.toThrow(/permissive|permission/iu);
  });

  it('treats corrupt JSON as a typed error, never a crash or a silently empty key', async () => {
    const paths = await tempPaths();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.credentialsFile, 'not valid json {{{', { mode: 0o600 });

    await expect(readStoredCredentials(paths)).rejects.toBeInstanceOf(AuthCorruptCredentialsError);
  });

  it('treats a file with the wrong shape (missing apiKey) as corrupt', async () => {
    const paths = await tempPaths();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.credentialsFile, JSON.stringify({ version: 1 }), { mode: 0o600 });

    await expect(readStoredCredentials(paths)).rejects.toBeInstanceOf(AuthCorruptCredentialsError);
  });

  it.skipIf(process.platform === 'win32')('overwriting an existing (weakly permissioned) file ends with mode 0600', async () => {
    const paths = await tempPaths();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.credentialsFile, JSON.stringify({ version: 1, apiKey: 'old-key' }), { mode: 0o644 });

    await writeStoredCredentials(paths, 'new-key');

    const fileStat = await stat(paths.credentialsFile);
    expect(fileStat.mode & 0o777).toBe(0o600);
    await expect(readStoredCredentials(paths)).resolves.toEqual({ version: 1, apiKey: 'new-key' });
  });
});

describe('statStoredCredentialsFile', () => {
  it('reports a missing file without throwing', async () => {
    const paths = await tempPaths();

    await expect(statStoredCredentialsFile(paths)).resolves.toEqual({ exists: false, permissionsEnforced: true, ownerOnly: undefined });
  });

  it.skipIf(process.platform === 'win32')('reports owner-only permissions for a freshly written file', async () => {
    const paths = await tempPaths();
    await writeStoredCredentials(paths, CANARY_SECRET);

    await expect(statStoredCredentialsFile(paths)).resolves.toEqual({ exists: true, permissionsEnforced: true, ownerOnly: true });
  });

  it('reports permissions as not enforced on Windows, regardless of actual mode', async () => {
    const paths = await tempPaths();
    await writeStoredCredentials(paths, CANARY_SECRET);

    await expect(statStoredCredentialsFile(paths, { platform: 'win32' })).resolves.toEqual({
      exists: true,
      permissionsEnforced: false,
      ownerOnly: undefined,
    });
  });
});

describe('deleteStoredCredentials (auth logout)', () => {
  it('deletes an existing stored file and reports it existed', async () => {
    const paths = await tempPaths();
    await writeStoredCredentials(paths, CANARY_SECRET);

    await expect(deleteStoredCredentials(paths)).resolves.toBe(true);
    await expect(readFile(paths.credentialsFile, 'utf8')).rejects.toThrow();
  });

  it('reports honestly that nothing existed, without throwing', async () => {
    const paths = await tempPaths();

    await expect(deleteStoredCredentials(paths)).resolves.toBe(false);
  });
});

describe('mutation probe: writes atomically with mode set at creation, never write-then-chmod', () => {
  it('creates a temp file (never the final path) with mode 0o600 at open, then renames it onto the final path', async () => {
    const paths = await tempPaths();
    const calls: string[] = [];
    const fakeFs: AuthStorageFsOps = {
      mkdir: vi.fn(async (path, options) => {
        calls.push('mkdir');
        return mkdir(path, options);
      }),
      writeFile: vi.fn(async (path, data, options) => {
        calls.push('writeFile');
        // The critical assertion: the file that is actually created with a
        // mode must NOT be the final credentials path — creating the real
        // destination directly (even with the right mode) and only later
        // renaming a *different* temp file would be a different, incorrect
        // sequence than the one this probe pins.
        expect(path).not.toBe(paths.credentialsFile);
        expect(options).toEqual({ mode: 0o600, flag: 'wx' });
        return writeFile(path, data, options);
      }),
      rename: vi.fn(async (oldPath, newPath) => {
        calls.push('rename');
        expect(newPath).toBe(paths.credentialsFile);
        return rename(oldPath, newPath);
      }),
      readFile: (path, encoding) => readFile(path, encoding),
      stat: (path) => stat(path),
      unlink: (path) => unlink(path),
    };

    await writeStoredCredentials(paths, CANARY_SECRET, { fs: fakeFs });

    expect(calls).toEqual(['mkdir', 'writeFile', 'rename']);
    await expect(readStoredCredentials(paths)).resolves.toEqual({ version: 1, apiKey: CANARY_SECRET });
  });
});

// #endregion

// #region secret hygiene: no error type ever accepts or leaks the key

describe('secret hygiene: auth error types never carry the key', () => {
  const errors = [
    new AuthInsecurePermissionsError('/tmp/does-not-matter/credentials.json'),
    new AuthCorruptCredentialsError('/tmp/does-not-matter/credentials.json'),
    new AuthBlankKeyError(),
    new AuthPromptCancelledError(),
  ];

  it.each(errors.map((error) => [error.constructor.name, error] as const))('%s never stringifies with a real key value', (_name, error) => {
    const stringified = [String(error), error.message, error.toString(), JSON.stringify(error)].join('\n');
    expect(stringified).not.toContain(CANARY_SECRET);
  });
});

// #endregion

// #region readApiKeyFromPrompt (auth-prompt adapter)

function fakeWritable(): { readonly writes: string[]; write(chunk: string): void } {
  const writes: string[] = [];
  return { writes, write: (chunk: string) => { writes.push(chunk); } };
}

type FakeTtyStdin = AuthPromptReadable & { emit(event: 'data' | 'end' | 'error', payload?: unknown): void };

function fakeTtyStdin(): FakeTtyStdin {
  const stream = new PassThrough() as unknown as FakeTtyStdin;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = vi.fn((mode: boolean) => { stream.isRaw = mode; });
  return stream;
}

describe('readApiKeyFromPrompt: non-TTY (piped/redirected stdin)', () => {
  it('reads one trimmed line and resolves', async () => {
    const stdin = new PassThrough();
    const stdout = fakeWritable();
    const promise = readApiKeyFromPrompt({ stdin, stdout });
    stdin.write('  a-real-key  \n');
    stdin.end();

    await expect(promise).resolves.toBe('a-real-key');
  });

  it('resolves with the buffered content even without a trailing newline', async () => {
    const stdin = new PassThrough();
    const stdout = fakeWritable();
    const promise = readApiKeyFromPrompt({ stdin, stdout });
    stdin.write('no-newline-key');
    stdin.end();

    await expect(promise).resolves.toBe('no-newline-key');
  });

  it('never writes anything to stdout for non-TTY input', async () => {
    const stdin = new PassThrough();
    const stdout = fakeWritable();
    const promise = readApiKeyFromPrompt({ stdin, stdout });
    stdin.write('a-real-key\n');
    stdin.end();
    await promise;

    expect(stdout.writes).toEqual([]);
  });
});

describe('readApiKeyFromPrompt: TTY (interactive, hidden input)', () => {
  it('never echoes typed characters to stdout', async () => {
    const stdin = fakeTtyStdin();
    const stdout = fakeWritable();
    const promise = readApiKeyFromPrompt({ stdin, stdout });
    stdin.emit('data', CANARY_SECRET);
    stdin.emit('data', '\n');

    await expect(promise).resolves.toBe(CANARY_SECRET);
    for (const chunk of stdout.writes) expect(chunk).not.toContain(CANARY_SECRET);
  });

  it('sets raw mode on entry and restores the prior raw-mode state on success', async () => {
    const stdin = fakeTtyStdin();
    const stdout = fakeWritable();
    const promise = readApiKeyFromPrompt({ stdin, stdout });
    expect(stdin.isRaw).toBe(true);
    stdin.emit('data', 'key\n');

    await promise;
    expect(stdin.isRaw).toBe(false);
  });

  it('supports backspace corrections', async () => {
    const stdin = fakeTtyStdin();
    const stdout = fakeWritable();
    const promise = readApiKeyFromPrompt({ stdin, stdout });
    stdin.emit('data', 'wrongg');
    stdin.emit('data', '\u007F');
    stdin.emit('data', '\n');

    await expect(promise).resolves.toBe('wrong');
  });

  it('Ctrl+C cancels the read and still restores raw mode, without leaving the terminal in raw mode', async () => {
    const stdin = fakeTtyStdin();
    const stdout = fakeWritable();
    const promise = readApiKeyFromPrompt({ stdin, stdout });
    stdin.emit('data', 'partial-input');
    stdin.emit('data', '\u0003');

    await expect(promise).rejects.toBeInstanceOf(AuthPromptCancelledError);
    expect(stdin.isRaw).toBe(false);
    for (const chunk of stdout.writes) expect(chunk).not.toContain('partial-input');
  });
});

// #endregion
