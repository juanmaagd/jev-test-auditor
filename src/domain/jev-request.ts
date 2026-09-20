/**
 * Composes one Jev request (state + model + questions) from a
 * {@link TestCase} and its {@link EvidenceBundle}, per the versioned rubric
 * (Phase 4, task P4-1, `odd/tasks/phase-4-jev-evaluation.md`). Pure domain:
 * no Node imports, no adapter imports, nothing here ever reaches the
 * network — it only builds the payload the gateway (P4-2) will send.
 */
import {
  estimateTokensFromBytes,
  JEV_ESTIMATE_SNAPSHOT,
  type JevEstimateSnapshot,
} from './jev-pricing.js';
import {
  utf8ByteLength,
  type EvidenceBundle,
  type EvidenceFragment,
  type EvidenceFragmentKind,
  type EvidenceSelectionReason,
  type OmittedEvidenceReason,
  type UnresolvedEvidenceReason,
} from './evidence.js';
import { validateRubric, type NoulCriteria, type Rubric, type RubricNoulQuestion, type RubricScoreQuestion } from './rubric.js';
import type { TestCase, TestCaseId, TestFramework, TestModifierKind } from './test-understanding.js';

/**
 * One evidence fragment projected into wire `state`. Deliberately excludes
 * `contentHash`, `span`, and the truncation byte counts (`originalBytes`/
 * `includedBytes`): those are provenance for the JSON report (Phase 4,
 * task P4-4) and for cache keys (Phase 5), not information Jev needs to
 * judge test quality — a hash or a byte count carries no semantic content,
 * and including them would spend tokens for nothing. `truncated` alone is
 * kept, since a cut-off fragment changes how its `content` should be read
 * (see `RUBRIC_V1`'s applicability instructions).
 */
export interface JevStateFragment {
  readonly kind: EvidenceFragmentKind;
  readonly path: string;
  readonly symbol?: string;
  readonly selectionReason: EvidenceSelectionReason;
  readonly truncated: boolean;
  readonly content: string;
}

export interface JevStateDenied {
  readonly path: string;
  readonly rule: string;
}

export interface JevStateUnresolved {
  readonly specifier: string;
  readonly reason: UnresolvedEvidenceReason;
}

export interface JevStateOmitted {
  readonly path: string;
  readonly symbol?: string;
  readonly reason: OmittedEvidenceReason;
}

export interface JevStateAncestrySegment {
  readonly kind: 'suite' | 'test';
  readonly name: string;
}

/**
 * The structured JSON state built from one test case and its evidence
 * bundle. Field selection (Phase 4 Decisions):
 * - `testCaseId`, `name`, `structuralAncestry`, `framework`,
 *   `repositoryRelativePath`: identify which test and where it lives, and
 *   let the model read nesting (`structuralAncestry`, kept in source order —
 *   it is nesting, not a set, so it is never sorted) the way a human would.
 *   `structuralAncestry`'s `ordinal` is dropped: it exists only to
 *   disambiguate same-named siblings for identity hashing
 *   (`test-understanding.ts`), and carries no judgment-relevant meaning.
 * - `modifiers`: static test modifiers (e.g. `skip`, `concurrent`) can bear
 *   directly on determinism/isolation judgments.
 * - `fragments`: the actual evidence, in the fixed kind order
 *   `test, helper, production-seam, mock-target` (matching
 *   `canonicalizeEvidenceBundle`), then by path.
 * - `denied`, `unresolved`, `omitted`: what evidence selection withheld,
 *   could not resolve, or cut for budget, so the model can tell "not shown
 *   to me" from "does not exist" (see `RUBRIC_V1`'s provenance guidance).
 *
 * Deliberately excluded: `hooks`, `imports`, `mocks`, and `assertions`
 * structural records from `TestCase` — the test's own source text already
 * arrives as a `kind: 'test'` fragment (and any in-scope hook body arrives
 * as its own `hook-in-scope` fragment), so a structured duplicate of what
 * that text already shows would spend tokens without adding information.
 */
