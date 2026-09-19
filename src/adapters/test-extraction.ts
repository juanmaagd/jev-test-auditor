import ts from 'typescript';
import { createHash } from 'node:crypto';
import { createTestCaseId } from './test-case-identity.js';
import type { TestExtractionRequest, TestExtractionResult } from '../domain/extraction.js';
import type {
  Diagnostic,
  DynamicMetadata,
  DynamicMetadataReason,
  HookKind,
  AssertionRecord,
  MockApi,
  MockRecord,
  ImportRecord,
  SourceSpan,
  StructuralAncestrySegment,
  TestCase,
  TestFramework,
  TestModifier,
  TestModifierKind,
} from '../domain/test-understanding.js';

const modifierKinds = new Set<TestModifierKind>([
  'skip',
  'only',
  'todo',
  'concurrent',
  'fails',
  'shuffle',
  'runIf',
  'skipIf',
]);
const hookKinds = new Set<HookKind>([
  'beforeAll',
  'beforeEach',
  'afterEach',
  'afterAll',
  'aroundAll',
  'aroundEach',
]);
const registrationWrapperName = /^(?:register|define|create)(?:Test|Spec|Case)$|^testCase$/u;

type RegistrationKind = 'suite' | 'test' | 'hook';

type SemanticName = RegistrationKind | TestModifierKind | HookKind;

interface CalleeInfo {
  readonly kind?: RegistrationKind;
  readonly modifiers: readonly TestModifier[];
  readonly dynamicReason?: DynamicMetadataReason;
  readonly parameterTable?: ts.Expression;
  readonly parameterForm?: 'each' | 'for';
}

interface BindingTable {
  readonly aliases: ReadonlyMap<string, SemanticName>;
  readonly namespaces: ReadonlySet<string>;
  readonly namespaceFrameworks: ReadonlyMap<string, Exclude<TestFramework, 'unknown'>>;
  readonly mockAliases: ReadonlyMap<string, MockApi>;
  readonly assertionAliases: ReadonlyMap<string, 'expect' | 'assert'>;
  readonly importLocals: ReadonlySet<string>;
  readonly frameworkBindingLocals: ReadonlySet<string>;
  readonly frameworks: readonly Exclude<TestFramework, 'unknown'>[];
}

interface HookEntry {
  readonly kind: HookKind;
  readonly span: SourceSpan;
  readonly scope: readonly StructuralAncestrySegment[];
  readonly body?: ts.Block | ts.Expression;
  readonly bodyLocalShadowed: ReadonlySet<string>;
}

interface ParameterCaseInfo {
  readonly identity: { readonly valueHash: string };
  readonly values: readonly unknown[];
  readonly segments: readonly (readonly unknown[])[];
  readonly span: SourceSpan;
}

interface ParameterContext {
  readonly case?: ParameterCaseInfo;
}

interface ExtractionContext {
  readonly sourceFile: ts.SourceFile;
  readonly framework: TestFramework;
  readonly bindings: BindingTable;
  readonly imports: readonly import('../domain/test-understanding.js').ImportRecord[];
  readonly testCases: TestCase[];
  readonly dynamicMetadata: DynamicMetadata[];
}

function frameworkForModule(specifier: string): Exclude<TestFramework, 'unknown'> | undefined {
  if (specifier === 'vitest' || specifier.startsWith('@vitest/')) return 'vitest';
  if (specifier === '@jest/globals' || specifier === 'jest' || specifier.startsWith('@jest/')) return 'jest';
  return undefined;
}

function semanticForName(name: string): SemanticName | undefined {
  if (name === 'describe' || name === 'suite') return 'suite';
  if (name === 'test' || name === 'it') return 'test';
  if (modifierKinds.has(name as TestModifierKind)) return name as TestModifierKind;
  if (hookKinds.has(name as HookKind)) return name as HookKind;
  return undefined;
}

