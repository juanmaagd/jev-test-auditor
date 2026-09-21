import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { normalizeRepositoryRelativePath } from '../domain/test-understanding.js';

/**
 * `odd/tasks/jest-ambient-globals.md`: NestJS's standard Jest setup (and most
 * plain Jest projects) never imports `@jest/globals` — `describe`/`it`/
 * `expect` are ambient globals. `frameworkForModule`
 * (`src/adapters/test-extraction.ts`) can only attribute a framework from an
 * import specifier, so every such file was extracted with test cases but
 * `framework: 'unknown'`, and that `'unknown'` reached the Jev request state
 * unjudged-by-framework.
 *
 * This module is the fallback: when a file's own imports attribute nothing,
 * ask the project's own configuration instead — the `jest` key in the
 * nearest `package.json`, a `jest.config.{js,cjs,mjs,ts,json}` file, or a
 * `"test": "jest"`-style runner script. It never executes or evaluates
 * anything: `package.json` is read and `JSON.parse`d (safe, structured
 * data), and a `jest.config.*` file is only ever checked for PRESENCE by
 * name, never opened — see {@link JEST_CONFIG_FILE_NAMES}'s doc for why
 * presence alone is sufficient evidence for that one.
 *
 * Deliberately separate from `src/adapters/repository-discovery.ts`'s own
 * `readPackageEvidence` (which only reads `rootDir`'s own `package.json` for
 * dependency names) rather than extending it: the bug this fixes is
 * specifically that a real audit's `--rootDir` is often a SUBDIRECTORY of the
 * actual project root (e.g. `backend/src/modules/auth`, with `package.json`
 * only at `backend/`), and discovery's own algorithm/report shape is out of
 * this task's authorized scope. This reader walks upward from the FILE's own
 * directory — which may be outside `rootDir` entirely — to find that
 * ancestor `package.json`, the same "nearest config wins" shape as
 * `src/adapters/alias-config.ts`'s `findNearestConfigFile`, just crossing a
 * boundary that one never needs to (a tsconfig/package.json alias table is
 * always resolved from files inside the audited root).
 *
 * Wired from `src/application/audit.ts`, which already threads a
 * `frameworkHint` through to `extractTestCases` (`discovered.framework`) —
 * this only makes that hint smarter when discovery's own import/dependency
 * evidence produced `'unknown'`. Extraction's own precedence
 * (`bindings.frameworks[0] ?? request.frameworkHint ?? 'unknown'`, and
 * `'unknown'` outright whenever a file's own imports name MORE THAN ONE
 * framework) already guarantees import-based attribution always wins and
 * this hint is consulted only when imports attributed nothing — no change
 * to `src/adapters/test-extraction.ts` was needed or made.
 */
export type JestFrameworkHint = 'jest';

/**
 * The exact filenames Jest's own config resolution looks for (a JSON
 * variant, plus every JS/TS module-format variant). Only presence is ever
 * checked, for two reasons: (1) a JS/TS config file cannot be read safely
 * without executing it — it is an arbitrary `module.exports = …` / `export
 * default …` program, not data — so `import()`/`require()` is out of scope
 * entirely (see this module's own top-level doc); (2) even for the one safe
 * format, `jest.config.json`, there is no field this reader would need from
 * its content — the filename itself is unambiguous Jest evidence (no other
 * tool resolves configuration from a file named exactly `jest.config.*`), so
 * reading its bytes would add a parse-failure mode with no corresponding
 * gain in evidence quality. Presence-only is therefore not a shortcut taken
 * under time pressure, it is the strictly safer and equally informative
 * choice for every extension in this list, JSON included.
 */
const JEST_CONFIG_FILE_NAMES: readonly string[] = [
  'jest.config.js',
  'jest.config.cjs',
  'jest.config.mjs',
  'jest.config.ts',
  'jest.config.json',
];

/**
 * Vitest's own config filenames, checked the same presence-only way as
 * {@link JEST_CONFIG_FILE_NAMES} — but here purely as CONFLICT evidence: a
 * `vitest.config.*` file sitting next to the same `package.json` this reader
 * would otherwise use to attribute Jest means this is a Vitest project (very
 * likely one that also runs with `globals: true`, which is what makes its
 * spec files import-free too), and it must stay `'unknown'` rather than be
 * guessed as Jest. See {@link frameworkFromPackageSignals}.
 */
