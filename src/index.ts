export { getResolvedConfiguration } from './application/configure.js';
export {
  DEFAULT_CONFIGURATION,
  resolveConfiguration,
  type ConfigurationOverrides,
  type EvidenceConfigurationOverrides,
  type ResolvedConfiguration,
  type ResolvedEvidenceConfiguration,
  type ResolvedStoreConfiguration,
  type StoreConfigurationOverrides,
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
  createMemoizingAliasConfigReader,
  resolveAliasConfig,
  type AliasConfigReader,
  type AliasConfigRequest,
} from './adapters/alias-config.js';
export {
  type AliasConfigRefusal,
  type AliasConfigRefusalReason,
  type AliasMappingEntry,
  type AliasMappingSource,
  type AliasMappings,
} from './domain/alias-config.js';
export {
  selectEvidence,
  type EvidenceSelectionRequest,
} from './adapters/evidence-selection.js';
export {
  createAuditEvidencePort,
  createMemoizingSourceReader,
  type SourceReader,
} from './adapters/evidence-audit-port.js';
export {
  classifyTestCase,
  estimateDryRun,
  estimateTokensFromBytes,
  JEV_ESTIMATE_SNAPSHOT,
  JEV_VERIFIED_RATE_LIMITS,
  validateJevEstimateSnapshot,
  type DryRunClassification,
  type DryRunEstimate,
  type DryRunFileInput,
  type DryRunRange,
  type DryRunSkippedReason,
  type DryRunSkippedTotals,
  type JevEstimateSnapshot,
} from './domain/estimate.js';

export {
  JEV_MODEL_ID,
  RUBRIC_DIMENSION_IDS,
  RUBRIC_QUALITY_LEVEL_COUNT,
  RUBRIC_QUALITY_LEVELS,
  RUBRIC_V1,
  RUBRIC_V2,
  validateRubric,
  type NoulCriteria,
  type Rubric,
  type RubricDimension,
  type RubricDimensionId,
  type RubricNoulQuestion,
  type RubricQuestion,
  type RubricScoreQuestion,
} from './domain/rubric.js';
export {
  assertJevRequestWithinBudget,
  buildJevQuestions,
  buildJevRequest,
  buildJevState,
  canonicalizeJevRequest,
  canonicalizeJevRequestQuestions,
  checkJevRequestBudget,
  JEV_REQUEST_LIMITS,
  type BuildJevRequestInput,
  type JevQuestion,
  type JevRequest,
  type JevRequestBudgetCheck,
  type JevRequestLimits,
  type JevState,
  type JevStateAncestrySegment,
  type JevStateDenied,
  type JevStateFragment,
  type JevStateOmitted,
  type JevStateUnresolved,
} from './domain/jev-request.js';

export {
  JevAbortError,
  JevAuthError,
  JevConfigurationError,
  JevOverloadedError,
  JevRateLimitError,
  JevRequestError,
  JevResponseError,
  JevTimeoutError,
  type JevAnswer,
  type JevEvaluation,
  type JevGatewayError,
  type JevGatewayErrorCode,
  type JevGatewayEvaluateOptions,
  type JevGatewayPort,
  type JevNoulAnswer,
  type JevRawAnswer,
  type JevRawNoulAnswer,
  type JevRawScoreAnswer,
  type JevScoreAnswer,
  type JevUsage,
} from './domain/jev-gateway.js';
export {
  createJevHttpGateway,
  DEFAULT_JEV_RETRY_CONFIG,
  DEFAULT_JEV_TIMEOUT_MS,
  JEV_TYPESAFE_BASE_URL,
  type CreateJevHttpGatewayOptions,
  type JevFetch,
  type JevRetryConfig,
  type JevSleep,
} from './adapters/jev-http-gateway.js';
export { createJevEvaluationPort } from './adapters/jev-evaluation-port.js';

export {
  AUTH_CREDENTIALS_VERSION,
  AuthBlankKeyError,
  AuthCorruptCredentialsError,
  AuthInsecurePermissionsError,
  AuthPromptCancelledError,
  resolveApiKey,
  type ApiKeyResolution,
  type ApiKeySource,
  type AuthStorageError,
  type AuthStorageErrorCode,
  type ResolveApiKeyInput,
  type StoredCredentials,
} from './domain/auth.js';
export {
  deleteStoredCredentials,
  readStoredCredentials,
  resolveAuthStoragePaths,
  statStoredCredentialsFile,
  writeStoredCredentials,
  type AuthStorageEnvironment,
  type AuthStorageFsOps,
  type AuthStorageOptions,
  type AuthStoragePaths,
  type StoredCredentialsFileStatus,
} from './adapters/auth-storage.js';
export {
  readApiKeyFromPrompt,
  type AuthPromptReadable,
  type AuthPromptStreams,
  type AuthPromptWritable,
} from './adapters/auth-prompt.js';

export {
  CLASSIFICATION_LEVELS,
  CLASSIFICATION_POLICY_V1,
  CLASSIFICATION_POLICY_V2,
  PROBABILITY_SUM_TOLERANCE,
  classifyEvaluation,
  isClassificationPolicyV2,
  validateClassificationPolicy,
  type ClassificationFinding,
  type ClassificationLevel,
  type ClassificationPolicy,
  type ClassificationPolicyV1,
  type ClassificationPolicyV2,
  type ClassificationResult,
  type ClassificationTestCaseIdentity,
  type ClassifyEvaluationInput,
  type DimensionJudgment,
  type DimensionJudgmentStatus,
  type DimensionNeedsReviewReason,
  type OverallClassificationStatus,
} from './domain/classification.js';

export { runAudit, type RunAuditOptions } from './application/audit.js';
export {
  AuditStoreCorruptError,
  AuditStoreSchemaVersionError,
  WORK_ITEM_STATES,
  type AuditCacheKeyPort,
  type AuditDiagnostic,
  type AuditDiscoveryPort,
  type AuditEvaluationOutcome,
  type AuditEvaluationPort,
  type AuditEvaluationRequest,
  type AuditEvaluationResult,
  type AuditEvaluationTotals,
  type AuditEvidenceBuildRequest,
  type AuditEvidenceBuildResult,
  type AuditEvidencePort,
  type AuditExtractorPort,
  type AuditFileResult,
  type AuditPorts,
  type AuditRequest,
  type AuditResult,
  type AuditSourceReaderPort,
  type AuditStoreCachedJudgment,
  type AuditStoreError,
  type AuditStoreErrorCode,
  type AuditStorePort,
  type AuditStoreWorkItemIdentity,
  type AuditStoreWorkItemOutcome,
  type AuditTotals,
  type SourceReadRequest,
  type WorkItemState,
} from './domain/audit.js';

export {
  computeCacheKey,
  createAuditCacheKeyPort,
  type CacheKeyInput,
} from './adapters/cache-key.js';

export {
  createSqliteAuditStore,
  isSqliteExperimentalWarning,
  resolveAuditStorePaths,
  withSqliteExperimentalWarningSuppressed,
  type AuditStorePathEnvironment,
  type AuditStorePaths,
  type CreateSqliteAuditStoreOptions,
} from './adapters/sqlite-audit-store.js';
