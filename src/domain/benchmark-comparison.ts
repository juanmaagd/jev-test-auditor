/**
 * Comparing two benchmark runs by fixture identity (task P7-3,
 * `odd/tasks/phase-7-benchmarks.md`). Pure — no I/O, no timers (enforced by
 * `test/architecture-boundary.test.ts`, exactly like every other
 * `src/domain` module): takes two already-loaded lists of
 * {@link BenchmarkCaseOutcome} (`src/domain/benchmark-store.ts`, read back by
 * `BenchmarkStorePort.loadRun`) and computes agreements, disagreements, and
 * regressions — never touches a database itself.
 *
 * **Refuse, never silently compare, across differing rubric or policy
 * versions** (hard constraint): `policyVersion`/`rubricVersion` are already
 * on every sampled classification, so comparing a v2-policy run against a
 * v3-policy run and calling the difference a regression would be "a false
 * result with a decimal point." This module has no vocabulary for a
 * version-confounded delta that a caller could safely still treat as a
 * regression count, so it refuses outright (`{ kind: 'refused' }`) rather
 * than comparing-with-a-label — see this module's own module doc in
 * `odd/tasks/phase-7-benchmarks.md`'s P7-3 report for the full
 * refuse-vs-label decision record. A MODEL identity difference is
 * deliberately NOT part of this refusal: the PRD explicitly wants
 * "regressions between rubric or model versions," so a model mismatch is
 * labelled on the comparison result (`modelMismatch`) and the comparison
 * still proceeds.
 *
 * **Fixture identity is id *and* bytes** — Decisions call for comparing "by
 * fixture identity," and a `caseId` alone is not that identity: if `cart.ts`
 * changed between two runs, the same id no longer names the same fixture.
 * Every matched case is additionally checked for both an unchanged
 * `fixtureHash` (the corpus case's own committed bytes) and an unchanged
 * operator declaration (`operator`/`operatorRole`/`oracleKind`/
 * `expectedOutcome` — a `case.json` edit with unchanged test/production
 * bytes is still a changed fixture); a mismatch on either is `'fixture-changed'`,
 * excluded from every bucket, never silently compared as if it were the same
 * case.
 *
 * **Only proven cases count** (hard constraint): agreement, disagreement,
 * and regression are computed exclusively over cases {@link CaseProofStatus}
 * `'proven'` in BOTH runs. This is not merely a filter of convenience —
 * `isCaseCorrect` (below) treats a case's Jev-classification correctness as
 * a function of `operatorRole` alone, and that mapping is trustworthy
 * exactly because `decideProof` (`src/domain/oracle.ts`) already confirmed
 * the underlying claim by execution: for a `'prescriptive'` case, that its
 * base test genuinely catches the fixed mutation its own operator-derived
 * variant hides (proof the base test is a genuinely good control); for a
 * `'descriptive'` case, that its declared flaw's `expectedOutcome` actually
 * held (proof the flaw is real, not merely asserted by a comment or a
 * filename). An unproven case has no such guarantee, so it is excluded
 * (`'unproven-in-baseline'`/`'unproven-in-candidate'`), never averaged in.
 */
import type { OverallClassificationStatus } from './classification.js';
import type { BenchmarkCaseOutcome } from './benchmark-store.js';
import type { CorpusOperatorRole } from './corpus.js';

/**
 * Whether a `'prescriptive'` (known-good-control) case is correctly called
 * `'healthy'`, or a `'descriptive'` (deliberately-bad) case is correctly
 * called anything OTHER than `'healthy'` — the coarse, binary ground-truth
 * signal this comparator uses for regression detection only. Deliberately
 * coarser than any future per-dimension precision/recall metric (P7-4's own
 * job, out of this task's scope): this reads directly off the corpus's own
 * already-documented design (`src/domain/corpus.ts`'s module doc: "3 good
 * controls and 8 deliberately bad, one per rubric criterion"), not a new
 * quality policy invented here.
 */
export function isCaseCorrect(operatorRole: CorpusOperatorRole, status: OverallClassificationStatus): boolean {
  return operatorRole === 'prescriptive' ? status === 'healthy' : status !== 'healthy';
}

export interface BenchmarkVersions {
  readonly policyVersion: number;
  readonly rubricVersion: number;
}

