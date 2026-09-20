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

  it('expands literal parameter tables with stable per-case identities', () => {
    const result = extract(`
      test.each([1, [2, 'two'], { ok: true }])('case', () => {});
    `, 'vitest');

    expect(result.testCases.map((testCase) => testCase.parameterization)).toEqual([
      { mode: 'static', cases: [{ identity: expect.any(Object), values: [1], span: expect.any(Object) }] },
      { mode: 'static', cases: [{ identity: expect.any(Object), values: [2, 'two'], span: expect.any(Object) }] },
      { mode: 'static', cases: [{ identity: expect.any(Object), values: [{ ok: true }], span: expect.any(Object) }] },
    ]);
    expect(new Set(result.testCases.map((testCase) => testCase.id)).size).toBe(3);
  });

  describe('type-only wrapper unwrapping on parameter tables', () => {
    it('expands an "as const" table the same as the bare table, including value identity', () => {
      const bare = extract("test.each([[1, 2], [3, 4]])('case', () => {});", 'vitest');
      const asConst = extract("test.each([[1, 2], [3, 4]] as const)('case', () => {});", 'vitest');

      const summarize = (result: TestExtractionResult) => result.testCases.map((testCase) => ({
        name: testCase.name,
        values: testCase.parameterization.mode === 'static' ? testCase.parameterization.cases[0]?.values : undefined,
        valueHash: testCase.parameterization.mode === 'static'
          ? testCase.parameterization.cases[0]?.identity.valueHash
          : undefined,
      }));

      expect(asConst.dynamicMetadata).toEqual([]);
      expect(asConst.testCases).toHaveLength(2);
      expect(summarize(asConst)).toEqual(summarize(bare));
    });

    it('unwraps a "satisfies"-wrapped parameter table', () => {
      const result = extract(
        "test.each([[1, 2], [3, 4]] satisfies readonly (readonly [number, number])[])('case', () => {});",
        'vitest',
      );

      expect(result.dynamicMetadata).toEqual([]);
      expect(result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
        ? testCase.parameterization.cases[0]?.values : [])).toEqual([[1, 2], [3, 4]]);
    });

    it('unwraps a parenthesized parameter table', () => {
      const result = extract("test.each(([[1, 2], [3, 4]]))('case', () => {});", 'vitest');

      expect(result.dynamicMetadata).toEqual([]);
      expect(result.testCases).toHaveLength(2);
    });

    it('unwraps an angle-bracket type assertion wrapping a parameter table', () => {
      const result = extract(
        "test.each(<readonly (readonly [number, number])[]>[[1, 2], [3, 4]])('case', () => {});",
        'vitest',
      );

      expect(result.dynamicMetadata).toEqual([]);
      expect(result.testCases).toHaveLength(2);
    });

    it('unwraps a non-null-asserted parameter table', () => {
      const result = extract("test.each([[1, 2], [3, 4]]!)('case', () => {});", 'vitest');

      expect(result.dynamicMetadata).toEqual([]);
      expect(result.testCases).toHaveLength(2);
    });

    it('unwraps nested and repeated type-only wrappers around a parameter table', () => {
      const result = extract("test.each((([[1, 2], [3, 4]] as const)))('case', () => {});", 'vitest');

      expect(result.dynamicMetadata).toEqual([]);
      expect(result.testCases).toHaveLength(2);
    });

    it('unwraps a type-only wrapper on an individually-annotated row', () => {
      const result = extract("test.each([[1, 2] as const, [3, 4]])('case', () => {});", 'vitest');

      expect(result.dynamicMetadata).toEqual([]);
      expect(result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
        ? testCase.parameterization.cases[0]?.values : [])).toEqual([[1, 2], [3, 4]]);
    });

    it('expands "as const" tables identically to the bare table for Vitest .for', () => {
      const bare = extract("test.for([[1, 2], [3, 4]])('case', () => {});", 'vitest');
      const asConst = extract("test.for([[1, 2], [3, 4]] as const)('case', () => {});", 'vitest');
      const values = (result: TestExtractionResult) => result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
        ? testCase.parameterization.cases[0]?.values : []);

      expect(asConst.dynamicMetadata).toEqual([]);
      expect(asConst.testCases).toHaveLength(2);
      expect(values(asConst)).toEqual(values(bare));
    });

    it('leaves tagged-template parameter tables unaffected by type-only unwrapping', () => {
      const result = extract("test.each`value | expected\none | 1`('templated', () => {});", 'vitest');

      expect(result.testCases).toHaveLength(1);
      expect(result.testCases[0]?.parameterization.mode).toBe('static');
    });

    it('keeps a genuinely dynamic identifier table dynamic even when wrapped in "as const"', () => {
      const result = extract("test.each(rows as const)('dynamic', () => {});", 'vitest');

      expect(result.testCases).toEqual([]);
      expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['dynamic-parameter-table']);
    });

    it('keeps a genuinely dynamic call-expression table dynamic even when parenthesized', () => {
      const result = extract("test.each((getRows()))('dynamic', () => {});", 'vitest');

      expect(result.testCases).toEqual([]);
      expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['dynamic-parameter-table']);
    });

    it('keeps a spread row dynamic even when the surrounding table is wrapped in "as const"', () => {
      const result = extract("test.each([[...rows]] as const)('dynamic', () => {});", 'vitest');

      expect(result.testCases).toEqual([]);
      expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['dynamic-parameter-table']);
    });

    it('does not unwrap a call expression even when it looks like it forwards a literal table', () => {
      const result = extract("test.each(identity([[1, 2], [3, 4]]))('dynamic', () => {});", 'vitest');

      expect(result.testCases).toEqual([]);
      expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['dynamic-parameter-table']);
    });
  });

  it('expands safe no-substitution tagged-template tables', () => {
    const result = extract(`test.each\`
      value | expected
      one | 1
      two | 2
    \`('templated', () => {});`, 'vitest');

    expect(result.testCases.map((testCase) => testCase.parameterization.mode)).toEqual(['static', 'static']);
    expect(result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
      ? testCase.parameterization.cases[0]?.values : [])).toEqual([
      [{ value: 'one', expected: '1' }],
      [{ value: 'two', expected: '2' }],
    ]);
    expect(result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
      ? testCase.parameterization.cases[0]?.span.start.line : undefined)).toEqual([3, 4]);
    expect(result.testCases[0]?.parameterization.mode === 'static' && result.testCases[1]?.parameterization.mode === 'static'
      ? result.testCases[0].parameterization.cases[0]?.span
      : undefined).not.toEqual(result.testCases[1]?.parameterization.mode === 'static'
      ? result.testCases[1].parameterization.cases[0]?.span
      : undefined);
  });

  it('accepts tagged-template substitutions only when every interpolation is static', () => {
    const result = extract("test.each`value | expected\n${'one'} | 1\n${'two'} | 2`('templated', () => {});", 'vitest');

    expect(result.testCases.map((testCase) => testCase.parameterization.mode)).toEqual(['static', 'static']);
    expect(result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
      ? testCase.parameterization.cases[0]?.values : [])).toEqual([
      [{ value: 'one', expected: '1' }],
      [{ value: 'two', expected: '2' }],
    ]);
  });

  it('preserves typed static tagged-template substitutions', () => {
    const result = extract("test.each`value | expected\n${1} | ${{ answer: true }}\n${-0} | ${false}`('typed', () => {});", 'vitest');

    expect(result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
      ? testCase.parameterization.cases[0]?.values : [])).toEqual([
      [{ value: 1, expected: { answer: true } }],
      [{ value: -0, expected: false }],
    ]);
    const first = result.testCases[0]?.parameterization;
    const second = result.testCases[1]?.parameterization;
    const secondValue = second?.mode === 'static' ? second.cases[0]?.values[0] : undefined;
    expect(secondValue && Object.is((secondValue as { readonly value?: unknown }).value, -0)).toBe(true);
    expect(first?.mode === 'static' && second?.mode === 'static'
      ? first.cases[0]?.identity.valueHash
      : undefined).not.toBe(second?.mode === 'static' ? second.cases[0]?.identity.valueHash : undefined);
  });

  it('rejects multiline tagged substitutions conservatively', () => {
    const result = extract("test.each`value | expected\n${{\n  answer: true\n}} | ok`('dynamic', () => {});", 'vitest');

    expect(result.testCases).toEqual([]);
    expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['dynamic-parameter-table']);
  });

  it('gates Vitest .for tables by verified framework attribution', () => {
    const vitest = extract("test.for([[1], [2]])('works', () => {});", 'vitest');
    const jest = extract("test.for([[1], [2]])('works', () => {});", 'jest');
    const unknown = extract("test.for([[1], [2]])('works', () => {});");

    expect(vitest.testCases).toHaveLength(2);
    expect(jest.testCases).toEqual([]);
    expect(unknown.testCases).toEqual([]);
    expect(jest.dynamicMetadata[0]?.reason).toBe('unsupported-syntax');
    expect(unknown.dynamicMetadata[0]?.reason).toBe('unsupported-syntax');
  });

  it('preserves Vitest .for rows as single array arguments', () => {
    const result = extract("test.for([[1, 2]])('works', () => {});", 'vitest');

    expect(result.testCases[0]?.parameterization.mode === 'static'
      ? result.testCases[0].parameterization.cases[0]?.values : []).toEqual([[1, 2]]);
  });

  it('supports tagged-template Vitest .for rows as typed objects', () => {
    const result = extract("test.for`value | expected\n${1} | ${false}`('works', () => {});", 'vitest');

    expect(result.testCases[0]?.parameterization.mode === 'static'
      ? result.testCases[0].parameterization.cases[0]?.values : []).toEqual([{ value: 1, expected: false }]);
    expect(result.testCases[0]?.parameterization.mode === 'static'
      ? result.testCases[0].parameterization.cases[0]?.span.start.line : undefined).toBe(2);
  });

  it('rejects duplicate or empty tagged-template headers', () => {
    const duplicate = extract("test.each`value | value\none | 1`('duplicate', () => {});", 'vitest');
    const empty = extract("test.each`value | | expected\none | x | 1`('empty', () => {});", 'vitest');

    expect(duplicate.testCases).toEqual([]);
    expect(duplicate.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['dynamic-parameter-table']);
    expect(empty.testCases).toEqual([]);
    expect(empty.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['dynamic-parameter-table']);
  });

  it('preserves __proto__ tagged headers as own properties', () => {
    const result = extract("test.each`__proto__ | value\n${{ answer: true }} | ok`('prototype', () => {});", 'vitest');
    const row = result.testCases[0]?.parameterization.mode === 'static'
      ? result.testCases[0].parameterization.cases[0]?.values[0] : undefined;

    expect(row && Object.prototype.hasOwnProperty.call(row, '__proto__')).toBe(true);
    expect(row && (row as { readonly __proto__: unknown }).__proto__).toEqual({ answer: true });
  });

  it('combines nested parameterized suites and tests without line-based identity', () => {
    const source = "describe.each([['outer-a'], ['outer-b']])('outer', () => test.each([[1], [2]])('inner', () => {}));";
    const result = extract(source, 'vitest');
    const moved = extract(`\n\n${source}`, 'vitest');

    expect(result.testCases).toHaveLength(4);
    expect(new Set(result.testCases.map((testCase) => testCase.id)).size).toBe(4);
    expect(result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
      ? testCase.parameterization.cases[0]?.identity.index : undefined)).toEqual([0, 1, 2, 3]);
    expect(result.testCases.map((testCase) => testCase.parameterization.mode === 'static'
      ? testCase.parameterization.cases[0]?.values : [])).toEqual([
      ['outer-a', 1],
      ['outer-a', 2],
      ['outer-b', 1],
      ['outer-b', 2],
    ]);
    expect(moved.testCases.map((testCase) => testCase.id)).toEqual(result.testCases.map((testCase) => testCase.id));
  });

  it.each([
    ['identifier', 'test.each(rows)(\'dynamic\', () => {})'],
    ['call', 'test.each(getRows())(\'dynamic\', () => {})'],
    ['spread', 'test.each([[...rows]])(\'dynamic\', () => {})'],
    ['getter', "test.each([[{ get value() { return 1; } }]])('dynamic', () => {})"],
    ['computed', "test.each([[{ [key]: 1 }]])('dynamic', () => {})"],
    ['template substitution', "test.each(`[[${value}]]`)('dynamic', () => {})"],
  ])('marks %s parameter tables dynamic without inventing cases', (_label, sourceText) => {
    const result = extract(sourceText, 'vitest');

    expect(result.testCases).toEqual([]);
    expect(result.dynamicMetadata.map((metadata) => metadata.reason)).toEqual(['dynamic-parameter-table']);
  });

  it('preserves parameter boundaries and rejects non-finite/object-prototype values', () => {
    const collisionA = extract("describe.each([[1]])('outer', () => test.each([[2]])('inner', () => {}));", 'vitest');
    const collisionB = extract("describe.each([[1, 2]])('outer', () => test.each([[]])('inner', () => {}));", 'vitest');
    const invalid = extract("test.each([1e999])('invalid', () => {});", 'vitest');
    const values = extract("test.each([-0, 0, { __proto__: 1 }])('values', () => {});", 'vitest');

    expect(collisionA.testCases[0]?.id).not.toBe(collisionB.testCases[0]?.id);
    const collisionAHash = collisionA.testCases[0]?.parameterization.mode === 'static'
      ? collisionA.testCases[0].parameterization.cases[0]?.identity.valueHash : undefined;
    const collisionBHash = collisionB.testCases[0]?.parameterization.mode === 'static'
      ? collisionB.testCases[0].parameterization.cases[0]?.identity.valueHash : undefined;
    expect(collisionAHash).not.toBe(collisionBHash);
    expect(invalid.testCases).toEqual([]);
    expect(invalid.dynamicMetadata[0]?.reason).toBe('dynamic-parameter-table');
    expect(values.testCases).toHaveLength(3);
    expect(values.testCases[0]?.parameterization.mode === 'static'
      ? Object.is(values.testCases[0].parameterization.cases[0]?.values[0], -0) : false).toBe(true);
    expect(values.testCases[1]?.parameterization.mode === 'static'
      ? Object.is(values.testCases[1].parameterization.cases[0]?.values[0], 0) : false).toBe(true);
    expect(values.testCases[0]?.parameterization.mode === 'static' && values.testCases[1]?.parameterization.mode === 'static'
      ? values.testCases[0].parameterization.cases[0]?.identity.valueHash
      : undefined).not.toBe(values.testCases[1]?.parameterization.mode === 'static'
      ? values.testCases[1].parameterization.cases[0]?.identity.valueHash
      : undefined);
    const objectValue = values.testCases[2]?.parameterization.mode === 'static'
      ? values.testCases[2].parameterization.cases[0]?.values[0] : undefined;
    expect(objectValue && Object.prototype.hasOwnProperty.call(objectValue, '__proto__')).toBe(true);
  });

  it('collects imports, mocks, assertions, hook evidence, and isolates siblings', () => {
    const result = extract(`
      import { vi } from 'vitest';
      import { expect, assert } from 'vitest';
      export { helper } from './helper';
      import('./lazy');
      import(dynamicModule);
      require('./required');
      require(dynamicModule);
      beforeEach(() => { vi.mock('./hook'); });
      vi.mock('./module');
      vi.mock(moduleName);
      test('first', () => {
        vi.fn();
        expect(value).not.toBe(false);
        assert.equal(value, true);
      });
      test('second', () => { expect(value).toBe(true); });
    `, 'vitest');
    const first = result.testCases[0];
    const second = result.testCases[1];

    expect(result.testCases).toHaveLength(2);
    expect(first?.imports.map((record) => ({ kind: record.kind, specifier: record.specifier }))).toEqual([
      { kind: 'import', specifier: 'vitest' },
      { kind: 'import', specifier: 'vitest' },
      { kind: 'export-from', specifier: './helper' },
      { kind: 'dynamic-import', specifier: './lazy' },
      { kind: 'dynamic-import', specifier: undefined },
      { kind: 'require', specifier: './required' },
      { kind: 'require', specifier: undefined },
    ]);
    expect(first?.mocks.map((mock) => ({ api: mock.api, moduleSpecifier: mock.moduleSpecifier, static: mock.static }))).toEqual([
      { api: 'vi.mock', moduleSpecifier: './module', static: true },
      { api: 'vi.mock', moduleSpecifier: undefined, static: false },
      { api: 'vi.mock', moduleSpecifier: './hook', static: true },
      { api: 'vi.fn', moduleSpecifier: undefined, static: true },
    ]);
    expect(first?.assertions.map((assertion) => ({ api: assertion.api, matcher: assertion.matcher, negated: assertion.negated }))).toEqual([
      { api: 'expect', matcher: 'toBe', negated: true },
      { api: 'assert', matcher: 'equal', negated: false },
    ]);
    expect(second?.assertions.map((assertion) => assertion.matcher)).toEqual(['toBe']);
    expect(second?.assertions).not.toEqual(first?.assertions);
  });

  it('supports verified framework globals, assertion aliases, and matcher chains', () => {
    const jest = extract(`
      test('jest', () => {
        jest.mock('./module');
        assert(value);
        expect(promise).resolves.not.toBe(false);
        expect(other).rejects.toEqual(error);
      });
    `, 'jest');
    const ambiguous = extract(`
      import { assert as check } from 'vitest';
      test('ambiguous', () => { check(value); });
    `);
    const unknownGlobal = extract("test('unknown', () => { jest.mock('./module'); });");

    expect(jest.testCases[0]?.mocks.map((mock) => mock.api)).toEqual(['jest.mock']);
    expect(jest.testCases[0]?.assertions.map((assertion) => ({ api: assertion.api, matcher: assertion.matcher, negated: assertion.negated }))).toEqual([
      { api: 'assert', matcher: undefined, negated: false },
      { api: 'expect', matcher: 'toBe', negated: true },
      { api: 'expect', matcher: 'toEqual', negated: false },
    ]);
    expect(ambiguous.testCases[0]?.assertions).toHaveLength(1);
    expect(ambiguous.testCases[0]?.assertions[0]?.api).toBe('assert');
    expect(unknownGlobal.testCases[0]?.mocks).toEqual([]);
  });

  it('does not leak scope mocks from helper callbacks and respects hook shadows', () => {
    const result = extract(`
      import { vi } from 'vitest';
      function helper() { vi.mock('./helper'); }
      setup(() => vi.mock('./setup'));
      beforeEach((vi) => { vi.mock('./shadowed'); });
      test('works', () => {});
    `, 'vitest');

    expect(result.testCases[0]?.mocks).toEqual([]);
  });

  it('shadows test callback parameters while collecting evidence', () => {
    const result = extract(`
      import { vi, expect } from 'vitest';
      test('works', (vi, expect) => {
        vi.mock('./shadowed');
        expect(value).toBe(true);
      });
    `, 'vitest');

    expect(result.testCases[0]?.mocks).toEqual([]);
    expect(result.testCases[0]?.assertions).toEqual([]);
  });

  it('does not report shadowed mocks or assertions', () => {
    const result = extract(`
      import { vi } from 'vitest';
      const expect = localExpect;
      test('shadowed', () => {
        const vi = localVi;
        vi.mock('./module');
        expect(value).toBe(true);
      });
    `, 'vitest');

    expect(result.testCases[0]?.mocks).toEqual([]);
    expect(result.testCases[0]?.assertions).toEqual([]);
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
      if (enabled) registerTest('conditional-shadowed', () => {});
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

describe('unsupported framework reporting (B-1)', () => {
  it('warns naming bun:test when the framework cannot be attributed and nothing is extracted', () => {
    const result = extract("import { test } from 'bun:test';\ntest('works', () => {});");

    expect(result.testCases).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'unsupported-framework', severity: 'warning' });
    expect(result.diagnostics[0]?.message).toContain('bun:test');
  });

  it('warns naming node:test the same way', () => {
    const result = extract("import { test } from 'node:test';\ntest('works', () => {});");

    expect(result.testCases).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ code: 'unsupported-framework', severity: 'warning' });
    expect(result.diagnostics[0]?.message).toContain('node:test');
  });

  it('states plainly that no framework import was found when the file has none at all', () => {
    const result = extract('export const helper = 1;');

    expect(result.testCases).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'unsupported-framework', severity: 'warning' });
    expect(result.diagnostics[0]?.message).toMatch(/no .*framework import/iu);
  });

  it('names every conflicting framework import when zero cases are extracted', () => {
    const result = extract("import { expect } from 'vitest';\nimport { fn } from '@jest/globals';");

    expect(result.testCases).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic).toMatchObject({ code: 'unsupported-framework', severity: 'warning' });
    expect(diagnostic?.message).toContain('vitest');
    expect(diagnostic?.message).toContain('@jest/globals');
  });

  it('never invents a test case for an unattributable framework', () => {
    const result = extract("import { test } from 'bun:test';\ntest.each([[1], [2]])('works', () => {});");

    expect(result.testCases).toEqual([]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'unsupported-framework')).toBe(true);
  });

  it('does not warn for a recognized-framework file that legitimately has zero test cases', () => {
    const result = extract("import { expect } from 'vitest';\nexport const helper = () => expect(1).toBe(1);");

    expect(result.testCases).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('does not warn for an unattributable framework file that still yields cases from bare globals', () => {
    const result = extract("test('works', () => {});");

    expect(result.testCases).toHaveLength(1);
    expect(result.testCases[0]).toMatchObject({ framework: 'unknown' });
    expect(result.diagnostics).toEqual([]);
  });

  it('does not warn for conflicting jest/vitest evidence that still yields test cases', () => {
    const result = extract(
      "import { test as a } from 'vitest'; import { test as b } from '@jest/globals'; a('a', () => {}); b('b', () => {});",
    );

    expect(result.testCases.map((testCase) => testCase.framework)).toEqual(['unknown', 'unknown']);
    expect(result.diagnostics).toEqual([]);
  });
});