export interface JevState {
  readonly testCaseId: TestCaseId;
  readonly name: string;
  readonly structuralAncestry: readonly JevStateAncestrySegment[];
  readonly framework: TestFramework;
  readonly repositoryRelativePath: string;
  readonly modifiers: readonly TestModifierKind[];
  readonly fragments: readonly JevStateFragment[];
  readonly denied: readonly JevStateDenied[];
  readonly unresolved: readonly JevStateUnresolved[];
  readonly omitted: readonly JevStateOmitted[];
}

const FRAGMENT_KIND_ORDER: Readonly<Record<EvidenceFragmentKind, number>> = {
  test: 0,
  helper: 1,
  'production-seam': 2,
  'mock-target': 3,
};

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function toJevStateFragment(fragment: EvidenceFragment): JevStateFragment {
  return {
    kind: fragment.kind,
    path: fragment.repositoryRelativePath,
    ...(fragment.symbol === undefined ? {} : { symbol: fragment.symbol }),
    selectionReason: fragment.selectionReason,
    truncated: fragment.truncation.truncated,
    content: fragment.content,
  };
}

function compareJevStateFragments(left: JevStateFragment, right: JevStateFragment): number {
  return (
    compareNumbers(FRAGMENT_KIND_ORDER[left.kind], FRAGMENT_KIND_ORDER[right.kind])
    || compareStrings(left.path, right.path)
    || compareStrings(left.symbol ?? '', right.symbol ?? '')
    || compareStrings(left.content, right.content)
  );
}

function compareJevStateDenied(left: JevStateDenied, right: JevStateDenied): number {
  return compareStrings(left.path, right.path) || compareStrings(left.rule, right.rule);
}

function compareJevStateUnresolved(left: JevStateUnresolved, right: JevStateUnresolved): number {
  return compareStrings(left.specifier, right.specifier) || compareStrings(left.reason, right.reason);
}

function compareJevStateOmitted(left: JevStateOmitted, right: JevStateOmitted): number {
  return (
    compareStrings(left.path, right.path)
    || compareStrings(left.symbol ?? '', right.symbol ?? '')
    || compareStrings(left.reason, right.reason)
  );
}

/**
 * Builds a {@link JevState} from a test case and its evidence bundle. The
 * result is already in canonical (sorted) order — see
 * {@link canonicalizeJevRequest} — so a caller that serializes it directly
 * (as {@link buildJevRequest} does) gets the same bytes a defensive
 * re-canonicalization would produce.
 *
 * Throws `RangeError` if `bundle.testCaseId` does not match `testCase.id`:
 * building state from a mismatched pair would silently judge the wrong
 * test.
 */
export function buildJevState(testCase: TestCase, bundle: EvidenceBundle): JevState {
  if (bundle.testCaseId !== testCase.id) {
    throw new RangeError(
      `Evidence bundle test case id (${bundle.testCaseId}) does not match the test case (${testCase.id})`,
    );
  }

  return {
    testCaseId: testCase.id,
    name: testCase.name,
    structuralAncestry: testCase.structuralAncestry.map((segment) => ({
      kind: segment.kind,
      name: segment.name,
    })),
    framework: testCase.framework,
    repositoryRelativePath: testCase.repositoryRelativePath,
    modifiers: [...testCase.modifiers.map((modifier) => modifier.kind)].sort(compareStrings),
    fragments: bundle.fragments.map(toJevStateFragment).sort(compareJevStateFragments),
    denied: bundle.denied
      .map((denied) => ({ path: denied.repositoryRelativePath, rule: denied.rule }))
      .sort(compareJevStateDenied),
    unresolved: [...bundle.unresolved].sort(compareJevStateUnresolved),
    omitted: bundle.omitted
      .map((omitted) => ({
        path: omitted.repositoryRelativePath,
        ...(omitted.symbol === undefined ? {} : { symbol: omitted.symbol }),
        reason: omitted.reason,
      }))
      .sort(compareJevStateOmitted),
  };
}

