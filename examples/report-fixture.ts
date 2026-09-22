/**
 * Synthetic audit report used only to render `examples/audit-report.html`.
 * The numbers are a style fixture: they exercise every status, the cost line,
 * and the noul matrix. They are not a recorded audit.
 */
import type { DimensionJudgment, OverallClassificationStatus } from '../src/domain/classification.js';
import type { AuditReport, AuditReportClassification } from '../src/domain/report.js';
import type { RubricDimensionId } from '../src/domain/rubric.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

const LABELS: readonly { id: RubricDimensionId; label: string }[] = [
  { id: 'falsifiability', label: 'Falsifiability' },
  { id: 'behavioral-focus', label: 'Behavioral focus' },
  { id: 'refactor-resistance', label: 'Refactor resistance' },
  { id: 'assertion-strength', label: 'Assertion strength' },
  { id: 'test-double-quality', label: 'Test-double quality' },
  { id: 'determinism-isolation', label: 'Determinism and isolation' },
  { id: 'diagnostic-quality', label: 'Diagnostic quality' },
];

function dimension(id: RubricDimensionId, label: string, score: number, applicability = 0.9): DimensionJudgment {
  const level = score >= 3 ? 'strong' : score >= 2 ? 'acceptable' : score >= 1 ? 'weak' : 'misleading';
  const applicable = applicability >= 0.5;
  return {
    dimensionId: id,
    dimensionLabel: label,
    applicable,
    applicabilityProbability: applicability,
    status: applicable ? 'judged' : 'not-applicable',
    level: applicable ? level : undefined,
    score: applicable ? score : undefined,
    confidence: applicable ? 0.8 : undefined,
    reason: undefined,
    probabilities: { '0': 0.05, '1': 0.1, '2': 0.15, '3': 0.7 },
    deficientMass: score < 2 ? 0.6 : 0.08,
    acceptableMass: score < 2 ? 0.4 : 0.92,
    criticalMass: score < 1 ? 0.4 : 0.05,
  };
}

function dimensions(scores: readonly number[], applicability: readonly number[]): DimensionJudgment[] {
  return LABELS.map((entry, index) => dimension(entry.id, entry.label, scores[index] ?? 0, applicability[index] ?? 0.9));
}

function classification(
  name: string,
  path: string,
  status: OverallClassificationStatus,
  scores: readonly number[],
  applicability: readonly number[],
  cache: 'fresh' | 'cached',
): AuditReportClassification {
  return {
    testCaseId: `tc:v1:${name}` as TestCaseId,
    repositoryRelativePath: path,
    name,
    status,
    dimensions: dimensions(scores, applicability),
    findings: status === 'healthy' ? [] : [{
      testCaseId: `tc:v1:${name}` as TestCaseId,
      repositoryRelativePath: path,
      name,
      dimensionId: 'falsifiability',
      dimensionLabel: 'Falsifiability',
      level: status === 'misleading' ? 'misleading' : 'weak',
      score: scores[0] ?? 0,
      confidence: 0.8,
      applicabilityProbability: 0.9,
      status: 'judged',
      reason: undefined,
      probabilities: { '0': 0.05, '1': 0.1, '2': 0.15, '3': 0.7 },
      deficientMass: 0.4,
      acceptableMass: 0.6,
      criticalMass: 0.1,
    }],
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: cache === 'fresh' ? 4605 : 4100, outputTokens: 180 },
    cache,
    ...(cache === 'fresh' ? { latency: { latencyMs: 840, attemptLatenciesMs: [840] } } : {}),
    evidence: { fragments: 2, truncatedFragments: 0, denied: [], unresolved: [], omitted: [] },
  };
}

function markNeedsReview(entry: AuditReportClassification): AuditReportClassification {
  return {
    ...entry,
    dimensions: entry.dimensions.map((dimension, index) => index === 4
      ? { ...dimension, status: 'needs-review', level: undefined, score: undefined }
      : dimension),
  };
}

export function exampleAuditReport(): AuditReport {
  return {
    reportVersion: 1,
    rootDir: 'examples/billing-service',
    runId: 'run:v1:example',
    reportingOnly: true,
    complete: true,
    versions: { storeSchema: 3, rubric: 2, policy: 2 },
    modelRequested: 'jev-1.13.0',
    discovery: {
      files: [
        { path: 'src/billing.test.ts', framework: 'vitest', testCaseCount: 4, dynamicMetadataCount: 0, evidenceBundleCount: 4 },
        { path: 'src/invoice.test.ts', framework: 'jest', testCaseCount: 2, dynamicMetadataCount: 1, evidenceBundleCount: 2 },
      ],
      excluded: [{ path: 'e2e/checkout.spec.ts', reason: 'unsupported-framework' }],
      totals: {
        files: 2,
        excluded: 1,
        testCases: 6,
        dynamicMetadata: 1,
        diagnostics: 1,
        unsupportedFrameworkFiles: 1,
        evidenceBundles: 6,
        evidenceFragments: 12,
        evidenceTruncatedFragments: 0,
        evidenceOmitted: 0,
        evidenceDenied: 0,
        evidenceUnresolved: 0,
      },
    },
    totals: {
      evaluated: 4,
      cached: 1,
      failed: 1,
      skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
      usage: { inputTokens: 18420, outputTokens: 720 },
      statusCounts: { healthy: 2, weak: 1, misleading: 1, 'needs-review': 1 },
      respondedModel: 'jev-1.13.0',
      modelMismatches: 0,
    },
    latency: { measuredTestCases: 4, totalMs: 3360, meanMs: 840, minMs: 410, maxMs: 1280 },
    cacheStatus: [
      { testCaseId: 'tc:v1:failed' as TestCaseId, repositoryRelativePath: 'src/refund.test.ts', name: 'rejects a negative amount', status: 'not-evaluated' },
    ],
    classifications: [
      classification('never double charges', 'src/billing.test.ts', 'misleading', [0, 1, 2, 0, 1, 2, 0], [0.22, 0.91, 0.84, 0.18, 0.77, 0.63, 0.41], 'fresh'),
      classification('formats the invoice total', 'src/invoice.test.ts', 'weak', [0, 1, 2, 1, 1, 3, 0], [0.58, 0.86, 0.93, 0.71, 0.66, 0.97, 0.35], 'fresh'),
      markNeedsReview(classification('retries a declined charge', 'src/billing.test.ts', 'needs-review', [1, 1, 2, 1, 2, 3, 1], [0.81, 0.74, 0.88, 0.69, 0.52, 0.95, 0.8], 'fresh')),
      classification('charges the saved card', 'src/billing.test.ts', 'healthy', [1, 2, 3, 2, 2, 3, 1], [0.96, 0.92, 0.98, 0.9, 0.87, 0.99, 0.73], 'cached'),
      classification('records the ledger entry', 'src/invoice.test.ts', 'healthy', [2, 2, 3, 3, 3, 3, 2], [0.9, 0.85, 0.94, 0.97, 0.91, 0.96, 0.88], 'fresh'),
    ],
    diagnostics: [
      { code: 'evaluation-failed', message: 'Provider timed out while judging rejects a negative amount.', severity: 'error', path: 'src/refund.test.ts' },
    ],
  };
}
