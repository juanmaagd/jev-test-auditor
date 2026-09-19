export { getResolvedConfiguration } from './application/configure.js';
export {
  DEFAULT_CONFIGURATION,
  resolveConfiguration,
  type ConfigurationOverrides,
  type ResolvedConfiguration,
} from './domain/config.js';
export { createTestCaseId } from './adapters/test-case-identity.js';
export {
  type AssertionApi,
  type AssertionRecord,
  type Diagnostic,
  type DiagnosticSeverity,
  type DynamicMetadataReason,
  type DynamicMetadata,
  type HookKind,
  type ImportKind,
  type HookRecord,
  type ImportRecord,
  type MockApi,
  type MockRecord,
  type DynamicParameterization,
  type NoParameterization,
  type ParameterizationMetadata,
  type StaticParameterization,
  type SourcePosition,
  type SourceSpan,
  type StaticParameterCase,
  type StaticParameterIdentity,
  type StructuralAncestrySegment,
  type TestCase,
  type TestCaseId,
  type TestCaseIdInput,
  type TestCaseKind,
  type TestFramework,
  type TestModifier,
  type TestModifierKind,
} from './domain/test-understanding.js';

export { discoverTestFiles } from './adapters/repository-discovery.js';
export {
  DEFAULT_DISCOVERY_EXCLUDES,
  DEFAULT_DISCOVERY_INCLUDE,
  type DiscoveredTestFile,
  type DiscoveryExclusionReason,
  type DiscoveryRequest,
  type DiscoveryResult,
  type ExcludedTestFile,
  type FrameworkEvidence,
  type FrameworkEvidenceSource,
} from './domain/discovery.js';
export { extractTestCases } from './adapters/test-extraction.js';
export { readSourceFile } from './adapters/source-reader.js';
export {
  type TestExtractionRequest,
  type TestExtractionResult,
} from './domain/extraction.js';

export {
  buildEvidenceBundle,
  canonicalizeEvidenceBundle,
  DEFAULT_EVIDENCE_BUDGET,
  DEFAULT_EVIDENCE_DENY_PATTERNS,
  validateEvidenceBudget,
  type DeniedEvidence,
  type EvidenceBudget,
  type EvidenceBundle,
  type EvidenceBundleInput,
  type EvidenceFragment,
  type EvidenceFragmentKind,
  type EvidenceSelectionReason,
  type EvidenceTotals,
  type EvidenceTruncation,
  type OmittedEvidence,
  type OmittedEvidenceReason,
  type ResolvedEvidenceFile,
  type UnresolvedEvidence,
  type UnresolvedEvidenceReason,
} from './domain/evidence.js';
export {
  hashEvidenceBundle,
  hashEvidenceContent,
} from './adapters/evidence-hash.js';
export {
  resolveEvidenceFiles,
  type EvidenceResolutionRequest,
  type EvidenceResolutionResult,
} from './adapters/evidence-resolution.js';
export {
  selectEvidence,
  type EvidenceSelectionRequest,
} from './adapters/evidence-selection.js';

export { runAudit } from './application/audit.js';
export {
  type AuditDiagnostic,
  type AuditDiscoveryPort,
  type AuditExtractorPort,
  type AuditFileResult,
  type AuditPorts,
  type AuditRequest,
  type AuditResult,
  type AuditSourceReaderPort,
  type AuditTotals,
  type SourceReadRequest,
} from './domain/audit.js';
