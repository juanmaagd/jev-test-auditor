import { createHash } from 'node:crypto';
import {
  canonicalizeTestCaseIdentity,
  normalizeTestSource,
  type TestCaseId,
  type TestCaseIdInput,
} from '../domain/test-understanding.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createTestCaseId(input: TestCaseIdInput): TestCaseId {
  const normalizedSourceHash = sha256(normalizeTestSource(input.testSource));
  const canonicalIdentity = canonicalizeTestCaseIdentity(input, normalizedSourceHash);
  return `tc:v1:${sha256(canonicalIdentity)}`;
}
