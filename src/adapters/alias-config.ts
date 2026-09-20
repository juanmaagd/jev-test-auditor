import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import type {
  AliasConfigRefusal,
  AliasConfigRefusalReason,
  AliasMappingEntry,
  AliasMappings,
} from '../domain/alias-config.js';
import type { SourceReadRequest } from '../domain/audit.js';
import { normalizeRepositoryRelativePath } from '../domain/test-understanding.js';
import { isOutsideRootRelative } from './containment.js';
import { globRegExp } from './repository-discovery.js';
import { readSourceFile } from './source-reader.js';

export interface AliasConfigRequest {
  readonly rootDir: string;
  /** Repository-relative path of the file whose mapping table is being built. */
  readonly repositoryRelativePath: string;
  /**
   * Injectable reader for every config file this function reads
   * (tsconfig/jsconfig `extends` chain, nearest `package.json`, root
   * `package.json`, and each workspace package's own `package.json`).
   * Defaults to {@link readSourceFile}.
   *
   * This function holds no cache of its own. A caller building a run-scoped
   * cache (an audit over many files) passes the SAME memoizing reader (e.g.
   * `createMemoizingSourceReader` from `src/adapters/evidence-audit-port.ts`,
   * already used for source files) into every call for that run — a config
   * file shared by two files' nearest chains is then read from disk once,
   * exactly like the feature doc's "Decisions" require ("the cache is part
   * of the same run-scoped reader already used for source files"). This
   * mirrors `resolveEvidenceFiles`'s own `readSource` injection point rather
   * than inventing a second, parallel caching mechanism.
   */
  readonly readSource?: (request: SourceReadRequest) => Promise<string>;
}

/**
 * Deterministic condition preference applied to a `package.json` `imports`
 * conditional-object value, and reused for a workspace package's own
 * `exports['.']` conditional object (see {@link packageEntryTarget}):
 * `default` first, then `import`, then `node`. This is a static-analysis
 * choice, not an emulation of Node's real per-invocation condition
 * negotiation (which depends on the actual runtime/loader and is not knowable
 * from static configuration alone): `default` is the universal fallback
 * authors most often supply and is safe regardless of how the code ends up
 * loaded; `import` is the next most common static ESM entry; `node` is the
 * remaining common case. Any other condition name (`require`, `browser`,
 * `types`, a custom condition, ...) is ignored rather than guessed at — see
 * `imports-unsupported-conditions`.
 */
const CONDITION_PREFERENCE = ['default', 'import', 'node'] as const;

/**
 * Defensive backstop against a runaway `extends` chain. The real guard
 * against an `extends` cycle is the ancestry-stack check in
 * {@link loadConfigChain} (see `extends-cycle`); this cap only protects
 * against a hypothetical bug in that check turning into unbounded async
 * recursion instead of a fast, recorded refusal. No real-world tsconfig
 * chain is anywhere near this deep.
 */
const MAX_EXTENDS_DEPTH = 64;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(sink: AliasConfigRefusal[], reason: AliasConfigRefusalReason, declaredIn: string, detail: string): void {
  sink.push({ reason, declaredIn, detail });
}

/**
 * Repository-relative directories to search for a nearest config, nearest
 * first: the file's own directory, then each ancestor up to (and including)
 * the repository root, represented as `''`.
 */
function ancestryDirectories(repositoryRelativePath: string): string[] {
  const segments = repositoryRelativePath.split('/');
  segments.pop();
  const dirs: string[] = [segments.join('/')];
  let current = segments;
  while (current.length > 0) {
    current = current.slice(0, -1);
    dirs.push(current.join('/'));
  }
  return dirs;
}