const VITEST_CONFIG_FILE_NAMES: readonly string[] = [
  'vitest.config.js',
  'vitest.config.cjs',
  'vitest.config.mjs',
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
];

/** Matches `jest` as its own command-name token inside a `"test"` script value (e.g. `"jest"`, `"jest --coverage"`, `"cross-env X=1 jest --runInBand"`). Word-boundaried so it never matches a longer identifier that merely contains the letters. */
const JEST_SCRIPT_PATTERN = /\bjest\b/u;
/** Matches `vitest` as its own token — see {@link JEST_SCRIPT_PATTERN}. Used only as conflicting evidence against a Jest attribution. */
const VITEST_SCRIPT_PATTERN = /\bvitest\b/u;
/** Matches a `bun test` invocation — Bun's own test runner CLI form — as conflicting evidence against a Jest attribution. */
const BUN_TEST_SCRIPT_PATTERN = /\bbun\s+test\b/u;

/** Defensive backstop against a pathological filesystem (e.g. a directory that is its own parent via a bind mount): mirrors `alias-config.ts`'s `MAX_EXTENDS_DEPTH` — no real repository ancestry is ever remotely this deep. */
const MAX_WALK_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PackageRootSignals {
  readonly hasJestKey: boolean;
  readonly testScriptRunsJest: boolean;
  readonly testScriptRunsVitest: boolean;
  readonly testScriptRunsBun: boolean;
  readonly hasVitestDependency: boolean;
  readonly hasJestConfigFile: boolean;
  readonly hasVitestConfigFile: boolean;
}

/**
 * Walks from `startDirAbs` up toward the filesystem root looking for a
 * directory containing `package.json`, and returns that directory — never
 * its content, that is {@link readPackageRootSignals}'s job. This is the one
 * place this reader deliberately reads OUTSIDE `rootDir`: a real audit's
 * `--rootDir` is often a subdirectory of the actual project
 * (`backend/src/modules/auth` with `package.json` only at `backend/`), and
 * there is no way to find that ancestor without leaving the audited root.
 *
 * Bounded so it can never wander into unrelated, unbounded ancestry: the
 * walk stops (with no match) the moment it inspects a directory that itself
 * contains a `.git` entry — the repository boundary — without also
 * containing a `package.json`, or when it reaches the real filesystem root
 * (`dirname(dir) === dir`), or after {@link MAX_WALK_DEPTH} hops as a final
 * backstop. `package.json` is checked before the `.git` check at each
 * directory, so a `package.json` living directly alongside a `.git` (the
 * ordinary case: the repository root itself) is still found.
 */
