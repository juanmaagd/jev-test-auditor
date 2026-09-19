import { posix } from 'node:path';
import ts from 'typescript';
import {
  buildEvidenceBundle,
  validateEvidenceBudget,
  type EvidenceBudget,
  type EvidenceBundle,
  type EvidenceFragment,
  type EvidenceFragmentKind,
  type EvidenceSelectionReason,
  type OmittedEvidence,
  type ResolvedEvidenceFile,
} from '../domain/evidence.js';
import type { SourceReadRequest } from '../domain/audit.js';
import {
  normalizeRepositoryRelativePath,
  normalizeTestSource,
  type MockApi,
  type MockRecord,
  type SourceSpan,
  type TestCase,
} from '../domain/test-understanding.js';
import { hashEvidenceContent } from './evidence-hash.js';
import type { EvidenceResolutionResult } from './evidence-resolution.js';
import { readSourceFile } from './source-reader.js';

export interface EvidenceSelectionRequest {
  readonly rootDir: string;
  readonly testCase: TestCase;
  /** Full source text of the test case's own file (used to slice hook bodies and to build the test file's import-binding table). */
  readonly testFileSource: string;
  /** The P3-2 resolution for this same test file; consumed as-is, never re-resolved. */
  readonly resolution: EvidenceResolutionResult;
  readonly budget: EvidenceBudget;
  /** Injectable file reader for tests; defaults to {@link readSourceFile}. */
  readonly readSource?: (request: SourceReadRequest) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Small local utilities (byte accounting, string comparison, script kind).
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function scriptKindForPath(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function sourceSpanOf(sourceFile: ts.SourceFile, node: ts.Node): SourceSpan {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
}

/** Slices `sourceFile.text` between two 1-based (line, column) positions using the same convention as {@link sourceSpanOf}/`test-extraction.ts`. */
function sliceBySpan(sourceFile: ts.SourceFile, span: SourceSpan): string {
  const start = sourceFile.getPositionOfLineAndCharacter(span.start.line - 1, span.start.column - 1);
  const end = sourceFile.getPositionOfLineAndCharacter(span.end.line - 1, span.end.column - 1);
  return sourceFile.text.slice(start, end);
}

// ---------------------------------------------------------------------------
// Lexical (no-FS) specifier <-> repository-relative-path matching, used to
// find a P3-2-resolved file both by exact (importedFrom, specifier) match
// and, when that fails, by a path-shape comparison that ignores extension
// and directory-index differences. This never invents a new resolution: it
// only ever matches against files P3-2 already resolved (and therefore
// already contained/deny-checked).
// ---------------------------------------------------------------------------

const SOURCE_EXTENSION_PATTERN = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/iu;

function stripSourceExtension(path: string): string {
  return path.replace(SOURCE_EXTENSION_PATTERN, '');
}

/** A path key that ignores source-extension and trailing `/index` differences, so `./x`, `./x.ts`, and `./x/index.ts` compare equal. */
function lexicalTargetKey(repositoryRelativePath: string): string {
  const withoutExtension = stripSourceExtension(repositoryRelativePath);
  return withoutExtension.endsWith('/index') ? withoutExtension.slice(0, -'/index'.length) : withoutExtension;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/** Computes a {@link lexicalTargetKey} for a relative specifier purely from text, with no filesystem access. `undefined` for a non-relative specifier or one that lexically escapes the repository root. */
function resolveLexicalSpecifierKey(importerRepositoryRelativePath: string, specifier: string): string | undefined {
  if (!isRelativeSpecifier(specifier)) return undefined;
  const importerDir = posix.dirname(importerRepositoryRelativePath);
  const joined = posix.join(importerDir, specifier);
  try {
    return lexicalTargetKey(normalizeRepositoryRelativePath(joined));
  } catch {
    return undefined;
  }
}

/**
 * Every already-resolved file whose {@link lexicalTargetKey} matches
 * `specifier` resolved relative to `importer`. A lexical key collides by
 * design — `src/x.ts` and `src/x/index.ts` both key to `src/x`, and so do
 * `src/x.ts` and `src/x.js` — so this can return more than one file; callers
 * decide what "more than one" means for them.
 */
function lexicalMatches(
  resolution: EvidenceResolutionResult,
  importerRepositoryRelativePath: string,
  specifier: string,
): readonly ResolvedEvidenceFile[] {
  const key = resolveLexicalSpecifierKey(importerRepositoryRelativePath, specifier);
  if (key === undefined) return [];
  return resolution.files.filter((file) => lexicalTargetKey(file.repositoryRelativePath) === key);
}

/**
 * Finds a P3-2-resolved file for one `(importer, specifier)` pair. Tries an
 * exact `(importedFrom, specifier)` match first (the documented, primary
 * behavior); when that fails — e.g. the same file was resolved under a
 * different literal specifier spelling because `resolveEvidenceFiles`
 * dedupes by path and keeps only the tie-broken specifier, or the specifier
 * was recorded against a different importer (a file imported by both the
 * test file and a helper is only ever resolved once, at its lowest hop) —
 * falls back to a lexical path-shape match against every already-resolved
 * file. Never performs its own filesystem resolution.
 *
 * When the lexical fallback matches more than one already-resolved file
 * (e.g. both `src/x.ts` and `src/x/index.ts` exist and are independently
 * resolved), which one the specifier actually meant is genuinely ambiguous:
 * this returns `undefined` rather than guessing, because attaching the
 * wrong file's declaration as evidence is worse than attaching none.
 */
function findResolvedFile(
  resolution: EvidenceResolutionResult,
  importerRepositoryRelativePath: string,
  specifier: string,
): ResolvedEvidenceFile | undefined {
  const exact = resolution.files.find((file) => (
    file.importedFrom === importerRepositoryRelativePath && file.specifier === specifier
  ));
  if (exact !== undefined) return exact;

  const matches = lexicalMatches(resolution, importerRepositoryRelativePath, specifier);
  return matches.length === 1 ? matches[0] : undefined;
}

// ---------------------------------------------------------------------------
// Import binding table: local identifier -> (specifier, exported name).
// ---------------------------------------------------------------------------

type ImportBindingKind = 'named' | 'default' | 'namespace';

interface ImportBinding {
  readonly localName: string;
  /** The name exported by the target module. Absent for `default` (implicitly `'default'`) and `namespace` (not a single name). */
  readonly importedName?: string;
  readonly specifier: string;
  readonly kind: ImportBindingKind;
}

function staticModuleSpecifier(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

function staticRequireSpecifier(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined
    || !ts.isCallExpression(expression)
    || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== 'require'
    || expression.arguments.length !== 1) return undefined;
  return staticModuleSpecifier(expression.arguments[0]);
}

/**
 * Local import-binding table of one source file's own top-level `import`
 * declarations and `require(...)` destructures/assignments: local
 * identifier -> `(specifier, exported name)`. Covers named, aliased named
 * (`{ a as b }`), default, namespace (`* as ns`), `const { a } =
 * require(...)`, and `const x = require(...)`. Dynamic imports and bare
 * side-effect imports contribute no binding (nothing to reference by name).
 */
function importBindingsFor(sourceFile: ts.SourceFile): readonly ImportBinding[] {
  const bindings: ImportBinding[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = staticModuleSpecifier(statement.moduleSpecifier);
      if (specifier === undefined || statement.importClause === undefined) continue;
      const clause = statement.importClause;
      if (clause.name !== undefined) {
        bindings.push({ localName: clause.name.text, specifier, kind: 'default' });
      }
      const namedBindings = clause.namedBindings;
      if (namedBindings === undefined) continue;
      if (ts.isNamespaceImport(namedBindings)) {
        bindings.push({ localName: namedBindings.name.text, specifier, kind: 'namespace' });
        continue;
      }
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        bindings.push({ localName: element.name.text, importedName, specifier, kind: 'named' });
      }
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const specifier = staticRequireSpecifier(declaration.initializer);
      if (specifier === undefined) continue;
      if (ts.isIdentifier(declaration.name)) {
        bindings.push({ localName: declaration.name.text, specifier, kind: 'namespace' });
        continue;
      }
      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
        const importedName = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
        bindings.push({ localName: element.name.text, importedName, specifier, kind: 'named' });
      }
    }
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// Reference collection: which import bindings does a text fragment actually
// use? Syntactic, not scope-aware — a local re-declaration that shadows an
// import binding's name is not distinguished (documented limitation; not
// exercised by the test/hook/helper snippets this module selects).
// ---------------------------------------------------------------------------

interface ReferenceAccumulator {
  /** Local names of non-namespace bindings referenced directly. */
  readonly direct: Set<string>;
  /** Namespace-binding local name -> set of `ns.member` member names accessed. */
  readonly members: Map<string, Set<string>>;
}

function isDeclarationName(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
    || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)
    || ts.isFunctionExpression(parent) || ts.isClassExpression(parent)) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return true;
  return false;
}

