/**
 * Resolving the TypeSafe API key a real provider call needs — shared by
 * `src/cli/index.ts` (`audit --evaluate`) and `src/cli/benchmark.ts`'s own
 * `--store` sampling (task P7-3, `odd/tasks/phase-7-benchmarks.md`).
 *
 * Extracted into its own module (P7-3), rather than imported from
 * `src/cli/index.ts` directly, specifically so `src/cli/benchmark.ts` can
 * import this WITHOUT also importing everything `src/cli/index.ts` itself
 * imports — the audit store, the cache-key port, the full `audit` command
 * surface. `test/benchmark-cli-boundary.test.ts` asserts the closure from
 * `src/cli/benchmark.ts` never reaches `sqlite-audit-store.ts`/`cache-key.ts`;
 * importing `cli/index.ts` for this one function would silently break that
 * proof by pulling its entire import graph into benchmark's own closure.
 */
import {
  AuthCorruptCredentialsError,
  AuthInsecurePermissionsError,
  resolveApiKey,
} from '../domain/auth.js';
import { readStoredCredentials, resolveAuthStoragePaths } from '../adapters/auth-storage.js';

export const NO_KEY_USAGE_MESSAGE = 'No TypeSafe API key is configured. Provide one with `jev-test-auditor auth login`, or set the TYPESAFE_API_KEY environment variable.';

/**
 * Resolves the API key a real provider call should use: `TYPESAFE_API_KEY`
 * first (checked without ever touching the stored file, so CI's env-only
 * setup never pays for or risks a stored-file read), else the locally
 * stored file. A storage-side problem (insecure permissions, corrupt file)
 * is itself reported as the usage error rather than silently treated as "no
 * key" — a stray unusable stored file is a real, actionable problem, not
 * nothing.
 */
export async function resolveEvaluationApiKey(): Promise<{ readonly apiKey: string } | { readonly errorMessage: string }> {
  const environmentApiKey = process.env['TYPESAFE_API_KEY']?.trim() ?? '';
  if (environmentApiKey.length > 0) return { apiKey: environmentApiKey };

  const paths = resolveAuthStoragePaths();
  try {
    const stored = await readStoredCredentials(paths);
    const resolution = resolveApiKey({ environmentApiKey: undefined, stored });
    return resolution === undefined ? { errorMessage: NO_KEY_USAGE_MESSAGE } : { apiKey: resolution.apiKey };
  } catch (error) {
    if (error instanceof AuthInsecurePermissionsError || error instanceof AuthCorruptCredentialsError) {
      return { errorMessage: error.message };
    }
    throw error;
  }
}
