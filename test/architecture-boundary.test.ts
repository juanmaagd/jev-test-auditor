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
