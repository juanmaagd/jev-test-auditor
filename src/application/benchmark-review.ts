/**
 * Benchmark review application orchestration (Phase 8, task P8-3,
 * `odd/tasks/phase-8-benchmark-review-skill.md`).
 *
 * Coordinates:
 * 1. Preparing blind review sessions from stored benchmark runs and corpus cases.
 * 2. Enforcing strict blindness invariants on all worker payloads.
 * 3. Recording frozen subagent assessments and computing discrepancy classifications.
 * 4. Completing review sessions with aggregate summaries and error categorization.
 *
 * Inward architecture boundary: pure application layer — imports only relative domain
 * and application modules, no Node builtins, no adapters. Enforced by
 * `test/architecture-boundary.test.ts` and `test/benchmark-review-boundary.test.ts`.
 */
import {
  assertPayloadIsBlind,
  compareReviewAssessment,
  createBlindReviewPayload,
  selectBenchmarkReviewCases,
  type BenchmarkCaseReviewComparison,
  type BenchmarkReviewSelectionOptions,
  type BlindReviewWorkerPayload,
  type FrozenWorkerAssessment,
  type ReviewDiscrepancyKind,
} from '../domain/benchmark-review.js';
import type {
  BenchmarkCaseOutcome,
  BenchmarkFixtureFile,
  BenchmarkReviewCaseRecord,
  BenchmarkReviewRunRecord,
  BenchmarkStorePort,
} from '../domain/benchmark-store.js';
import type { CorpusCase } from '../domain/corpus.js';

export interface PrepareReviewSessionOptions {
  readonly benchmarkRunId: string;
  readonly selection: BenchmarkReviewSelectionOptions;
  readonly corpusCases: readonly CorpusCase[];
}

export interface PreparedReviewSession {
  readonly reviewRunId: string;
  readonly benchmarkRunId: string;
  readonly payloads: readonly BlindReviewWorkerPayload[];
  readonly selectedOutcomes: readonly BenchmarkCaseOutcome[];
}

/**
 * Prepares a blind review session by loading outcomes from a stored benchmark run,
 * selecting review cases according to strategy, packaging fixture files into blind
 * payloads, verifying blindness, and registering the review run in the store.
 */
export async function prepareReviewSession(
  store: BenchmarkStorePort,
  options: PrepareReviewSessionOptions,
): Promise<PreparedReviewSession> {
  const outcomes = await store.loadRun(options.benchmarkRunId);
  if (outcomes === undefined) {
    throw new Error(`Benchmark run not found: ${options.benchmarkRunId}`);
  }

  const selectedOutcomes = selectBenchmarkReviewCases(outcomes, options.selection);
  const corpusCaseMap = new Map<string, CorpusCase>(
    options.corpusCases.map((c) => [c.id, c]),
  );

  const payloads: BlindReviewWorkerPayload[] = [];
  for (const outcome of selectedOutcomes) {
    const corpusCase = corpusCaseMap.get(outcome.caseId);
    if (corpusCase === undefined) {
      throw new Error(`Corpus case definition not found for case "${outcome.caseId}"`);
    }
    const fixtureFiles: readonly BenchmarkFixtureFile[] = [
      corpusCase.baseTest,
      ...corpusCase.productionSources,
    ];
    const payload = createBlindReviewPayload(outcome, fixtureFiles);
    assertPayloadIsBlind(payload);
    payloads.push(payload);
  }

  const reviewRunId = await store.beginReview(
    options.benchmarkRunId,
    options.selection.selectionKind,
  );

  return {
    reviewRunId,
    benchmarkRunId: options.benchmarkRunId,
    payloads,
    selectedOutcomes,
  };
}

export interface RecordAssessmentOptions {
  readonly reviewRunId: string;
  readonly frozenAssessment: FrozenWorkerAssessment;
  readonly outcome: BenchmarkCaseOutcome;
}

/**
 * Compares a frozen worker assessment with Jev's sampled classification and deterministic
 * oracle ground truth, persists the result, and returns the discrepancy comparison.
 */
export async function recordWorkerAssessment(
  store: BenchmarkStorePort,
  options: RecordAssessmentOptions,
): Promise<BenchmarkCaseReviewComparison> {
  if (options.outcome.sample === undefined) {
    throw new Error(`Cannot review case "${options.outcome.caseId}": outcome has no Jev sample`);
  }

  const comparison = compareReviewAssessment(
    options.frozenAssessment,
    options.outcome.sample,
    {
      operatorRole: options.outcome.operatorRole,
      expectedOutcome: options.outcome.expectedOutcome,
      proofStatus: options.outcome.proofStatus,
    },
  );

  await store.recordReviewCase(options.reviewRunId, {
    frozenAssessment: options.frozenAssessment,
    comparison,
  });

  return comparison;
}

export interface ReviewSessionSummary {
  readonly reviewRun: BenchmarkReviewRunRecord;
  readonly totalCasesReviewed: number;
  readonly agreementCount: number;
  readonly disagreementCount: number;
  readonly discrepanciesByKind: Readonly<Record<ReviewDiscrepancyKind, number>>;
  readonly cases: readonly BenchmarkReviewCaseRecord[];
}

/**
 * Marks a review run finished, loads all recorded cases, and returns an aggregate summary.
 */
export async function completeReviewSession(
  store: BenchmarkStorePort,
  reviewRunId: string,
): Promise<ReviewSessionSummary> {
  await store.finishReview(reviewRunId);

  const reviewRun = await store.loadReview(reviewRunId);
  if (reviewRun === undefined) {
    throw new Error(`Review run not found: "${reviewRunId}"`);
  }

  const cases = await store.loadReviewCases(reviewRunId);

  let agreementCount = 0;
  let disagreementCount = 0;
  const discrepanciesByKind: Record<ReviewDiscrepancyKind, number> = {
    'likely-model-error': 0,
    'rubric-ambiguity': 0,
    'context-selection-error': 0,
    'unsupported-disagreement': 0,
  };

  for (const c of cases) {
    if (c.comparison.agreement) {
      agreementCount += 1;
    } else {
      disagreementCount += 1;
      if (c.comparison.discrepancyKind !== undefined) {
        discrepanciesByKind[c.comparison.discrepancyKind] += 1;
      }
    }
  }

  return {
    reviewRun,
    totalCasesReviewed: cases.length,
    agreementCount,
    disagreementCount,
    discrepanciesByKind,
    cases,
  };
}
