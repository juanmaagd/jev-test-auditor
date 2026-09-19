import type {
  ConfigurationOverrides,
  ResolvedConfiguration,
} from './config.js';
import type {
  DiscoveredTestFile,
  DiscoveryRequest,
  DiscoveryResult,
  ExcludedTestFile,
} from './discovery.js';
import type {
  TestExtractionRequest,
  TestExtractionResult,
} from './extraction.js';
import type {
  Diagnostic,
  DynamicMetadata,
  TestCase,
} from './test-understanding.js';
import type { EvidenceBudget, EvidenceBundle } from './evidence.js';

export interface SourceReadRequest {
  readonly rootDir: string;
  readonly repositoryRelativePath: string;
}

export interface AuditDiscoveryPort {
  discover(request: DiscoveryRequest): Promise<DiscoveryResult>;
}

export interface AuditSourceReaderPort {
  read(request: SourceReadRequest): Promise<string>;
}

export interface AuditExtractorPort {
  extract(request: TestExtractionRequest): TestExtractionResult;
}

export interface AuditEvidenceBuildRequest {
  readonly rootDir: string;
  readonly repositoryRelativePath: string;
  /** Full source text of the file, already read once by {@link AuditSourceReaderPort}; the evidence port never re-reads the test file itself. */
  readonly sourceText: string;
  readonly testCases: readonly TestCase[];
  readonly budget: EvidenceBudget;
  /** Additive deny patterns, layered on top of the resolver's own always-applied defaults. */
  readonly deny: readonly string[];
}

export interface AuditEvidenceBuildResult {
  /**
   * One bundle per SUCCESSFULLY selected test case, in `request.testCases`
   * relative order; callers match a bundle to its test case by
   * `bundle.testCaseId`, not by array position, since a failed selection
   * contributes no entry here at all.
   */
  readonly bundles: readonly EvidenceBundle[];
  /**
   * One `evidence-selection-failed` diagnostic per test case whose
   * selection failed, naming that test case's id and name. Uncertainty is
   * not quality: a failed selection is never represented as an empty (or
   * otherwise placeholder) bundle indistinguishable from "this test
   * genuinely has no supporting evidence" — it is reported here instead,
   * and simply produces no bundle.
   */
  readonly diagnostics: readonly Diagnostic[];
}

export interface AuditEvidencePort {
  /**
   * Builds evidence for `request.testCases`. Never called for a file with
   * zero test cases. See {@link AuditEvidenceBuildResult} for how success
   * and per-test-case failure are represented.
   */
  build(request: AuditEvidenceBuildRequest): Promise<AuditEvidenceBuildResult>;
}

export interface AuditPorts {
  readonly discovery: AuditDiscoveryPort;
  readonly sourceReader: AuditSourceReaderPort;
  readonly extractor: AuditExtractorPort;
  readonly evidence: AuditEvidencePort;
}

export type AuditRequest = ResolvedConfiguration;

export interface AuditFileResult {
  readonly discovered: DiscoveredTestFile;
  readonly testCases: readonly TestCase[];
  readonly dynamicMetadata: readonly DynamicMetadata[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * One bundle per successfully selected test case (matched by
   * `bundle.testCaseId`, not position — see {@link AuditEvidenceBuildResult}).
   * Empty when there are no test cases, every test case's selection failed
   * (see `evidence-selection-failed` diagnostics), or the whole file's
   * evidence build failed (see the `evidence-failed` diagnostic).
   */
  readonly evidence: readonly EvidenceBundle[];
}

export interface AuditDiagnostic extends Diagnostic {
  readonly repositoryRelativePath?: string;
}

export interface AuditTotals {
  readonly files: number;
  readonly excluded: number;
  readonly testCases: number;
  readonly dynamicMetadata: number;
  readonly diagnostics: number;
  readonly evidenceBundles: number;
  readonly evidenceFragments: number;
  readonly evidenceTruncatedFragments: number;
  readonly evidenceOmitted: number;
  readonly evidenceDenied: number;
  readonly evidenceUnresolved: number;
}

export interface AuditResult {
  readonly rootDir: string;
  readonly files: readonly AuditFileResult[];
  readonly excluded: readonly ExcludedTestFile[];
  readonly diagnostics: readonly AuditDiagnostic[];
  readonly totals: AuditTotals;
  readonly reportingOnly: true;
}

export type AuditConfigurationOverrides = ConfigurationOverrides;