/** Joins a repository-relative directory (`''` for the root) with a file/segment name. */
function joinRepoRelative(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

/** Repository-relative parent directory of a repository-relative path (`''` for a root-level path). */
function repoDirOf(repositoryRelativePath: string): string {
  const index = repositoryRelativePath.lastIndexOf('/');
  return index === -1 ? '' : repositoryRelativePath.slice(0, index);
}

/**
 * Walks up from the file's own directory to the repository root (inclusive),
 * returning the first repository-relative path whose directory contains one
 * of `names`, tried in `names` order at each directory (so passing
 * `['tsconfig.json', 'jsconfig.json']` prefers a tsconfig over a jsconfig at
 * the SAME directory level, while still preferring a nearer directory's
 * jsconfig over a farther directory's tsconfig). Uses `readdir` directly
 * (not the injectable reader) since this is filesystem *structure*, not
 * config *content* — the same split `resolveEvidenceFiles` and
 * `repository-discovery.ts` already make.
 */
async function findNearestConfigFile(
  rootDirAbs: string,
  repositoryRelativePath: string,
  names: readonly string[],
): Promise<string | undefined> {
  for (const dir of ancestryDirectories(repositoryRelativePath)) {
    let entries: string[];
    try {
      entries = await readdir(resolve(rootDirAbs, dir));
    } catch {
      continue;
    }
    const found = names.find((name) => entries.includes(name));
    if (found !== undefined) return joinRepoRelative(dir, found);
  }
  return undefined;
}

type ConfigReadOutcome =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'unreadable'; readonly detail: string };

/**
 * Reads and JSONC-parses one config file through the injectable reader —
 * never `require`d, `import()`ed, or otherwise executed. Comments and
 * trailing commas are tolerated (`ts.parseConfigFileTextToJson` is a text
 * parser, not a module loader); a file that cannot be parsed at all is
 * `malformed`, never thrown.
 */
async function readAndParseConfig(
  rootDirForRead: string,
  repositoryRelativePath: string,
  readSource: (request: SourceReadRequest) => Promise<string>,
): Promise<ConfigReadOutcome> {
  let text: string;
  try {
    text = await readSource({ rootDir: rootDirForRead, repositoryRelativePath });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', detail: messageOf(error) };
  }
  const parsed = ts.parseConfigFileTextToJson(repositoryRelativePath, text);
  if (parsed.error !== undefined) {
    return { kind: 'malformed', detail: ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ') };
  }
  if (parsed.config === undefined) {
    return { kind: 'malformed', detail: 'Unable to parse configuration file' };
  }
  return { kind: 'ok', value: parsed.config };
}

interface OwnConfigSettings {
  readonly baseUrl?: string;
  readonly paths?: Readonly<Record<string, readonly string[]>>;
  readonly extendsList: readonly string[];
}

/** Extracts this config's own (not inherited) `baseUrl`/`paths`/`extends`, tolerant of any malformed or absent shape — never throws. */
function extractOwnSettings(value: unknown): OwnConfigSettings {
  const root = isPlainObject(value) ? value : {};
  const compilerOptions = isPlainObject(root.compilerOptions) ? root.compilerOptions : {};

  const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : undefined;

  const rawPaths = compilerOptions.paths;
  let paths: Record<string, readonly string[]> | undefined;
  if (isPlainObject(rawPaths)) {
    const collected: Record<string, readonly string[]> = {};
    for (const [key, rawValue] of Object.entries(rawPaths)) {
      const targets = Array.isArray(rawValue)
        ? rawValue.filter((item): item is string => typeof item === 'string')
        : typeof rawValue === 'string' ? [rawValue] : [];
      if (targets.length > 0) collected[key] = targets;
    }
    if (Object.keys(collected).length > 0) paths = collected;
  }

  const rawExtends = root.extends;
  const extendsList = typeof rawExtends === 'string'
    ? [rawExtends]
    : Array.isArray(rawExtends)
      ? rawExtends.filter((item): item is string => typeof item === 'string')
      : [];

  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(paths !== undefined ? { paths } : {}),
    extendsList,
  };
}

type ExtendsTargetResolution =
  | { readonly kind: 'candidate'; readonly path: string }
  | { readonly kind: 'outside-root' }
  | { readonly kind: 'node-modules' };

