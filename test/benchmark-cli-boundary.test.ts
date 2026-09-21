/**
 * Proves, by static import-graph closure (never by prose), that the `audit`
 * command cannot reach the oracle runner on any path — the acceptance
 * criterion `odd/tasks/phase-7-benchmarks.md`'s P7-2 task names explicitly:
 * "the audit path cannot reach the runner". Reuses the same TypeScript-AST
 * import-following approach `test/architecture-boundary.test.ts` already
 * uses for the domain/application layer check and the single-fetch-site
 * check, applied here to a different question: which files are transitively
 * reachable from a given entry file's own `import`/`export ... from`/dynamic
 * `import()`/`require()` statements.
 *
 * Two assertions, not one, exactly like the existing "exactly one bare
 * fetch(...) call site" check: a negative control alone (the runner is not
 * reachable from `audit`) would trivially pass if the runner module did not
 * exist, or were never imported from anywhere at all. The positive control
 * (the runner IS reachable from `src/cli/benchmark.ts`, the dedicated
 * benchmark entry point) is what makes the negative control meaningful.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const AUDIT_ENTRY = join(SRC_ROOT, 'cli', 'index.ts');
const BENCHMARK_ENTRY = join(SRC_ROOT, 'cli', 'benchmark.ts');
const ORACLE_RUNNER = join(SRC_ROOT, 'adapters', 'oracle-runner.ts');
const AUDIT_SQLITE_STORE = join(SRC_ROOT, 'adapters', 'sqlite-audit-store.ts');
const CACHE_KEY = join(SRC_ROOT, 'adapters', 'cache-key.ts');

function moduleSpecifier(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

function importSpecifiersFrom(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = moduleSpecifier(node.arguments[0]);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const specifier = moduleSpecifier(node.arguments[0]);
      if (specifier) specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function resolveRelativeSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined; // a bare package specifier never resolves into src/
  const withoutExtension = specifier.replace(/\.js$/u, '');
  return resolve(dirname(fromFile), `${withoutExtension}.ts`);
}

/** Every `src/**\/*.ts` file transitively reachable from `entryFile` via its own static imports, including `entryFile` itself. */
async function transitiveClosure(entryFile: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    const source = ts.createSourceFile(current, await readFile(current, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const specifier of importSpecifiersFrom(source)) {
      const resolved = resolveRelativeSpecifier(current, specifier);
      if (resolved !== undefined && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

describe('benchmark execution is unreachable from audit', () => {
  it('never reaches the oracle runner from the audit command\'s own entry point', async () => {
    const closure = await transitiveClosure(AUDIT_ENTRY);
    expect([...closure]).not.toContain(ORACLE_RUNNER);
    expect([...closure]).not.toContain(BENCHMARK_ENTRY);
  });

  it('DOES reach the oracle runner from the dedicated benchmark entry point (positive control — the check above is not vacuous)', async () => {
    const closure = await transitiveClosure(BENCHMARK_ENTRY);
    expect([...closure]).toContain(ORACLE_RUNNER);
  });
});

/**
 * Task P7-3's own structural proof of two hard constraints at once: the
 * benchmark command's `--store` sampling can neither reach the user's real
 * audit store (`sqlite-audit-store.ts`) nor its content-addressed cache
 * (`cache-key.ts`) — see `src/adapters/benchmark-sample-port.ts`'s own doc.
 * `src/cli/index.ts` (`audit`) DOES reach both (positive control — proven by
 * the audit store's own extensive test suite already exercising them), so
 * this negative assertion on `src/cli/benchmark.ts`'s closure cannot pass
 * merely because either module is unreachable from anywhere.
 */
describe('benchmark --store cannot reach the audit store or its cache', () => {
  it('DOES reach sqlite-audit-store.ts and cache-key.ts from the audit command\'s own entry point (positive control)', async () => {
    const closure = await transitiveClosure(AUDIT_ENTRY);
    expect([...closure]).toContain(AUDIT_SQLITE_STORE);
    expect([...closure]).toContain(CACHE_KEY);
  });

  it('never reaches sqlite-audit-store.ts or cache-key.ts from the benchmark command\'s own entry point', async () => {
    const closure = await transitiveClosure(BENCHMARK_ENTRY);
    expect([...closure]).not.toContain(AUDIT_SQLITE_STORE);
    expect([...closure]).not.toContain(CACHE_KEY);
  });
});
