import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  DEFAULT_DISCOVERY_EXCLUDES,
  DEFAULT_DISCOVERY_INCLUDE,
  type DiscoveredTestFile,
  type DiscoveryExclusionReason,
  type DiscoveryRequest,
  type DiscoveryResult,
  type ExcludedTestFile,
  type FrameworkEvidence,
} from '../domain/discovery.js';
import { isOutsideRootRelative } from './containment.js';
import { type Diagnostic, type TestFramework } from '../domain/test-understanding.js';

const SUPPORTED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const TEST_NAME_PATTERN = /(?:^|\.)(?:test|spec)\.(?:js|jsx|ts|tsx)$/u;
const DEFAULT_EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'vendor',
  'coverage',
  'generated',
  // Keep in sync with `DEFAULT_DISCOVERY_EXCLUDES` (`src/domain/discovery.ts`) — see that entry's
  // own comment for why `.jta` belongs alongside `.git`/`node_modules` here.
  '.jta',
]);
const E2E_MODULES = new Set([
  '@playwright/test',
  'playwright',
  'cypress',
  'webdriverio',
  'detox',
]);
const FRAMEWORK_MODULES: readonly {
  readonly framework: Exclude<TestFramework, 'unknown'>;
  readonly matches: (specifier: string) => boolean;
}[] = [
  { framework: 'jest', matches: (specifier) => specifier === 'jest' || specifier.startsWith('@jest/') },
  { framework: 'vitest', matches: (specifier) => specifier === 'vitest' || specifier.startsWith('@vitest/') },
  // B-2 (bun-test-support.md): `bun:test` is a single fixed module
  // specifier (not a package with a scope prefix), attributed the same way
  // as import/require evidence for jest/vitest via `frameworkFromSource`
  // below. No `PACKAGE_FRAMEWORKS` entry: bun is a runtime, not an npm
  // dependency named `bun`/`@bun/*`, so there is no equivalent
  // package.json evidence source for it.
  { framework: 'bun', matches: (specifier) => specifier === 'bun:test' },
];
const PACKAGE_FRAMEWORKS: readonly {
  readonly framework: Exclude<TestFramework, 'unknown'>;
  readonly pattern: RegExp;
}[] = [
  { framework: 'jest', pattern: /^(?:jest|@jest\/)/u },
  { framework: 'vitest', pattern: /^(?:vitest|@vitest\/)/u },
];

type StaticModuleKind = 'import' | 'export-from' | 'dynamic-import' | 'require';

interface StaticModuleSpecifier {
  readonly kind: StaticModuleKind;
  readonly specifier: string;
}

interface PackageEvidence {
  readonly framework: Exclude<TestFramework, 'unknown'>;
  readonly dependency: string;
}

interface PackageEvidenceResult {
  readonly evidence: readonly PackageEvidence[];
  readonly diagnostics: readonly Diagnostic[];
}

function normalizeRelativePath(path: string): string {
  return path.split('\\').join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Compiles a glob pattern (`*`, `**`, `**\/`, `?`, `{a,b}`) into a `RegExp`
 * anchored to the full candidate string. Exported for reuse by evidence
 * deny-pattern matching (`src/adapters/evidence-resolution.ts`), which
 * matches a pattern with no `/` against a candidate's basename alone.
 */
export function globRegExp(pattern: string): RegExp {
  const normalized = normalizeRelativePath(pattern);
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '{') {
      const end = normalized.indexOf('}', index + 1);
      if (end !== -1) {
        const alternatives = normalized.slice(index + 1, end)
          .split(',')
          .map((alternative) => escapeRegExp(alternative))
          .join('|');
        source += `(?:${alternatives})`;
        index = end;
      } else {
        source += '\\{';
      }
    } else if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(character ?? '');
    }
  }
  return new RegExp(`${source}$`, 'u');
}

/** Matches a full repository-relative path against a glob pattern. See {@link globRegExp}. */
export function matchesGlob(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern);
  const normalizedCandidate = normalizeRelativePath(candidate);
  return globRegExp(normalizedPattern).test(normalizedCandidate)
    || (normalizedPattern.endsWith('/**')
      && normalizedCandidate === normalizedPattern.slice(0, -3));
}

function matchesAnyGlob(patterns: readonly string[], candidate: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, candidate));
}

function hasDefaultExcludedSegment(path: string): boolean {
  return path.split('/').some((segment) => DEFAULT_EXCLUDED_SEGMENTS.has(segment.toLowerCase()));
}

function isSupportedTestFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension) && TEST_NAME_PATTERN.test(basename(path).toLowerCase());
}

function exclusion(
  repositoryRelativePath: string,
  reason: DiscoveryExclusionReason,
  evidence: readonly string[] = [],
): ExcludedTestFile {
  return { repositoryRelativePath, reason, evidence: [...evidence] };
}

function scriptKindFor(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case '.js': return ts.ScriptKind.JS;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.tsx': return ts.ScriptKind.TSX;
    default: return ts.ScriptKind.TS;
  }
}

function stringLiteralText(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

function staticModuleSpecifiers(source: string, path: string): readonly StaticModuleSpecifier[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const specifiers: StaticModuleSpecifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.push({ kind: 'import', specifier });
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.push({ kind: 'export-from', specifier });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (specifier !== undefined) specifiers.push({ kind: 'dynamic-import', specifier });
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
    ) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (specifier !== undefined) specifiers.push({ kind: 'require', specifier });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

async function readPackageEvidence(rootDir: string): Promise<PackageEvidenceResult> {
  try {
    const packageSource = await readFile(join(rootDir, 'package.json'), 'utf8');
    const packageJson: unknown = JSON.parse(packageSource);
    if (typeof packageJson !== 'object' || packageJson === null || Array.isArray(packageJson)) {
      return {
        evidence: [],
        diagnostics: [{
          code: 'package-json-invalid',
          message: 'Unable to parse package.json for framework evidence',
          severity: 'warning',
        }],
      };
    }
    const dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((key) => {
        const value = (packageJson as Record<string, unknown>)[key];
        return typeof value === 'object' && value !== null ? Object.keys(value) : [];
      })
      .sort();
    return {
      evidence: dependencies.flatMap((dependency) => {
        const match = PACKAGE_FRAMEWORKS.find((candidate) => candidate.pattern.test(dependency));
        return match ? [{ framework: match.framework, dependency }] : [];
      }),
      diagnostics: [],
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        evidence: [],
        diagnostics: [{
          code: 'package-json-invalid',
          message: 'Unable to parse package.json for framework evidence',
          severity: 'warning',
        }],
      };
    }
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { evidence: [], diagnostics: [] };
    }
    return {
      evidence: [],
      diagnostics: [{
        code: 'package-json-unreadable',
        message: 'Unable to read package.json for framework evidence',
        severity: 'warning',
      }],
    };
  }
}

function frameworkFromSource(
  moduleSpecifiers: readonly StaticModuleSpecifier[],
  packageEvidence: readonly PackageEvidence[],
): { readonly framework: TestFramework; readonly evidence: readonly FrameworkEvidence[] } {
  const importedEvidence = moduleSpecifiers.flatMap((module) => {
    const match = FRAMEWORK_MODULES.find((candidate) => candidate.matches(module.specifier));
    return match ? [{ framework: match.framework, source: 'import' as const, detail: module.specifier }] : [];
  });
  if (importedEvidence.length > 0) {
    const frameworks = new Set(importedEvidence.map((item) => item.framework));
    return {
      framework: frameworks.size === 1 ? importedEvidence[0]?.framework ?? 'unknown' : 'unknown',
      evidence: importedEvidence,
    };
  }

  const packageEvidenceRecords = packageEvidence.map((item) => ({
    framework: item.framework,
    source: 'package' as const,
    detail: item.dependency,
  }));
  const frameworks = new Set(packageEvidenceRecords.map((item) => item.framework));
  return {
    framework: frameworks.size === 1 ? packageEvidenceRecords[0]?.framework ?? 'unknown' : 'unknown',
    evidence: packageEvidenceRecords,
  };
}

function e2eEvidence(
  repositoryRelativePath: string,
  moduleSpecifiers: readonly StaticModuleSpecifier[],
): readonly string[] {
  const path = repositoryRelativePath.toLowerCase();
  const fileName = basename(path);
  const evidence: string[] = [];
  if (path.split('/').includes('e2e') || path.split('/').includes('end-to-end')) evidence.push('e2e-path-segment');
  if (/\.(?:e2e|cy)\.(?:js|jsx|ts|tsx)$/u.test(fileName)) evidence.push('e2e-file-suffix');
  for (const module of moduleSpecifiers) {
    if (E2E_MODULES.has(module.specifier) || module.specifier.startsWith('@wdio/')) {
      evidence.push(`e2e-framework-import:${module.specifier}`);
    }
  }
  return [...new Set(evidence)];
}

