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
 * A specifier starting with `@/`, `~/`, or `#` is classified
 * `alias-specifier` (conventional path-alias prefixes). Every other
 * non-relative specifier, including any `@scope/name` (e.g.
 * `@babel/core`, `@tanstack/react-query`), is classified `bare-specifier`.
 * A scoped alias such as `@app/utils` is reported as `bare-specifier` too:
 * it is structurally indistinguishable from a real scoped npm package
 * without consulting `tsconfig` `paths` or `node_modules`, which this
 * resolver is explicitly forbidden from doing (see the feature scope). A
 * hard-coded allowlist of "known" npm scopes was deliberately rejected —
 * it would silently misreport any unlisted real package (e.g.
 * `@nestjs/core`) as an alias and drift out of date. Misclassifying a
 * scoped alias as bare has no safety impact: both outcomes leave the
 * specifier unresolved and unread; only the diagnostic `reason` differs.
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
 * Resolves one import specifier of one importer file. Order of checks,
 * matching the feature's mandatory rules: relative-specifier gate, lexical
 * containment of the un-extended base, ordered candidate probing with a
 * realpath containment check per existing candidate (catches a symlink
 * escape), then — for the first existing, in-root, regular-file candidate —
 * deny-list gate before any extension-support check, so a denied file is
 * always reported as denied rather than merely "unsupported extension".
 */
async function resolveSpecifier(
  rootDir: string,
  importerRepositoryRelativePath: string,
  specifier: string,
  denyPatterns: readonly string[],
  testFilePath: string,
): Promise<ResolveOutcome> {
  if (!isRelativeSpecifier(specifier)) {
    return { kind: 'unresolved', reason: classifyNonRelativeSpecifier(specifier) };
  }

  const importerDirectory = dirname(absoluteFromRepoRelative(rootDir, importerRepositoryRelativePath));
  const base = resolve(importerDirectory, specifier);
  const relativeBase = relative(rootDir, base);
  if (isAbsolute(relativeBase) || isOutsideRootRelative(relativeBase)) {
    return { kind: 'unresolved', reason: 'outside-root' };
  }

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

  return { kind: 'unresolved', reason: 'not-found' };
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
 * Resolves a test file's relative imports into repository-local evidence
 * files: hop 1 is the test file's own imports (as already extracted by the
 * caller); for each hop-1 file classified as a `helper`, its own relative
 * imports are resolved once more as hop 2. Production files, and every
 * hop-2 file regardless of role, are never expanded further. Never
 * executes, `require`s, or `import()`s any repository file — only text
 * reads (via {@link readSourceFile}) and static TypeScript-compiler-API
 * parsing (via {@link importRecordsFor}) of the hop-1 helpers it must read
 * to discover hop-2 imports. See {@link resolveSpecifier} for the
 * per-specifier resolution/containment/deny rules and {@link
 * probingCandidates} for the extension/index probing order.
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

  const denied: DeniedEvidence[] = [];
  const unresolved: UnresolvedEvidence[] = [];
  const hop1Candidates: FileCandidate[] = [];

  for (const record of request.imports) {
    if (record.specifier === undefined) {
      applyOutcome({ kind: 'unresolved', reason: 'dynamic-specifier' }, record, testFilePath, 1, hop1Candidates, denied, unresolved);
      continue;
    }
    const outcome = await resolveSpecifier(rootDir, testFilePath, record.specifier, denyPatterns, testFilePath);
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
      const outcome = await resolveSpecifier(rootDir, helper.repositoryRelativePath, record.specifier, denyPatterns, testFilePath);
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