/**
 * Classifies and resolves one `extends` specifier — relative (`./`/`../`,
 * resolved against the config's own directory) or a real absolute
 * filesystem path (resolved as-is, exactly like real TypeScript: `extends`
 * has no "root-relative" notion of its own, so a leading `/` is an ordinary
 * absolute path, not shorthand for "relative to the repository root"). A
 * relative specifier is derived entirely from the already-realpath'd
 * `rootDirAbs`, so a plain lexical comparison is exact. An absolute
 * specifier, by contrast, carries its OWN independent spelling that can
 * legitimately land inside the repository root while looking lexically
 * "outside" it (e.g. a temp root reached through a symlinked ancestor, such
 * as macOS's `/tmp` -> `/private/tmp`) — so it is realpath'd first (when it
 * exists) and THAT result is what gets compared against `rootDirAbs`. When
 * the absolute target does not exist yet, realpath fails and the lexical
 * absolute path is used for classification instead; a target that is
 * lexically nowhere near the root (e.g. `/etc/whatever.json`) is still
 * correctly refused, and one that turns out to exist only gets a final
 * verdict once actually read (`extends-missing`/`config-malformed`).
 *
 * Either way, the SAME containment rule applies: the resolved result must
 * land inside the repository root and outside `node_modules`, or it is
 * refused — an absolute path is never given a free pass just because it is
 * spelled with a leading `/`, and is never silently reinterpreted as
 * pointing somewhere inside the repository when it does not.
 *
 * A specifier that is neither relative nor absolute is an npm package
 * specifier (e.g. `@tsconfig/node20/tsconfig.json`) and is refused the same
 * way as a target that resolves inside `node_modules`: both are "the
 * `node_modules` mechanism," never followed.
 */
async function resolveExtendsTarget(rootDirAbs: string, currentDir: string, specifier: string): Promise<ExtendsTargetResolution> {
  const isRelative = specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
  const isAbsoluteSpecifier = isAbsolute(specifier);
  if (!isRelative && !isAbsoluteSpecifier) return { kind: 'node-modules' };

  let absTarget: string;
  if (isAbsoluteSpecifier) {
    const lexical = resolve(specifier);
    try {
      absTarget = await realpath(lexical);
    } catch {
      absTarget = lexical;
    }
  } else {
    absTarget = resolve(rootDirAbs, currentDir, specifier);
  }

  const rel = relative(rootDirAbs, absTarget).split('\\').join('/');
  if (isAbsolute(rel) || isOutsideRootRelative(rel)) return { kind: 'outside-root' };
  if (rel.split('/').includes('node_modules')) return { kind: 'node-modules' };
  return { kind: 'candidate', path: rel };
}

/** Tries `path`, then `path.json` (TS's own extends fallback), returning the first that exists (whatever its own read/parse outcome), or `undefined` if neither exists. */
async function resolveExtendsCandidate(
  rootDirForRead: string,
  path: string,
  readSource: (request: SourceReadRequest) => Promise<string>,
): Promise<readonly [string, ConfigReadOutcome] | undefined> {
  for (const candidate of [path, `${path}.json`]) {
    const outcome = await readAndParseConfig(rootDirForRead, candidate, readSource);
    if (outcome.kind !== 'missing') return [candidate, outcome];
  }
  return undefined;
}

interface DeclaredValue<T> {
  readonly value: T;
  /** Repository-relative directory of the config that declared this value, for base-path math. */
  readonly declaringDir: string;
  /** Repository-relative path of the config that declared this value, for entry provenance. */
  readonly declaredIn: string;
}

interface MergedChainResult {
  readonly baseUrl?: DeclaredValue<string>;
  readonly paths?: DeclaredValue<Readonly<Record<string, readonly string[]>>>;
}

/**
 * Resolves one config's effective `baseUrl`/`paths`, following its `extends`
 * chain. Nearest (child) settings always win outright over inherited ones —
 * `paths`/`baseUrl` are never merged key-by-key across `extends`, matching
 * TypeScript's own behavior. An `extends` array is applied left to right,
 * each entry's settings overriding the previous entries' (before the
 * config's own settings override all of them).
 *
 * Cycle guard: `ancestryStack` holds the realpath of every config currently
 * being loaded on the current call chain. Before recursing into a
 * candidate `extends` target, its realpath is checked against the stack; a
 * hit is recorded as `extends-cycle` and that target is skipped rather than
 * recursed into, so a cycle can never hang or overflow the stack. Each call
 * adds its own realpath to the stack for the duration of its own recursion
 * and removes it in a `finally`, so unrelated diamond-shaped `extends`
 * graphs (the same ancestor reached twice through different branches, but
 * never through itself) are not mistaken for cycles.
 */