async function findPackageRootDir(startDirAbs: string): Promise<string | undefined> {
  let current: string;
  try {
    current = await realpath(startDirAbs);
  } catch {
    current = startDirAbs;
  }
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return undefined;
    }
    if (entries.includes('package.json')) return current;
    const isRepositoryBoundary = entries.includes('.git');
    const parent = dirname(current);
    if (isRepositoryBoundary || parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Reads and `JSON.parse`s `package.json` at `packageRootDirAbs`, returning the Jest/Vitest signals this reader needs from it. Never `require`d or evaluated — plain data. Any read/parse failure (missing, unreadable, malformed, or not a JSON object) yields `undefined`: no signal, never a guess. */
async function readPackageRootSignals(packageRootDirAbs: string): Promise<PackageRootSignals | undefined> {
  let text: string;
  try {
    text = await readFile(resolve(packageRootDirAbs, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;

  const hasJestKey = parsed.jest !== undefined && parsed.jest !== null;

  const scripts = isPlainObject(parsed.scripts) ? parsed.scripts : {};
  const testScript = typeof scripts.test === 'string' ? scripts.test : undefined;
  const testScriptRunsJest = testScript !== undefined && JEST_SCRIPT_PATTERN.test(testScript);
  const testScriptRunsVitest = testScript !== undefined && VITEST_SCRIPT_PATTERN.test(testScript);
  const testScriptRunsBun = testScript !== undefined && BUN_TEST_SCRIPT_PATTERN.test(testScript);

  const dependencyNames = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .flatMap((key) => (isPlainObject(parsed[key]) ? Object.keys(parsed[key] as Record<string, unknown>) : []));
  const hasVitestDependency = dependencyNames.some((name) => name === 'vitest' || name.startsWith('@vitest/'));

  let siblingEntries: string[];
  try {
    siblingEntries = await readdir(packageRootDirAbs);
  } catch {
    siblingEntries = [];
  }
  const hasJestConfigFile = JEST_CONFIG_FILE_NAMES.some((name) => siblingEntries.includes(name));
  const hasVitestConfigFile = VITEST_CONFIG_FILE_NAMES.some((name) => siblingEntries.includes(name));

  return {
    hasJestKey,
    testScriptRunsJest,
    testScriptRunsVitest,
    testScriptRunsBun,
    hasVitestDependency,
    hasJestConfigFile,
    hasVitestConfigFile,
  };
}

/**
 * Decides Jest attribution from one package root's signals. Import-based
 * attribution always wins over this (see this module's top-level doc); this
 * function only ever runs when that produced nothing, so its own job is
 * narrower: attribute Jest when there is positive Jest evidence AND no
 * conflicting evidence for a different framework at the SAME package root.
 * Conflicting evidence (a `"test"` script naming a different runner, a
 * `vitest` dependency, or a `vitest.config.*` file) wins over positive Jest
 * evidence rather than being ignored — a project mid-migration with a stale
 * `jest.config.js` left behind must stay `'unknown'`, not be guessed.
 */
function frameworkFromPackageSignals(signals: PackageRootSignals): JestFrameworkHint | undefined {
  const hasConflictingEvidence = signals.testScriptRunsVitest
    || signals.testScriptRunsBun
    || signals.hasVitestDependency
    || signals.hasVitestConfigFile;
  if (hasConflictingEvidence) return undefined;

  const hasJestEvidence = signals.hasJestKey || signals.testScriptRunsJest || signals.hasJestConfigFile;
  return hasJestEvidence ? 'jest' : undefined;
}

async function resolveJestFrameworkHintForDirectory(rootDir: string, repositoryRelativeDirectory: string): Promise<JestFrameworkHint | undefined> {
  const startDirAbs = resolve(rootDir, repositoryRelativeDirectory);
  const packageRootDirAbs = await findPackageRootDir(startDirAbs);
  if (packageRootDirAbs === undefined) return undefined;
  const signals = await readPackageRootSignals(packageRootDirAbs);
  if (signals === undefined) return undefined;
  return frameworkFromPackageSignals(signals);
}

/** Repository-relative parent directory of a repository-relative path (`''` for a root-level path). Mirrors `alias-config.ts`'s own `repoDirOf`. */
function repoDirOf(repositoryRelativePath: string): string {
  const index = repositoryRelativePath.lastIndexOf('/');
  return index === -1 ? '' : repositoryRelativePath.slice(0, index);
}

/** Injectable, per-directory-cached Jest project-config hint lookup — see {@link createJestFrameworkHintReader}. */
export type JestFrameworkHintReader = (repositoryRelativePath: string) => Promise<JestFrameworkHint | undefined>;

/**
 * Wraps the package-root walk with an in-memory cache keyed by the file's
 * own directory: every file in the same directory shares the exact same
 * nearest-`package.json` search and the same signals, so an audit of (say)
 * eleven spec files under `src/modules/auth/` performs this walk once, not
 * eleven times — the same "one config read per directory per run" shape as
 * `alias-config.ts`'s `createMemoizingAliasConfigReader`. As there, the
 * *promise* itself is cached so concurrent lookups for the same directory
 * dedupe onto one underlying walk instead of racing.
 *
 * Intended to be created once per audit run (in `src/application/audit.ts`,
 * before the per-file loop) and called once per discovered file whose
 * `discovered.framework` is `'unknown'`.
 */
export function createJestFrameworkHintReader(rootDir: string): JestFrameworkHintReader {
  const cache = new Map<string, Promise<JestFrameworkHint | undefined>>();
  return (repositoryRelativePath: string): Promise<JestFrameworkHint | undefined> => {
    const directory = repoDirOf(normalizeRepositoryRelativePath(repositoryRelativePath));
    const cached = cache.get(directory);
    if (cached !== undefined) return cached;
    const pending = resolveJestFrameworkHintForDirectory(rootDir, directory);
    cache.set(directory, pending);
    return pending;
  };
}