function mockApiForFramework(
  framework: Exclude<TestFramework, 'unknown'>,
  name: string,
): MockApi | undefined {
  const jestApis = new Set(['fn', 'mock', 'spyOn', 'doMock', 'unmock', 'deepUnmock', 'setMock', 'requireActual', 'requireMock', 'createMockFromModule', 'genMockFromModule']);
  const vitestApis = new Set(['fn', 'mock', 'spyOn', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);
  if (framework === 'jest' && jestApis.has(name)) return `jest.${name}` as MockApi;
  if (framework === 'vitest' && vitestApis.has(name)) {
    return `vi.${name}` as MockApi;
  }
  return undefined;
}

function frameworkNamespaceName(framework: Exclude<TestFramework, 'unknown'>, name: string): boolean {
  return (framework === 'vitest' && name === 'vi') || (framework === 'jest' && name === 'jest');
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

function bindingsFor(sourceFile: ts.SourceFile): BindingTable {
  const aliases = new Map<string, SemanticName>();
  const namespaces = new Set<string>();
  const namespaceFrameworks = new Map<string, Exclude<TestFramework, 'unknown'>>();
  const mockAliases = new Map<string, MockApi>();
  const assertionAliases = new Map<string, 'expect' | 'assert'>();
  const importLocals = new Set<string>();
  const frameworkBindingLocals = new Set<string>();
  const frameworks: Exclude<TestFramework, 'unknown'>[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = staticModuleSpecifier(statement.moduleSpecifier);
    const framework = specifier === undefined ? undefined : frameworkForModule(specifier);
    if (framework !== undefined) frameworks.push(framework);
    if (statement.importClause === undefined) continue;
    if (statement.importClause.name !== undefined) importLocals.add(statement.importClause.name.text);
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      importLocals.add(namedBindings.name.text);
      if (framework !== undefined) {
        namespaces.add(namedBindings.name.text);
        namespaceFrameworks.set(namedBindings.name.text, framework);
      }
      continue;
    }
    for (const element of namedBindings.elements) {
      importLocals.add(element.name.text);
      if (framework === undefined) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      const semantic = semanticForName(importedName);
      if (semantic !== undefined) aliases.set(element.name.text, semantic);
      if (framework !== undefined) {
        const mockApi = mockApiForFramework(framework, importedName);
        if (mockApi !== undefined) mockAliases.set(element.name.text, mockApi);
        if (importedName === 'expect' || importedName === 'assert') assertionAliases.set(element.name.text, importedName);
        if (frameworkNamespaceName(framework, importedName)) {
          namespaces.add(element.name.text);
          namespaceFrameworks.set(element.name.text, framework);
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const specifier = staticRequireSpecifier(declaration.initializer);
      const framework = specifier === undefined ? undefined : frameworkForModule(specifier);
      if (framework === undefined) continue;
      frameworks.push(framework);
      if (ts.isIdentifier(declaration.name)) {
        namespaces.add(declaration.name.text);
        namespaceFrameworks.set(declaration.name.text, framework);
        importLocals.add(declaration.name.text);
        frameworkBindingLocals.add(declaration.name.text);
        continue;
      }
      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
        const importedName = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
        importLocals.add(element.name.text);
        frameworkBindingLocals.add(element.name.text);
        const semantic = semanticForName(importedName);
        if (semantic !== undefined) aliases.set(element.name.text, semantic);
        const mockApi = mockApiForFramework(framework, importedName);
        if (mockApi !== undefined) mockAliases.set(element.name.text, mockApi);
        if (importedName === 'expect' || importedName === 'assert') assertionAliases.set(element.name.text, importedName);
        if (frameworkNamespaceName(framework, importedName)) {
          namespaces.add(element.name.text);
          namespaceFrameworks.set(element.name.text, framework);
        }
      }
    }
  }

  return {
    aliases,
    namespaces,
    namespaceFrameworks,
    mockAliases,
    assertionAliases,
    importLocals,
    frameworkBindingLocals,
    frameworks,
  };
}

function sourceSpan(sourceFile: ts.SourceFile, node: ts.Node): SourceSpan {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
}

function spanFromPositions(sourceFile: ts.SourceFile, startPosition: number, length: number): SourceSpan {
  const start = sourceFile.getLineAndCharacterOfPosition(Math.max(0, startPosition));
  const end = sourceFile.getLineAndCharacterOfPosition(Math.min(sourceFile.end, startPosition + length));
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
}

function staticName(expression: ts.Expression | undefined): string | undefined {
  return staticModuleSpecifier(expression);
}

function propertyName(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return staticModuleSpecifier(expression.argumentExpression);
}

function analyzeCallee(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  bindings: BindingTable,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): CalleeInfo {
  if (ts.isCallExpression(expression)) {
    const parent = analyzeCallee(expression.expression, sourceFile, bindings, shadowed, localShadowed);
    return parent.dynamicReason === 'dynamic-parameter-table' && parent.parameterTable === undefined && expression.arguments[0] !== undefined
      ? { ...parent, parameterTable: expression.arguments[0] }
      : parent;
  }
  if (ts.isTaggedTemplateExpression(expression)) {
    const parent = analyzeCallee(expression.tag, sourceFile, bindings, shadowed, localShadowed);
    return parent.dynamicReason === 'dynamic-parameter-table' && parent.parameterTable === undefined
      ? { ...parent, parameterTable: expression.template }
      : parent;
  }
  if (ts.isIdentifier(expression)) {
    const semantic = (localShadowed.has(expression.text) ? undefined : bindings.aliases.get(expression.text))
      ?? (shadowed.has(expression.text) ? undefined : semanticForName(expression.text));
    return semanticInfo(semantic, []);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const name = propertyName(expression);
    if (ts.isIdentifier(expression.expression) && bindings.namespaces.has(expression.expression.text)) {
      if (localShadowed.has(expression.expression.text)) return { modifiers: [] };
      return semanticInfo(semanticForName(name ?? ''), []);
    }
    const parent = analyzeCallee(expression.expression, sourceFile, bindings, shadowed, localShadowed);
    if (name === undefined) {
      return { ...parent, dynamicReason: 'unsupported-syntax' };
    }
    if ((name === 'each' || name === 'for') && parent.kind !== undefined) {
      return {
        ...parent,
        dynamicReason: 'dynamic-parameter-table',
        parameterForm: name,
      };
    }
    if (modifierKinds.has(name as TestModifierKind) && parent.kind !== undefined) {
      const result: CalleeInfo = {
        kind: parent.kind,
        modifiers: [...parent.modifiers, { kind: name as TestModifierKind, span: sourceSpan(sourceFile, expression) }],
        ...(parent.parameterTable === undefined ? {} : { parameterTable: parent.parameterTable }),
        ...(parent.parameterForm === undefined ? {} : { parameterForm: parent.parameterForm }),
      };
      return parent.dynamicReason === undefined ? result : { ...result, dynamicReason: parent.dynamicReason };
    }
    return parent;
  }
  return { modifiers: [] };
}

function semanticInfo(
  semantic: SemanticName | undefined,
  modifiers: readonly TestModifier[],
): CalleeInfo {
  if (semantic === undefined) return { modifiers };
  if (modifierKinds.has(semantic as TestModifierKind)) return { modifiers };
  if (hookKinds.has(semantic as HookKind)) return { kind: 'hook', modifiers };
  return { kind: semantic as RegistrationKind, modifiers };
}

function callbackBody(call: ts.CallExpression): ts.Block | ts.Expression | undefined {
  const callback = call.arguments[1];
  if (callback === undefined || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return undefined;
  return callback.body;
}

function hookCallbackBody(call: ts.CallExpression): ts.Block | ts.Expression | undefined {
  const callback = call.arguments[0];
  if (callback === undefined || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return undefined;
  return callback.body;
}

function nextOrdinal(counters: Map<string, number>, kind: 'suite' | 'test', name: string): number {
  const key = `${kind}:${name}`;
  const ordinal = counters.get(key) ?? 0;
  counters.set(key, ordinal + 1);
  return ordinal;
}

function isControlFlow(node: ts.Node): boolean {
  return ts.isIfStatement(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isSwitchStatement(node)
    || ts.isConditionalExpression(node);
}

function isFunctionLike(node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function callInfo(
  node: ts.Node,
  context: ExtractionContext,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): CalleeInfo | undefined {
  return ts.isCallExpression(node)
    ? analyzeCallee(node.expression, context.sourceFile, context.bindings, shadowed, localShadowed)
    : undefined;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) return propertyName(expression);
  return undefined;
}

function isRegistrationLookingWrapper(node: ts.CallExpression, shadowed: ReadonlySet<string>): boolean {
  if (!node.arguments.some((argument) => isFunctionLike(argument))) return false;
  const name = calleeName(node.expression);
  if (name !== undefined && shadowed.has(name)) return false;
  return name !== undefined && registrationWrapperName.test(name);
}

function candidateCalls(
  node: ts.Node,
  context: ExtractionContext,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (
    child: ts.Node,
    currentShadowed: ReadonlySet<string>,
    currentLocalShadowed: ReadonlySet<string>,
  ): void => {
    if (isFunctionLike(child)) {
      const functionSets = functionShadowSets(child, currentShadowed, currentLocalShadowed);
      ts.forEachChild(child, (nested) => visit(nested, functionSets.shadowed, functionSets.localShadowed));
      return;
    }
    if (ts.isCallExpression(child)) {
      const info = callInfo(child, context, currentShadowed, currentLocalShadowed);
      if (info?.kind !== undefined
        || info?.dynamicReason !== undefined
        || isRegistrationLookingWrapper(child, currentShadowed)) {
        calls.push(child);
      }
    }
    ts.forEachChild(child, (nested) => visit(nested, currentShadowed, currentLocalShadowed));
  };
  visit(node, shadowed, localShadowed);
  return calls;
}

function directCall(statement: ts.Statement): ts.CallExpression | undefined {
  return ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    ? statement.expression
    : undefined;
}

function hookNameForExpression(
  expression: ts.Expression,
  bindings: BindingTable,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): HookKind | undefined {
  let name: string | undefined;
  if (ts.isIdentifier(expression)) {
    const semantic = (localShadowed.has(expression.text) ? undefined : bindings.aliases.get(expression.text))
      ?? (shadowed.has(expression.text) ? undefined : semanticForName(expression.text));
    return semantic !== undefined && hookKinds.has(semantic as HookKind) ? semantic as HookKind : undefined;
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    if (!ts.isIdentifier(expression.expression)) return undefined;
    if (localShadowed.has(expression.expression.text)
      || !bindings.namespaces.has(expression.expression.text)) return undefined;
    name = propertyName(expression);
  }
  return name !== undefined && hookKinds.has(name as HookKind) ? name as HookKind : undefined;
}

function collectHooks(
  statements: readonly ts.Statement[],
  context: ExtractionContext,
  scope: readonly StructuralAncestrySegment[],
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): readonly HookEntry[] {
  return statements.flatMap((statement) => {
    const call = directCall(statement);
    const info = call === undefined ? undefined : callInfo(call, context, shadowed, localShadowed);
    if (call === undefined || info?.kind !== 'hook') return [];
    const hookName = hookNameForExpression(call.expression, context.bindings, shadowed, localShadowed);
    if (hookName === undefined) return [];
    const body = hookCallbackBody(call);
    const callback = call.arguments[0];
    const bodyLocalShadowed = callback !== undefined && isFunctionLike(callback)
      ? functionShadowSets(callback, shadowed, localShadowed).localShadowed
      : localShadowed;
    return [{
      kind: hookName,
      span: sourceSpan(context.sourceFile, call),
      scope: [...scope],
      bodyLocalShadowed,
      ...(body === undefined ? {} : { body }),
    }];
  });
}

function syntaxDiagnostics(sourceFile: ts.SourceFile): readonly Diagnostic[] {
  const parsed = sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.DiagnosticWithLocation[] };
  return (parsed.parseDiagnostics ?? []).map((diagnostic) => ({
    code: 'syntax-error',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    severity: 'error' as const,
    ...(diagnostic.start === undefined
      ? {}
      : { span: spanFromPositions(sourceFile, diagnostic.start, diagnostic.length ?? 0) }),
  }));
}

function addBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addBindingNames(element.name, names);
  }
}

function declaredNames(statements: readonly ts.Statement[], ignored: ReadonlySet<string> = new Set()): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingNames(declaration.name, names);
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) names.add(statement.name.text);
    }
  }
  for (const name of ignored) names.delete(name);
  return names;
}

