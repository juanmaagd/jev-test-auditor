import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  DEFAULT_EVIDENCE_DENY_PATTERNS,
  type DeniedEvidence,
  type ResolvedEvidenceFile,
  type UnresolvedEvidence,
  type UnresolvedEvidenceReason,
} from '../domain/evidence.js';
import { normalizeRepositoryRelativePath, type ImportRecord } from '../domain/test-understanding.js';
import type { SourceReadRequest } from '../domain/audit.js';
import type { AliasMappingEntry, AliasMappingSource, AliasMappings } from '../domain/alias-config.js';
import { createMemoizingAliasConfigReader, type AliasConfigReader } from './alias-config.js';
import { isOutsideRootRelative } from './containment.js';
import { globRegExp, matchesGlob } from './repository-discovery.js';
import { readSourceFile } from './source-reader.js';
import { importRecordsFor } from './test-extraction.js';

export interface EvidenceResolutionRequest {
  readonly rootDir: string;
  /** Repository-relative path of the test file whose imports seed hop 1. */
  readonly testFilePath: string;
  /** The test file's own relative imports (hop 1), already extracted by the caller. */
  readonly imports: readonly ImportRecord[];
  /** Additive glob deny patterns, layered on top of {@link DEFAULT_EVIDENCE_DENY_PATTERNS}. */
  readonly deny?: readonly string[];
  /**
   * Injectable reader for the hop-1 helper files this function must read to
   * discover hop-2 imports. Defaults to {@link readSourceFile}. A caller that
   * shares one memoizing reader across an entire audit run (see
   * `src/adapters/evidence-audit-port.ts`) passes it here too, so a helper
   * read by resolution is never re-read by fragment selection.
   */
  readonly readSource?: (request: SourceReadRequest) => Promise<string>;
  /**
   * Injectable, per-directory-cached alias mapping lookup (task A-2,
   * `odd/tasks/path-alias-resolution.md`), consulted for every non-relative
   * specifier BEFORE it is classified `bare-specifier`/`alias-specifier`.
   * Defaults to a fresh {@link createMemoizingAliasConfigReader} built from
   * this request's `rootDir`/`readSource`, which already dedupes repeated
   * lookups for the same directory WITHIN this one call (hop 1 and hop 2
   * alike). A caller running many files in one audit (see
   * `createAuditEvidencePort` in `src/adapters/evidence-audit-port.ts`)
   * passes ONE reader shared across every `resolveEvidenceFiles` call in
   * that run, so a directory's configuration is read at most once per run,
   * not once per file or per specifier.
   */
  readonly getAliasMappings?: AliasConfigReader;
}

export interface EvidenceResolutionResult {
  readonly files: readonly ResolvedEvidenceFile[];
  readonly denied: readonly DeniedEvidence[];
  readonly unresolved: readonly UnresolvedEvidence[];
}

/**
 * Extensions probed, in this exact order, both when appending an extension
 * to an extension-less specifier and when probing `index<ext>` inside a
 * directory. This is the project's declared probing priority: TypeScript
 * sources first, then their JSX/module-kind siblings, then plain JS.
 */
const APPEND_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const;
const SOURCE_EXTENSIONS = new Set<string>(APPEND_EXTENSIONS);

/**
 * TS-ESM rewrite targets: a specifier written with a compiled-JS-style
 * extension is retried against its TypeScript source extension(s), in
 * order, before any generic extension-appending is attempted.
 */
const TS_ESM_REWRITE: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const HELPER_PATH_SEGMENTS = new Set(['test', 'tests', '__tests__', '__mocks__']);
const HELPER_BASENAME_MARKERS = ['helper', 'fixture', 'setup'];

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * The FALLBACK classification for a non-relative specifier that matched no
 * statically declared alias mapping (see {@link resolveViaAliasMapping} in
 * this file, task A-2 — every non-relative specifier is first checked
 * against the importing file's `tsconfig`/`jsconfig` `paths`/`baseUrl`,
 * `package.json` `imports`, and workspace package names before it ever
 * reaches this function). A specifier starting with `@/`, `~/`, or `#` is
 * classified `alias-specifier` (conventional path-alias prefixes). Every
 * other non-relative specifier, including any `@scope/name` (e.g.
 * `@babel/core`, `@tanstack/react-query`), is classified `bare-specifier`.
 * A scoped alias such as `@app/utils` is reported as `bare-specifier` too
 * when nothing maps it: it is structurally indistinguishable from a real
 * scoped npm package once no mapping applies. This resolver never resolves
 * into `node_modules` regardless of classification (the deny list blocks
 * it even for a mapped target that lands there). A hard-coded allowlist of
 * "known" npm scopes was deliberately rejected — it would silently
 * misreport any unlisted real package (e.g. `@nestjs/core`) as an alias and
 * drift out of date. Misclassifying a scoped alias as bare has no safety
 * impact: both outcomes leave the specifier unresolved and unread; only the
 * diagnostic `reason` differs.
 */