/** Whether an `Identifier` node is a value-level reference (as opposed to a declared/property/label name). */
function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent: ts.Node | undefined = node.parent as ts.Node | undefined;
  if (parent === undefined) return true;
  return !isDeclarationName(node, parent);
}

function collectReferences(root: ts.Node, bindingsByLocalName: ReadonlyMap<string, ImportBinding>, into: ReferenceAccumulator): void {
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = bindingsByLocalName.get(node.expression.text);
      if (binding !== undefined && binding.kind === 'namespace') {
        const members = into.members.get(binding.localName) ?? new Set<string>();
        members.add(node.name.text);
        into.members.set(binding.localName, members);
        ts.forEachChild(node, visit);
        return;
      }
    }
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      const binding = bindingsByLocalName.get(node.text);
      if (binding !== undefined && binding.kind !== 'namespace') into.direct.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function referencesIn(
  texts: readonly string[],
  scriptKind: ts.ScriptKind,
  bindingsByLocalName: ReadonlyMap<string, ImportBinding>,
): ReferenceAccumulator {
  const accumulator: ReferenceAccumulator = { direct: new Set(), members: new Map() };
  for (const text of texts) {
    const snippet = ts.createSourceFile('snippet.ts', text, ts.ScriptTarget.Latest, true, scriptKind);
    collectReferences(snippet, bindingsByLocalName, accumulator);
  }
  return accumulator;
}

