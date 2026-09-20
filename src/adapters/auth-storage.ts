/**
 * Local, per-user TypeSafe API key storage (Phase 4, task P4-5): a per-user
 * JSON credentials file scoped to this tool only (never a global
 * environment variable — see `src/domain/auth.ts`), written atomically with
 * owner-only permissions set at creation, and read only when its on-disk
 * permissions are still owner-only on POSIX.
 *
 * Paths (Phase 4 Scope/Decisions):
 *   - POSIX: `$XDG_CONFIG_HOME/jev-test-auditor/credentials.json`, else
 *     `~/.config/jev-test-auditor/credentials.json`.
 *   - Windows: `%APPDATA%\jev-test-auditor\credentials.json`.
 *
 * Every exported function takes the resolved {@link AuthStoragePaths} plus
 * an optional {@link AuthStorageOptions} (filesystem operations and the
 * platform to enforce permissions for) so tests can point at a temp
 * directory and a fake filesystem instead of the real per-user config
 * directory — no test may touch the real `~/.config` or `%APPDATA%`.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AUTH_CREDENTIALS_VERSION,
  AuthCorruptCredentialsError,
  AuthInsecurePermissionsError,
  type StoredCredentials,
} from '../domain/auth.js';

const APP_DIR_NAME = 'jev-test-auditor';
const CREDENTIALS_FILE_NAME = 'credentials.json';

/** Owner-only: `rwx` for the directory, `rw` for the file — no bits for group or other. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** Any of these bits set means group or other has some access — refuse to read, per the fail-closed permissions policy. */
const PERMISSIVE_MODE_MASK = 0o077;

export interface AuthStoragePaths {
  readonly configDir: string;
  readonly credentialsFile: string;
}

export interface AuthStorageEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

function defaultEnvironment(): AuthStorageEnvironment {
  return { platform: process.platform, env: process.env, homedir: homedir() };
}

/**
 * POSIX: `$XDG_CONFIG_HOME/jev-test-auditor/credentials.json`, else
 * `~/.config/jev-test-auditor/credentials.json`. Windows:
 * `%APPDATA%\jev-test-auditor\credentials.json`, falling back to
 * `~/AppData/Roaming` only if `APPDATA` is somehow blank (defensive; a real
 * Windows install always sets it).
 */
export function resolveAuthStoragePaths(environment: AuthStorageEnvironment = defaultEnvironment()): AuthStoragePaths {
  const { platform, env, homedir: home } = environment;

  if (platform === 'win32') {
    const appData = env['APPDATA']?.trim();
    const base = appData && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming');
    const configDir = join(base, APP_DIR_NAME);
    return { configDir, credentialsFile: join(configDir, CREDENTIALS_FILE_NAME) };
  }

  const xdgConfigHome = env['XDG_CONFIG_HOME']?.trim();
  const base = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(home, '.config');
  const configDir = join(base, APP_DIR_NAME);
  return { configDir, credentialsFile: join(configDir, CREDENTIALS_FILE_NAME) };
}

/**
 * The narrow slice of `node:fs/promises` this module needs, injectable so
 * tests (and mutation probes) can observe exactly which calls are made —
 * e.g. proving the credentials file is written through a temp-file-plus-
 * rename sequence rather than a direct write followed by a separate
 * `chmod`, which would leave a window where the file exists world-readable.
 */
export interface AuthStorageFsOps {
  readonly mkdir: (path: string, options: { readonly recursive: true; readonly mode: number }) => Promise<unknown>;
  readonly writeFile: (path: string, data: string, options: { readonly mode: number; readonly flag: string }) => Promise<void>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly readFile: (path: string, encoding: 'utf8') => Promise<string>;
  readonly stat: (path: string) => Promise<{ readonly mode: number }>;
  readonly unlink: (path: string) => Promise<void>;
}

const defaultFsOps: AuthStorageFsOps = {
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  readFile: (path, encoding) => readFile(path, encoding),
  stat: (path) => stat(path),
  unlink: (path) => unlink(path),
};

export interface AuthStorageOptions {
  readonly fs?: AuthStorageFsOps;
  readonly platform?: NodeJS.Platform;
}

function fsOpsOf(options: AuthStorageOptions | undefined): AuthStorageFsOps {
  return options?.fs ?? defaultFsOps;
}

function platformOf(options: AuthStorageOptions | undefined): NodeJS.Platform {
  return options?.platform ?? process.platform;
}

/** POSIX enforces owner-only file permissions; Windows does not — this tool never pretends otherwise. */
function permissionsEnforcedOn(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStoredCredentials(raw: string): StoredCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  if (parsed['version'] !== AUTH_CREDENTIALS_VERSION) return undefined;
  if (typeof parsed['apiKey'] !== 'string') return undefined;
  return { version: AUTH_CREDENTIALS_VERSION, apiKey: parsed['apiKey'] };
}