function classifyNonRelativeSpecifier(specifier: string): 'bare-specifier' | 'alias-specifier' {
  if (specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('#')) return 'alias-specifier';
  return 'bare-specifier';
}

function isSourceExtension(extension: string): boolean {
  return SOURCE_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * Helper classification, applied to an already-normalized repository-relative
 * path: a test file (`.test.`/`.spec.` in the basename), or a path with a
 * `test`/`tests`/`__tests__`/`__mocks__` segment, or a basename containing
 * `helper`, `fixture`, or `setup` (case-insensitive). Everything else is
 * production.
 */
function isHelperPath(repositoryRelativePath: string): boolean {
  const base = basename(repositoryRelativePath).toLowerCase();
  if (base.includes('.test.') || base.includes('.spec.')) return true;
  if (HELPER_BASENAME_MARKERS.some((marker) => base.includes(marker))) return true;
  return repositoryRelativePath.split('/').some((segment) => HELPER_PATH_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * Builds the ordered probing candidates for a specifier already resolved to
 * an absolute base path (no extension logic applied yet): the exact path;
 * then, only when the base's own extension has a TS-ESM rewrite target, the
 * rewritten path(s); then, unless the base's own extension is already a
 * recognized source extension or a rewrite source (appending further would
 * either be redundant, e.g. `foo.ts` + `.ts`, or nonsensical, e.g. `foo.js`
 * + `.ts` instead of the proper `.js` -> `.ts` rewrite), the base with each
 * of {@link APPEND_EXTENSIONS} appended — this also covers a specifier
 * whose trailing dotted segment is not a language extension at all but part
 * of the `.test`/`.spec`/`.helper` naming convention (e.g. `./math.test`
 * for `math.test.ts`, or `./outer.helper` for `outer.helper.ts`); then,
 * always, the base treated as a directory with `index<ext>` for each of
 * {@link APPEND_EXTENSIONS}.
 */
function probingCandidates(base: string): readonly string[] {
  const candidates: string[] = [base];
  const extension = extname(base);
  const lowerExtension = extension.toLowerCase();
  const rewriteTargets = TS_ESM_REWRITE[lowerExtension] ?? [];
  if (rewriteTargets.length > 0) {
    const withoutExtension = base.slice(0, base.length - extension.length);
    for (const target of rewriteTargets) candidates.push(withoutExtension + target);
  }
  const hasRecognizedExtension = rewriteTargets.length > 0 || SOURCE_EXTENSIONS.has(lowerExtension);
  if (!hasRecognizedExtension) {
    for (const appended of APPEND_EXTENSIONS) candidates.push(base + appended);
  }
  for (const appended of APPEND_EXTENSIONS) candidates.push(resolve(base, `index${appended}`));
  return candidates;
}

/**
 * Matches a repository-relative candidate path against one deny pattern. A
 * pattern with no `/` matches the candidate's basename alone, at any depth
 * (e.g. `*.pem` denies `secrets/key.pem`); a pattern containing `/` matches
 * the full candidate path with `**`/`*`/`{a,b}` glob semantics (reused from
 * repository discovery's exclude matching).
 */
function matchedDenyPattern(repositoryRelativePath: string, patterns: readonly string[]): string | undefined {
  const base = basename(repositoryRelativePath);
  return patterns.find((pattern) => (
    pattern.includes('/') ? matchesGlob(pattern, repositoryRelativePath) : globRegExp(pattern).test(base)
  ));
}

function absoluteFromRepoRelative(rootDir: string, repositoryRelativePath: string): string {
  return resolve(rootDir, ...repositoryRelativePath.split('/'));
}

function scriptKindForPath(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

type ResolveOutcome =
  | { readonly kind: 'resolved'; readonly repositoryRelativePath: string }
  | { readonly kind: 'denied'; readonly repositoryRelativePath: string; readonly rule: string }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedEvidenceReason }
  /** Resolved successfully, but to the test file itself: never returned as evidence, and not an error. */
  | { readonly kind: 'self' };

/**
 * {@link ResolveOutcome} plus one internal-only case: every probing
 * candidate for THIS ONE base path was tried and none existed. Kept
 * separate from `{ kind: 'unresolved', reason: 'not-found' }` because the
 * two callers below translate it differently: a single relative specifier
 * has only one base, so it becomes `not-found` directly; an alias-mapped
 * specifier may have several target bases tried in order (see
 * {@link resolveViaAliasMapping}), where `no-candidate` means "try the next
 * target" rather than "give up".
 */
type ProbeOutcome = ResolveOutcome | { readonly kind: 'no-candidate' };

/**
 * Probes one absolute base path (already containment-checked by the
 * caller) through the project's ordered extension/index candidates,
 * applying the feature's mandatory rules in order: a realpath containment
 * check per existing candidate (catches a symlink escape), then — for the
 * first existing, in-root, regular-file candidate — the deny-list gate
 * before any extension-support check, so a denied file is always reported
 * as denied rather than merely "unsupported extension". Shared by relative
 * specifiers ({@link resolveRelativeSpecifier}) and every alias-mapped
 * target ({@link resolveViaAliasMapping}, task A-2): "each candidate target
 * goes through the existing extension/index probing, the deny list before
 * any read, and realpath containment" applies identically to both.
 */
async function probeBase(
  rootDir: string,
  base: string,
  denyPatterns: readonly string[],
  testFilePath: string,
): Promise<ProbeOutcome> {
  for (const candidate of probingCandidates(base)) {
    let candidateStat;
    try {
      candidateStat = await lstat(candidate);
    } catch {
      continue;
    }
    if (candidateStat.isDirectory()) continue;

    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    const relativeReal = relative(rootDir, real);
    if (isAbsolute(relativeReal) || isOutsideRootRelative(relativeReal)) {
      return { kind: 'unresolved', reason: 'outside-root' };
    }

    let realStat;
    try {
      realStat = await stat(real);
    } catch {
      continue;
    }
    if (!realStat.isFile()) continue;

    const repositoryRelativePath = normalizeRepositoryRelativePath(relativeReal);

    const denyRule = matchedDenyPattern(repositoryRelativePath, denyPatterns);
    if (denyRule !== undefined) {
      return { kind: 'denied', repositoryRelativePath, rule: `deny-list:${denyRule}` };
    }

    if (!isSourceExtension(extname(repositoryRelativePath))) {
      return { kind: 'unresolved', reason: 'unsupported-extension' };
    }

    if (repositoryRelativePath === testFilePath) return { kind: 'self' };

    return { kind: 'resolved', repositoryRelativePath };
  }

  return { kind: 'no-candidate' };
}

/** Resolves a relative specifier: lexical containment of the un-extended base, then {@link probeBase}. */
async function resolveRelativeSpecifier(
  rootDir: string,
  importerRepositoryRelativePath: string,
  specifier: string,
  denyPatterns: readonly string[],
  testFilePath: string,
): Promise<ResolveOutcome> {
  const importerDirectory = dirname(absoluteFromRepoRelative(rootDir, importerRepositoryRelativePath));
  const base = resolve(importerDirectory, specifier);
  const relativeBase = relative(rootDir, base);
  if (isAbsolute(relativeBase) || isOutsideRootRelative(relativeBase)) {
    return { kind: 'unresolved', reason: 'outside-root' };
  }

  const outcome = await probeBase(rootDir, base, denyPatterns, testFilePath);
  return outcome.kind === 'no-candidate' ? { kind: 'unresolved', reason: 'not-found' } : outcome;
}

/** Precedence order for alias mechanisms (task A-2's decision): Node subpath `imports` beats tsconfig/jsconfig `paths`, which beats a workspace package name, which beats a bare `baseUrl` catch-all. Applied uniformly to every non-relative specifier — a `#`-prefixed specifier is filtered to the `imports` group structurally (A-1 only ever emits `#`-prefixed `imports` patterns), so no separate branch on the specifier's own prefix is needed. */
const ALIAS_PRECEDENCE: readonly AliasMappingSource[] = ['imports', 'paths', 'workspace', 'baseUrl'];

interface AliasMatch {
  readonly entry: AliasMappingEntry;
  /** The text captured by the pattern's single `*`, or `undefined` for an exact (star-less) pattern match. */
  readonly capture?: string;
}

function countAsterisks(pattern: string): number {
  let count = 0;
  for (const character of pattern) if (character === '*') count += 1;
  return count;
}

/**
 * TypeScript's own `matchPatternOrExact` rule (`tryParsePatterns` +
 * `findBestPatternMatch` in the TypeScript compiler), applied within ONE
 * mechanism's entries at a time (this function is called once per
 * {@link ALIAS_PRECEDENCE} group, never across groups): an exact
 * (star-less) pattern equal to the specifier wins outright over any
 * wildcard pattern, regardless of declaration order; otherwise, among the
 * wildcard patterns that match, the one with the longest PREFIX (the text
 * before its single `*`) wins, with ties broken by declaration order. A
 * pattern containing two or more `*` characters is malformed and never
 * matches anything (mirrors TypeScript's own `hasZeroOrOneAsteriskCharacter`
 * guard) — A-1 does not itself validate this, so it is enforced here.
 */
function findBestMatch(entries: readonly AliasMappingEntry[], specifier: string): AliasMatch | undefined {
  for (const entry of entries) {
    if (countAsterisks(entry.pattern) === 0 && entry.pattern === specifier) return { entry };
  }

  let best: (AliasMatch & { readonly prefixLength: number }) | undefined;
  for (const entry of entries) {
    if (countAsterisks(entry.pattern) !== 1) continue;
    const starIndex = entry.pattern.indexOf('*');
    const prefix = entry.pattern.slice(0, starIndex);
    const suffix = entry.pattern.slice(starIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (specifier.length < prefix.length + suffix.length) continue;
    if (best !== undefined && prefix.length <= best.prefixLength) continue;
    best = { entry, capture: specifier.slice(prefix.length, specifier.length - suffix.length), prefixLength: prefix.length };
  }
  return best;
}

function substituteTarget(target: string, capture: string | undefined): string {
  return capture === undefined ? target : target.replace('*', capture);
}

/**
 * Task A-2's decision for "Workspace entry points that are build output"
 * (`odd/tasks/path-alias-resolution.md`): a workspace package's bare-name
 * entry's targets, as built by `resolveWorkspaceEntries` in
 * `src/adapters/alias-config.ts`, are always `[declaredEntry?, packageDir]`
 * — the declared `exports`/`main` entry (if any) first, then the package
 * directory itself as the plain fallback. This reconstructs `packageDir` as
 * the LAST element and any declared entry as everything before it (A-1
 * never emits more than one declared entry, but this tolerates any count),
 * then reorders the trial sequence to prefer a plausible SOURCE file over a
 * declared entry that is very commonly generated build output (e.g.
 * `dist/index.js`, blocked by the `**\/dist/**` deny pattern):
 * `packageDir/src/index` (probed with the project's normal extension/index
 * rules) first, then the package directory's own top-level probing
 * (`packageDir/index.ts` etc., via the same probing on `packageDir`
 * itself), and only THEN the declared entry — so a real source layout
 * resolves before ever touching the declared entry, and the declared entry
 * is reached (and, if it is denied build output, reported `denied` rather
 * than silently dropped — see {@link resolveViaAliasMapping}) only when no
 * plausible source file exists at all.
 */
function orderedWorkspaceEntryTargets(targets: readonly string[]): readonly string[] {
  const packageDir = targets[targets.length - 1] ?? '';
  const declaredEntries = targets.slice(0, -1);
  return [`${packageDir}/src/index`, packageDir, ...declaredEntries];
}

/** Ordered target bases to try for one matched alias entry, applying the workspace source-preference reorder ({@link orderedWorkspaceEntryTargets}) only to a workspace package's bare (non-wildcard) name entry — a `name/*` subpath match has no such ambiguity and is substituted as-is. */
function orderedTargetsFor(match: AliasMatch): readonly string[] {
  const substituted = match.entry.targets.map((target) => substituteTarget(target, match.capture));
  const isBareWorkspaceEntry = match.entry.source === 'workspace' && countAsterisks(match.entry.pattern) === 0;
  return isBareWorkspaceEntry ? orderedWorkspaceEntryTargets(substituted) : substituted;
}

/**
 * Resolves a non-relative specifier against the importing file's alias
 * mapping table (task A-2). Walks {@link ALIAS_PRECEDENCE} in order; for
 * each mechanism that has a matching entry ({@link findBestMatch}), tries
 * that entry's targets in declaration order (with the workspace
 * source-preference reorder applied where relevant), re-checking
 * containment after wildcard substitution — the DECLARED target string was
 * already containment-checked by A-1, but the specifier's own captured
 * portion is caller-controlled text that could contain `../` segments, so
 * the SUBSTITUTED result must be re-checked here before ever touching the
 * filesystem — then probing each target exactly like a relative specifier
 * ({@link probeBase}: extension/index probing, deny list, realpath
 * containment).
 *
 * The first target that produces an existing file (`resolved`, `denied`,
 * `self`, or a symlink `outside-root`/`unsupported-extension`) is terminal:
 * the search stops there, whether or not the file could actually be used
 * as evidence. Divergence from a literal reading of the feature doc's "the
 * first mechanism that produces an existing, in-root, non-denied file
 * wins": a `denied` (or escaping) target does NOT fall through to try a
 * LATER mechanism in this implementation — see this task's report for why
 * this was chosen over continuing to search. A target that produces no
 * candidate at all (`no-candidate`) is NOT terminal: the search continues
 * to the next target, and — once an entry's whole target list is
 * exhausted — to the next mechanism in {@link ALIAS_PRECEDENCE}.
 *
 * Returns `undefined` when no mechanism matched the specifier at all,
 * letting the caller fall back to {@link classifyNonRelativeSpecifier}.
 * When at least one `imports`/`paths`/`workspace` entry matched but every
 * target of every matching entry was `no-candidate`, returns
 * `alias-mapped-not-found` — a mapping was declared, it just pointed
 * nowhere. A `baseUrl` catch-all match alone does NOT set this: `baseUrl`
 * is a search root, not a declared mapping, so an unmatched specifier under
 * a bare `baseUrl` still falls back to `bare-specifier`/`alias-specifier`
 * (this matters for every real repository that declares `baseUrl` without
 * `paths`, e.g. supermarket-pro's backend tsconfig — otherwise `lodash`,
 * `@nestjs/core`, etc. would all be misreported as a stale alias).
 */
async function resolveViaAliasMapping(
  rootDir: string,
  aliasMappings: AliasMappings,
  specifier: string,
  denyPatterns: readonly string[],
  testFilePath: string,
): Promise<ResolveOutcome | undefined> {
  let matchedDeclaredMapping = false;

  for (const source of ALIAS_PRECEDENCE) {
    const entries = aliasMappings.entries.filter((entry) => entry.source === source);
    const match = findBestMatch(entries, specifier);
    if (match === undefined) continue;
    if (source !== 'baseUrl') matchedDeclaredMapping = true;

    for (const target of orderedTargetsFor(match)) {
      const absoluteTarget = resolve(rootDir, ...target.split('/'));
      const relativeTarget = relative(rootDir, absoluteTarget);
      if (isAbsolute(relativeTarget) || isOutsideRootRelative(relativeTarget)) {
        return { kind: 'unresolved', reason: 'outside-root' };
      }

      const probed = await probeBase(rootDir, absoluteTarget, denyPatterns, testFilePath);
      if (probed.kind !== 'no-candidate') return probed;
    }
  }

  return matchedDeclaredMapping ? { kind: 'unresolved', reason: 'alias-mapped-not-found' } : undefined;
}

/**
 * Resolves one import specifier of one importer file: a relative specifier
 * through {@link resolveRelativeSpecifier}, a non-relative specifier
 * through the importing file's OWN alias mapping table (fetched via
 * `getAliasMappings(importerRepositoryRelativePath)` — a hop-2 helper's
 * specifiers use the HELPER's nearest configuration, never the test file's,
 * task A-2), falling back to {@link classifyNonRelativeSpecifier} when no
 * mapping matched at all.
 */
async function resolveSpecifier(
  rootDir: string,
  importerRepositoryRelativePath: string,
  specifier: string,
  denyPatterns: readonly string[],
  testFilePath: string,
  getAliasMappings: AliasConfigReader,
): Promise<ResolveOutcome> {
  if (isRelativeSpecifier(specifier)) {
    return resolveRelativeSpecifier(rootDir, importerRepositoryRelativePath, specifier, denyPatterns, testFilePath);
  }

  const aliasMappings = await getAliasMappings(importerRepositoryRelativePath);
  const mapped = await resolveViaAliasMapping(rootDir, aliasMappings, specifier, denyPatterns, testFilePath);
  if (mapped !== undefined) return mapped;

  return { kind: 'unresolved', reason: classifyNonRelativeSpecifier(specifier) };
}

interface FileCandidate {
  readonly repositoryRelativePath: string;
  readonly role: 'helper' | 'production';
  readonly hop: 1 | 2;
  readonly importedFrom: string;
  readonly specifier: string;
}

/**
 * Deduplicates by `repositoryRelativePath`, keeping the lowest `hop`; on a
 * hop tie, keeps the candidate whose `(importedFrom, specifier)` pair sorts
 * first, for a deterministic, input-order-independent result. This is also
 * what makes cycles and self-imports terminate without ever duplicating a
 * file: a file already present (at hop 1 or hop 2) never gains a second
 * entry, regardless of how many other files import it.
 */
function dedupeCandidates(candidates: readonly FileCandidate[]): FileCandidate[] {
  const byPath = new Map<string, FileCandidate>();
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.repositoryRelativePath);
    if (existing === undefined || candidate.hop < existing.hop) {
      byPath.set(candidate.repositoryRelativePath, candidate);
      continue;
    }
    if (candidate.hop === existing.hop) {
      const candidateKey = `${candidate.importedFrom} ${candidate.specifier}`;
      const existingKey = `${existing.importedFrom} ${existing.specifier}`;
      if (candidateKey < existingKey) byPath.set(candidate.repositoryRelativePath, candidate);
    }
  }
  return [...byPath.values()];
}

function dedupeDenied(entries: readonly DeniedEvidence[]): DeniedEvidence[] {
  const byKey = new Map<string, DeniedEvidence>();
  for (const entry of entries) byKey.set(`${entry.repositoryRelativePath} ${entry.rule}`, entry);
  return [...byKey.values()].sort((left, right) => (
    compareStrings(left.repositoryRelativePath, right.repositoryRelativePath) || compareStrings(left.rule, right.rule)
  ));
}

function dedupeUnresolved(entries: readonly UnresolvedEvidence[]): UnresolvedEvidence[] {
  const byKey = new Map<string, UnresolvedEvidence>();
  for (const entry of entries) byKey.set(`${entry.specifier} ${entry.reason}`, entry);
  return [...byKey.values()].sort((left, right) => (
    compareStrings(left.specifier, right.specifier) || compareStrings(left.reason, right.reason)
  ));
}

function applyOutcome(
  outcome: ResolveOutcome,
  record: ImportRecord,
  importedFrom: string,
  hop: 1 | 2,
  candidates: FileCandidate[],
  denied: DeniedEvidence[],
  unresolved: UnresolvedEvidence[],
): void {
  const specifierText = record.specifier ?? '';
  if (outcome.kind === 'resolved') {
    candidates.push({
      repositoryRelativePath: outcome.repositoryRelativePath,
      role: isHelperPath(outcome.repositoryRelativePath) ? 'helper' : 'production',
      hop,
      importedFrom,
      specifier: specifierText,
    });
  } else if (outcome.kind === 'denied') {
    denied.push({ repositoryRelativePath: outcome.repositoryRelativePath, rule: outcome.rule });
  } else if (outcome.kind === 'unresolved') {
    unresolved.push({ specifier: specifierText, reason: outcome.reason });
  }
  // 'self': the test file itself is never returned as evidence; silently dropped.
}

/**
 * Resolves a test file's imports into repository-local evidence files: hop
 * 1 is the test file's own imports (as already extracted by the caller);
 * for each hop-1 file classified as a `helper`, its own imports are
 * resolved once more as hop 2. Production files, and every hop-2 file
 * regardless of role, are never expanded further. A relative specifier
 * resolves lexically against its importer's directory; a non-relative
 * specifier is first checked against the IMPORTING file's own statically
 * declared alias mapping table — `tsconfig`/`jsconfig` `paths`/`baseUrl`,
 * `package.json` `imports`, and workspace package names (task A-2,
 * `odd/tasks/path-alias-resolution.md`) — so a hop-2 helper's specifiers
 * use the helper's own nearest configuration, never the test file's. Never
 * executes, `require`s, or `import()`s any repository file, or any
 * configuration file — only text reads (via {@link readSourceFile}) and
 * static parsing (TypeScript-compiler-API for source, JSONC for
 * configuration) of the hop-1 helpers and configuration files it must read.
 * See {@link resolveSpecifier} for the per-specifier resolution/alias/
 * containment/deny rules and {@link probingCandidates} for the
 * extension/index probing order.
 */
export async function resolveEvidenceFiles(request: EvidenceResolutionRequest): Promise<EvidenceResolutionResult> {
  const requestedRoot = resolve(request.rootDir);
  if ((await lstat(requestedRoot)).isSymbolicLink()) {
    throw new RangeError(`Evidence root must not be a symlink: ${request.rootDir}`);
  }
  const rootDir = await realpath(requestedRoot);
  const testFilePath = normalizeRepositoryRelativePath(request.testFilePath);
  const denyPatterns: readonly string[] = [...DEFAULT_EVIDENCE_DENY_PATTERNS, ...(request.deny ?? [])];
  const readSource = request.readSource ?? readSourceFile;
  const getAliasMappings = request.getAliasMappings ?? createMemoizingAliasConfigReader(request.rootDir, readSource);

  const denied: DeniedEvidence[] = [];
  const unresolved: UnresolvedEvidence[] = [];
  const hop1Candidates: FileCandidate[] = [];

  for (const record of request.imports) {
    if (record.specifier === undefined) {
      applyOutcome({ kind: 'unresolved', reason: 'dynamic-specifier' }, record, testFilePath, 1, hop1Candidates, denied, unresolved);
      continue;
    }
    const outcome = await resolveSpecifier(rootDir, testFilePath, record.specifier, denyPatterns, testFilePath, getAliasMappings);
    applyOutcome(outcome, record, testFilePath, 1, hop1Candidates, denied, unresolved);
  }

  const hop1Files = dedupeCandidates(hop1Candidates);
  const sourceTexts = new Map<string, string>();
  const hop2Candidates: FileCandidate[] = [];

  const hop1Helpers = hop1Files
    .filter((file) => file.role === 'helper')
    .sort((left, right) => compareStrings(left.repositoryRelativePath, right.repositoryRelativePath));

  for (const helper of hop1Helpers) {
    const sourceText = await readSource({
      rootDir: request.rootDir,
      repositoryRelativePath: helper.repositoryRelativePath,
    });
    sourceTexts.set(helper.repositoryRelativePath, sourceText);

    const sourceFile = ts.createSourceFile(
      helper.repositoryRelativePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(helper.repositoryRelativePath),
    );

    for (const record of importRecordsFor(sourceFile)) {
      if (record.specifier === undefined) {
        applyOutcome({ kind: 'unresolved', reason: 'dynamic-specifier' }, record, helper.repositoryRelativePath, 2, hop2Candidates, denied, unresolved);
        continue;
      }
      const outcome = await resolveSpecifier(rootDir, helper.repositoryRelativePath, record.specifier, denyPatterns, testFilePath, getAliasMappings);
      applyOutcome(outcome, record, helper.repositoryRelativePath, 2, hop2Candidates, denied, unresolved);
    }
  }

  const allFiles = dedupeCandidates([...hop1Files, ...hop2Candidates]);
  const files: ResolvedEvidenceFile[] = allFiles
    .map((candidate): ResolvedEvidenceFile => {
      const sourceText = sourceTexts.get(candidate.repositoryRelativePath);
      return {
        repositoryRelativePath: candidate.repositoryRelativePath,
        role: candidate.role,
        hop: candidate.hop,
        importedFrom: candidate.importedFrom,
        specifier: candidate.specifier,
        ...(sourceText === undefined ? {} : { sourceText }),
      };
    })
    .sort((left, right) => compareStrings(left.repositoryRelativePath, right.repositoryRelativePath));

  return {
    files,
    denied: dedupeDenied(denied),
    unresolved: dedupeUnresolved(unresolved),
  };
}