interface ReferencedImport {
  readonly specifier: string;
  /** The exported name to look up in the target module; `'default'` for a default-import reference. */
  readonly exportedName: string;
}

/** Turns a {@link ReferenceAccumulator} into a deterministically sorted, deduplicated list of `(specifier, exportedName)` pairs to resolve. Sorting up front (rather than relying on `Set`/`Map` iteration order) keeps downstream symbol selection for a shared declaration stable. */
function referencedImportsFrom(
  accumulator: ReferenceAccumulator,
  bindingsByLocalName: ReadonlyMap<string, ImportBinding>,
): readonly ReferencedImport[] {
  const seen = new Set<string>();
  const result: ReferencedImport[] = [];
  const add = (specifier: string, exportedName: string): void => {
    const key = JSON.stringify([specifier, exportedName]);
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ specifier, exportedName });
  };

  for (const localName of accumulator.direct) {
    const binding = bindingsByLocalName.get(localName);
    if (binding === undefined) continue;
    add(binding.specifier, binding.kind === 'default' ? 'default' : (binding.importedName ?? localName));
  }
  for (const [localName, members] of accumulator.members) {
    const binding = bindingsByLocalName.get(localName);
    if (binding === undefined) continue;
    for (const member of members) add(binding.specifier, member);
  }

  return result.sort((left, right) => (
    compareStrings(left.specifier, right.specifier) || compareStrings(left.exportedName, right.exportedName)
  ));
}

// ---------------------------------------------------------------------------
// Finding the smallest top-level declaration for an exported name inside a
// resolved target file's source.
// ---------------------------------------------------------------------------

type ExportModifiedStatement = ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isExportModifiedDeclaration(statement: ts.Statement): statement is ExportModifiedStatement {
  return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isVariableStatement(statement))
    && hasModifier(statement, ts.SyntaxKind.ExportKeyword);
}

function declarationName(statement: ExportModifiedStatement): string | undefined {
  return ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ? statement.name?.text : undefined;
}

function declarationDeclaresName(statement: ts.Statement, name: string): boolean {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name?.text === name;
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name) && declaration.name.text === name
    ));
  }
  return false;
}

function findTopLevelDeclarationByName(statements: readonly ts.Statement[], name: string): ts.Statement | undefined {
  return statements.find((statement) => (
    ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isVariableStatement(statement)
  ) && declarationDeclaresName(statement, name));
}

type DeclarationLookup =
  | { readonly kind: 'declaration'; readonly node: ts.Node; readonly symbol: string }
  | { readonly kind: 're-export'; readonly node: ts.Node; readonly symbol: string };

