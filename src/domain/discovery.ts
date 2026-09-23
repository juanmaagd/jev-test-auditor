import type { Diagnostic, TestFramework } from './test-understanding.js';

export const DEFAULT_DISCOVERY_INCLUDE = '**/*.{test,spec}.{js,jsx,ts,tsx}';
export const DEFAULT_DISCOVERY_EXCLUDES: readonly string[] = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/vendor/**',
  '**/coverage/**',
  '**/generated/**',
  // `.jta/` (feature "persisted-run-reports") is where `audit --evaluate` persists its own canonical
  // report JSON inside the audited project's own root (`src/adapters/persisted-report-store.ts`) —
  // excluded by default exactly like `.git`/`node_modules`, so a repeat run never discovers its own
  // prior output.
  '**/.jta/**',
];

export type DiscoveryExclusionReason =
  | 'unsupported-extension'
  | 'not-test-file'
  | 'configured-exclude'
  | 'default-exclude'
  | 'e2e-v1'
  | 'symlink'
  | 'outside-root';

export type FrameworkEvidenceSource = 'import' | 'package';

export interface FrameworkEvidence {
  readonly framework: Exclude<TestFramework, 'unknown'>;
  readonly source: FrameworkEvidenceSource;
  readonly detail: string;
}

export interface DiscoveredTestFile {
  readonly repositoryRelativePath: string;
  readonly framework: TestFramework;
  readonly frameworkEvidence: readonly FrameworkEvidence[];
}

export interface ExcludedTestFile {
  readonly repositoryRelativePath: string;
  readonly reason: DiscoveryExclusionReason;
  readonly evidence: readonly string[];
}

export interface DiscoveryRequest {
  readonly rootDir: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface DiscoveryResult {
  readonly files: readonly DiscoveredTestFile[];
  readonly excluded: readonly ExcludedTestFile[];
  readonly diagnostics: readonly Diagnostic[];
}
