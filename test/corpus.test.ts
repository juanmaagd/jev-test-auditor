import { describe, expect, it } from 'vitest';
import {
  buildCorpusCase,
  CORPUS_OPERATOR_IDS,
  CORPUS_ORACLE_KINDS,
  parseCorpusCaseManifest,
  type CorpusCaseManifest,
  type CorpusExpectedOutcome,
  type CorpusOperatorId,
  type CorpusOperatorRole,
  type CorpusOracleKind,
  type CorpusSourceFile,
} from '../src/domain/corpus.js';

/**
 * Six literal fixtures, one per {@link CorpusOperatorId}, each paired with a
 * distinct {@link CorpusOracleKind} and its own `testEffect`/`productionEffect`
 * text. This is the trap fixture the task calls for: if every case shared one
 * operator and one effect string, a parser that ignored those fields entirely
 * (returning a hardcoded value) would still pass every assertion below.
 *
 * Proven by mutation (see the task report for the exact run): swapping the
 * `operator` field between two of THESE SAME fixture objects does not, on
 * its own, prove anything — the `it.each` assertions below read their
 * expected value from the same object the input was built from, so a swap
 * that moves both sides together stays green regardless of whether the
 * parser works. The mutation that actually kills a hardcoded/ignoring
 * parser decouples the two: feed a fixed literal operator into every
 * fixture's input JSON while leaving each assertion pointed at that
 * fixture's real, distinct operator — a parser that does not thread
 * `operators[0]` through goes red on 5 of 6 fixtures.
 */
const DISTINCT_FIXTURES: ReadonlyArray<{
  readonly id: string;
  readonly operator: CorpusOperatorId;
  readonly operatorRole: CorpusOperatorRole;
  readonly oracleKind: CorpusOracleKind;
  readonly testEffect: string;
  readonly productionEffect: string;
  readonly expectedOutcome: CorpusExpectedOutcome;
}> = [
  {
    id: 'case-remove-assertion',
    operator: 'remove-assertion',
    operatorRole: 'descriptive',
    oracleKind: 'assertion-mutation',
    testEffect: 'The real equality assertion is replaced by a tautology comparing a literal to itself.',
    productionEffect: 'No production mutation can change this assertion\'s outcome, since nothing it computes reaches it.',
    expectedOutcome: 'expected-to-keep-passing',
  },
  {
    id: 'case-weaken-expectation',
    operator: 'weaken-expectation',
    operatorRole: 'prescriptive',
    oracleKind: 'assertion-mutation',
    testEffect: 'An exact-value assertion is weakened to a truthy check.',
    productionEffect: 'A production mutation that returns any other truthy value would not fail this test.',
    expectedOutcome: 'expected-to-keep-passing',
  },
  {
    id: 'case-add-shared-state',
    operator: 'add-shared-state',
    operatorRole: 'descriptive',
    oracleKind: 'repeated-randomized-execution',
    testEffect: 'The test writes to and reads from module-level state shared with other tests.',
    productionEffect: 'Resetting the shared module state between repeated runs is expected to change the outcome.',
    expectedOutcome: 'expected-to-fail',
  },
  {
    id: 'case-mock-owned-logic',
    operator: 'mock-owned-logic',
    operatorRole: 'descriptive',
    oracleKind: 'production-mutation',
    testEffect: 'The function under test is replaced by a local mock returning a canned value.',
    productionEffect: 'Corrupting the real function has no effect on this test, since it is never invoked.',
    expectedOutcome: 'expected-to-keep-passing',
  },
  {
    id: 'case-pin-implementation-detail',
    operator: 'pin-implementation-detail',
    operatorRole: 'descriptive',
    oracleKind: 'semantics-preserving-refactor',
    testEffect: 'The test asserts on an internal call that is not part of the public contract.',
    productionEffect: 'A behavior-preserving internal refactor is expected to break this test.',
    expectedOutcome: 'expected-to-fail',
  },
  {
    id: 'case-introduce-uncontrolled-time',
    operator: 'introduce-uncontrolled-time',
    operatorRole: 'prescriptive',
    oracleKind: 'repeated-randomized-execution',
    testEffect: 'The test depends on real wall-clock time instead of an injected clock.',
    productionEffect: 'Running the test repeatedly at different real times is expected to change the outcome.',
    expectedOutcome: 'expected-to-fail',
  },
];

