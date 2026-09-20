import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Layer = 'domain' | 'application';
type ImportKind = 'import' | 'export-from' | 'dynamic-import' | 'require';

interface BoundaryViolation {
  file: string;
  kind: ImportKind;
  layer: Layer;
  specifier: string;
}

const forbiddenCrossLayerSegments = new Set([
  'application',
  'cli',
  'adapter',
  'adapters',
  'infrastructure',
  'provider',
  'providers',
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return files.flat().filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
}

function moduleSpecifier(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

function importsFrom(sourceFile: ts.SourceFile): Array<{ kind: ImportKind; specifier: string }> {
  const imports: Array<{ kind: ImportKind; specifier: string }> = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier) imports.push({ kind: 'import', specifier });
    } else if (ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier) imports.push({ kind: 'export-from', specifier });
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = moduleSpecifier(node.arguments[0]);
      if (specifier) imports.push({ kind: 'dynamic-import', specifier });
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
    ) {
      const specifier = moduleSpecifier(node.arguments[0]);
      if (specifier) imports.push({ kind: 'require', specifier });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function layerFor(file: string): Layer | undefined {
  const [layer] = relative(join(process.cwd(), 'src'), file).split(/[\\/]/u);
  return layer === 'domain' || layer === 'application' ? layer : undefined;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.'
    || specifier === '..'
    || specifier.startsWith('./')
    || specifier.startsWith('../');
}

function hasForbiddenDependency(layer: Layer, specifier: string): boolean {
  if (!isRelativeSpecifier(specifier)) return true;

  const segments = specifier.split('/');
  if (layer === 'domain' || layer === 'application') {
    return segments.some((segment) => forbiddenCrossLayerSegments.has(segment));
  }

  return false;
}

async function findBoundaryViolations(): Promise<BoundaryViolation[]> {
  const files = await sourceFiles(join(process.cwd(), 'src'));
  const violations: BoundaryViolation[] = [];

  for (const file of files) {
    const layer = layerFor(file);
    if (!layer) continue;

    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const dependency of importsFrom(source)) {
      if (hasForbiddenDependency(layer, dependency.specifier)) {
        violations.push({ file, layer, ...dependency });
      }
    }
  }

  return violations;
}

describe('architecture boundaries', () => {
  it('keeps inward layers free of forbidden dependencies', async () => {
    await expect(findBoundaryViolations()).resolves.toEqual([]);
  });
});

/**
 * `--inspect-payloads` (Phase 3, P3-4) prints only the already-selected local
 * evidence state; nothing in the audit pipeline may reach the network to
 * produce or supplement it. This is a static, repository-wide guard (all of
 * `src/`, not just `domain`/`application`) alongside the runtime check in
 * `test/cli.test.ts` that stubs `globalThis.fetch` during a real audit run.
 */
const FORBIDDEN_NETWORK_SPECIFIERS = new Set([
  'node:http', 'http',
  'node:https', 'https',
  'node:net', 'net',
  'node:tls', 'tls',
  'undici',
]);

function countBareFetchCalls(sourceFile: ts.SourceFile): number {
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      count += 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

function containsBareFetchCall(sourceFile: ts.SourceFile): boolean {
  return countBareFetchCalls(sourceFile) > 0;
}

/**
 * `src/adapters/jev-http-gateway.ts` (Phase 4, task P4-2) is the one
 * reviewed exception to "never calls a bare fetch(...)": it is the sole
 * TypeSafe HTTP gateway adapter, and its network call is always the
 * caller-injected `fetch` or, absent an override, `globalThis.fetch` —
 * never a new import of `node:http`/`node:https`/`node:net`/`node:tls`/
 * `undici`, which stays forbidden repository-wide, unconditionally, by the
 * import check above (this file is not exempt from that one). Every other
 * file under `src/` still fails the check below on any bare `fetch(...)`
 * call. The positive assertion right after it keeps this exception honest:
 * if the adapter ever stops calling `fetch` directly (or starts calling it
 * more than once), that assertion — not silence — is what notices.
 */
const ALLOWED_BARE_FETCH_FILE = join(process.cwd(), 'src', 'adapters', 'jev-http-gateway.ts');

describe('no network access', () => {
  it('never imports a raw network module anywhere under src/', async () => {
    const files = await sourceFiles(join(process.cwd(), 'src'));
    const violations: { readonly file: string; readonly specifier: string }[] = [];

    for (const file of files) {
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      for (const dependency of importsFrom(source)) {
        if (FORBIDDEN_NETWORK_SPECIFIERS.has(dependency.specifier)) violations.push({ file, specifier: dependency.specifier });
      }
    }

    expect(violations).toEqual([]);
  });

  it('never calls a bare fetch(...) anywhere under src/, except the one reviewed gateway call site', async () => {
    const files = await sourceFiles(join(process.cwd(), 'src'));
    const violations: string[] = [];

    for (const file of files) {
      if (file === ALLOWED_BARE_FETCH_FILE) continue;
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      if (containsBareFetchCall(source)) violations.push(file);
    }

    expect(violations).toEqual([]);
  });

  it('allows exactly one bare fetch(...) call site in the TypeSafe HTTP gateway adapter', async () => {
    const source = ts.createSourceFile(
      ALLOWED_BARE_FETCH_FILE,
      await readFile(ALLOWED_BARE_FETCH_FILE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(countBareFetchCalls(source)).toBe(1);
  });
});
