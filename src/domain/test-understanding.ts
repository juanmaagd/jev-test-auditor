/** The framework evidence attributed to a test file or case. */
export type TestFramework = 'jest' | 'vitest' | 'unknown';

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
  | 'skipIf';

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
  | 'vi.importMock';

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
