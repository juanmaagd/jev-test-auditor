import { describe, expect, it } from 'vitest';
import { extractTestCases, type TestExtractionResult } from '../src/index.js';

function extract(sourceText: string, frameworkHint?: 'jest' | 'vitest' | 'unknown'): TestExtractionResult {
  return frameworkHint === undefined
    ? extractTestCases({ repositoryRelativePath: 'fixture.test.ts', sourceText })
    : extractTestCases({ repositoryRelativePath: 'fixture.test.ts', sourceText, frameworkHint });
}

describe('structural test extraction', () => {
  it.each([
    ['fixture.test.js', 'test("works", () => {})'],
    ['fixture.spec.jsx', 'it("works", () => {})'],
    ['fixture.test.ts', 'test("works", () => {})'],
    ['fixture.spec.tsx', 'test("works", () => {})'],
  ])('parses supported source extension %s without executing code', (repositoryRelativePath, sourceText) => {
    const result = extractTestCases({ repositoryRelativePath, sourceText: `${sourceText}; throw new Error('not executed');` });

    expect(result.testCases).toHaveLength(1);
    expect(result.testCases[0]).toMatchObject({
      name: 'works',
      imports: [],
      mocks: [],
      assertions: [],
      parameterization: { mode: 'none', cases: [] },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('extracts nested suites and duplicate sibling names with stable ordinals', () => {
    const sourceText = `describe('outer', () => {
      test('same', () => {});
      test('same', () => {});
      suite('inner', () => it('same', () => {}));
    });`;

    const result = extract(sourceText, 'vitest');

    expect(result.testCases.map((testCase) => ({
      name: testCase.name,
      ancestry: testCase.structuralAncestry,
      source: testCase.source,
    }))).toEqual([
      {
        name: 'same',
        ancestry: [
          { kind: 'suite', name: 'outer', ordinal: 0 },
          { kind: 'test', name: 'same', ordinal: 0 },
        ],
        source: "test('same', () => {})",
      },
      {
        name: 'same',
        ancestry: [
          { kind: 'suite', name: 'outer', ordinal: 0 },
          { kind: 'test', name: 'same', ordinal: 1 },
        ],
        source: "test('same', () => {})",
      },
      {
        name: 'same',
        ancestry: [
          { kind: 'suite', name: 'outer', ordinal: 0 },
          { kind: 'suite', name: 'inner', ordinal: 0 },
          { kind: 'test', name: 'same', ordinal: 0 },
        ],
        source: "it('same', () => {})",
      },
    ]);
  });

  it('keeps identity stable across line movement and changes it for source or ancestry changes', () => {
    const source = "describe('outer', () => test(`works`, () => {}));";
    const moved = extract(`\n\n${source}`, 'vitest').testCases[0];
    const original = extract(source, 'vitest').testCases[0];
    const changedSource = extract("describe('outer', () => test(`changed`, () => {}));", 'vitest').testCases[0];
    const changedAncestry = extract("describe('different', () => test(`works`, () => {}));", 'vitest').testCases[0];

    expect(moved?.id).toBe(original?.id);
    expect(changedSource?.id).not.toBe(original?.id);
    expect(changedAncestry?.id).not.toBe(original?.id);
  });

  it('resolves named aliases, namespace imports, and globals without executing imports', () => {
    const aliased = extract("import { describe as group, test as check } from 'vitest'; group('g', () => check('a', () => {}));");
    const namespaced = extract("import * as vi from 'vitest'; vi.describe('g', () => vi.it('b', () => {})); vi.beforeEach(() => {});");
    const globals = extract("describe('g', () => it('c', () => {}));", 'jest');
    const jestAlias = extract("import { describe as group, test as check } from '@jest/globals'; group('g', () => check('d', () => {}));");
    const jestNamespace = extract("import * as j from '@jest/globals'; j.describe('g', () => j.it('e', () => {}));");
    const conflicting = extract("import { test as a } from 'vitest'; import { test as b } from '@jest/globals'; a('a', () => {}); b('b', () => {});");

    expect(aliased.testCases[0]).toMatchObject({ name: 'a', framework: 'vitest' });
    expect(namespaced.testCases[0]).toMatchObject({ name: 'b', framework: 'vitest' });
    expect(namespaced.testCases[0]?.hooks.map((hook) => hook.kind)).toEqual(['beforeEach']);
    expect(globals.testCases[0]).toMatchObject({ name: 'c', framework: 'jest' });
    expect(jestAlias.testCases[0]).toMatchObject({ name: 'd', framework: 'jest' });
    expect(jestNamespace.testCases[0]).toMatchObject({ name: 'e', framework: 'jest' });
    expect(conflicting.testCases.map((testCase) => testCase.framework)).toEqual(['unknown', 'unknown']);
  });

  it('supports static CommonJS framework bindings without executing require', () => {
    const vitest = extract(`
      const { test: check, describe: group, beforeEach: setup } = require('vitest');
      group('group', () => check('works', () => {}));
      setup(() => {});
    `);
    const namespace = extract(`
      const vi = require('vitest');
      vi.describe('group', () => vi.it('works', () => {}));
      vi.beforeEach(() => {});
    `);
    const jest = extract(`
      const { test: check, describe: group } = require('@jest/globals');
      group('group', () => check('works', () => {}));
    `);
    const dynamic = extract(`
      const vi = require(moduleName);
      vi.test('not-static', () => {});
    `);

    expect(vitest.testCases).toMatchObject([{ name: 'works', framework: 'vitest' }]);
    expect(vitest.testCases[0]?.hooks.map((hook) => hook.kind)).toEqual(['beforeEach']);
    expect(namespace.testCases).toMatchObject([{ name: 'works', framework: 'vitest' }]);
    expect(namespace.testCases[0]?.hooks.map((hook) => hook.kind)).toEqual(['beforeEach']);
    expect(jest.testCases).toMatchObject([{ name: 'works', framework: 'jest' }]);
    expect(dynamic.testCases).toEqual([]);
  });

  it('lets local redeclarations shadow static CommonJS aliases and namespaces', () => {
    const result = extract(`
      const { test: check } = require('vitest');
      const vi = require('vitest');
      describe('outer', () => {
        const check = localCheck;
        const vi = localVi;
        check('alias-shadowed', () => {});
        vi.test('namespace-shadowed', () => {});
        it('real', () => {});
      });
    `);

    expect(result.testCases.map((testCase) => testCase.name)).toEqual(['real']);
  });

  it('extracts chained modifiers in either order and todo registrations', () => {
    const result = extract(`
      test.skip.only.concurrent.fails.shuffle('first', () => {});
      test.only.skip('second', () => {});
      test.runIf(condition)('third', () => {});
      test.skipIf(condition)('fourth', () => {});
      test.todo('later');
    `, 'vitest');

    expect(result.testCases.map((testCase) => ({
      name: testCase.name,
      modifiers: testCase.modifiers.map((modifier) => modifier.kind),
    }))).toEqual([
      { name: 'first', modifiers: ['skip', 'only', 'concurrent', 'fails', 'shuffle'] },
      { name: 'second', modifiers: ['only', 'skip'] },
      { name: 'third', modifiers: ['runIf'] },
      { name: 'fourth', modifiers: ['skipIf'] },
      { name: 'later', modifiers: ['todo'] },
    ]);
  });

  it('inherits lexical suite hooks and preserves hook scopes', () => {
    const result = extract(`
      beforeAll(() => {});
      describe('outer', () => {
        beforeEach(() => {});
        describe('inner', () => {
          afterEach(() => {});
          aroundEach(() => {});
          it('works', () => {});
        });
      });
    `, 'vitest');
    const testCase = result.testCases[0];

    expect(testCase?.hooks.map((hook) => ({ kind: hook.kind, scope: hook.scope }))).toEqual([
      { kind: 'beforeAll', scope: [] },
      { kind: 'beforeEach', scope: [{ kind: 'suite', name: 'outer', ordinal: 0 }] },
      { kind: 'afterEach', scope: [
        { kind: 'suite', name: 'outer', ordinal: 0 },
        { kind: 'suite', name: 'inner', ordinal: 0 },
      ] },
      { kind: 'aroundEach', scope: [
        { kind: 'suite', name: 'outer', ordinal: 0 },
        { kind: 'suite', name: 'inner', ordinal: 0 },
      ] },
    ]);
  });

  it('reports malformed syntax deterministically without crashing', () => {
    const result = extract("describe('broken', () => { test('works', () => {");

    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', code: 'syntax-error' });
    expect(result.diagnostics[0]?.message).toContain('}');
  });

  it('records dynamic registrations without inventing stable test cases', () => {
    const result = extract(`
      test(getName(), () => {});
      if (enabled) test('conditional', () => {});
      for (const item of items) it('loop', () => {});
      registerTest('wrapped', () => {});
      test[method]('computed', () => {});
    `, 'vitest');

    expect(result.testCases).toEqual([]);
    expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual([
      'dynamic-test-name',
      'conditional-registration',
      'conditional-registration',
      'custom-wrapper',
      'unsupported-syntax',
    ]);
  });

  it('suppresses global fallback for shadowed names while preserving nested scope resolution', () => {
    const result = extract(`
      import { helper as test } from 'other';
      const describe = localDescribe;
      const jest = localJest;
      const callback = () => {};
      function beforeEach() {}
      test('import-shadowed', () => {});
      describe('local-shadowed', () => {});
      jest.describe('object-shadowed', callback);
      beforeEach(() => {});
      suite('outer', () => {
        const test = localTest;
        test('nested-shadowed', () => {});
        it('real', () => {});
      });
    `, 'vitest');
    const aliasedResult = extract(`
      import { test } from 'vitest';
      describe('outer', () => {
        const test = localTest;
        test('nested-shadowed', () => {});
        it('real', () => {});
      });
    `);

    expect(result.testCases.map((testCase) => testCase.name)).toEqual(['real']);
    expect(result.dynamicMetadata).toEqual([]);
    expect(aliasedResult.testCases.map((testCase) => testCase.name)).toEqual(['real']);
  });

  it('inherits suite modifiers with their original modifier spans', () => {
    const sourceText = `
      describe.skip('outer', () => {
        test('inherited', () => {});
        describe.only('inner', () => it.skip('nested', () => {}));
      });
    `;
    const result = extract(sourceText, 'vitest');
    const inherited = result.testCases.find((testCase) => testCase.name === 'inherited');
    const nested = result.testCases.find((testCase) => testCase.name === 'nested');

    expect(inherited?.modifiers.map((modifier) => modifier.kind)).toEqual(['skip']);
    expect(nested?.modifiers.map((modifier) => modifier.kind)).toEqual(['skip', 'only', 'skip']);
    expect(nested?.modifiers[0]?.span).toEqual({ start: { line: 2, column: 7 }, end: { line: 2, column: 20 } });
    expect(nested?.modifiers[1]?.span).toEqual({ start: { line: 4, column: 9 }, end: { line: 4, column: 22 } });
  });

  it('records suites with non-inline callbacks as dynamic registrations', () => {
    const result = extract(`
      const callback = () => {};
      describe('suite', callback);
    `, 'vitest');

    expect(result.testCases).toEqual([]);
    expect(result.dynamicMetadata).toHaveLength(1);
    expect(result.dynamicMetadata[0]).toMatchObject({ reason: 'dynamic-registration' });
  });

  it('only records registration-looking wrappers, including conditional wrappers', () => {
    const result = extract(`
      beforeEach(() => {});
      setup(() => {});
      Promise.resolve().then(() => {});
      registerTest('wrapped', () => {});
      if (enabled) registerTest('conditional', () => {});
    `, 'vitest');

    expect(result.testCases).toEqual([]);
    expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual([
      'custom-wrapper',
      'conditional-registration',
    ]);
  });

  it.each([
    ['registerCleanup', false],
    ['testRequest', false],
    ['showcase', false],
    ['api.case', false],
    ['registerTest', true],
    ['defineTest', true],
    ['createTest', true],
    ['testCase', true],
  ])('uses anchored wrapper names for %s', (callee, shouldRecord) => {
    const result = extract(`${callee}('wrapped', () => {});`, 'vitest');

    expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(
      shouldRecord ? ['custom-wrapper'] : [],
    );
  });

  it('does not classify shadowed wrapper names as custom registrations', () => {
    const unbound = extract(`registerTest('unbound', () => {});`);
    const shadowed = extract(`
      import { helper as registerTest } from 'other';
      registerTest('import-shadowed', () => {});
      function helper(registerTest) {
        registerTest('parameter-shadowed', () => {});
      }
      function local() {
        const registerTest = localRegister;
        registerTest('local-shadowed', () => {});
      }
    `, 'vitest');

    expect(unbound.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['custom-wrapper']);
    expect(shadowed.dynamicMetadata).toEqual([]);
  });

  it('applies function parameter and local declaration shadows to wrapper analysis', () => {
    const result = extract(`
      function parameterHelper(test) {
        test('parameter-shadowed', () => {});
      }
      function localHelper() {
        const test = localTest;
        test('local-shadowed', () => {});
      }
    `, 'vitest');

    expect(result.dynamicMetadata).toEqual([]);
  });

  it('recomputes shadows for nested functions and arrows', () => {
    const result = extract(`
      function outer() {
        function nestedParameters(test, registerTest) {
          test('parameter-test', () => {});
          registerTest('parameter-wrapper', () => {});
        }
        function nestedLocals() {
          const test = localTest;
          const registerTest = localRegister;
          test('local-test', () => {});
          registerTest('local-wrapper', () => {});
        }
        const arrowParameters = (test, registerTest) => {
          test('arrow-parameter-test', () => {});
          registerTest('arrow-parameter-wrapper', () => {});
        };
        const arrowLocals = () => {
          const test = localTest;
          const registerTest = localRegister;
          test('arrow-local-test', () => {});
          registerTest('arrow-local-wrapper', () => {});
        };
      }
    `, 'vitest');

    expect(result.dynamicMetadata).toEqual([]);
  });

  it('normalizes extension case before selecting the TSX parser', () => {
    const result = extractTestCases({
      repositoryRelativePath: 'fixture.TEST.TSX',
      sourceText: `test('upper', () => <Component />);`,
      frameworkHint: 'vitest',
    });

    expect(result.testCases.map((testCase) => testCase.name)).toEqual(['upper']);
    expect(result.diagnostics).toEqual([]);
  });
});