function manifestJsonFor(fixture: (typeof DISTINCT_FIXTURES)[number], overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    id: fixture.id,
    operators: [fixture.operator],
    operatorRole: fixture.operatorRole,
    oracleKind: fixture.oracleKind,
    testEffect: fixture.testEffect,
    productionEffect: fixture.productionEffect,
    expectedOutcome: fixture.expectedOutcome,
    testFile: 'test.ts',
    productionFiles: ['production.ts'],
    ...overrides,
  });
}

describe('parseCorpusCaseManifest', () => {
  it.each(DISTINCT_FIXTURES)('parses "$id" with its own declared operator and oracle kind, not another case\'s', (fixture) => {
    const manifest = parseCorpusCaseManifest(manifestJsonFor(fixture));
    expect(manifest.id).toBe(fixture.id);
    expect(manifest.operator).toBe(fixture.operator);
    expect(manifest.operatorRole).toBe(fixture.operatorRole);
    expect(manifest.oracleKind).toBe(fixture.oracleKind);
    expect(manifest.testEffect).toBe(fixture.testEffect);
    expect(manifest.productionEffect).toBe(fixture.productionEffect);
    expect(manifest.expectedOutcome).toBe(fixture.expectedOutcome);
  });

  it('covers all six operator ids and all four oracle kinds across the fixture set', () => {
    expect(new Set(DISTINCT_FIXTURES.map((f) => f.operator))).toEqual(new Set(CORPUS_OPERATOR_IDS));
    expect(new Set(DISTINCT_FIXTURES.map((f) => f.oracleKind))).toEqual(new Set(CORPUS_ORACLE_KINDS));
  });

  it('rejects invalid JSON', () => {
    expect(() => parseCorpusCaseManifest('{not json')).toThrow(RangeError);
  });

  it('rejects a non-object top level', () => {
    expect(() => parseCorpusCaseManifest('[]')).toThrow(RangeError);
    expect(() => parseCorpusCaseManifest('"a string"')).toThrow(RangeError);
    expect(() => parseCorpusCaseManifest('42')).toThrow(RangeError);
  });

  it('rejects an unknown top-level field, including a hand-authored "proofStatus"', () => {
    const withExtra = manifestJsonFor(DISTINCT_FIXTURES[0]!, { proofStatus: 'proven' });
    expect(() => parseCorpusCaseManifest(withExtra)).toThrow(/unknown field/i);
    expect(() => parseCorpusCaseManifest(withExtra)).toThrow(/proofStatus/);
  });

  it('rejects a missing or empty id', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { id: undefined }))).toThrow(RangeError);
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { id: '   ' }))).toThrow(RangeError);
  });

  it('rejects a case declaring two operators', () => {
    expect(() => parseCorpusCaseManifest(
      manifestJsonFor(DISTINCT_FIXTURES[0]!, { operators: ['remove-assertion', 'mock-owned-logic'] }),
    )).toThrow(/exactly one operator/);
  });

  it('rejects a case declaring no operators', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { operators: [] })))
      .toThrow(/exactly one operator/);
  });

  it('rejects an unknown operator id', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { operators: ['delete-production-file'] })))
      .toThrow(/unknown operator/);
  });

  it('rejects a manifest missing "operatorRole"', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { operatorRole: undefined })))
      .toThrow(/must declare a known "operatorRole"/);
  });

  it('rejects a manifest declaring an unknown "operatorRole" value', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { operatorRole: 'vibes' })))
      .toThrow(/must declare a known "operatorRole"/);
  });

  it('accepts and returns a declared "operatorRole"', () => {
    const manifest = parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { operatorRole: 'prescriptive' }));
    expect(manifest.operatorRole).toBe('prescriptive');
  });

  it('rejects a missing or unknown oracleKind', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { oracleKind: undefined })))
      .toThrow(/oracleKind/);
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { oracleKind: 'vibes' })))
      .toThrow(/oracleKind/);
  });

  it('rejects a missing or empty testEffect', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { testEffect: undefined })))
      .toThrow(/testEffect/);
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { testEffect: '' })))
      .toThrow(/testEffect/);
  });

  it('rejects a missing or empty productionEffect', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { productionEffect: undefined })))
      .toThrow(/productionEffect/);
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { productionEffect: '' })))
      .toThrow(/productionEffect/);
  });

  it('rejects a manifest missing "expectedOutcome"', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { expectedOutcome: undefined })))
      .toThrow(/must declare a known "expectedOutcome"/);
  });

  it('rejects a manifest declaring an unknown "expectedOutcome" value', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { expectedOutcome: 'vibes' })))
      .toThrow(/must declare a known "expectedOutcome"/);
  });

  it('accepts and returns a declared "expectedOutcome"', () => {
    const manifest = parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { expectedOutcome: 'expected-to-fail' }));
    expect(manifest.expectedOutcome).toBe('expected-to-fail');
  });

  it('rejects a testFile that escapes its case directory', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { testFile: '../../etc/passwd' })))
      .toThrow(/testFile/);
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { testFile: '/etc/passwd' })))
      .toThrow(/testFile/);
  });

  it('rejects empty productionFiles', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { productionFiles: [] })))
      .toThrow(/productionFiles/);
  });

  it('rejects a productionFiles entry that escapes its case directory', () => {
    expect(() => parseCorpusCaseManifest(manifestJsonFor(DISTINCT_FIXTURES[0]!, { productionFiles: ['../secret.ts'] })))
      .toThrow(/productionFiles/);
  });
});