/**
 * Finds the smallest top-level declaration in `sourceFile` that defines
 * `exportedName`: a function/class declaration, a whole `const`/`let`/`var`
 * statement, an `export default` declaration/expression, or — for a local
 * `export { x }` re-binding — the local declaration it points to. A name
 * that is only re-exported from another module (`export { x } from './y'`,
 * `export * from './y'`) selects the re-export statement itself; per the
 * feature's documented hop limit this is never followed into `./y`. A name
 * with no matching export (a type/interface, a CommonJS `module.exports`
 * assignment, or nothing at all) returns `undefined`: selection never
 * invents content.
 */
function findExportedDeclaration(sourceFile: ts.SourceFile, exportedName: string): DeclarationLookup | undefined {
  const statements = sourceFile.statements;

  if (exportedName === 'default') {
    for (const statement of statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        return { kind: 'declaration', node: statement, symbol: 'default' };
      }
      if (isExportModifiedDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        return { kind: 'declaration', node: statement, symbol: declarationName(statement) ?? 'default' };
      }
    }
    return undefined;
  }

  for (const statement of statements) {
    if (isExportModifiedDeclaration(statement)
      && !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      && declarationDeclaresName(statement, exportedName)) {
      return { kind: 'declaration', node: statement, symbol: exportedName };
    }
  }

  for (const statement of statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined) continue;
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) continue;
    for (const specifier of clause.elements) {
      if (specifier.name.text !== exportedName) continue;
      const localName = specifier.propertyName?.text ?? specifier.name.text;
      const local = findTopLevelDeclarationByName(statements, localName);
      if (local !== undefined) return { kind: 'declaration', node: local, symbol: localName };
    }
  }

  for (const statement of statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) continue;
    const clause = statement.exportClause;
    if (clause === undefined) {
      return { kind: 're-export', node: statement, symbol: exportedName };
    }
    if (ts.isNamedExports(clause) && clause.elements.some((element) => element.name.text === exportedName)) {
      return { kind: 're-export', node: statement, symbol: exportedName };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Mock-target detection.
// ---------------------------------------------------------------------------

function isMockRegistrationApi(api: MockApi): boolean {
  return api === 'jest.mock' || api === 'jest.doMock' || api === 'vi.mock' || api === 'vi.doMock';
}

/**
 * Lexical keys of every module statically mocked (`jest.mock`/`vi.mock`/
 * `doMock`) from the test file, used to re-classify an otherwise
 * `helper`/`production-seam` fragment as `mock-target`. Prefers the actual
 * P3-2-resolved path (handles a mock specifier spelled differently from the
 * matching import, e.g. `vi.mock('./worker')` alongside `import './worker.js'`)
 * and falls back to a purely lexical key when the mocked module was never
 * independently imported (so P3-2 never resolved it).
 */
function computeMockedTargetKeys(
  mocks: readonly MockRecord[],
  testFilePath: string,
  resolution: EvidenceResolutionResult,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const mock of mocks) {
    if (!isMockRegistrationApi(mock.api) || !mock.static || mock.moduleSpecifier === undefined) continue;
    const resolved = findResolvedFile(resolution, testFilePath, mock.moduleSpecifier);
    if (resolved !== undefined) {
      keys.add(lexicalTargetKey(resolved.repositoryRelativePath));
      continue;
    }
    // `findResolvedFile` found nothing: either a genuine non-match (the mocked module was
    // never independently imported, so falling back to a purely lexical key is the best
    // available signal) or an AMBIGUOUS lexical match (two or more already-resolved files
    // share the key). In the ambiguous case, which file was meant is unknowable, so no key
    // is added — the alternative would risk marking every colliding file as mock-target.
    if (lexicalMatches(resolution, testFilePath, mock.moduleSpecifier).length > 1) continue;
    const key = resolveLexicalSpecifierKey(testFilePath, mock.moduleSpecifier);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Candidate fragments: raw (untruncated, un-normalized) content plus enough
// metadata to finalize into an `EvidenceFragment` later.
// ---------------------------------------------------------------------------

interface CandidateFragment {
  readonly kind: EvidenceFragmentKind;
  readonly repositoryRelativePath: string;
  readonly span: SourceSpan;
  readonly content: string;
  readonly selectionReason: EvidenceSelectionReason;
  readonly symbol?: string;
}

function candidateKey(candidate: CandidateFragment): string {
  const { span } = candidate;
  return JSON.stringify([candidate.repositoryRelativePath, span.start.line, span.start.column, span.end.line, span.end.column]);
}

function compareCandidates(left: CandidateFragment, right: CandidateFragment): number {
  return (
    compareStrings(left.repositoryRelativePath, right.repositoryRelativePath)
    || compareNumbers(left.span.start.line, right.span.start.line)
    || compareNumbers(left.span.start.column, right.span.start.column)
    || compareStrings(left.symbol ?? '', right.symbol ?? '')
  );
}

/** Deduplicates by `(path, span)`, keeping the first occurrence — callers order higher-priority candidates first. */
function dedupeCandidatesByPathSpan(candidates: readonly CandidateFragment[]): CandidateFragment[] {
  const seen = new Map<string, CandidateFragment>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (!seen.has(key)) seen.set(key, candidate);
  }
  return [...seen.values()];
}

/** Resolves one referenced import to a candidate fragment: finds the target file, reads its source, and locates the smallest declaration for the exported name. `undefined` when the specifier doesn't resolve to a P3-2 file or the name has no matching export. */
async function resolveCandidateForImport(
  ref: ReferencedImport,
  importerRepositoryRelativePath: string,
  resolution: EvidenceResolutionResult,
  rootDir: string,
  readSource: (request: SourceReadRequest) => Promise<string>,
  mockedKeys: ReadonlySet<string>,
): Promise<{ readonly candidate: CandidateFragment; readonly resolvedFile: ResolvedEvidenceFile } | undefined> {
  const resolvedFile = findResolvedFile(resolution, importerRepositoryRelativePath, ref.specifier);
  if (resolvedFile === undefined) return undefined;

  const sourceText = resolvedFile.sourceText
    ?? await readSource({ rootDir, repositoryRelativePath: resolvedFile.repositoryRelativePath });
  const targetScriptKind = scriptKindForPath(resolvedFile.repositoryRelativePath);
  const targetSourceFile = ts.createSourceFile(
    resolvedFile.repositoryRelativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    targetScriptKind,
  );
  const lookup = findExportedDeclaration(targetSourceFile, ref.exportedName);
  if (lookup === undefined) return undefined;

  const isMocked = mockedKeys.has(lexicalTargetKey(resolvedFile.repositoryRelativePath));
  const kind: EvidenceFragmentKind = isMocked ? 'mock-target' : (resolvedFile.role === 'helper' ? 'helper' : 'production-seam');
  const selectionReason: EvidenceSelectionReason = isMocked ? 'mock-target-module' : 'imported-binding-referenced';

  return {
    candidate: {
      kind,
      repositoryRelativePath: resolvedFile.repositoryRelativePath,
      span: sourceSpanOf(targetSourceFile, lookup.node),
      content: lookup.node.getText(targetSourceFile),
      selectionReason,
      symbol: lookup.symbol,
    },
    resolvedFile,
  };
}

// ---------------------------------------------------------------------------
// Byte-budget truncation.
// ---------------------------------------------------------------------------

/** Backs a byte offset off a UTF-8 continuation byte so a cut never splits a multi-byte character. */
function utf8SafeTruncateBytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (maxBytes >= bytes.length) return bytes;
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    end -= 1;
  }
  return bytes.slice(0, end);
}

