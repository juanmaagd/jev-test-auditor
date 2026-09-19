import type {
  Diagnostic,
  DynamicMetadata,
  TestCase,
  TestFramework,
} from './test-understanding.js';

export interface TestExtractionRequest {
  readonly repositoryRelativePath: string;
  readonly sourceText: string;
  readonly frameworkHint?: TestFramework;
}

export interface TestExtractionResult {
  readonly testCases: readonly TestCase[];
  readonly dynamicMetadata: readonly DynamicMetadata[];
  readonly diagnostics: readonly Diagnostic[];
}