function sourceFile(path: string, contents = '// content'): CorpusSourceFile {
  return { path, contents };
}

function manifestFor(fixture: (typeof DISTINCT_FIXTURES)[number]): CorpusCaseManifest {
  return parseCorpusCaseManifest(manifestJsonFor(fixture));
}

describe('buildCorpusCase', () => {
  it('assembles a case and marks it unverified, never reading a proof status from the manifest', () => {
    const manifest = manifestFor(DISTINCT_FIXTURES[0]!);
    const built = buildCorpusCase(manifest, sourceFile('test.ts'), [sourceFile('production.ts')]);

    expect(built.id).toBe(manifest.id);
    expect(built.operator).toBe(manifest.operator);
    expect(built.oracleKind).toBe(manifest.oracleKind);
    expect(built.testEffect).toBe(manifest.testEffect);
    expect(built.productionEffect).toBe(manifest.productionEffect);
    expect(built.proofStatus).toBe('unverified');
  });

  it('carries the base test and production sources through as their own addressable entries', () => {
    const manifest = manifestFor(DISTINCT_FIXTURES[0]!);
    const baseTest = sourceFile('test.ts', 'it("x", () => {});');
    const production = sourceFile('production.ts', 'export const x = 1;');
    const built = buildCorpusCase(manifest, baseTest, [production]);

    expect(built.baseTest).toEqual(baseTest);
    expect(built.productionSources).toEqual([production]);
  });

  it('rejects a base test whose path does not match the manifest\'s declared testFile', () => {
    const manifest = manifestFor(DISTINCT_FIXTURES[0]!);
    expect(() => buildCorpusCase(manifest, sourceFile('wrong.ts'), [sourceFile('production.ts')]))
      .toThrow(/testFile/);
  });

  it('rejects production sources whose paths do not match the manifest\'s declared productionFiles', () => {
    const manifest = manifestFor(DISTINCT_FIXTURES[0]!);
    expect(() => buildCorpusCase(manifest, sourceFile('test.ts'), [sourceFile('wrong.ts')]))
      .toThrow(/productionFiles/);
  });

  it('rejects a production source count mismatch', () => {
    const manifest = manifestFor(DISTINCT_FIXTURES[0]!);
    expect(() => buildCorpusCase(manifest, sourceFile('test.ts'), [])).toThrow(/productionFiles/);
  });

  it('does not accept a proofStatus override even if a caller tries to smuggle one in', () => {
    const manifest = manifestFor(DISTINCT_FIXTURES[0]!);
    const built = buildCorpusCase(
      manifest,
      sourceFile('test.ts'),
      [sourceFile('production.ts')],
    );
    // No third-party field can influence this: the return shape is fixed by buildCorpusCase itself.
    expect(Object.keys(built).sort()).toEqual(
      [
        'baseTest', 'expectedOutcome', 'id', 'operator', 'operatorRole',
        'oracleKind', 'productionEffect', 'productionSources', 'proofStatus', 'testEffect',
      ].sort(),
    );
  });
});