/** Finds the longest prefix of `text` ending at a `\n` boundary whose UTF-8 byte length is `<= maxBytes`. `undefined` when not even the first line fits. */
function truncateAtLineBoundaryOnly(text: string, maxBytes: number): { readonly content: string; readonly includedBytes: number } | undefined {
  if (maxBytes <= 0) return undefined;
  let cutBytes = 0;
  let cutIndex = 0;
  let searchFrom = 0;
  for (;;) {
    const newlineIndex = text.indexOf('\n', searchFrom);
    if (newlineIndex === -1) break;
    const candidateEnd = newlineIndex + 1;
    const candidateBytes = utf8ByteLength(text.slice(0, candidateEnd));
    if (candidateBytes > maxBytes) break;
    cutBytes = candidateBytes;
    cutIndex = candidateEnd;
    searchFrom = candidateEnd;
  }
  return cutBytes > 0 ? { content: text.slice(0, cutIndex), includedBytes: cutBytes } : undefined;
}

/** Per-fragment truncation: prefers the last full line that fits within `maxBytes`; when not even one line fits, falls back to a raw UTF-8-safe byte cut (never splits a multi-byte character). Always produces *some* content — per-fragment budgets have no "omit" outcome. */
function truncateToFragmentBudget(normalized: string, maxBytes: number): { readonly content: string; readonly includedBytes: number; readonly truncated: boolean } {
  const fullBytes = utf8ByteLength(normalized);
  if (fullBytes <= maxBytes) return { content: normalized, includedBytes: fullBytes, truncated: false };

  const lineOnly = truncateAtLineBoundaryOnly(normalized, maxBytes);
  if (lineOnly !== undefined) return { content: lineOnly.content, includedBytes: lineOnly.includedBytes, truncated: true };

  const safeBytes = utf8SafeTruncateBytes(encoder.encode(normalized), maxBytes);
  return { content: decoder.decode(safeBytes), includedBytes: safeBytes.length, truncated: true };
}

