import ts from 'typescript';
import { createTestCaseId } from './test-case-identity.js';
import type { TestExtractionRequest, TestExtractionResult } from '../domain/extraction.js';
import type {
  Diagnostic,
  DynamicMetadata,
  DynamicMetadataReason,
  HookKind,
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
}

interface BindingTable {
  readonly aliases: ReadonlyMap<string, SemanticName>;
  readonly namespaces: ReadonlySet<string>;
  readonly importLocals: ReadonlySet<string>;
  readonly frameworkBindingLocals: ReadonlySet<string>;
  readonly frameworks: readonly Exclude<TestFramework, 'unknown'>[];
}

interface ExtractionContext {
  readonly sourceFile: ts.SourceFile;
  readonly framework: TestFramework;
  readonly bindings: BindingTable;
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
      if (framework !== undefined) namespaces.add(namedBindings.name.text);
      continue;
    }
    for (const element of namedBindings.elements) {
      importLocals.add(element.name.text);
      if (framework === undefined) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      const semantic = semanticForName(importedName);
      if (semantic !== undefined) aliases.set(element.name.text, semantic);
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
      }
    }
  }

  return { aliases, namespaces, importLocals, frameworkBindingLocals, frameworks };
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
  if (ts.isCallExpression(expression)) return analyzeCallee(expression.expression, sourceFile, bindings, shadowed, localShadowed);
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
    if (name === 'each' && parent.kind !== undefined) {
      return { ...parent, dynamicReason: 'dynamic-parameter-table' };
    }
    if (modifierKinds.has(name as TestModifierKind) && parent.kind !== undefined) {
      const result: CalleeInfo = {
        kind: parent.kind,
        modifiers: [...parent.modifiers, { kind: name as TestModifierKind, span: sourceSpan(sourceFile, expression) }],
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
): readonly { readonly kind: HookKind; readonly span: SourceSpan; readonly scope: readonly StructuralAncestrySegment[] }[] {
  return statements.flatMap((statement) => {
    const call = directCall(statement);
    const info = call === undefined ? undefined : callInfo(call, context, shadowed, localShadowed);
    if (call === undefined || info?.kind !== 'hook') return [];
    const hookName = hookNameForExpression(call.expression, context.bindings, shadowed, localShadowed);
    if (hookName === undefined) return [];
    return [{ kind: hookName, span: sourceSpan(context.sourceFile, call), scope: [...scope] }];
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
    inheritedHooks: readonly { readonly kind: HookKind; readonly span: SourceSpan; readonly scope: readonly StructuralAncestrySegment[] }[],
    inheritedModifiers: readonly TestModifier[],
    inheritedShadows: ReadonlySet<string>,
    inheritedLocalShadows: ReadonlySet<string>,
  ): void => {
    const declarations = declaredNames(
      statements,
      ancestry.length === 0 ? context.bindings.frameworkBindingLocals : new Set(),
    );
    const shadowed = new Set([...inheritedShadows, ...context.bindings.importLocals, ...declarations]);
    const localShadowed = new Set([...inheritedLocalShadows, ...declarations]);
    const localHooks = collectHooks(statements, context, ancestry, shadowed, localShadowed);
    const hooks = [...inheritedHooks, ...localHooks];
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
        if (info?.dynamicReason !== undefined) {
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
            if (body !== undefined) {
              if (ts.isBlock(body)) {
                processStatements(body.statements, nextAncestry, hooks, nextModifiers, nextShadows, nextLocalShadows);
              } else {
                processStatements([ts.factory.createExpressionStatement(body)], nextAncestry, hooks, nextModifiers, nextShadows, nextLocalShadows);
              }
            } else {
              recordDynamic(node, 'dynamic-registration');
            }
            return;
          }
          const source = node.getText(context.sourceFile);
          const span = sourceSpan(context.sourceFile, node);
          const testCase: TestCase = {
            id: createTestCaseId({
              repositoryRelativePath: context.sourceFile.fileName,
              structuralAncestry: nextAncestry,
              testSource: source,
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
            imports: [],
            mocks: [],
            assertions: [],
            parameterization: { mode: 'none', cases: [] },
            diagnostics: [],
          };
          context.testCases.push(testCase);
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

  processStatements(context.sourceFile.statements, [], [], [], new Set(), new Set());
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