function callbackParameterNames(call: ts.CallExpression): ReadonlySet<string> {
  const callback = call.arguments[1];
  if (callback === undefined || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return new Set();
  const names = new Set<string>();
  for (const parameter of callback.parameters) addBindingNames(parameter.name, names);
  return names;
}

type StaticLiteralResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function staticLiteral(expression: ts.Expression): StaticLiteralResult {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { ok: true, value: expression.text };
  }
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isPrefixUnaryExpression(expression)
    && (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)
    && ts.isNumericLiteral(expression.operand)) {
    const value = Number(expression.operand.text);
    if (!Number.isFinite(value)) return { ok: false };
    return { ok: true, value: expression.operator === ts.SyntaxKind.MinusToken ? -value : value };
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: unknown[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) return { ok: false };
      const value = staticLiteral(element);
      if (!value.ok) return { ok: false };
      values.push(value.value);
    }
    return { ok: true, value: values };
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const value: Record<string, unknown> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) return { ok: false };
      const name = property.name;
      if (ts.isComputedPropertyName(name)
        || (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name))) return { ok: false };
      const propertyValue = staticLiteral(property.initializer);
      if (!propertyValue.ok) return { ok: false };
      Object.defineProperty(value, name.text, {
        configurable: true,
        enumerable: true,
        value: propertyValue.value,
        writable: true,
      });
    }
    return { ok: true, value };
  }
  return { ok: false };
}

