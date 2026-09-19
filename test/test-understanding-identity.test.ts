import { describe, expect, it } from 'vitest';
import { createTestCaseId, type TestCaseIdInput } from '../src/index.js';

const baseInput: TestCaseIdInput = {
  repositoryRelativePath: 'src/math.test.ts',
  structuralAncestry: [
    { kind: 'suite', name: 'math', ordinal: 0 },
    { kind: 'test', name: 'adds numbers', ordinal: 0 },
  ],
  testSource: 'expect(add(1, 2)).toBe(3);',
};

describe('stable test case identity', () => {
  it('is deterministic for the same normalized input', () => {
    const firstId = createTestCaseId(baseInput);
    const secondId = createTestCaseId({ ...baseInput });

    expect(firstId).toBe(secondId);
    expect(firstId).toMatch(/^tc:v1:[0-9a-f]{64}$/u);
  });

  it('treats Windows and POSIX separators as the same repository path', () => {
    const windowsId = createTestCaseId({ ...baseInput, repositoryRelativePath: 'src\\math.test.ts' });

    expect(windowsId).toBe(createTestCaseId(baseInput));
  });

  it('treats CRLF and CR source as the same normalized source', () => {
    const crlfId = createTestCaseId({ ...baseInput, testSource: 'expect(add(1, 2)).toBe(3);\r\n' });
    const crId = createTestCaseId({ ...baseInput, testSource: 'expect(add(1, 2)).toBe(3);\r' });
    const lfId = createTestCaseId({ ...baseInput, testSource: 'expect(add(1, 2)).toBe(3);\n' });

    expect(crlfId).toBe(lfId);
    expect(crId).toBe(lfId);
  });

  it('keeps duplicate structural names distinct through ordinals', () => {
    const secondDuplicateId = createTestCaseId({
      ...baseInput,
      structuralAncestry: baseInput.structuralAncestry.map((segment, index) => (
        index === 1 ? { ...segment, ordinal: 1 } : segment
      )),
    });

    expect(secondDuplicateId).not.toBe(createTestCaseId(baseInput));
  });

  it('does not change when presentation line locations move but test source stays the same', () => {
    const movedSourceId = createTestCaseId({
      ...baseInput,
      sourceSpan: { start: { line: 100, column: 0 }, end: { line: 100, column: 28 } },
    });

    expect(movedSourceId).toBe(createTestCaseId(baseInput));
  });

  it.each([
    ['path', { ...baseInput, repositoryRelativePath: 'src/other.test.ts' }],
    ['ancestry', {
      ...baseInput,
      structuralAncestry: [
        { kind: 'suite', name: 'other', ordinal: 0 },
        { kind: 'test', name: 'adds numbers', ordinal: 0 },
      ],
    }],
    ['source', { ...baseInput, testSource: 'expect(add(2, 2)).toBe(4);' }],
  ] as const)('changes when the %s identity component changes', (_label, changedInput) => {
    expect(createTestCaseId(changedInput)).not.toBe(createTestCaseId(baseInput));
  });

  it('gives each static parameter case a distinct identity', () => {
    const firstCaseId = createTestCaseId({
      ...baseInput,
      staticParameter: { index: 0, valueHash: 'a' },
    });
    const differentValueId = createTestCaseId({
      ...baseInput,
      staticParameter: { index: 0, valueHash: 'b' },
    });
    const differentIndexId = createTestCaseId({
      ...baseInput,
      staticParameter: { index: 1, valueHash: 'a' },
    });

    expect(firstCaseId).not.toBe(differentValueId);
    expect(firstCaseId).not.toBe(differentIndexId);
    expect(firstCaseId).not.toBe(createTestCaseId(baseInput));
  });

  it('rejects a static parameter identity without a value hash at runtime', () => {
    const malformedInput = {
      ...baseInput,
      staticParameter: { index: 0 },
    } as TestCaseIdInput;

    expect(() => createTestCaseId(malformedInput)).toThrow(/value hash/u);
  });

  it.each([
    '/absolute.test.ts',
    'C:\\repo\\absolute.test.ts',
    '../outside.test.ts',
    'suite/../../outside.test.ts',
  ])('rejects identity paths outside the repository root: %s', (repositoryRelativePath) => {
    expect(() => createTestCaseId({ ...baseInput, repositoryRelativePath })).toThrow(/repository-relative/u);
  });
});
