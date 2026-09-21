/**
 * Benchmark agent-review skill domain contracts and logic (Phase 8, task P8-1,
 * `odd/tasks/phase-8-benchmark-review-skill.md`).
 *
 * Pure domain module — no Node imports, no adapter imports, no I/O, no timers,
 * no process spawning. Enforced by `test/architecture-boundary.test.ts`.
 *
 * This module coordinates the double-blind review process:
 * 1. Selecting cases (all, disagreements, regressions, stratified) from immutable runs.
 * 2. Assembling strictly blind worker payloads (zero Jev data).
 * 3. Enforcing the blindness invariant.
 * 4. Freezing reviewer assessments with immutable input hashes and timestamps.
 * 5. Comparing frozen assessments against Jev verdicts and classifying discrepancies
 *    into: `likely-model-error`, `rubric-ambiguity`, `context-selection-error`,
 *    or `unsupported-disagreement`.
 */
import { isCaseCorrect } from './benchmark-comparison.js';
import { OPERATOR_DIMENSION } from './benchmark-metrics.js';
import type {
  BenchmarkCaseOutcome,
  BenchmarkFixtureFile,
  BenchmarkOracleRunRecord,
  BenchmarkSampleRecord,
} from './benchmark-store.js';
import type {
  ClassificationLevel,
  OverallClassificationStatus,
} from './classification.js';
import type {
  CorpusExpectedOutcome,
  CorpusOperatorId,
  CorpusOperatorRole,
  CorpusOracleKind,
} from './corpus.js';
import type { CaseProofStatus } from './oracle.js';
import {
  RUBRIC_DIMENSION_IDS,
  RUBRIC_V2,
  type RubricDimensionId,
} from './rubric.js';

export type BenchmarkReviewSelectionKind =
  | 'all'
  | 'disagreements'
  | 'regressions'
  | 'stratified';

export interface BenchmarkReviewSelectionOptions {
  readonly selectionKind: BenchmarkReviewSelectionKind;
  readonly limit?: number;
  readonly dimension?: RubricDimensionId;
}

/**
 * Filters and selects cases from a completed benchmark run according to
 * the specified review strategy and optional dimension/limit constraints.
 */