interface TemplateTableParts {
  readonly text: string;
  readonly values: readonly unknown[];
}

const staticPlaceholderPrefix = '\u0000jev-static-';
const staticPlaceholderSuffix = '\u0000';

function templateTableParts(template: ts.TemplateLiteral, sourceFile: ts.SourceFile): TemplateTableParts | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return { text: template.text, values: [] };
  if (!ts.isTemplateExpression(template)) return undefined;
  const values: unknown[] = [];
  let text = template.head.text;
  for (const span of template.templateSpans) {
    const source = sourceFile.text.slice(span.expression.getStart(sourceFile), span.expression.getEnd());
    if (/[\r\n]/u.test(source)) return undefined;
    const value = staticLiteral(span.expression);
    if (!value.ok) return undefined;
    const index = values.push(value.value) - 1;
    text += `${staticPlaceholderPrefix}${index}${staticPlaceholderSuffix}`;
    text += span.literal.text;
  }
  return { text, values };
}

function pipeCells(line: string): readonly string[] | undefined {
  if (!line.includes('|')) return undefined;
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function templateCellValue(cell: string, values: readonly unknown[]): StaticLiteralResult {
  const match = cell.match(new RegExp(`^${staticPlaceholderPrefix}(\\d+)${staticPlaceholderSuffix}$`, 'u'));
  if (match !== null) {
    const index = Number(match[1]);
    return index < values.length ? { ok: true, value: values[index] } : { ok: false };
  }
  if (cell.includes(staticPlaceholderPrefix)) return { ok: false };
  return { ok: true, value: cell };
}

function templateRowSpan(
  sourceFile: ts.SourceFile,
  template: ts.TemplateLiteral,
  lineIndex: number,
): SourceSpan | undefined {
  const contentStart = template.getStart(sourceFile) + 1;
  const contentEnd = template.getEnd() - 1;
  const firstLine = sourceFile.getLineAndCharacterOfPosition(contentStart).line;
  const sourceLine = firstLine + lineIndex;
  if (sourceLine >= sourceFile.getLineStarts().length) return undefined;
  const lineStart = sourceFile.getPositionOfLineAndCharacter(sourceLine, 0);
  const nextLineStart = sourceLine + 1 < sourceFile.getLineStarts().length
    ? sourceFile.getPositionOfLineAndCharacter(sourceLine + 1, 0)
    : sourceFile.text.length;
  let start = Math.max(lineStart, contentStart);
  let end = Math.min(nextLineStart, contentEnd);
  while (end > start && /[\r\n]/u.test(sourceFile.text[end - 1] ?? '')) end -= 1;
  while (start < end && /[ \t]/u.test(sourceFile.text[start] ?? '')) start += 1;
  while (end > start && /[ \t]/u.test(sourceFile.text[end - 1] ?? '')) end -= 1;
  return start < end ? spanFromPositions(sourceFile, start, end - start) : undefined;
}

function parameterRows(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  parameterForm: 'each' | 'for',
): readonly { readonly values: readonly unknown[]; readonly span: SourceSpan }[] | undefined {
  const template = ts.isTaggedTemplateExpression(expression)
    ? expression.template
    : ts.isNoSubstitutionTemplateLiteral(expression) || ts.isTemplateExpression(expression)
      ? expression
      : undefined;
  if (template !== undefined) {
    const table = templateTableParts(template, sourceFile);
    if (table === undefined) return undefined;
    const lines = table.text.split(/\r?\n/u).map((line, index) => ({ line, index, trimmed: line.trim() }))
      .filter((entry) => entry.trimmed.length > 0);
    const header = lines[0] === undefined ? undefined : pipeCells(lines[0].trimmed);
    if (header === undefined || header.length === 0 || header.some((cell) => cell.includes(staticPlaceholderPrefix))) return undefined;
    const headers = header.map((cell) => cell.trim());
    if (headers.some((headerCell) => headerCell.length === 0) || new Set(headers).size !== headers.length) return undefined;
    const rows: { readonly values: readonly unknown[]; readonly span: SourceSpan }[] = [];
    for (const entry of lines.slice(1)) {
      const cells = pipeCells(entry.trimmed);
      if (cells === undefined || cells.length !== header.length) return undefined;
      if (cells.every((cell) => /^-+$/u.test(cell))) continue;
      const values: unknown[] = [];
      for (const cell of cells) {
        const value = templateCellValue(cell, table.values);
        if (!value.ok) return undefined;
        values.push(value.value);
      }
      const span = templateRowSpan(sourceFile, template, entry.index);
      if (span === undefined) return undefined;
      const row: Record<string, unknown> = {};
      for (const [index, headerCell] of headers.entries()) {
        Object.defineProperty(row, headerCell, {
          configurable: true,
          enumerable: true,
          value: values[index],
          writable: true,
        });
      }
      rows.push({ values: [row], span });
    }
    return rows;
  }
  if (!ts.isArrayLiteralExpression(expression)) return undefined;
  const rows: { readonly values: readonly unknown[]; readonly span: SourceSpan }[] = [];
  for (const row of expression.elements) {
    if (ts.isSpreadElement(row)) return undefined;
    const value = staticLiteral(row);
    if (!value.ok) return undefined;
    rows.push({
      values: parameterForm === 'for'
        ? [value.value]
        : Array.isArray(value.value) ? value.value : [value.value],
      span: sourceSpan(sourceFile, row),
    });
  }
  return rows;
}

function parameterValueHash(values: readonly unknown[]): string {
  return createHash('sha256').update(canonicalParameterValue(values), 'utf8').digest('hex');
}

function canonicalParameterValue(value: unknown): string {
  if (value === null) return 'null;';
  if (typeof value === 'string') return `string:${value.length}:${value};`;
  if (typeof value === 'boolean') return `boolean:${value ? '1' : '0'};`;
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return 'number:-0;';
    return `number:${value};`;
  }
  if (Array.isArray(value)) return `array:${value.length}[${value.map(canonicalParameterValue).join('')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `object:${Object.keys(object).map((key) => `key:${key.length}:${key}:${canonicalParameterValue(object[key])}`).join('')};`;
  }
  return `unsupported:${typeof value};`;
}

function expandParameterContext(
  parent: ParameterContext,
  row: { readonly values: readonly unknown[]; readonly span: SourceSpan },
): ParameterContext {
  const values = parent.case === undefined ? row.values : [...parent.case.values, ...row.values];
  const segments = parent.case === undefined ? [row.values] : [...parent.case.segments, row.values];
  return {
    case: {
      values,
      span: row.span,
      segments,
      identity: { valueHash: parameterValueHash(segments) },
    },
  };
}

/**
 * Static import/export-from/dynamic-import/require specifiers of a parsed
 * source file, each with its source span. Shared with evidence import
 * resolution (`src/adapters/evidence-resolution.ts`), which reuses this
 * exact scan for a resolved helper file's own imports (hop 2) instead of
 * duplicating a second TypeScript-compiler-API walk.
 */
export function importRecordsFor(sourceFile: ts.SourceFile): readonly ImportRecord[] {
  const records: ImportRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = staticModuleSpecifier(node.moduleSpecifier);
      records.push({ kind: 'import', ...(specifier === undefined ? {} : { specifier }), span: sourceSpan(sourceFile, node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = staticModuleSpecifier(node.moduleSpecifier);
      records.push({ kind: 'export-from', ...(specifier === undefined ? {} : { specifier }), span: sourceSpan(sourceFile, node) });
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = staticModuleSpecifier(node.arguments[0]);
        records.push({ kind: 'dynamic-import', ...(specifier === undefined ? {} : { specifier }), span: sourceSpan(sourceFile, node) });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const specifier = staticModuleSpecifier(node.arguments[0]);
        records.push({ kind: 'require', ...(specifier === undefined ? {} : { specifier }), span: sourceSpan(sourceFile, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return records;
}

function mockApiForExpression(
  expression: ts.Expression,
  bindings: BindingTable,
  framework: TestFramework,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): MockApi | undefined {
  if (ts.isIdentifier(expression)) {
    if (localShadowed.has(expression.text)) return undefined;
    return bindings.mockAliases.get(expression.text);
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
  if (!ts.isIdentifier(expression.expression)) return undefined;
  const namespace = expression.expression.text;
  if (localShadowed.has(namespace)) return undefined;
  const verifiedFramework = bindings.namespaces.has(namespace)
    ? bindings.namespaceFrameworks.get(namespace)
    : (shadowed.has(namespace)
      || (framework !== 'jest' && framework !== 'vitest')
      || !frameworkNamespaceName(framework, namespace)
      ? undefined
      : framework);
  if (verifiedFramework === undefined) return undefined;
  const name = propertyName(expression);
  return name === undefined ? undefined : mockApiForFramework(verifiedFramework, name);
}

function mockRecordForCall(
  call: ts.CallExpression,
  context: ExtractionContext,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): MockRecord | undefined {
  const api = mockApiForExpression(call.expression, context.bindings, context.framework, shadowed, localShadowed);
  if (api === undefined) return undefined;
  const needsModule = !api.endsWith('.fn') && !api.endsWith('.spyOn');
  const moduleSpecifier = needsModule ? staticModuleSpecifier(call.arguments[0]) : undefined;
  return {
    api,
    ...(moduleSpecifier === undefined ? {} : { moduleSpecifier }),
    static: !needsModule || call.arguments[0] === undefined || moduleSpecifier !== undefined,
    span: sourceSpan(context.sourceFile, call),
  };
}

function assertionRoot(
  expression: ts.Expression,
  context: ExtractionContext,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): 'expect' | 'assert' | undefined {
  if (ts.isIdentifier(expression)) {
    if (localShadowed.has(expression.text)) return undefined;
    const aliasKind = context.bindings.assertionAliases.get(expression.text);
    if (aliasKind !== undefined) return aliasKind;
    if (!shadowed.has(expression.text) && (expression.text === 'expect' || expression.text === 'assert')) return expression.text;
    return undefined;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
  if (!ts.isIdentifier(expression.expression)) return undefined;
  const namespace = expression.expression.text;
  if (localShadowed.has(namespace) || !context.bindings.namespaces.has(namespace)) return undefined;
  const name = propertyName(expression);
  return name === 'expect' ? 'expect' : name === 'assert' ? 'assert' : undefined;
}

function assertionRecordForCall(
  call: ts.CallExpression,
  context: ExtractionContext,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): AssertionRecord | undefined {
  if (ts.isIdentifier(call.expression) || ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)) {
    const direct = assertionRoot(call.expression, context, shadowed, localShadowed);
    if (direct === 'assert') return { api: direct, negated: false, span: sourceSpan(context.sourceFile, call) };
  }
  if (!ts.isPropertyAccessExpression(call.expression) && !ts.isElementAccessExpression(call.expression)) return undefined;
  const matcher = propertyName(call.expression);
  if (matcher === undefined) return undefined;
  let base: ts.Expression = call.expression.expression;
  let negated = false;
  while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) {
    const chainName = propertyName(base);
    if (chainName === 'not') negated = true;
    if (chainName !== 'not' && chainName !== 'resolves' && chainName !== 'rejects') break;
    base = base.expression;
  }
  if (ts.isCallExpression(base) && assertionRoot(base.expression, context, shadowed, localShadowed) === 'expect') {
    return { api: 'expect', matcher, negated, span: sourceSpan(context.sourceFile, call) };
  }
  if (assertionRoot(base, context, shadowed, localShadowed) === 'assert') {
    return { api: 'assert', matcher, negated: false, span: sourceSpan(context.sourceFile, call) };
  }
  return undefined;
}

function collectEvidence(
  node: ts.Node,
  context: ExtractionContext,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): { readonly mocks: readonly MockRecord[]; readonly assertions: readonly AssertionRecord[] } {
  const mocks: MockRecord[] = [];
  const assertions: AssertionRecord[] = [];
  const visit = (child: ts.Node, currentShadowed: ReadonlySet<string>, currentLocalShadowed: ReadonlySet<string>): void => {
    if (isFunctionLike(child)) {
      const sets = functionShadowSets(child, currentShadowed, currentLocalShadowed);
      ts.forEachChild(child, (nested) => visit(nested, sets.shadowed, sets.localShadowed));
      return;
    }
    if (ts.isCallExpression(child)) {
      const mock = mockRecordForCall(child, context, currentShadowed, currentLocalShadowed);
      if (mock !== undefined) mocks.push(mock);
      const assertion = assertionRecordForCall(child, context, currentShadowed, currentLocalShadowed);
      if (assertion !== undefined) assertions.push(assertion);
    }
    ts.forEachChild(child, (nested) => visit(nested, currentShadowed, currentLocalShadowed));
  };
  const blockDeclarations = ts.isBlock(node) ? declaredNames(node.statements) : new Set<string>();
  visit(node, new Set([...shadowed, ...blockDeclarations]), new Set([...localShadowed, ...blockDeclarations]));
  return { mocks, assertions };
}

function collectScopeMocks(
  statements: readonly ts.Statement[],
  context: ExtractionContext,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): readonly MockRecord[] {
  const mocks: MockRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const info = callInfo(node, context, shadowed, localShadowed);
      if (info?.kind === 'test' || info?.kind === 'suite' || info?.kind === 'hook') return;
      const mock = mockRecordForCall(node, context, shadowed, localShadowed);
      if (mock !== undefined) mocks.push(mock);
      for (const child of node.getChildren()) {
        if (!isFunctionLike(child)) visit(child);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of statements) visit(statement);
  return mocks;
}

function functionShadowSets(
  node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  shadowed: ReadonlySet<string>,
  localShadowed: ReadonlySet<string>,
): { readonly shadowed: ReadonlySet<string>; readonly localShadowed: ReadonlySet<string> } {
  const names = new Set<string>();
  for (const parameter of node.parameters) addBindingNames(parameter.name, names);
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) names.add(node.name.text);
  if (node.body !== undefined && ts.isBlock(node.body)) {
    for (const name of declaredNames(node.body.statements)) names.add(name);
  }
  return {
    shadowed: new Set([...shadowed, ...names]),
    localShadowed: new Set([...localShadowed, ...names]),
  };
}

function extractWithContext(context: ExtractionContext): void {
  const parameterOrdinals = new Map<ts.Node, number>();

  const recordDynamic = (node: ts.CallExpression, reason: DynamicMetadataReason): void => {
    context.dynamicMetadata.push({
      reason,
      expression: node.getText(context.sourceFile),
      span: sourceSpan(context.sourceFile, node),
    });
  };

  const processStatements = (
    statements: readonly ts.Statement[],
    ancestry: readonly StructuralAncestrySegment[],
    inheritedHooks: readonly HookEntry[],
    inheritedModifiers: readonly TestModifier[],
    inheritedShadows: ReadonlySet<string>,
    inheritedLocalShadows: ReadonlySet<string>,
    inheritedMocks: readonly MockRecord[],
    parameterContext: ParameterContext,
  ): void => {
    const declarations = declaredNames(
      statements,
      ancestry.length === 0 ? context.bindings.frameworkBindingLocals : new Set(),
    );
    const shadowed = new Set([...inheritedShadows, ...context.bindings.importLocals, ...declarations]);
    const localShadowed = new Set([...inheritedLocalShadows, ...declarations]);
    const localHooks = collectHooks(statements, context, ancestry, shadowed, localShadowed);
    const hooks = [...inheritedHooks, ...localHooks];
    const scopeMocks = [...inheritedMocks, ...collectScopeMocks(statements, context, shadowed, localShadowed)];
    const counters = new Map<string, number>();

    const visit = (node: ts.Node): void => {
      if (isControlFlow(node)) {
        for (const call of candidateCalls(node, context, shadowed, localShadowed)) {
          const info = callInfo(call, context, shadowed, localShadowed);
          recordDynamic(call, info?.dynamicReason ?? 'conditional-registration');
        }
        return;
      }
      if (isFunctionLike(node) && !ts.isSourceFile(node)) {
        const functionSets = functionShadowSets(node, shadowed, localShadowed);
        for (const call of candidateCalls(node, context, functionSets.shadowed, functionSets.localShadowed)) {
          recordDynamic(call, 'custom-wrapper');
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        const info = callInfo(node, context, shadowed, localShadowed);
        if (info?.kind === 'hook') return;
        let parameterVariants: readonly ParameterContext[] = [parameterContext];
        if (info?.dynamicReason === 'dynamic-parameter-table') {
          if (info.parameterForm === 'for' && context.framework !== 'vitest') {
            recordDynamic(node, 'unsupported-syntax');
            return;
          }
          const rows = info.parameterTable === undefined ? undefined : parameterRows(
            info.parameterTable,
            context.sourceFile,
            info.parameterForm ?? 'each',
          );
          if (rows === undefined) {
            recordDynamic(node, 'dynamic-parameter-table');
            return;
          }
          parameterVariants = rows.map((row) => expandParameterContext(parameterContext, row));
        } else if (info?.dynamicReason !== undefined) {
          recordDynamic(node, info.dynamicReason);
          return;
        }
        if (info?.kind === 'suite' || info?.kind === 'test') {
          const name = staticName(node.arguments[0]);
          if (name === undefined) {
            recordDynamic(node, 'dynamic-test-name');
            return;
          }
          const kind = info.kind;
          const segment: StructuralAncestrySegment = {
            kind,
            name,
            ordinal: nextOrdinal(counters, kind, name),
          };
          const nextAncestry = [...ancestry, segment];
          if (kind === 'suite') {
            const body = callbackBody(node);
            const nextModifiers = [...inheritedModifiers, ...info.modifiers];
            const nextShadows = new Set([...shadowed, ...callbackParameterNames(node)]);
            const nextLocalShadows = new Set([...localShadowed, ...callbackParameterNames(node)]);
            if (body === undefined) {
              recordDynamic(node, 'dynamic-registration');
              return;
            }
            for (const variant of parameterVariants) {
              if (ts.isBlock(body)) {
                processStatements(body.statements, nextAncestry, hooks, nextModifiers, nextShadows, nextLocalShadows, scopeMocks, variant);
              } else {
                processStatements([ts.factory.createExpressionStatement(body)], nextAncestry, hooks, nextModifiers, nextShadows, nextLocalShadows, scopeMocks, variant);
              }
            }
            return;
          }
          const source = node.getText(context.sourceFile);
          const span = sourceSpan(context.sourceFile, node);
          const testBody = callbackBody(node);
          const testCallbackShadows = callbackParameterNames(node);
          for (const variant of parameterVariants) {
            const bodyEvidence = testBody === undefined
              ? { mocks: [], assertions: [] }
              : collectEvidence(
                testBody,
                context,
                new Set([...shadowed, ...testCallbackShadows]),
                new Set([...localShadowed, ...testCallbackShadows]),
              );
            const hookEvidence = hooks.flatMap((hook) => hook.body === undefined
              ? []
              : [collectEvidence(
                hook.body,
                context,
                new Set([...shadowed, ...hook.bodyLocalShadowed]),
                hook.bodyLocalShadowed,
              )]);
            const mocks = [...scopeMocks, ...hookEvidence.flatMap((evidence) => evidence.mocks), ...bodyEvidence.mocks];
            const assertions = [...hookEvidence.flatMap((evidence) => evidence.assertions), ...bodyEvidence.assertions];
            const staticCase = variant.case;
            const parameterOrdinal = staticCase === undefined ? 0 : parameterOrdinals.get(node) ?? 0;
            if (staticCase !== undefined) parameterOrdinals.set(node, parameterOrdinal + 1);
            const identity = staticCase === undefined
              ? undefined
              : { ...staticCase.identity, index: parameterOrdinal };
            const parameterization = staticCase === undefined
              ? { mode: 'none' as const, cases: [] as const }
              : {
                mode: 'static' as const,
                cases: [{
                  identity: { ...staticCase.identity, index: parameterOrdinal },
                  values: staticCase.values,
                  span: staticCase.span,
                }],
              };
            context.testCases.push({
              id: createTestCaseId({
                repositoryRelativePath: context.sourceFile.fileName,
                structuralAncestry: nextAncestry,
                testSource: source,
                ...(identity === undefined ? {} : { staticParameter: identity }),
                sourceSpan: span,
              }),
              repositoryRelativePath: context.sourceFile.fileName,
              kind: 'test',
              framework: context.framework,
              name,
              structuralAncestry: nextAncestry,
              source,
              span,
              modifiers: [...inheritedModifiers, ...info.modifiers],
              hooks: hooks.map((hook) => ({ kind: hook.kind, scope: [...hook.scope], span: hook.span })),
              imports: context.imports,
              mocks,
              assertions,
              parameterization,
              diagnostics: [],
            });
          }
          return;
        }
        if (isRegistrationLookingWrapper(node, shadowed)) {
          recordDynamic(node, 'custom-wrapper');
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    for (const statement of statements) visit(statement);
  };

  processStatements(context.sourceFile.statements, [], [], [], new Set(), new Set(), [], {});
}

export function extractTestCases(request: TestExtractionRequest): TestExtractionResult {
  const extension = request.repositoryRelativePath.toLowerCase();
  const sourceFile = ts.createSourceFile(
    request.repositoryRelativePath,
    request.sourceText,
    ts.ScriptTarget.Latest,
    true,
    extension.endsWith('.tsx') ? ts.ScriptKind.TSX
      : extension.endsWith('.jsx') ? ts.ScriptKind.JSX
        : extension.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const bindings = bindingsFor(sourceFile);
  const frameworkSet = new Set(bindings.frameworks);
  const framework: TestFramework = frameworkSet.size > 1
    ? 'unknown'
    : bindings.frameworks[0] ?? request.frameworkHint ?? 'unknown';
  const context: ExtractionContext = {
    sourceFile,
    framework,
    bindings,
    imports: importRecordsFor(sourceFile),
    testCases: [],
    dynamicMetadata: [],
  };
  extractWithContext(context);
  return {
    testCases: context.testCases,
    dynamicMetadata: context.dynamicMetadata,
    diagnostics: syntaxDiagnostics(sourceFile),
  };
}
