import {
  canonicalizeTestCaseIdentity,
  normalizeTestSource,
  type TestCaseId,
  type TestCaseIdInput,
} from '../domain/test-understanding.js';
import { sha256 } from './hash.js';

export function createTestCaseId(input: TestCaseIdInput): TestCaseId {
  const normalizedSourceHash = sha256(normalizeTestSource(input.testSource));
  const canonicalIdentity = canonicalizeTestCaseIdentity(input, normalizedSourceHash);
  return `tc:v1:${sha256(canonicalIdentity)}`;
}
