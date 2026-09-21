import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function moduleSpecifier(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

function extractRelativeImports(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier && specifier.startsWith('.')) specifiers.push(specifier);
    } else if (ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier && specifier.startsWith('.')) specifiers.push(specifier);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = moduleSpecifier(node.arguments[0]);
      if (specifier && specifier.startsWith('.')) specifiers.push(specifier);
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
    ) {
      const specifier = moduleSpecifier(node.arguments[0]);
      if (specifier && specifier.startsWith('.')) specifiers.push(specifier);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveTsPath(fromFile: string, specifier: string): string {
  const dir = dirname(fromFile);
  const candidate = resolve(dir, specifier);
  if (candidate.endsWith('.js')) {
    return candidate.slice(0, -3) + '.ts';
  }
  return candidate.endsWith('.ts') ? candidate : candidate + '.ts';
}

async function computeTransitiveClosure(entryFile: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue = [entryFile];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    let content: string;
    try {
      content = await readFile(current, 'utf-8');
    } catch {
      continue;
    }

    const sourceFile = ts.createSourceFile(current, content, ts.ScriptTarget.Latest, true);
    const specifiers = extractRelativeImports(sourceFile);

    for (const specifier of specifiers) {
      const resolved = resolveTsPath(current, specifier);
      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return visited;
}

describe('benchmark review architecture boundary', () => {
  it('src/cli/index.ts never imports benchmark-review or review-persistence directly or transitively', async () => {
    const cliEntry = join(process.cwd(), 'src/cli/index.ts');
    const closure = await computeTransitiveClosure(cliEntry);

    const forbiddenFiles = Array.from(closure).filter((filePath) => {
      const normalized = filePath.replace(/\\/g, '/');
      return (
        normalized.includes('benchmark-review')
        || normalized.includes('sqlite-benchmark-store')
        || normalized.includes('skills/jev-benchmark-review')
      );
    });

    expect(forbiddenFiles).toEqual([]);
  });
});