/**
 * A question as it appears on the wire, exactly matching the verified
 * provider contract (`odd/tasks/phase-4-jev-evaluation.md`): a `noul`
 * question with optional `true`/`false` criteria, or a `score` question
 * with an ordered `criteria` list. No `id` field — the id is only ever the
 * key under which this value sits in {@link JevRequest.questions}, per the
 * contract ("Question ids are never sent to the model").
 */
export type JevQuestion =
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria?: NoulCriteria }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

function toWireQuestion(question: RubricNoulQuestion | RubricScoreQuestion): JevQuestion {
  if (question.type === 'noul') {
    return question.criteria === undefined
      ? { type: 'noul', instructions: question.instructions }
      : { type: 'noul', instructions: question.instructions, criteria: question.criteria };
  }
  return { type: 'score', instructions: question.instructions, criteria: question.criteria };
}

/**
 * One Jev request body, matching the verified provider contract's
 * `{ state, model, questions }` shape (field order here mirrors that
 * contract; see {@link canonicalizeJevRequest} for the actual wire byte
 * order).
 */
export interface JevRequest {
  readonly state: JevState;
  readonly model: string;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export interface BuildJevRequestInput {
  readonly testCase: TestCase;
  readonly bundle: EvidenceBundle;
  readonly rubric: Rubric;
}

/**
 * Composes one {@link JevRequest}: `rubric.model` pinned as `model`, the
 * bundle-derived {@link JevState}, and one wire question per rubric
 * question (14 for {@link RUBRIC_V1} — one applicability `noul` and one
 * quality `score` question per dimension). Validates `rubric` first (see
 * {@link validateRubric}) and throws `RangeError` before composing anything
 * if it is malformed.
 */
export function buildJevRequest(input: BuildJevRequestInput): JevRequest {
  validateRubric(input.rubric);

  const state = buildJevState(input.testCase, input.bundle);
  const questions = buildJevQuestions(input.rubric);

  return { state, model: input.rubric.model, questions };
}

/**
 * Composes the wire `questions` map for a whole rubric — one applicability
 * `noul` question and one quality `score` question per dimension — with no
 * test case or evidence bundle involved. Extracted out of {@link
 * buildJevRequest} so a caller that only needs the rubric's own fixed
 * per-request contribution (every evaluable request sends the exact same
 * `questions` map for a given rubric) does not need to fabricate a test case
 * and bundle just to measure it (see `estimateDryRun`'s `rubricBytesPerRequest`
 * in `src/domain/estimate.ts`). Validates `rubric` first, same as
 * {@link buildJevRequest}.
 */
export function buildJevQuestions(rubric: Rubric): Readonly<Record<string, JevQuestion>> {
  validateRubric(rubric);

  const questions: Record<string, JevQuestion> = {};
  for (const dimension of rubric.dimensions) {
    questions[dimension.applicability.id] = toWireQuestion(dimension.applicability);
    questions[dimension.quality.id] = toWireQuestion(dimension.quality);
  }
  return questions;
}

interface CanonicalJevStateFragment {
  readonly kind: EvidenceFragmentKind;
  readonly path: string;
  readonly symbol?: string;
  readonly selectionReason: EvidenceSelectionReason;
  readonly truncated: boolean;
  readonly content: string;
}

function canonicalStateFragment(fragment: JevStateFragment): CanonicalJevStateFragment {
  return {
    kind: fragment.kind,
    path: fragment.path,
    ...(fragment.symbol === undefined ? {} : { symbol: fragment.symbol }),
    selectionReason: fragment.selectionReason,
    truncated: fragment.truncated,
    content: fragment.content,
  };
}

interface CanonicalJevState {
  readonly testCaseId: TestCaseId;
  readonly name: string;
  readonly structuralAncestry: readonly JevStateAncestrySegment[];
  readonly framework: TestFramework;
  readonly repositoryRelativePath: string;
  readonly modifiers: readonly TestModifierKind[];
  readonly fragments: readonly CanonicalJevStateFragment[];
  readonly denied: readonly JevStateDenied[];
  readonly unresolved: readonly JevStateUnresolved[];
  readonly omitted: readonly (JevStateOmitted)[];
}

/**
 * Produces the canonical (sorted, fixed-key-order) form of a {@link JevState}.
 * Independent of whatever order {@link buildJevState} already produced —
 * defensive, the same way `canonicalizeEvidenceBundle` re-sorts rather than
 * trusting `buildEvidenceBundle`'s own order — so a `JevState` assembled by
 * hand (e.g. in a test) still canonicalizes correctly. `structuralAncestry`
 * is never sorted: it is nesting order, not a set.
 */
function canonicalStatePayload(state: JevState): CanonicalJevState {
  return {
    testCaseId: state.testCaseId,
    name: state.name,
    structuralAncestry: state.structuralAncestry.map((segment) => ({ kind: segment.kind, name: segment.name })),
    framework: state.framework,
    repositoryRelativePath: state.repositoryRelativePath,
    modifiers: [...state.modifiers].sort(compareStrings),
    fragments: state.fragments.map(canonicalStateFragment).sort(compareJevStateFragments),
    denied: [...state.denied].sort(compareJevStateDenied),
    unresolved: [...state.unresolved].sort(compareJevStateUnresolved),
    omitted: state.omitted
      .map((omitted) => ({
        path: omitted.path,
        ...(omitted.symbol === undefined ? {} : { symbol: omitted.symbol }),
        reason: omitted.reason,
      }))
      .sort(compareJevStateOmitted),
  };
}

function canonicalQuestion(question: JevQuestion): JevQuestion {
  if (question.type === 'noul') {
    return question.criteria === undefined
      ? { type: 'noul', instructions: question.instructions }
      : { type: 'noul', instructions: question.instructions, criteria: { true: question.criteria.true, false: question.criteria.false } };
  }
  return { type: 'score', instructions: question.instructions, criteria: [...question.criteria] };
}

function canonicalQuestionsPayload(questions: Readonly<Record<string, JevQuestion>>): [string, JevQuestion][] {
  const ids = Object.keys(questions).sort(compareStrings);
  return ids.map((id) => {
    const question = questions[id];
    if (question === undefined) {
      // Unreachable: `id` was produced by `Object.keys(questions)` above.
      throw new Error(`unreachable: question id ${id} has no value`);
    }
    return [id, canonicalQuestion(question)];
  });
}

/**
 * Serializes a {@link JevRequest} to a stable JSON string: fixed key order
 * (`state`, `model`, `questions`, matching the provider contract's own
 * `{ state, model, questions }` body shape), fragments/denied/unresolved/
 * omitted sorted deterministically, and `questions` sorted by id. Equal
 * requests always produce byte-identical output — this exact string is
 * what the gateway (Phase 4, task P4-2) sends as the request body, and what
 * Phase 5's cache key hashes.
 */
export function canonicalizeJevRequest(request: JevRequest): string {
  const state = canonicalStatePayload(request.state);
  const questions = Object.fromEntries(canonicalQuestionsPayload(request.questions));

  return JSON.stringify({ state, model: request.model, questions });
}

/**
 * Canonical (sorted-by-id) JSON serialization of a wire `questions` map on
 * its own — the exact bytes {@link canonicalizeJevRequest} would embed under
 * its `questions` key, isolated from `state`/`model` so a caller (see
 * `estimateDryRun`'s `rubricBytesPerRequest`) can measure the rubric's own
 * fixed per-request byte contribution without building a full request.
 */
export function canonicalizeJevRequestQuestions(questions: Readonly<Record<string, JevQuestion>>): string {
  return JSON.stringify(Object.fromEntries(canonicalQuestionsPayload(questions)));
}

/**
 * The provider budget limits this phase checks against (Phase 4 Decisions):
 * a 64,000-token ceiling for the whole request, and a 32,000-token ceiling
 * for `state` plus the single longest question. `bytesPerToken` defaults to
 * {@link JEV_ESTIMATE_SNAPSHOT}'s verified range so ordinary callers need no
 * override; tests override individual fields to exercise a tight ceiling
 * without needing a multi-kilobyte fixture.
 */
export interface JevRequestLimits {
  readonly bytesPerToken: JevEstimateSnapshot['bytesPerToken'];
  readonly totalTokenCeiling: number;
  readonly statePlusLongestQuestionTokenCeiling: number;
}

export const JEV_REQUEST_LIMITS: JevRequestLimits = {
  bytesPerToken: JEV_ESTIMATE_SNAPSHOT.bytesPerToken,
  totalTokenCeiling: 64_000,
  statePlusLongestQuestionTokenCeiling: 32_000,
};

export interface JevRequestBudgetCheck {
  readonly withinTotal: boolean;
  readonly withinStatePlusLongestQuestion: boolean;
  /** Worst-case (most tokens) estimate for the whole canonical request. Clearly an estimate, not a wire-accurate count — see `estimateTokensFromBytes`. */
  readonly estimatedTotalTokens: number;
  /** Worst-case estimate for `state` plus the single longest question's own canonical bytes. */
  readonly estimatedStatePlusLongestQuestionTokens: number;
}

/**
 * Checks a composed {@link JevRequest} against {@link JevRequestLimits}
 * (defaulting to {@link JEV_REQUEST_LIMITS}), reporting rather than
 * throwing so a caller can report honestly on both limits even when one is
 * exceeded (see {@link assertJevRequestWithinBudget} for the throwing
 * form). Both token counts use the worst-case (most-tokens) end of
 * {@link estimateTokensFromBytes}'s range, so a request this reports as
 * within budget is never actually over it because of favorable rounding.
 */
export function checkJevRequestBudget(
  request: JevRequest,
  limits: JevRequestLimits = JEV_REQUEST_LIMITS,
): JevRequestBudgetCheck {
  const totalBytes = utf8ByteLength(canonicalizeJevRequest(request));
  const estimatedTotalTokens = estimateTokensFromBytes(totalBytes, limits.bytesPerToken).max;

  const stateBytes = utf8ByteLength(JSON.stringify(canonicalStatePayload(request.state)));
  const questionEntries = canonicalQuestionsPayload(request.questions);
  let longestQuestionBytes = 0;
  for (const [, question] of questionEntries) {
    const bytes = utf8ByteLength(JSON.stringify(question));
    if (bytes > longestQuestionBytes) longestQuestionBytes = bytes;
  }
  const estimatedStatePlusLongestQuestionTokens = estimateTokensFromBytes(
    stateBytes + longestQuestionBytes,
    limits.bytesPerToken,
  ).max;

  return {
    withinTotal: estimatedTotalTokens <= limits.totalTokenCeiling,
    withinStatePlusLongestQuestion:
      estimatedStatePlusLongestQuestionTokens <= limits.statePlusLongestQuestionTokenCeiling,
    estimatedTotalTokens,
    estimatedStatePlusLongestQuestionTokens,
  };
}

/**
 * Rejects a {@link JevRequestBudgetCheck} that is over either budget,
 * throwing `RangeError`. Takes the already-computed check (never
 * recomputes it) so a caller that already reported the check honestly can
 * still choose to enforce it. {@link checkJevRequestBudget} itself never
 * throws — only this explicit enforcement step does.
 */
export function assertJevRequestWithinBudget(check: JevRequestBudgetCheck): void {
  if (!check.withinTotal) {
    throw new RangeError(
      `Jev request exceeds the total token budget (estimate): ~${check.estimatedTotalTokens} tokens`,
    );
  }
  if (!check.withinStatePlusLongestQuestion) {
    throw new RangeError(
      'Jev request exceeds the state-plus-longest-question token budget (estimate): '
      + `~${check.estimatedStatePlusLongestQuestionTokens} tokens`,
    );
  }
}