async function loadConfigChain(
  rootDirAbs: string,
  rootDirForRead: string,
  configRepositoryRelativePath: string,
  outcome: ConfigReadOutcome,
  ancestryStack: Set<string>,
  readSource: (request: SourceReadRequest) => Promise<string>,
  refusals: AliasConfigRefusal[],
  configFilesRead: Set<string>,
  depth: number,
): Promise<MergedChainResult> {
  configFilesRead.add(configRepositoryRelativePath);

  if (outcome.kind === 'malformed') {
    refuse(refusals, 'config-malformed', configRepositoryRelativePath, outcome.detail);
    return {};
  }
  if (outcome.kind === 'unreadable') {
    // Lexically in-root but the reader itself refused it — e.g. a symlink
    // whose realpath escapes the root, caught by `readSourceFile`'s own
    // containment check (a `RangeError`, not `ENOENT`). Never read, and
    // recorded here rather than silently dropped.
    refuse(refusals, 'config-unreadable', configRepositoryRelativePath, outcome.detail);
    return {};
  }
  if (outcome.kind !== 'ok' || depth > MAX_EXTENDS_DEPTH) return {};

  const absPath = resolve(rootDirAbs, configRepositoryRelativePath);
  let ownReal: string;
  try {
    ownReal = await realpath(absPath);
  } catch {
    ownReal = absPath;
  }

  ancestryStack.add(ownReal);
  try {
    const own = extractOwnSettings(outcome.value);
    const thisDir = repoDirOf(configRepositoryRelativePath);

    let mergedBaseUrl: DeclaredValue<string> | undefined;
    let mergedPaths: DeclaredValue<Readonly<Record<string, readonly string[]>>> | undefined;

    for (const extendsSpecifier of own.extendsList) {
      const target = await resolveExtendsTarget(rootDirAbs, thisDir, extendsSpecifier);
      if (target.kind === 'outside-root') {
        refuse(refusals, 'extends-outside-root', configRepositoryRelativePath, extendsSpecifier);
        continue;
      }
      if (target.kind === 'node-modules') {
        refuse(refusals, 'extends-node-modules', configRepositoryRelativePath, extendsSpecifier);
        continue;
      }

      const resolved = await resolveExtendsCandidate(rootDirForRead, target.path, readSource);
      if (resolved === undefined) {
        refuse(refusals, 'extends-missing', configRepositoryRelativePath, extendsSpecifier);
        continue;
      }
      const [chosenPath, chosenOutcome] = resolved;

      let targetReal: string;
      try {
        targetReal = await realpath(resolve(rootDirAbs, chosenPath));
      } catch {
        targetReal = resolve(rootDirAbs, chosenPath);
      }
      if (ancestryStack.has(targetReal)) {
        refuse(refusals, 'extends-cycle', configRepositoryRelativePath, extendsSpecifier);
        continue;
      }

      const child = await loadConfigChain(
        rootDirAbs,
        rootDirForRead,
        chosenPath,
        chosenOutcome,
        ancestryStack,
        readSource,
        refusals,
        configFilesRead,
        depth + 1,
      );
      if (child.baseUrl !== undefined) mergedBaseUrl = child.baseUrl;
      if (child.paths !== undefined) mergedPaths = child.paths;
    }

    const finalBaseUrl = own.baseUrl !== undefined
      ? { value: own.baseUrl, declaringDir: thisDir, declaredIn: configRepositoryRelativePath }
      : mergedBaseUrl;
    const finalPaths = own.paths !== undefined
      ? { value: own.paths, declaringDir: thisDir, declaredIn: configRepositoryRelativePath }
      : mergedPaths;

    return {
      ...(finalBaseUrl !== undefined ? { baseUrl: finalBaseUrl } : {}),
      ...(finalPaths !== undefined ? { paths: finalPaths } : {}),
    };
  } finally {
    ancestryStack.delete(ownReal);
  }
}