export interface StoredCredentialsFileStatus {
  readonly exists: boolean;
  /** `false` on Windows: this tool does not enforce (or claim to verify) file permissions there. */
  readonly permissionsEnforced: boolean;
  /** Whether the file's mode grants no access to group/other. `undefined` when the file does not exist or permissions are not enforced on this platform. */
  readonly ownerOnly: boolean | undefined;
}

/**
 * Reads the stored credentials file's existence and permission status
 * without reading or parsing its content — used by `auth status`, which
 * must never risk holding the key in memory when it does not need to.
 */
export async function statStoredCredentialsFile(
  paths: AuthStoragePaths,
  options?: AuthStorageOptions,
): Promise<StoredCredentialsFileStatus> {
  const fsOps = fsOpsOf(options);
  const platform = platformOf(options);
  const enforced = permissionsEnforcedOn(platform);

  let fileStat: { readonly mode: number };
  try {
    fileStat = await fsOps.stat(paths.credentialsFile);
  } catch (error) {
    if (isEnoent(error)) return { exists: false, permissionsEnforced: enforced, ownerOnly: undefined };
    throw error;
  }

  if (!enforced) return { exists: true, permissionsEnforced: false, ownerOnly: undefined };
  return { exists: true, permissionsEnforced: true, ownerOnly: (fileStat.mode & PERMISSIVE_MODE_MASK) === 0 };
}

/**
 * Reads and validates the stored credentials file. Returns `undefined` when
 * no file exists at all — the normal "never logged in" state, not an error.
 *
 * Throws {@link AuthInsecurePermissionsError} on POSIX when the file's mode
 * grants any group/other access: fail closed rather than silently trusting
 * a world- or group-readable secret. Throws
 * {@link AuthCorruptCredentialsError} when the file exists, has acceptable
 * permissions, but cannot be parsed into the expected `{ version: 1,
 * apiKey }` shape — never a crash, never a silently empty key.
 */
export async function readStoredCredentials(
  paths: AuthStoragePaths,
  options?: AuthStorageOptions,
): Promise<StoredCredentials | undefined> {
  const fsOps = fsOpsOf(options);
  const platform = platformOf(options);

  let fileStat: { readonly mode: number };
  try {
    fileStat = await fsOps.stat(paths.credentialsFile);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  if (permissionsEnforcedOn(platform) && (fileStat.mode & PERMISSIVE_MODE_MASK) !== 0) {
    throw new AuthInsecurePermissionsError(paths.credentialsFile);
  }

  const raw = await fsOps.readFile(paths.credentialsFile, 'utf8');
  const parsed = parseStoredCredentials(raw);
  if (parsed === undefined) throw new AuthCorruptCredentialsError(paths.credentialsFile);
  return parsed;
}

/**
 * Writes the credentials file atomically with `0o600` set at creation —
 * never write-then-`chmod`, which would leave a window where the file
 * exists on disk with the new secret under old (or default, looser)
 * permissions. A temp file is created in the same directory with
 * `{ flag: 'wx', mode: 0o600 }` — born with the right permissions rather
 * than created loosely and tightened afterward — and `rename`d onto the
 * final path, which is atomic on both POSIX and Windows and replaces
 * whatever was at the destination (including its old mode) in one step.
 * The containing directory is created with `0o700` at creation for the
 * same reason.
 */
export async function writeStoredCredentials(
  paths: AuthStoragePaths,
  apiKey: string,
  options?: AuthStorageOptions,
): Promise<void> {
  const fsOps = fsOpsOf(options);
  await fsOps.mkdir(paths.configDir, { recursive: true, mode: DIRECTORY_MODE });

  const payload: StoredCredentials = { version: AUTH_CREDENTIALS_VERSION, apiKey };
  const tempFile = join(paths.configDir, `.${CREDENTIALS_FILE_NAME}.${randomBytes(8).toString('hex')}.tmp`);
  await fsOps.writeFile(tempFile, JSON.stringify(payload), { mode: FILE_MODE, flag: 'wx' });
  await fsOps.rename(tempFile, paths.credentialsFile);
}

/** Deletes the stored credentials file. Returns whether a file actually existed, so `auth logout` can report honestly instead of always claiming success. */
export async function deleteStoredCredentials(paths: AuthStoragePaths, options?: AuthStorageOptions): Promise<boolean> {
  const fsOps = fsOpsOf(options);
  try {
    await fsOps.unlink(paths.credentialsFile);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}