interface PreparedFragment {
  readonly kind: EvidenceFragmentKind;
  readonly repositoryRelativePath: string;
  readonly span: SourceSpan;
  readonly selectionReason: EvidenceSelectionReason;
  readonly symbol?: string;
  /** True original byte length, from before any truncation (fragment- or bundle-level). */
  readonly originalBytes: number;
  readonly content: string;
  readonly includedBytes: number;
  readonly truncated: boolean;
}

function prepareFragment(candidate: CandidateFragment, maxFragmentBytes: number): PreparedFragment {
  const normalized = normalizeTestSource(candidate.content);
  const { content, includedBytes, truncated } = truncateToFragmentBudget(normalized, maxFragmentBytes);
  return {
    kind: candidate.kind,
    repositoryRelativePath: candidate.repositoryRelativePath,
    span: candidate.span,
    selectionReason: candidate.selectionReason,
    ...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
    originalBytes: utf8ByteLength(normalized),
    content,
    includedBytes,
    truncated,
  };
}

function finalizeEvidenceFragment(item: PreparedFragment): EvidenceFragment {
  return {
    kind: item.kind,
    repositoryRelativePath: item.repositoryRelativePath,
    span: item.span,
    content: item.content,
    contentHash: hashEvidenceContent(item.content),
    selectionReason: item.selectionReason,
    truncation: { truncated: item.truncated, originalBytes: item.originalBytes, includedBytes: item.includedBytes },
    ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
  };
}

function makeOmitted(item: PreparedFragment): OmittedEvidence {
  return {
    repositoryRelativePath: item.repositoryRelativePath,
    ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
    reason: 'bundle-budget-exhausted',
  };
}

/**
 * Fills the bundle in priority order, enforcing the bundle-wide byte budget.
 * A fragment that fully fits in the remaining budget is added as-is. The
 * first fragment that does not fit is truncated to the remaining budget at
 * a full-line boundary only (no mid-line byte-safe fallback here — a
 * fragment that cannot offer even one full line is omitted outright); after
 * that fragment (whether it was partially included or fully omitted), every
 * later candidate in priority order is omitted too, without being attempted.
 */