export type BenchmarkVersionRefusalReason =
  | 'no-successful-samples-in-baseline'
  | 'no-successful-samples-in-candidate'
  | 'mixed-versions-in-baseline'
  | 'mixed-versions-in-candidate'
  | 'policy-version-mismatch'
  | 'rubric-version-mismatch';

export type BenchmarkCaseExclusionReason =
  | 'missing-in-baseline'
  | 'missing-in-candidate'
  | 'fixture-changed'
  | 'unproven-in-baseline'
  | 'unproven-in-candidate'
  | 'not-sampled-in-baseline'
  | 'not-sampled-in-candidate';

export interface BenchmarkCaseExclusion {
  readonly caseId: string;
  readonly reason: BenchmarkCaseExclusionReason;
}

export interface BenchmarkCaseAgreement {
  readonly caseId: string;
  readonly status: OverallClassificationStatus;
}

export interface BenchmarkCaseDelta {
  readonly caseId: string;
  readonly baselineStatus: OverallClassificationStatus;
  readonly candidateStatus: OverallClassificationStatus;
}

export type BenchmarkComparisonResult =
  | { readonly kind: 'refused'; readonly reason: BenchmarkVersionRefusalReason; readonly detail: string }
  | {
    readonly kind: 'compared';
    readonly baselineVersions: BenchmarkVersions;
    readonly candidateVersions: BenchmarkVersions;
    /** Labelled, never refused on — see this module's own doc. */
    readonly modelMismatch: boolean;
    readonly baselineModel: string;
    readonly candidateModel: string;
    readonly agreements: readonly BenchmarkCaseAgreement[];
    readonly disagreements: readonly BenchmarkCaseDelta[];
    readonly regressions: readonly BenchmarkCaseDelta[];
    readonly excluded: readonly BenchmarkCaseExclusion[];
  };

type VersionDerivation =
  | { readonly kind: 'none' }
  | { readonly kind: 'mixed' }
  | { readonly kind: 'ok'; readonly versions: BenchmarkVersions };

/** One run's own version identity, derived from its samples — never a separately-tracked run field that could drift from what was actually sampled. */
function deriveVersions(outcomes: readonly BenchmarkCaseOutcome[]): VersionDerivation {
  const pairs = new Set(
    outcomes
      .filter((outcome) => outcome.sample !== undefined)
      .map((outcome) => `${outcome.sample!.policyVersion}:${outcome.sample!.rubricVersion}`),
  );
  if (pairs.size === 0) return { kind: 'none' };
  if (pairs.size > 1) return { kind: 'mixed' };
  const [policyVersion, rubricVersion] = [...pairs][0]!.split(':').map(Number);
  return { kind: 'ok', versions: { policyVersion: policyVersion!, rubricVersion: rubricVersion! } };
}

/** One run's own model identity, derived from its samples — `'mixed'` when more than one distinct requested model appears (reported honestly, never collapsed to the first one seen). */
function deriveModel(outcomes: readonly BenchmarkCaseOutcome[]): string {
  const models = new Set(outcomes.filter((outcome) => outcome.sample !== undefined).map((outcome) => outcome.sample!.model.requested));
  if (models.size === 1) return [...models][0]!;
  return 'mixed';
}

function refuse(reason: BenchmarkVersionRefusalReason, detail: string): BenchmarkComparisonResult {
  return { kind: 'refused', reason, detail };
}

function sameFixture(baseline: BenchmarkCaseOutcome, candidate: BenchmarkCaseOutcome): boolean {
  return baseline.fixtureHash === candidate.fixtureHash
    && baseline.operator === candidate.operator
    && baseline.operatorRole === candidate.operatorRole
    && baseline.oracleKind === candidate.oracleKind
    && baseline.expectedOutcome === candidate.expectedOutcome;
}

/**
 * Compares two already-loaded benchmark runs by fixture identity. See this
 * module's own doc for the refuse-on-version-mismatch, fixture-identity, and
 * only-proven-cases-count rules this implements.
 */