/** Lexically resolves `rawTarget` (may contain a literal `*`, left untouched) against `baseAbsDir`, returning the repository-relative result or `undefined` if it escapes the root. Never touches the filesystem — the target need not exist. */
function containRelativeTarget(rootDirAbs: string, baseAbsDir: string, rawTarget: string): string | undefined {
  const abs = resolve(baseAbsDir, rawTarget);
  const rel = relative(rootDirAbs, abs).split('\\').join('/');
  return (isAbsolute(rel) || isOutsideRootRelative(rel)) ? undefined : rel;
}

function resolveTargetsAgainst(
  rootDirAbs: string,
  baseAbsDir: string,
  rawTargets: readonly string[],
  declaredIn: string,
  refusals: AliasConfigRefusal[],
): string[] {
  const results: string[] = [];
  for (const rawTarget of rawTargets) {
    const contained = containRelativeTarget(rootDirAbs, baseAbsDir, rawTarget);
    if (contained === undefined) {
      refuse(refusals, 'target-outside-root', declaredIn, rawTarget);
      continue;
    }
    results.push(contained);
  }
  return results;
}

/**
 * Builds `paths` and `baseUrl` entries from a resolved chain. Per TypeScript's
 * own module-resolution rule: when an effective `baseUrl` exists ANYWHERE in
 * the chain, every `paths` target is resolved relative to baseUrl's own
 * resolved directory — regardless of which config in the chain textually
 * declared the `paths` object itself. Only when no `baseUrl` is present at
 * all are `paths` targets resolved relative to the directory of the config
 * that declared `paths` (`pathsBasePath` in TS's own terms). Both mechanisms
 * are recorded whenever present (a `paths` match and the `baseUrl` catch-all
 * are not mutually exclusive at the table-building stage); which one a given
 * specifier should actually use is left to the consumer applying this table
 * (see the feature doc's task A-2 — this function only builds the table, it
 * does not implement TypeScript's exact non-relative-specifier resolution
 * algorithm).
 */
function buildTsconfigEntries(rootDirAbs: string, merged: MergedChainResult, refusals: AliasConfigRefusal[]): {
  readonly pathsEntries: AliasMappingEntry[];
  readonly baseUrlEntries: AliasMappingEntry[];
} {
  const pathsEntries: AliasMappingEntry[] = [];
  const baseUrlEntries: AliasMappingEntry[] = [];

  const baseUrlAbsDir = merged.baseUrl !== undefined
    ? resolve(rootDirAbs, merged.baseUrl.declaringDir, merged.baseUrl.value)
    : undefined;

  if (merged.paths !== undefined) {
    const pathsBaseAbsDir = baseUrlAbsDir ?? resolve(rootDirAbs, merged.paths.declaringDir);
    for (const [pattern, rawTargets] of Object.entries(merged.paths.value)) {
      const targets = resolveTargetsAgainst(rootDirAbs, pathsBaseAbsDir, rawTargets, merged.paths.declaredIn, refusals);
      if (targets.length > 0) {
        pathsEntries.push({ source: 'paths', pattern, targets, declaredIn: merged.paths.declaredIn });
      }
    }
  }

  if (merged.baseUrl !== undefined && baseUrlAbsDir !== undefined) {
    const targets = resolveTargetsAgainst(rootDirAbs, baseUrlAbsDir, ['*'], merged.baseUrl.declaredIn, refusals);
    if (targets.length > 0) {
      baseUrlEntries.push({ source: 'baseUrl', pattern: '*', targets, declaredIn: merged.baseUrl.declaredIn });
    }
  }

  return { pathsEntries, baseUrlEntries };
}

type ConditionalResolution =
  | { readonly kind: 'target'; readonly target: string }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'unsupported' };

/** Resolves a Node `imports`/`exports` conditional value (string, `null`, or a nested condition object) per {@link CONDITION_PREFERENCE}. */
function resolveConditionalValue(value: unknown): ConditionalResolution {
  if (value === null) return { kind: 'blocked' };
  if (typeof value === 'string') return { kind: 'target', target: value };
  if (isPlainObject(value)) {
    for (const condition of CONDITION_PREFERENCE) {
      if (condition in value) {
        const nested = resolveConditionalValue(value[condition]);
        if (nested.kind !== 'unsupported') return nested;
      }
    }
    return { kind: 'unsupported' };
  }
  return { kind: 'unsupported' };
}

