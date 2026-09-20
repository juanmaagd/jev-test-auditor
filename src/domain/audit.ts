import type {
  ClassificationResult,
  OverallClassificationStatus,
} from './classification.js';
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
import type { DryRunSkippedTotals } from './estimate.js';
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

/** One evaluable test case and its evidence, ready to be judged (Phase 4, task P4-4). */
export interface AuditEvaluationRequest {
  readonly testCase: TestCase;
  readonly bundle: EvidenceBundle;
}

/**
 * The Jev evaluation port (Phase 4, task P4-4): builds the request, calls
 * the gateway, and classifies the result for exactly one evaluable test
 * case. Production is `src/adapters/jev-evaluation-port.ts`, composing
 * `buildJevRequest`, a `JevGatewayPort`, and `classifyEvaluation` over the
 * shipped `RUBRIC_V1`/`CLASSIFICATION_POLICY_V1`.
 *
 * **This port is the entire opt-in gate.** `runAudit` (see {@link AuditPorts.evaluation})
 * evaluates every evaluable test case if and only if this port is present on
 * `AuditPorts`; when it is `undefined`, evaluation is skipped entirely —
 * `runAudit` never constructs a gateway, reads an API key, or reaches the
 * network on its own. The CLI composition root is responsible for
 * constructing this port lazily, only when `--evaluate` was actually
 * requested (`createJevHttpGateway` validates the API key eagerly, so
 * constructing it unconditionally would turn every offline run into a
 * configuration error).
 *
 * A rejected promise from `evaluate` is a single test case's failure, never
 * the whole run's: `runAudit` isolates it into one `evaluation-failed`
 * diagnostic naming the test case id and the error's typed kind (never the
 * API key or the request body) and simply records no classification for
 * that test case — uncertainty is not quality, so a failure is never
 * represented as a fabricated verdict.
 */
export interface AuditEvaluationPort {
  evaluate(request: AuditEvaluationRequest): Promise<ClassificationResult>;
}

export interface AuditPorts {
  readonly discovery: AuditDiscoveryPort;
  readonly sourceReader: AuditSourceReaderPort;
  readonly extractor: AuditExtractorPort;
  readonly evidence: AuditEvidencePort;
  /** Opt-in (Phase 4, task P4-4): see {@link AuditEvaluationPort}'s own doc for the full opt-in contract. */
  readonly evaluation?: AuditEvaluationPort;
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
  /**
   * Count of files carrying an `unsupported-framework` diagnostic (B-1,
   * `odd/tasks/bun-test-support.md`): a discovered, included test file
   * whose framework could not be attributed and that produced zero test
   * cases. Reported explicitly so a reader sees this without reading every
   * diagnostic record — the same silence the diagnostic itself exists to
   * prevent must not reappear one level up in the totals.
   */
  readonly unsupportedFrameworkFiles: number;
  readonly evidenceBundles: number;
  readonly evidenceFragments: number;
  readonly evidenceTruncatedFragments: number;
  readonly evidenceOmitted: number;
  readonly evidenceDenied: number;
  readonly evidenceUnresolved: number;
}

/**
 * Evaluation totals (Phase 4, task P4-4). `evaluated`, `failed`, and
 * `skipped` always sum to the total number of test cases `classifyTestCase`
 * (see `src/domain/estimate.ts`) considered across the whole run: `skipped`
 * is never evaluated at all (a static `skip`/`todo` modifier or no built
 * evidence bundle); `failed` was attempted but its gateway call or
 * classification threw; `evaluated` succeeded and has a
 * {@link ClassificationResult} in `classifications`. `modelMismatches`
 * counts evaluated test cases whose `model.matchesPin` is `false` — the
 * verified provider contract requires this to be reported, never hidden
 * (Phase 4 Scope), and a single "first success" `respondedModel` alone
 * would silently hide a mismatch on a later call.
 */
export interface AuditEvaluationTotals {
  readonly evaluated: number;
  readonly failed: number;
  readonly skipped: DryRunSkippedTotals;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly statusCounts: Readonly<Record<OverallClassificationStatus, number>>;
  /** The `model.responded` of the first successful evaluation, in submission order; `undefined` when none succeeded. Not a claim that every evaluation responded with the same model — see `modelMismatches`. */
  readonly respondedModel: string | undefined;
  readonly modelMismatches: number;
}

/**
 * The full evaluation outcome for one audit run (Phase 4, task P4-4).
 * `classifications` holds one entry per successfully evaluated test case,
 * in the same deterministic file-then-test-case order as `AuditResult.files`
 * regardless of which gateway call actually completed first (see
 * `runBoundedPool` in `src/application/audit.ts`) — never sorted or
 * reordered afterward, and never containing an entry for a failed or
 * skipped test case.
 */
export interface AuditEvaluationResult {
  readonly classifications: readonly ClassificationResult[];
  readonly totals: AuditEvaluationTotals;
}

export interface AuditResult {
  readonly rootDir: string;
  readonly files: readonly AuditFileResult[];
  readonly excluded: readonly ExcludedTestFile[];
  readonly diagnostics: readonly AuditDiagnostic[];
  readonly totals: AuditTotals;
  readonly reportingOnly: true;
  /** `undefined` unless `--evaluate` was requested (i.e. `AuditPorts.evaluation` was present) — see {@link AuditEvaluationPort}'s doc for the full opt-in contract. */
  readonly evaluation?: AuditEvaluationResult;
}

export type AuditConfigurationOverrides = ConfigurationOverrides;