export function compareBenchmarkRuns(
  baseline: readonly BenchmarkCaseOutcome[],
  candidate: readonly BenchmarkCaseOutcome[],
): BenchmarkComparisonResult {
  const baselineVersions = deriveVersions(baseline);
  if (baselineVersions.kind === 'none') {
    return refuse('no-successful-samples-in-baseline', 'The baseline run has no successfully sampled case to derive a rubric/policy version identity from.');
  }
  if (baselineVersions.kind === 'mixed') {
    return refuse('mixed-versions-in-baseline', 'The baseline run\'s own samples carry more than one distinct (policyVersion, rubricVersion) pair; refusing to treat it as one run\'s version identity.');
  }
  const candidateVersions = deriveVersions(candidate);
  if (candidateVersions.kind === 'none') {
    return refuse('no-successful-samples-in-candidate', 'The candidate run has no successfully sampled case to derive a rubric/policy version identity from.');
  }
  if (candidateVersions.kind === 'mixed') {
    return refuse('mixed-versions-in-candidate', 'The candidate run\'s own samples carry more than one distinct (policyVersion, rubricVersion) pair; refusing to treat it as one run\'s version identity.');
  }
  if (baselineVersions.versions.policyVersion !== candidateVersions.versions.policyVersion) {
    return refuse(
      'policy-version-mismatch',
      `Baseline run used classification policy version ${baselineVersions.versions.policyVersion}, candidate run used `
      + `${candidateVersions.versions.policyVersion}; comparing across differing policy versions is refused, never silently compared.`,
    );
  }
  if (baselineVersions.versions.rubricVersion !== candidateVersions.versions.rubricVersion) {
    return refuse(
      'rubric-version-mismatch',
      `Baseline run used rubric version ${baselineVersions.versions.rubricVersion}, candidate run used `
      + `${candidateVersions.versions.rubricVersion}; comparing across differing rubric versions is refused, never silently compared.`,
    );
  }

  const baselineModel = deriveModel(baseline);
  const candidateModel = deriveModel(candidate);

  const baselineById = new Map(baseline.map((outcome) => [outcome.caseId, outcome]));
  const candidateById = new Map(candidate.map((outcome) => [outcome.caseId, outcome]));
  const allCaseIds = [...new Set([...baselineById.keys(), ...candidateById.keys()])].sort();

  const agreements: BenchmarkCaseAgreement[] = [];
  const disagreements: BenchmarkCaseDelta[] = [];
  const regressions: BenchmarkCaseDelta[] = [];
  const excluded: BenchmarkCaseExclusion[] = [];

  for (const caseId of allCaseIds) {
    const baselineCase = baselineById.get(caseId);
    const candidateCase = candidateById.get(caseId);
    if (baselineCase === undefined) {
      excluded.push({ caseId, reason: 'missing-in-baseline' });
      continue;
    }
    if (candidateCase === undefined) {
      excluded.push({ caseId, reason: 'missing-in-candidate' });
      continue;
    }
    if (!sameFixture(baselineCase, candidateCase)) {
      excluded.push({ caseId, reason: 'fixture-changed' });
      continue;
    }
    if (baselineCase.proofStatus.kind !== 'proven') {
      excluded.push({ caseId, reason: 'unproven-in-baseline' });
      continue;
    }
    if (candidateCase.proofStatus.kind !== 'proven') {
      excluded.push({ caseId, reason: 'unproven-in-candidate' });
      continue;
    }
    if (baselineCase.sample === undefined) {
      excluded.push({ caseId, reason: 'not-sampled-in-baseline' });
      continue;
    }
    if (candidateCase.sample === undefined) {
      excluded.push({ caseId, reason: 'not-sampled-in-candidate' });
      continue;
    }

    const baselineStatus = baselineCase.sample.classification.status;
    const candidateStatus = candidateCase.sample.classification.status;
    if (baselineStatus === candidateStatus) {
      agreements.push({ caseId, status: baselineStatus });
      continue;
    }

    const baselineCorrect = isCaseCorrect(baselineCase.operatorRole, baselineStatus);
    const candidateCorrect = isCaseCorrect(candidateCase.operatorRole, candidateStatus);
    const delta: BenchmarkCaseDelta = { caseId, baselineStatus, candidateStatus };
    if (baselineCorrect && !candidateCorrect) {
      regressions.push(delta);
    } else {
      disagreements.push(delta);
    }
  }

  return {
    kind: 'compared',
    baselineVersions: baselineVersions.versions,
    candidateVersions: candidateVersions.versions,
    modelMismatch: baselineModel !== candidateModel,
    baselineModel,
    candidateModel,
    agreements,
    disagreements,
    regressions,
    excluded,
  };
}