function extractImportsEntries(
  rootDirAbs: string,
  packageValue: unknown,
  declaredIn: string,
  refusals: AliasConfigRefusal[],
): AliasMappingEntry[] {
  const root = isPlainObject(packageValue) ? packageValue : {};
  const importsValue = root.imports;
  if (!isPlainObject(importsValue)) return [];

  const baseAbsDir = resolve(rootDirAbs, repoDirOf(declaredIn));
  const entries: AliasMappingEntry[] = [];
  for (const [key, rawValue] of Object.entries(importsValue)) {
    if (!key.startsWith('#')) continue;
    const resolved = resolveConditionalValue(rawValue);
    if (resolved.kind === 'blocked') continue;
    if (resolved.kind === 'unsupported') {
      refuse(refusals, 'imports-unsupported-conditions', declaredIn, key);
      continue;
    }
    if (!resolved.target.startsWith('./')) {
      refuse(refusals, 'imports-external-target', declaredIn, key);
      continue;
    }
    const contained = containRelativeTarget(rootDirAbs, baseAbsDir, resolved.target);
    if (contained === undefined) {
      refuse(refusals, 'target-outside-root', declaredIn, resolved.target);
      continue;
    }
    entries.push({ source: 'imports', pattern: key, targets: [contained], declaredIn });
  }
  return entries;
}

/** A workspace package's own static entry-point target: `exports['.']` (string or a resolvable conditional object) if present, else `main`, else `undefined`. Never `require`d or evaluated — read as data only. */
function packageEntryTarget(pkg: Record<string, unknown>): string | undefined {
  const exportsValue = pkg.exports;
  if (typeof exportsValue === 'string') return exportsValue;
  if (isPlainObject(exportsValue)) {
    const dot = exportsValue['.'];
    if (dot !== undefined) {
      const resolved = resolveConditionalValue(dot);
      if (resolved.kind === 'target') return resolved.target;
    }
  }
  return typeof pkg.main === 'string' ? pkg.main : undefined;
}

/**
 * Expands workspace glob patterns (e.g. `packages/*`) into repository-relative
 * package directories using real directory listings (never the injectable
 * reader, which is for file content — see {@link findNearestConfigFile}).
 * Each pattern is walked segment by segment so only directories actually
 * matching the pattern are ever listed (no whole-repository walk); a
 * `node_modules` or dot-prefixed directory is never descended into or
 * returned, regardless of the pattern.
 */
async function expandWorkspaceGlobs(rootDirAbs: string, patterns: readonly string[]): Promise<string[]> {
  const results = new Set<string>();
  for (const pattern of patterns) {
    const segments = pattern.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    let currentDirs: string[] = [''];
    for (const segment of segments) {
      const hasGlob = /[*?{]/u.test(segment);
      const nextDirs: string[] = [];
      for (const currentDir of currentDirs) {
        let entries;
        try {
          entries = await readdir(resolve(rootDirAbs, currentDir), { withFileTypes: true });
        } catch {
          continue;
        }
        if (!hasGlob) {
          if (entries.some((entry) => entry.name === segment && entry.isDirectory())) {
            nextDirs.push(joinRepoRelative(currentDir, segment));
          }
          continue;
        }
        const regex = globRegExp(segment);
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          if (regex.test(entry.name)) nextDirs.push(joinRepoRelative(currentDir, entry.name));
        }
      }
      currentDirs = nextDirs;
    }
    for (const dir of currentDirs) {
      if (!dir.split('/').includes('node_modules')) results.add(dir);
    }
  }
  return [...results].sort();
}