function isOutsideRoot(rootDir: string, candidate: string): boolean {
  return isOutsideRootRelative(relative(rootDir, candidate));
}

async function walk(
  directory: string,
  rootDir: string,
  include: readonly string[],
  configuredExclude: readonly string[],
  packageEvidence: readonly PackageEvidence[],
  files: DiscoveredTestFile[],
  excluded: ExcludedTestFile[],
): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  for (const entry of entries) {
    const candidate = join(directory, entry.name);
    const repositoryRelativePath = normalizeRelativePath(relative(rootDir, candidate));
    if (entry.isSymbolicLink()) {
      let target: string | undefined;
      try {
        target = await realpath(candidate);
      } catch {
        // A dangling symlink is still excluded and never followed.
      }
      excluded.push(exclusion(
        repositoryRelativePath,
        target !== undefined && isOutsideRoot(rootDir, target) ? 'outside-root' : 'symlink',
        target === undefined ? ['unresolved-symlink'] : ['symlink-not-followed'],
      ));
      continue;
    }

    if (entry.isDirectory()) {
      const defaultExcluded = hasDefaultExcludedSegment(repositoryRelativePath);
      const configured = matchesAnyGlob(configuredExclude, repositoryRelativePath);
      if (defaultExcluded || configured) {
        excluded.push(exclusion(
          repositoryRelativePath,
          configured ? 'configured-exclude' : 'default-exclude',
        ));
        continue;
      }
      await walk(candidate, rootDir, include, configuredExclude, packageEvidence, files, excluded);
      continue;
    }
    if (!entry.isFile()) continue;

    const defaultExcluded = hasDefaultExcludedSegment(repositoryRelativePath);
    const configured = matchesAnyGlob(configuredExclude, repositoryRelativePath);
    if (defaultExcluded || configured) {
      excluded.push(exclusion(
        repositoryRelativePath,
        configured ? 'configured-exclude' : 'default-exclude',
      ));
      continue;
    }
    const pathE2e = e2eEvidence(repositoryRelativePath, []);
    if (pathE2e.length > 0) {
      excluded.push(exclusion(repositoryRelativePath, 'e2e-v1', pathE2e));
      continue;
    }
    if (!isSupportedTestFile(repositoryRelativePath)) {
      const reason = SUPPORTED_EXTENSIONS.has(extname(repositoryRelativePath).toLowerCase())
        ? 'not-test-file'
        : 'unsupported-extension';
      excluded.push(exclusion(repositoryRelativePath, reason));
      continue;
    }
    if (!matchesAnyGlob(include, repositoryRelativePath)) {
      excluded.push(exclusion(repositoryRelativePath, 'not-test-file', ['include-pattern']));
      continue;
    }

    const source = await readFile(candidate, 'utf8');
    const modules = staticModuleSpecifiers(source, repositoryRelativePath);
    const e2e = e2eEvidence(repositoryRelativePath, modules);
    if (e2e.length > 0) {
      excluded.push(exclusion(repositoryRelativePath, 'e2e-v1', e2e));
      continue;
    }
    const framework = frameworkFromSource(modules, packageEvidence);
    files.push({ repositoryRelativePath, framework: framework.framework, frameworkEvidence: framework.evidence });
  }
}

export async function discoverTestFiles(request: DiscoveryRequest): Promise<DiscoveryResult> {
  const requestedRoot = resolve(request.rootDir);
  if ((await lstat(requestedRoot)).isSymbolicLink()) {
    throw new RangeError(`Discovery root must not be a symlink: ${request.rootDir}`);
  }
  const rootDir = await realpath(requestedRoot);
  const include = request.include ?? [DEFAULT_DISCOVERY_INCLUDE];
  const configuredExclude = request.exclude ?? [];
  const exclude = [...DEFAULT_DISCOVERY_EXCLUDES, ...configuredExclude];
  const packageResult = await readPackageEvidence(rootDir);
  const files: DiscoveredTestFile[] = [];
  const excluded: ExcludedTestFile[] = [];
  await walk(rootDir, rootDir, include, exclude, packageResult.evidence, files, excluded);
  files.sort((left, right) => left.repositoryRelativePath < right.repositoryRelativePath ? -1 : left.repositoryRelativePath > right.repositoryRelativePath ? 1 : 0);
  excluded.sort((left, right) => left.repositoryRelativePath < right.repositoryRelativePath ? -1 : left.repositoryRelativePath > right.repositoryRelativePath ? 1 : left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0);
  return { files, excluded, diagnostics: packageResult.diagnostics };
}