function fillBundle(prepared: readonly PreparedFragment[], maxBundleBytes: number): {
  readonly fragments: readonly EvidenceFragment[];
  readonly omitted: readonly OmittedEvidence[];
} {
  const fragments: EvidenceFragment[] = [];
  const omitted: OmittedEvidence[] = [];
  let runningBytes = 0;
  let stopped = false;

  for (const item of prepared) {
    if (stopped) {
      omitted.push(makeOmitted(item));
      continue;
    }

    const remaining = maxBundleBytes - runningBytes;
    if (item.includedBytes <= remaining) {
      fragments.push(finalizeEvidenceFragment(item));
      runningBytes += item.includedBytes;
      continue;
    }

    const lineOnly = truncateAtLineBoundaryOnly(item.content, remaining);
    if (lineOnly !== undefined) {
      fragments.push(finalizeEvidenceFragment({ ...item, content: lineOnly.content, includedBytes: lineOnly.includedBytes, truncated: true }));
      runningBytes += lineOnly.includedBytes;
    } else {
      omitted.push(makeOmitted(item));
    }
    stopped = true;
  }

  return { fragments, omitted };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Selects the minimal test, hook, helper, production-seam, and mock-target
 * evidence for one extracted `TestCase`, within the given byte budgets, and
 * builds the resulting {@link EvidenceBundle}. Consumes an already-computed
 * P3-2 {@link EvidenceResolutionResult} as-is — it never re-resolves
 * imports, reads outside the files that resolution named, or executes any
 * repository code.
 */
export async function selectEvidence(request: EvidenceSelectionRequest): Promise<EvidenceBundle> {
  validateEvidenceBudget(request.budget);
  const readSource = request.readSource ?? readSourceFile;
  const testFilePath = normalizeRepositoryRelativePath(request.testCase.repositoryRelativePath);
  const scriptKind = scriptKindForPath(testFilePath);
  const testSourceFile = ts.createSourceFile(testFilePath, request.testFileSource, ts.ScriptTarget.Latest, true, scriptKind);
  const testBindings = importBindingsFor(testSourceFile);
  const testBindingsByLocalName = new Map(testBindings.map((binding) => [binding.localName, binding] as const));

  const testCandidate: CandidateFragment = {
    kind: 'test',
    repositoryRelativePath: testFilePath,
    span: request.testCase.span,
    content: request.testCase.source,
    selectionReason: 'test-body',
  };
  const hookCandidates: CandidateFragment[] = request.testCase.hooks.map((hook) => ({
    kind: 'test',
    repositoryRelativePath: testFilePath,
    span: hook.span,
    content: sliceBySpan(testSourceFile, hook.span),
    selectionReason: 'hook-in-scope',
  }));

  const mockedKeys = computeMockedTargetKeys(request.testCase.mocks, testFilePath, request.resolution);

  const testScopeReferences = referencesIn(
    [testCandidate.content, ...hookCandidates.map((hook) => hook.content)],
    scriptKind,
    testBindingsByLocalName,
  );
  const hop1Referenced = referencedImportsFrom(testScopeReferences, testBindingsByLocalName);

  const hop1Results: Array<{ readonly candidate: CandidateFragment; readonly resolvedFile: ResolvedEvidenceFile }> = [];
  for (const ref of hop1Referenced) {
    const result = await resolveCandidateForImport(ref, testFilePath, request.resolution, request.rootDir, readSource, mockedKeys);
    if (result !== undefined) hop1Results.push(result);
  }

  const hop2Candidates: CandidateFragment[] = [];
  for (const { candidate, resolvedFile } of hop1Results) {
    if (resolvedFile.role !== 'helper' || resolvedFile.sourceText === undefined) continue;
    const helperScriptKind = scriptKindForPath(resolvedFile.repositoryRelativePath);
    const helperSourceFile = ts.createSourceFile(
      resolvedFile.repositoryRelativePath,
      resolvedFile.sourceText,
      ts.ScriptTarget.Latest,
      true,
      helperScriptKind,
    );
    const helperBindings = importBindingsFor(helperSourceFile);
    if (helperBindings.length === 0) continue;
    const helperBindingsByLocalName = new Map(helperBindings.map((binding) => [binding.localName, binding] as const));
    // Scan the SELECTED FRAGMENT's own text (the declaration span), not the whole helper file:
    // hop-2 evidence is bounded by what the selected declaration itself references.
    const helperReferences = referencesIn([candidate.content], helperScriptKind, helperBindingsByLocalName);
    const hop2Referenced = referencedImportsFrom(helperReferences, helperBindingsByLocalName);
    for (const ref of hop2Referenced) {
      const result = await resolveCandidateForImport(ref, resolvedFile.repositoryRelativePath, request.resolution, request.rootDir, readSource, mockedKeys);
      if (result !== undefined) hop2Candidates.push(result.candidate);
    }
  }

  const hop1Candidates = hop1Results.map((result) => result.candidate);
  const dedupedImported = dedupeCandidatesByPathSpan([...hop1Candidates, ...hop2Candidates]);
  const hop1Keys = new Set(hop1Candidates.map(candidateKey));
  const finalHop1 = dedupedImported.filter((candidate) => hop1Keys.has(candidateKey(candidate))).sort(compareCandidates);
  const finalHop2 = dedupedImported.filter((candidate) => !hop1Keys.has(candidateKey(candidate))).sort(compareCandidates);

  const orderedCandidates: CandidateFragment[] = [testCandidate, ...hookCandidates, ...finalHop1, ...finalHop2];
  const prepared = orderedCandidates.map((candidate) => prepareFragment(candidate, request.budget.maxFragmentBytes));
  const { fragments, omitted } = fillBundle(prepared, request.budget.maxBundleBytes);

  return buildEvidenceBundle({
    testCaseId: request.testCase.id,
    budget: request.budget,
    fragments,
    denied: request.resolution.denied,
    unresolved: request.resolution.unresolved,
    omitted,
  });
}