function workspacePatterns(rootPackageValue: unknown): readonly string[] {
  const root = isPlainObject(rootPackageValue) ? rootPackageValue : {};
  const raw = root.workspaces;
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  if (isPlainObject(raw) && Array.isArray(raw.packages)) {
    return raw.packages.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

async function resolveWorkspaceEntries(
  rootDirAbs: string,
  rootDirForRead: string,
  rootPackageValue: unknown,
  readSource: (request: SourceReadRequest) => Promise<string>,
  refusals: AliasConfigRefusal[],
  configFilesRead: Set<string>,
): Promise<AliasMappingEntry[]> {
  const patterns = workspacePatterns(rootPackageValue);
  if (patterns.length === 0) return [];

  const packageDirs = await expandWorkspaceGlobs(rootDirAbs, patterns);
  const entries: AliasMappingEntry[] = [];
  for (const dir of packageDirs) {
    const packageJsonPath = joinRepoRelative(dir, 'package.json');
    const outcome = await readAndParseConfig(rootDirForRead, packageJsonPath, readSource);
    if (outcome.kind === 'malformed') {
      configFilesRead.add(packageJsonPath);
      refuse(refusals, 'config-malformed', packageJsonPath, outcome.detail);
      continue;
    }
    if (outcome.kind === 'unreadable') {
      configFilesRead.add(packageJsonPath);
      refuse(refusals, 'config-unreadable', packageJsonPath, outcome.detail);
      continue;
    }
    if (outcome.kind !== 'ok') continue; // not every glob match is necessarily a package (no package.json there at all); skip silently.
    configFilesRead.add(packageJsonPath);

    const pkg = isPlainObject(outcome.value) ? outcome.value : {};
    const name = typeof pkg.name === 'string' ? pkg.name : undefined;
    if (name === undefined) continue;

    const entryTarget = packageEntryTarget(pkg);
    const declaredTarget = entryTarget !== undefined
      ? containRelativeTarget(rootDirAbs, resolve(rootDirAbs, dir), entryTarget)
      : undefined;
    // The package directory is always kept as a fallback target alongside a
    // declared entry file (e.g. a built "main": "./dist/index.js" that the
    // deny list will later refuse to read): without it, a source-only
    // consumer would have no candidate at all when the declared entry isn't
    // actually readable evidence. See this task's report for the tradeoff.
    const targets = declaredTarget !== undefined ? [declaredTarget, dir] : [dir];

    entries.push({ source: 'workspace', pattern: name, targets, declaredIn: packageJsonPath });
    entries.push({ source: 'workspace', pattern: `${name}/*`, targets: [`${dir}/*`], declaredIn: packageJsonPath });
  }
  return entries;
}

export async function resolveAliasConfig(request: AliasConfigRequest): Promise<AliasMappings> {
  const rootDirAbs = await realpath(resolve(request.rootDir));
  const readSource = request.readSource ?? readSourceFile;
  const repositoryRelativePath = normalizeRepositoryRelativePath(request.repositoryRelativePath);

  const refusals: AliasConfigRefusal[] = [];
  const configFilesRead = new Set<string>();

  let pathsEntries: AliasMappingEntry[] = [];
  let baseUrlEntries: AliasMappingEntry[] = [];
  const nearestConfigPath = await findNearestConfigFile(rootDirAbs, repositoryRelativePath, ['tsconfig.json', 'jsconfig.json']);
  if (nearestConfigPath !== undefined) {
    const outcome = await readAndParseConfig(request.rootDir, nearestConfigPath, readSource);
    const merged = await loadConfigChain(
      rootDirAbs,
      request.rootDir,
      nearestConfigPath,
      outcome,
      new Set<string>(),
      readSource,
      refusals,
      configFilesRead,
      0,
    );
    const built = buildTsconfigEntries(rootDirAbs, merged, refusals);
    pathsEntries = built.pathsEntries;
    baseUrlEntries = built.baseUrlEntries;
  }

  let importsEntries: AliasMappingEntry[] = [];
  const nearestPackagePath = await findNearestConfigFile(rootDirAbs, repositoryRelativePath, ['package.json']);
  let nearestPackageOutcome: ConfigReadOutcome | undefined;
  if (nearestPackagePath !== undefined) {
    nearestPackageOutcome = await readAndParseConfig(request.rootDir, nearestPackagePath, readSource);
    configFilesRead.add(nearestPackagePath);
    if (nearestPackageOutcome.kind === 'malformed') {
      refuse(refusals, 'config-malformed', nearestPackagePath, nearestPackageOutcome.detail);
    } else if (nearestPackageOutcome.kind === 'unreadable') {
      refuse(refusals, 'config-unreadable', nearestPackagePath, nearestPackageOutcome.detail);
    } else if (nearestPackageOutcome.kind === 'ok') {
      importsEntries = extractImportsEntries(rootDirAbs, nearestPackageOutcome.value, nearestPackagePath, refusals);
    }
  }

  let workspaceEntries: AliasMappingEntry[] = [];
  const rootPackagePath = 'package.json';
  // The nearest package.json search may already have read the root's own
  // package.json (when the file being resolved has no nearer one) — reuse
  // that outcome instead of reading it a second time, keeping "each config
  // file is read at most once per call" true even with a non-memoizing
  // `readSource`.
  const rootOutcome = nearestPackagePath === rootPackagePath && nearestPackageOutcome !== undefined
    ? nearestPackageOutcome
    : await readAndParseConfig(request.rootDir, rootPackagePath, readSource);
  if (rootOutcome.kind === 'malformed') {
    configFilesRead.add(rootPackagePath);
    if (nearestPackagePath !== rootPackagePath) refuse(refusals, 'config-malformed', rootPackagePath, rootOutcome.detail);
  } else if (rootOutcome.kind === 'unreadable') {
    configFilesRead.add(rootPackagePath);
    if (nearestPackagePath !== rootPackagePath) refuse(refusals, 'config-unreadable', rootPackagePath, rootOutcome.detail);
  } else if (rootOutcome.kind === 'ok') {
    configFilesRead.add(rootPackagePath);
    workspaceEntries = await resolveWorkspaceEntries(rootDirAbs, request.rootDir, rootOutcome.value, readSource, refusals, configFilesRead);
  }

  return {
    entries: [...importsEntries, ...pathsEntries, ...workspaceEntries, ...baseUrlEntries],
    configFiles: [...configFilesRead].sort(),
    refusals,
  };
}

/** Injectable, per-directory-cached alias mapping lookup (see {@link createMemoizingAliasConfigReader}). */
export type AliasConfigReader = (repositoryRelativePath: string) => Promise<AliasMappings>;

/**
 * Wraps {@link resolveAliasConfig} with an in-memory cache keyed by the
 * importing file's DIRECTORY (not its full path): every file in the same
 * directory shares the exact same nearest-config search and merged
 * `baseUrl`/`paths`/`imports`/workspace table, so this avoids re-walking the
 * ancestry chain, re-parsing config text, and re-expanding workspace globs
 * once per specifier or once per file — task A-2's "one config read per
 * directory per run, not per specifier" requirement
 * (`odd/tasks/path-alias-resolution.md`). As with
 * `createMemoizingSourceReader` (`src/adapters/evidence-audit-port.ts`), the
 * *promise* itself is cached, so concurrent lookups for the same directory
 * dedupe onto one underlying {@link resolveAliasConfig} call instead of
 * racing.
 *
 * Pass the SAME run-scoped `readSource` used elsewhere in the run (e.g. from
 * `createMemoizingSourceReader`) so the raw config file reads this performs
 * are ALSO deduped across every directory that happens to share a config
 * file. The two caches are complementary, not redundant: this one avoids
 * redoing the table-building computation itself; the shared reader avoids
 * redoing the disk read that computation requires.
 *
 * Intended to be created once per audit run (see `createAuditEvidencePort`
 * in `src/adapters/evidence-audit-port.ts`) and passed to every
 * `resolveEvidenceFiles` call in that run, exactly like the memoizing source
 * reader; never reused across runs, since a later run may target a
 * different `rootDir` or see changed configuration.
 */
export function createMemoizingAliasConfigReader(
  rootDir: string,
  readSource?: (request: SourceReadRequest) => Promise<string>,
): AliasConfigReader {
  const cache = new Map<string, Promise<AliasMappings>>();
  return (repositoryRelativePath: string): Promise<AliasMappings> => {
    const directory = repoDirOf(normalizeRepositoryRelativePath(repositoryRelativePath));
    const cached = cache.get(directory);
    if (cached !== undefined) return cached;
    const pending = resolveAliasConfig({
      rootDir,
      repositoryRelativePath,
      ...(readSource === undefined ? {} : { readSource }),
    });
    cache.set(directory, pending);
    return pending;
  };
}
