/** The framework evidence attributed to a test file or case. */
export type TestFramework = 'jest' | 'vitest' | 'bun' | 'unknown';

export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

export interface SourceSpan {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface StructuralAncestrySegment {
  readonly kind: 'suite' | 'test';
  readonly name: string;
  /** Zero-based sibling ordinal. It disambiguates duplicate names. */
  readonly ordinal: number;
}

export type TestModifierKind =
  | 'skip'
  | 'only'
  | 'todo'
  | 'concurrent'
  | 'fails'
  | 'shuffle'
  | 'runIf'
  | 'skipIf'
  /**
   * bun:test's `.todoIf(condition)` — a conditional todo. No existing kind
   * covers both "todo" and "conditional" together, so it is its own kind
   * rather than overloading `todo` or `skipIf` (B-2, bun-test-support.md).
   */
  | 'todoIf'
  /**
   * bun:test's `.serial` — forces sequential execution with no Jest or
   * Vitest equivalent (verified provider fact). Kept as a first-class kind
   * per the feature doc decision: ordering is evidence for the determinism
   * dimension, so it must never be dropped (B-2).
   */
  | 'serial';

export interface TestModifier {
  readonly kind: TestModifierKind;
  readonly span: SourceSpan;
}

export type HookKind =
  | 'beforeAll'
  | 'beforeEach'
  | 'afterEach'
  | 'afterAll'
  | 'aroundAll'
  | 'aroundEach';

export interface HookRecord {
  readonly kind: HookKind;
  readonly scope: readonly StructuralAncestrySegment[];
  readonly span: SourceSpan;
}

export type ImportKind = 'import' | 'export-from' | 'dynamic-import' | 'require';

export interface ImportRecord {
  readonly kind: ImportKind;
  readonly specifier?: string;
  readonly span: SourceSpan;
}

export type MockApi =
  | 'jest.fn'
  | 'jest.mock'
  | 'jest.spyOn'
  | 'jest.doMock'
  | 'jest.unmock'
  | 'jest.deepUnmock'
  | 'jest.setMock'
  | 'jest.requireActual'
  | 'jest.requireMock'
  | 'jest.createMockFromModule'
  | 'jest.genMockFromModule'
  | 'vi.fn'
  | 'vi.mock'
  | 'vi.spyOn'
  | 'vi.doMock'
  | 'vi.unmock'
  | 'vi.doUnmock'
  | 'vi.importActual'
  | 'vi.importMock'
  /**
   * bun:test naming scheme (B-2, bun-test-support.md): bun's own mock
   * surface (`mock()`, `spyOn()`, and `mock`'s sub-properties) is recorded
   * under a `bun.` prefix mirroring the existing `jest.`/`vi.` convention —
   * `bun.mock` for the direct-call `mock(fn)` form (distinct from
   * `bun.mock.module`, which is bun's module-mock form and the actual
   * equivalent of `jest.mock`/`vi.mock`).
   */
  | 'bun.mock'
  | 'bun.mock.module'
  | 'bun.mock.clearAllMocks'
  | 'bun.mock.restore'
  | 'bun.spyOn'
  /**
   * The `jest` object re-exported from `bun:test` is Jest-compatible but
   * bun-provenanced: recording it as plain `jest.*` would misattribute it as
   * real Jest (the feature doc's explicit decision). `bun.jest.*` mirrors
   * the full `jest.*` member set this extractor already recognizes so none
   * of it is silently dropped when imported through bun.
   */
  | 'bun.jest.fn'
  | 'bun.jest.mock'
  | 'bun.jest.spyOn'
  | 'bun.jest.doMock'
  | 'bun.jest.unmock'
  | 'bun.jest.deepUnmock'
  | 'bun.jest.setMock'
  | 'bun.jest.requireActual'
  | 'bun.jest.requireMock'
  | 'bun.jest.createMockFromModule'
  | 'bun.jest.genMockFromModule';

export interface MockRecord {
  readonly api: MockApi;
  readonly moduleSpecifier?: string;
  readonly static: boolean;
  readonly span: SourceSpan;
}

export type AssertionApi = 'expect' | 'assert' | 'matcher';

export interface AssertionRecord {
  readonly api: AssertionApi;
  readonly matcher?: string;
  readonly negated: boolean;
  readonly span: SourceSpan;
}

export interface StaticParameterIdentity {
  readonly index: number;
  readonly valueHash: string;
}

export interface StaticParameterCase {
  readonly identity: StaticParameterIdentity;
  readonly values: readonly unknown[];
  readonly span: SourceSpan;
}

export interface NoParameterization {
  readonly mode: 'none';
  readonly cases: readonly [];
}

export interface StaticParameterization {
  readonly mode: 'static';
  readonly cases: readonly StaticParameterCase[];
}

export interface DynamicParameterization {
  readonly mode: 'dynamic';
  readonly cases: readonly [];
  readonly expression: string;
}

export type ParameterizationMetadata =
  | NoParameterization
  | StaticParameterization
  | DynamicParameterization;

export type DynamicMetadataReason =
  | 'dynamic-registration'
  | 'dynamic-test-name'
  | 'dynamic-parameter-table'
  | 'conditional-registration'
  | 'custom-wrapper'
  | 'unknown-framework'
  | 'unsupported-syntax';

export interface DynamicMetadata {
  readonly reason: DynamicMetadataReason;
  readonly expression: string;
  readonly span: SourceSpan;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  readonly span?: SourceSpan;
}

export interface TestCaseIdInput {
  readonly repositoryRelativePath: string;
  readonly structuralAncestry: readonly StructuralAncestrySegment[];
  readonly testSource: string;
  readonly staticParameter?: StaticParameterIdentity;
  /** Presentation metadata deliberately excluded from identity. */
  readonly sourceSpan?: SourceSpan;
}

export type TestCaseKind = 'test';

export interface TestCase {
  readonly id: TestCaseId;
  readonly repositoryRelativePath: string;
  readonly kind: TestCaseKind;
  readonly framework: TestFramework;
  readonly name: string;
  readonly structuralAncestry: readonly StructuralAncestrySegment[];
  readonly source: string;
  readonly span: SourceSpan;
  readonly modifiers: readonly TestModifier[];
  readonly hooks: readonly HookRecord[];
  readonly imports: readonly ImportRecord[];
  readonly mocks: readonly MockRecord[];
  readonly assertions: readonly AssertionRecord[];
  readonly parameterization: ParameterizationMetadata;
  readonly dynamicMetadata?: DynamicMetadata;
  readonly diagnostics: readonly Diagnostic[];
}

export type TestCaseId = `tc:v1:${string}`;

export function normalizeRepositoryRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || normalized.startsWith('//')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.includes('\0')
  ) {
    throw new RangeError(`Identity path must be repository-relative: ${path}`);
  }

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new RangeError(`Identity path must be repository-relative: ${path}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw new RangeError(`Identity path must be repository-relative: ${path}`);
  }
  return segments.join('/');
}

export function normalizeTestSource(source: string): string {
  return source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function canonicalizeTestCaseIdentity(
  input: TestCaseIdInput,
  normalizedSourceHash: string,
): string {
  const ancestry = input.structuralAncestry.map((segment) => {
    if (!Number.isInteger(segment.ordinal) || segment.ordinal < 0) {
      throw new RangeError(`Structural ancestry ordinal must be a non-negative integer: ${segment.ordinal}`);
    }
    return {
      kind: segment.kind,
      name: segment.name,
      ordinal: segment.ordinal,
    };
  });

  if (input.staticParameter !== undefined) {
    if (!Number.isInteger(input.staticParameter.index) || input.staticParameter.index < 0) {
      throw new RangeError(`Static parameter index must be a non-negative integer: ${input.staticParameter.index}`);
    }
    if (typeof input.staticParameter.valueHash !== 'string' || input.staticParameter.valueHash.length === 0) {
      throw new TypeError('Static parameter value hash is required');
    }
  }

  return JSON.stringify({
    version: 1,
    path: normalizeRepositoryRelativePath(input.repositoryRelativePath),
    ancestry,
    sourceHash: normalizedSourceHash,
    parameter: input.staticParameter === undefined
      ? null
      : {
        index: input.staticParameter.index,
        valueHash: input.staticParameter.valueHash,
      },
  });
}