export function selectBenchmarkReviewCases(
  outcomes: readonly BenchmarkCaseOutcome[],
  options: BenchmarkReviewSelectionOptions,
): readonly BenchmarkCaseOutcome[] {
  let filtered = outcomes;

  if (options.dimension !== undefined) {
    filtered = filtered.filter(
      (outcome) => OPERATOR_DIMENSION[outcome.operator] === options.dimension,
    );
  }

  switch (options.selectionKind) {
    case 'all':
      break;
    case 'disagreements':
    case 'regressions': {
      filtered = filtered.filter((outcome) => {
        if (outcome.sample === undefined) return false;
        return !isCaseCorrect(outcome.operatorRole, outcome.sample.classification.status);
      });
      break;
    }
    case 'stratified': {
      const byDimension = new Map<RubricDimensionId, BenchmarkCaseOutcome[]>();
      for (const id of RUBRIC_DIMENSION_IDS) {
        byDimension.set(id, []);
      }
      for (const outcome of filtered) {
        const dim = OPERATOR_DIMENSION[outcome.operator];
        byDimension.get(dim)?.push(outcome);
      }
      const stratified: BenchmarkCaseOutcome[] = [];
      let round = 0;
      let added = true;
      while (added) {
        added = false;
        for (const dim of RUBRIC_DIMENSION_IDS) {
          const list = byDimension.get(dim) ?? [];
          if (round < list.length) {
            stratified.push(list[round]!);
            added = true;
          }
        }
        round += 1;
      }
      filtered = stratified;
      break;
    }
  }

  if (options.limit !== undefined && options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

export interface BlindReviewRubricCriterion {
  readonly dimensionId: RubricDimensionId;
  readonly label: string;
  readonly promptQuestions: readonly string[];
  readonly description: string;
}

/**
 * A worker payload prepared for a blind review subagent.
 *
 * INVARIANT: Contains zero Jev classification, verdict, score, confidence,
 * or findings data.
 */
export interface BlindReviewWorkerPayload {
  readonly caseId: string;
  readonly operator: CorpusOperatorId;
  readonly operatorRole: CorpusOperatorRole;
  readonly oracleKind: CorpusOracleKind;
  readonly expectedOutcome: CorpusExpectedOutcome;
  readonly testSource: string;
  readonly productionSources: readonly BenchmarkFixtureFile[];
  readonly oracleProof: {
    readonly status: CaseProofStatus;
    readonly runs: readonly BenchmarkOracleRunRecord[];
  };
  readonly rubricCriteria: readonly BlindReviewRubricCriterion[];
}

/**
 * Builds a blind worker payload for a given case outcome and fixture files.
 */
export function createBlindReviewPayload(
  outcome: BenchmarkCaseOutcome,
  fixtureFiles: readonly BenchmarkFixtureFile[],
): BlindReviewWorkerPayload {
  const testFile = fixtureFiles.find((f) => f.path === 'test.ts' || f.path.endsWith('/test.ts'));
  const testSource = testFile?.contents ?? '';

  const productionSources = fixtureFiles.filter(
    (f) => f.path !== 'test.ts' && !f.path.endsWith('/test.ts') && f.path !== 'case.json' && !f.path.endsWith('/case.json'),
  );

  const rubricCriteria: BlindReviewRubricCriterion[] = RUBRIC_V2.dimensions.map((dim) => ({
    dimensionId: dim.id,
    label: dim.label,
    promptQuestions: [dim.applicability.instructions, dim.quality.instructions],
    description: (dim.quality.criteria ?? []).join('\n\n'),
  }));

  const payload: BlindReviewWorkerPayload = {
    caseId: outcome.caseId,
    operator: outcome.operator,
    operatorRole: outcome.operatorRole,
    oracleKind: outcome.oracleKind,
    expectedOutcome: outcome.expectedOutcome,
    testSource,
    productionSources,
    oracleProof: {
      status: outcome.proofStatus,
      runs: outcome.oracleRuns,
    },
    rubricCriteria,
  };

  assertPayloadIsBlind(payload);
  return payload;
}

const FORBIDDEN_JEV_KEYS: readonly string[] = [
  'sample',
  'classification',
  'status',
  'score',
  'confidence',
  'deficientMass',
  'acceptableMass',
  'criticalMass',
  'findings',
  'model',
  'usage',
  'latencyMs',
];

/**
 * Validates that no Jev-specific classification or evaluation fields leak
 * into the reviewer's blind payload. Throws on any violation.
 */
export function assertPayloadIsBlind(payload: BlindReviewWorkerPayload): void {
  const record = payload as unknown as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_JEV_KEYS) {
    if (record[forbidden] !== undefined) {
      throw new Error(`Blindness violation: payload contains Jev verdict data in field "${forbidden}"`);
    }
  }
}

export interface BlindWorkerDimensionAssessment {
  readonly dimensionId: RubricDimensionId;
  readonly level: ClassificationLevel;
  readonly score: number;
  readonly confidence: number;
  readonly reasoning: string;
  readonly evidenceCitations: readonly string[];
}

export interface BlindWorkerAssessment {
  readonly caseId: string;
  readonly assessedDimensions: readonly BlindWorkerDimensionAssessment[];
  readonly overallUncertainty: number;
  readonly notes?: string;
}

export interface FrozenWorkerAssessment {
  readonly caseId: string;
  readonly inputPayloadHash: string;
  readonly frozenAt: string;
  readonly workerIdentity?: { readonly runtime: string; readonly model?: string } | undefined;
  readonly assessment: BlindWorkerAssessment;
}

export function freezeWorkerAssessment(input: {
  readonly caseId: string;
  readonly inputPayloadHash: string;
  readonly frozenAt: string;
  readonly workerIdentity?: { readonly runtime: string; readonly model?: string } | undefined;
  readonly assessment: BlindWorkerAssessment;
}): FrozenWorkerAssessment {
  if (!input.caseId) {
    throw new Error('FrozenWorkerAssessment requires a valid caseId');
  }
  if (!input.inputPayloadHash) {
    throw new Error('FrozenWorkerAssessment requires a valid inputPayloadHash');
  }
  if (!input.frozenAt) {
    throw new Error('FrozenWorkerAssessment requires a valid frozenAt timestamp');
  }

  return {
    caseId: input.caseId,
    inputPayloadHash: input.inputPayloadHash,
    frozenAt: input.frozenAt,
    workerIdentity: input.workerIdentity,
    assessment: input.assessment,
  };
}

export type ReviewDiscrepancyKind =
  | 'likely-model-error'
  | 'rubric-ambiguity'
  | 'context-selection-error'
  | 'unsupported-disagreement';

export interface BenchmarkCaseReviewComparison {
  readonly caseId: string;
  readonly agreement: boolean;
  readonly discrepancyKind?: ReviewDiscrepancyKind | undefined;
  readonly jevOutcome: {
    readonly status?: OverallClassificationStatus | undefined;
    readonly levels: Partial<Record<RubricDimensionId, ClassificationLevel>>;
  };
  readonly reviewerOutcome: {
    readonly levels: Partial<Record<RubricDimensionId, ClassificationLevel>>;
    readonly uncertainty: number;
  };
  readonly oracleGroundTruth: {
    readonly operatorRole: CorpusOperatorRole;
    readonly expectedOutcome: CorpusExpectedOutcome;
    readonly proofStatus: CaseProofStatus;
  };
  readonly explanation: string;
}

/**
 * Compares a frozen blind assessment with Jev's sampled outcome and the
 * deterministic oracle ground truth. Classifies discrepancies into one
 * of four diagnostic categories.
 */
export function compareReviewAssessment(
  frozen: FrozenWorkerAssessment,
  jevSample: BenchmarkSampleRecord,
  oracleOutcome: {
    readonly operatorRole: CorpusOperatorRole;
    readonly expectedOutcome: CorpusExpectedOutcome;
    readonly proofStatus: CaseProofStatus;
  },
): BenchmarkCaseReviewComparison {
  const jevLevels: Partial<Record<RubricDimensionId, ClassificationLevel>> = {};
  for (const dim of jevSample.classification.dimensions) {
    if (dim.level !== undefined) {
      jevLevels[dim.dimensionId] = dim.level;
    }
  }

  const reviewerLevels: Partial<Record<RubricDimensionId, ClassificationLevel>> = {};
  for (const dim of frozen.assessment.assessedDimensions) {
    reviewerLevels[dim.dimensionId] = dim.level;
  }

  const targetDimension = frozen.assessment.assessedDimensions[0]?.dimensionId ?? 'falsifiability';
  const jevLevel = jevLevels[targetDimension];
  const reviewerLevel = reviewerLevels[targetDimension];

  const isGroundTruthAcceptable = oracleOutcome.operatorRole === 'prescriptive';
  const isReviewerAcceptable = reviewerLevel === 'acceptable' || reviewerLevel === 'strong';

  const jevAgreesWithReviewer = jevLevel !== undefined && jevLevel === reviewerLevel;

  if (jevAgreesWithReviewer) {
    return {
      caseId: frozen.caseId,
      agreement: true,
      discrepancyKind: undefined,
      jevOutcome: {
        status: jevSample.classification.status,
        levels: jevLevels,
      },
      reviewerOutcome: {
        levels: reviewerLevels,
        uncertainty: frozen.assessment.overallUncertainty,
      },
      oracleGroundTruth: oracleOutcome,
      explanation: `Jev and reviewer agreed on level "${jevLevel}" for ${targetDimension}.`,
    };
  }

  // Discrepancy analysis
  let discrepancyKind: ReviewDiscrepancyKind;
  let explanation: string;

  const notesText = (frozen.assessment.notes ?? '').toLowerCase();
  const reasoningText = frozen.assessment.assessedDimensions
    .map((d) => d.reasoning)
    .join(' ')
    .toLowerCase();

  if (
    notesText.includes('context')
    || notesText.includes('missing')
    || notesText.includes('omitted')
    || reasoningText.includes('missing import')
    || reasoningText.includes('missing context')
  ) {
    discrepancyKind = 'context-selection-error';
    explanation = 'Reviewer reported insufficient or missing production context in the bundle.';
  } else if (
    frozen.assessment.overallUncertainty >= 0.5
    || notesText.includes('unclear')
    || notesText.includes('ambiguity')
    || notesText.includes('interpretation')
    || reasoningText.includes('rubric wording')
  ) {
    discrepancyKind = 'rubric-ambiguity';
    explanation = `Reviewer noted high uncertainty (${frozen.assessment.overallUncertainty}) or rubric ambiguity.`;
  } else if (isReviewerAcceptable !== isGroundTruthAcceptable) {
    discrepancyKind = 'unsupported-disagreement';
    explanation = `Reviewer contradicted the verified deterministic oracle ground truth (${isGroundTruthAcceptable ? 'acceptable' : 'deficient'}).`;
  } else {
    discrepancyKind = 'likely-model-error';
    explanation = `Jev misclassified (${jevLevel}) while reviewer correctly identified ground truth.`;
  }

  return {
    caseId: frozen.caseId,
    agreement: false,
    discrepancyKind,
    jevOutcome: {
      status: jevSample.classification.status,
      levels: jevLevels,
    },
    reviewerOutcome: {
      levels: reviewerLevels,
      uncertainty: frozen.assessment.overallUncertainty,
    },
    oracleGroundTruth: oracleOutcome,
    explanation,
  };
}
