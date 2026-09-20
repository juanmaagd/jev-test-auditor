/**
 * Local API key storage domain contracts (Phase 4, task P4-5): the
 * resolution precedence policy and the typed errors both the storage
 * adapter (`src/adapters/auth-storage.ts`), the prompt adapter
 * (`src/adapters/auth-prompt.ts`), and the CLI (`src/cli/index.ts`) share.
 * Pure domain code — no Node imports — mirroring the error-hierarchy shape
 * of `src/domain/jev-gateway.ts`.
 *
 * Precedence (Phase 4 Scope/Decisions): `TYPESAFE_API_KEY` wins when set and
 * non-blank, so CI keeps injecting GitHub secrets; otherwise the locally
 * stored per-user file; otherwise no key is available. Local storage is a
 * per-user file scoped to this tool, not a global environment variable.
 *
 * Hard secret-hygiene requirement: none of these error types ever accept the
 * API key, or anything derived from it, as a constructor argument — there is
 * no code path through which a key could reach any of these messages,
 * `toString()`, or `JSON.stringify()`.
 */

export const AUTH_CREDENTIALS_VERSION = 1 as const;

/** The on-disk shape of the stored credentials file, exactly `{ version: 1, apiKey }`. */
export interface StoredCredentials {
  readonly version: 1;
  readonly apiKey: string;
}

export type ApiKeySource = 'environment' | 'stored';

export interface ApiKeyResolution {
  readonly apiKey: string;
  readonly source: ApiKeySource;
}

export interface ResolveApiKeyInput {
  /** The raw `TYPESAFE_API_KEY` environment value, or `undefined` when unset. Trimmed and treated as absent when blank. */
  readonly environmentApiKey: string | undefined;
  /** The already-read and validated stored credentials, or `undefined` when no stored file exists (or was not consulted). */
  readonly stored: StoredCredentials | undefined;
}

/**
 * Pure precedence resolution: the environment variable wins whenever it is
 * set and non-blank; otherwise the stored file's key is used when present
 * and non-blank; otherwise `undefined` (no key available). Deliberately
 * takes already-read env/file state rather than reading either itself, so
 * this policy is fully testable without any filesystem or process access.
 */
export function resolveApiKey(input: ResolveApiKeyInput): ApiKeyResolution | undefined {
  const environmentKey = input.environmentApiKey?.trim() ?? '';
  if (environmentKey.length > 0) return { apiKey: environmentKey, source: 'environment' };

  const storedKey = input.stored?.apiKey.trim() ?? '';
  if (storedKey.length > 0) return { apiKey: storedKey, source: 'stored' };

  return undefined;
}

export type AuthStorageErrorCode = 'insecure-permissions' | 'corrupt' | 'blank-key' | 'prompt-cancelled';

abstract class AuthStorageErrorBase extends Error {
  abstract readonly code: AuthStorageErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The stored credentials file's on-disk permissions grant some access to
 * the file's group or other bits. Refuse to read it rather than silently
 * trusting a world- or group-readable secret (fail closed); the message
 * names the exact fix. POSIX only — Windows does not enforce this check.
 */
export class AuthInsecurePermissionsError extends AuthStorageErrorBase {
  readonly code = 'insecure-permissions' as const;
  readonly path: string;

  constructor(path: string) {
    super(
      `Refusing to read stored TypeSafe credentials at "${path}": its file permissions are more permissive than owner-only. `
      + `Fix them with \`chmod 600 ${path}\` and try again, or run \`jev-test-auditor auth login\` again to recreate the file with correct permissions.`,
    );
    this.path = path;
  }
}

/** The stored credentials file exists but is not valid JSON, or does not match the expected `{ version: 1, apiKey }` shape. Never a crash, never a silently empty key. */
export class AuthCorruptCredentialsError extends AuthStorageErrorBase {
  readonly code = 'corrupt' as const;
  readonly path: string;

  constructor(path: string) {
    super(
      `Stored TypeSafe credentials at "${path}" are corrupt or in an unrecognized format. `
      + 'Run `jev-test-auditor auth login` again to overwrite it.',
    );
    this.path = path;
  }
}

/** `auth login` read an empty or whitespace-only key from the prompt. Nothing is written to disk. */
export class AuthBlankKeyError extends AuthStorageErrorBase {
  readonly code = 'blank-key' as const;

  constructor() {
    super('No API key was entered. Nothing was stored.');
  }
}

/** The interactive prompt was cancelled (Ctrl+C) before a key was entered. Nothing is written to disk. */
export class AuthPromptCancelledError extends AuthStorageErrorBase {
  readonly code = 'prompt-cancelled' as const;

  constructor() {
    super('Login was cancelled before a key was entered. Nothing was stored.');
  }
}

export type AuthStorageError =
  | AuthInsecurePermissionsError
  | AuthCorruptCredentialsError
  | AuthBlankKeyError
  | AuthPromptCancelledError;
