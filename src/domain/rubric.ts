/**
 * The versioned seven-dimension Jev rubric (Phase 4, task P4-1). Pure data
 * plus its own structural validation — no Node imports, no adapter imports,
 * so it composes into a request without ever touching the network itself
 * (see `src/domain/jev-request.ts`).
 *
 * The seven dimensions and their questions come from `docs/PRD.md`'s
 * "Quality model": each carries an applicability/sufficient-evidence `noul`
 * question and a quality `score` question with exactly four ordered levels
 * (`misleading`, `weak`, `acceptable`, `strong`, per PRD "Global
 * classification"). Every `instructions`/`criteria` string is written to be
 * complete on its own: per the verified provider contract
 * (`odd/tasks/phase-4-jev-evaluation.md`), question ids are never sent to
 * the model, only `instructions`/`criteria`, so nothing outside those
 * strings can carry meaning.
 */

/** The seven PRD "Quality model" dimensions, in the order they appear there. */
export const RUBRIC_DIMENSION_IDS = [
  'falsifiability',
  'behavioral-focus',
  'refactor-resistance',
  'assertion-strength',
  'test-double-quality',
  'determinism-isolation',
  'diagnostic-quality',
] as const;

export type RubricDimensionId = (typeof RUBRIC_DIMENSION_IDS)[number];

const RUBRIC_DIMENSION_ID_SET: ReadonlySet<string> = new Set(RUBRIC_DIMENSION_IDS);

/** The four ordered quality levels every dimension's score question must use (PRD "Global classification"). */
export const RUBRIC_QUALITY_LEVELS = ['Misleading', 'Weak', 'Acceptable', 'Strong'] as const;

export const RUBRIC_QUALITY_LEVEL_COUNT = RUBRIC_QUALITY_LEVELS.length;

/**
 * Every request this phase sends must carry this exact pinned Jev model id
 * (Phase 4 Decisions, `odd/tasks/phase-4-jev-evaluation.md`: "Requests pin
 * the exact versioned model id `jev-1.13.0`"). `validateRubric` fails closed
 * on any other value, including a generic alias like `jev-latest`, so a
 * silent un-pin is a `RangeError`, not a quiet drift. A genuinely new pinned
 * model is a deliberate new rubric version that updates this constant.
 */
export const JEV_MODEL_ID = 'jev-1.13.0';

export interface NoulCriteria {
  readonly true: string;
  readonly false: string;
}

export interface RubricNoulQuestion {
  readonly id: string;
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria?: NoulCriteria;
}

export interface RubricScoreQuestion {
  readonly id: string;
  readonly type: 'score';
  readonly instructions: string;
  /** Exactly {@link RUBRIC_QUALITY_LEVEL_COUNT} ordered level descriptions; see {@link validateRubric}. */
  readonly criteria: readonly string[];
}

export type RubricQuestion = RubricNoulQuestion | RubricScoreQuestion;

export interface RubricDimension {
  readonly id: RubricDimensionId;
  readonly label: string;
  readonly applicability: RubricNoulQuestion;
  readonly quality: RubricScoreQuestion;
}

export interface Rubric {
  readonly version: number;
  readonly model: string;
  readonly dimensions: readonly RubricDimension[];
}

/**
 * Appended to every dimension's applicability instructions, verbatim, so
 * each question stays complete on its own (question ids are never sent to
 * the model — see the module doc). Explains the evidence-provenance fields
 * `buildJevState` (`src/domain/jev-request.ts`) puts in `state` alongside
 * `fragments`: without this, `denied`/`unresolved`/`omitted`/`truncated`
 * cost tokens but give the model no instruction on how to use them.
 */
const PROVENANCE_GUIDANCE =
  'The `fragments` field lists the evidence actually available for this judgment. `denied`, `unresolved`, '
  + 'and `omitted` name code that was withheld by a safety rule, could not be resolved, or was cut once the '
  + 'evidence budget ran out — treat every one of those as evidence you do not have, never as code that does '
  + 'not exist or behaves trivially. A fragment with `truncated: true` was cut off at its end: judge only what '
  + 'appears in the text you were given, not what its cut end might have contained.';

function withProvenanceGuidance(instructions: string): string {
  return `${instructions} ${PROVENANCE_GUIDANCE}`;
}

/**
 * Appended to every dimension's quality-score instructions, verbatim,
 * alongside {@link QUALITY_LEVEL_ORDER_NOTE} (see {@link withQualityGuidance}
 * for the order). This is a quality-specific variant of
 * {@link PROVENANCE_GUIDANCE}, not that sentence reused: the applicability
 * and quality questions for a dimension both see the same `state` but run
 * independently and cannot see each other's answers (Phase 4 provider
 * contract — questions are batched but answered separately), so a quality
 * question has no way to learn from the applicability question that a
 * `denied`/`unresolved`/`omitted` entry or a `truncated: true` fragment
 * means "withheld from me", not "the test lacks this". Left unguarded, a
 * quality question could score a test `Misleading` for "no visible
 * assertions on the outcome" purely because the deny list withheld the
 * helper that contained them — exactly the "uncertainty is not quality"
 * failure PRD principle 3 warns against, just at the quality question
 * instead of the applicability one. This sentence tells the quality
 * question to discount withheld evidence rather than penalize it, and
 * leaves the "is there enough evidence at all" call to the applicability
 * question, which is the one actually meant to answer it.
 */
const QUALITY_PROVENANCE_GUIDANCE =
  'Evidence named in `denied`, `unresolved`, or `omitted`, or cut short by a `truncated: true` fragment, was '
  + 'withheld from you — it must never by itself push this score toward a worse level, since a withheld or '
  + 'truncated fragment says nothing about whether the behavior it would have shown is good or bad. Judge this '
  + 'score only from what the shown text in `fragments` actually supports; whether there is enough evidence to '
  + 'judge this dimension at all is answered by the separate applicability question, not by this one.';

/**
 * Appended to every dimension's quality-score instructions, verbatim, since
 * the four `criteria` strings carry no separate "level name" field on the
 * wire — each one is prefixed with its own level name instead (see
 * {@link RUBRIC_QUALITY_LEVELS}), and this sentence tells the model that.
 */
const QUALITY_LEVEL_ORDER_NOTE =
  'The four levels below are ordered from weakest to strongest — misleading, weak, acceptable, strong — and each '
  + 'one starts with its own name. Choose exactly the single level whose description most closely matches what '
  + 'the evidence shows; do not average or split the difference between two levels.';

/**
 * Ordering: dimension-specific question first, then the withheld-evidence
 * caveat, then the level-order note last. The caveat is context the model
 * should hold while reading the four level descriptions below (so it does
 * not read, e.g., "no visible assertions" in the `Misleading` criterion and
 * apply it to a withheld fragment); the level-order note is the final
 * action instruction ("now pick one"), so it reads best immediately before
 * the criteria list that follows it in the same request.
 */
function withQualityGuidance(instructions: string): string {
  return `${instructions} ${QUALITY_PROVENANCE_GUIDANCE} ${QUALITY_LEVEL_ORDER_NOTE}`;
}

interface DimensionText {
  readonly id: RubricDimensionId;
  readonly label: string;
  readonly applicabilityInstructions: string;
  readonly applicabilityCriteria: NoulCriteria;
  readonly qualityInstructions: string;
  /** Exactly four strings, each already prefixed with its level name (`Misleading:`, `Weak:`, `Acceptable:`, `Strong:`). */
  readonly qualityCriteria: readonly [string, string, string, string];
}

const DIMENSION_TEXT: readonly DimensionText[] = [
  {
    id: 'falsifiability',
    label: 'Falsifiability',
    applicabilityInstructions:
      "Decide whether there is enough evidence to judge falsifiability: whether this test would actually fail "
      + 'if the specific behavior it claims to verify were broken. Sufficient evidence means you can see the '
      + "test's assertions and enough of the exercised behavior — directly, or through shown helper or "
      + 'production evidence — to reason concretely about what would make the test fail. Insufficient evidence '
      + "means the assertions, the code path they exercise, or the meaning of the expected values are hidden, "
      + 'elided, or entirely outside the evidence shown, so any falsifiability judgment would be a guess.',
    applicabilityCriteria: {
      true:
        "The test's assertions and the behavior they claim to verify are both visible in the evidence, so a "
        + "concrete 'what would make this fail' judgment is possible.",
      false:
        'The assertions, the exercised behavior, or the meaning of the expected values needed to judge '
        + 'falsifiability are missing from the evidence.',
    },
    qualityInstructions:
      'Judge falsifiability: would this test fail if the specific behavior it names or targets stopped working '
      + "correctly? A falsifiable test's assertions are wired to the actual outcome of that behavior, so breaking "
      + 'the behavior breaks the assertion. Do not judge whether the test currently passes — judge whether a '
      + 'genuine regression in the targeted behavior would make it fail.',
    qualityCriteria: [
      'Misleading: the test cannot fail from a regression in the behavior it claims to check — the assertion '
      + 'checks something structurally guaranteed to hold regardless of that behavior (for example asserting a '
      + 'mock was defined, asserting a variable exists, asserting a promise resolved without checking its value, '
      + 'or asserting a tautology), or the test body never actually invokes the behavior under test. A reader '
      + 'could break the real behavior entirely and this test would keep passing.',
      'Weak: the test could fail from some regressions but leaves an easy path for the targeted behavior to '
      + 'break without being caught — for example it checks only that a call happened or that no error was '
      + 'thrown, without checking the produced value or resulting state the behavior is actually responsible '
      + 'for, or it checks only one of several outcomes the behavior name promises.',
      'Acceptable: the test would fail for the specific behavior it names, though it may miss some adjacent '
      + 'edge cases or rely on one representative case rather than the behavior\'s full contract.',
      'Strong: the test is tightly wired to the targeted behavior — the assertions directly depend on the '
      + "values or state that behavior produces, cover the meaningful cases implied by the test's name, and a "
      + 'plausible regression in that behavior has no path to leave the test green.',
    ],
  },
  {
    id: 'behavioral-focus',
    label: 'Behavioral focus',
    applicabilityInstructions:
      'Decide whether there is enough evidence to judge behavioral focus: whether the assertions target an '
      + 'observable outcome (a return value, thrown error, emitted event, persisted state, or similar) rather '
      + 'than an incidental implementation detail (a specific internal call, a private field, or an '
      + 'implementation-only call order). Sufficient evidence means the assertions, and enough of what they '
      + 'check, are visible. Insufficient evidence means what the assertions actually inspect cannot be '
      + 'determined from the evidence shown.',
    applicabilityCriteria: {
      true: 'The assertions and what they inspect are visible enough to tell whether the check targets an '
      + 'outcome or an implementation detail.',
      false: 'What the assertions actually inspect cannot be determined from the evidence shown.',
    },
    qualityInstructions:
      'Judge behavioral focus: does the test assert something a caller of the code under test would actually '
      + 'observe or depend on — a return value, a thrown error, a side effect on shared state, an emitted '
      + 'event, a rendered result — rather than an incidental interaction that only exists because of how the '
      + "implementation happens to be written today (a specific private method being called, an internal call "
      + 'order, or an implementation-only field)?',
    qualityCriteria: [
      'Misleading: every assertion targets an implementation detail invisible to any real caller — for example '
      + 'asserting a specific private helper was called, asserting on the internal call order or call count of '
      + 'a helper with no observable effect, or asserting on an implementation-only internal field — with no '
      + 'assertion on any actual output or observable effect. The test would need to be rewritten, not just '
      + 'adjusted, if the implementation were reorganized without changing behavior.',
      'Weak: the test mixes some observable-outcome assertions with implementation-detail assertions, or its '
      + 'main assertion is on an outcome but is bundled with brittle checks on how that outcome was produced '
      + '(specific call arguments or order to a collaborator) that are not themselves part of the promised '
      + 'behavior.',
      'Acceptable: assertions target the observable outcome the test claims to verify, though a call-order or '
      + 'interaction check for a genuinely externally-visible side effect (for example a required write to a '
      + 'datastore) may also be present.',
      'Strong: every assertion targets an outcome or effect that a real caller of this code would observe or '
      + 'depend on, with no assertion tied to an implementation detail that could change under a '
      + 'behavior-preserving refactor.',
    ],
  },
  {
    id: 'refactor-resistance',
    label: 'Refactor resistance',
    applicabilityInstructions:
      'Decide whether there is enough evidence to judge refactor resistance: whether the internals of the code '
      + 'under test could be reorganized, renamed, or restructured — while preserving its externally observed '
      + 'behavior — without breaking this test. This requires seeing what the test couples itself to (imports, '
      + 'mocked modules, asserted call shapes) and, where shown, the production seam it exercises. Sufficient '
      + "evidence means the test's coupling points are visible. Insufficient evidence means the evidence shown "
      + 'does not reveal what internal structure the test depends on.',
    applicabilityCriteria: {
      true: "The test's imports, mocks, and assertions reveal what internal structure, if any, it is coupled "
      + 'to, enough to judge refactor resistance.',
      false: 'What the test is actually coupled to cannot be determined from the evidence shown.',
    },
    qualityInstructions:
      'Judge refactor resistance: if the code under test were reorganized internally — functions renamed, '
      + 'split, moved between modules, internal data structures changed — while its externally observed '
      + 'behavior stayed the same, would this test keep passing? Consider what the test imports, mocks, and '
      + 'asserts on: coupling to internal module paths, private structure, or exact internal call sequences '
      + 'makes a test brittle to refactors that change nothing a caller would notice.',
    qualityCriteria: [
      'Misleading: the test is coupled to internal structure that has nothing to do with the promised '
      + 'behavior — for example it mocks or imports a deep internal module instead of the public seam, or '
      + 'asserts on the exact sequence or count of internal helper calls — such that a purely internal '
      + 'reorganization that preserves all external behavior would break the test.',
      'Weak: the test is mostly coupled to the public seam, but has at least one assertion or mock that '
      + "reaches into an internal path or internal call shape not part of the code's public contract, creating "
      + 'a real risk of breaking on a behavior-preserving refactor.',
      "Acceptable: the test is coupled to the code's public seam — its exported or public entry point and its "
      + 'documented inputs and outputs — with no dependency on private internal structure, though it may be '
      + 'sensitive to some reasonable internal changes.',
      "Strong: the test depends only on the code's public contract — its inputs, outputs, and externally "
      + 'observable effects — and would keep passing through any internal reorganization that preserves that '
      + 'contract.',
    ],
  },
  {
    id: 'assertion-strength',
    label: 'Assertion strength',
    applicabilityInstructions:
      'Decide whether there is enough evidence to judge assertion strength: whether the assertions are precise '
      + '(checking specific expected values rather than loose shape checks), meaningful (tied to what the test '
      + 'claims to verify), and dependent on the actual result of the act under test rather than on a fixed '
      + 'literal unrelated to what was computed. Sufficient evidence means the assertion calls and their '
      + 'expected values, or a clear absence of assertions, are visible. Insufficient evidence means the '
      + 'assertions or their expected values are not shown.',
    applicabilityCriteria: {
      true: 'The assertion calls and the expected values they compare against are visible in the evidence.',
      false: 'The assertion calls or the expected values they compare against are not visible in the evidence '
      + 'shown.',
    },
    qualityInstructions:
      "Judge assertion strength: are the test's assertions precise and meaningful, checking specific values or "
      + 'conditions that follow from the act under test, rather than loose checks (existence, truthiness, '
      + 'type-only, an unreviewed snapshot) or a check against a value that does not actually depend on what '
      + 'was computed?',
    qualityCriteria: [
      'Misleading: there are no assertions that meaningfully constrain the outcome — missing assertions '
      + 'entirely, an assertion with no matcher, or an assertion against a fixed literal unconnected to the act '
      + 'under test (such as comparing a value against itself) — or the only assertion checks that no error was '
      + 'thrown with nothing about the actual result.',
      'Weak: assertions exist but are loose — they check only truthiness, type, or definedness, or an '
      + 'unreviewed opaque snapshot, where a materially wrong result could still satisfy the check.',
      'Acceptable: assertions check specific expected values or conditions that depend on the act under test '
      + 'and would catch a materially wrong result, though they may not cover every field or case a fuller '
      + 'check could.',
      'Strong: assertions precisely pin down the expected outcome — specific values, structured equality, or a '
      + 'reviewed, inline-expected snapshot — in a way clearly derived from what the act under test should '
      + 'produce, leaving little room for a wrong result to pass.',
    ],
  },
  {
    id: 'test-double-quality',
    label: 'Test-double quality',
    applicabilityInstructions:
      'Decide whether there is enough evidence to judge test-double quality: whether the mocks, stubs, spies, '
      + 'or fakes this test uses replace only appropriate boundaries — external systems, slow or nondeterministic '
      + 'dependencies, or explicitly out-of-scope collaborators — rather than the behavior under test itself. '
      + "Sufficient evidence means the test's mock or stub declarations and what they target are visible; a test "
      + 'that visibly uses no test doubles at all is also sufficient evidence, since there is nothing to misuse. '
      + 'Insufficient evidence means test-double usage is implied — for example by an unresolved import — but '
      + 'what is actually mocked, or how, is not visible.',
    applicabilityCriteria: {
      true: 'Every test double the test uses is visible in the evidence, or the test visibly uses none at all.',
      false: 'The test appears to use test doubles whose target or configuration is not visible in the '
      + 'evidence shown.',
    },
    qualityInstructions:
      'Judge test-double quality: are the mocks, stubs, spies, or fakes in this test applied at the right '
      + 'boundary — external systems, network calls, timers, randomness, or collaborators explicitly out of '
      + 'scope — rather than mocking the very function, module, or behavior the test claims to verify? Also '
      + 'consider whether a mocked return value is realistic enough that the test still exercises meaningful '
      + 'logic. A test with no test doubles at all is not penalized by this dimension, since there is nothing '
      + 'to misuse.',
    qualityCriteria: [
      'Misleading: the test mocks or stubs the exact unit, function, or behavior it claims to verify — for '
      + 'example mocking the function under test itself, or stubbing out the specific computation being '
      + 'asserted on — so the test can pass with the real logic removed or broken.',
      'Weak: the test doubles reach further than necessary — mocking a collaborator that contains real logic '
      + 'relevant to the outcome, or returning canned values so generic or unconditional that the test would '
      + 'pass under many different, even wrong, implementations of that collaborator.',
      'Acceptable: test doubles replace genuine external boundaries — I/O, network, time, randomness, or an '
      + 'explicitly out-of-scope collaborator — with reasonably realistic behavior, leaving the logic under '
      + 'test intact and exercised.',
      'Strong: test doubles are used only where necessary, are configured with realistic, case-specific '
      + 'behavior that still lets the test discriminate correct from incorrect logic, and nothing central to '
      + 'the behavior under test is replaced.',
    ],
  },
  {
    id: 'determinism-isolation',
    label: 'Determinism and isolation',
    applicabilityInstructions:
      'Decide whether there is enough evidence to judge determinism and isolation: whether this test can run '
      + 'alone, in any order relative to other tests, and repeatedly, always producing the same result. This '
      + "requires visibility into the test body, its in-scope hooks, and anything it reads or mutates that "
      + 'could be shared across tests — module-level state, timers, randomness, the filesystem, environment '
      + "variables, or a database. Sufficient evidence means these are visible. Insufficient evidence means the "
      + "test's setup or teardown, or its use of shared or external state, is not shown.",
    applicabilityCriteria: {
      true: 'The test body, its in-scope hooks, and any shared or external state it touches are visible in the '
      + 'evidence.',
      false: "The test's setup or teardown, or its dependence on shared, external, or time or random state, is "
      + 'not visible in the evidence shown.',
    },
    qualityInstructions:
      'Judge determinism and isolation: would this test produce the same pass or fail result every time it '
      + 'runs, regardless of run order and regardless of what other tests ran before it, without relying on '
      + 'real wall-clock time, unseeded randomness, network access, or state left behind by another test? '
      + 'Consider whether shared or module-level state is reset between runs and whether cleanup happens even '
      + 'on failure.',
    qualityCriteria: [
      'Misleading: the test depends on something that makes its outcome unpredictable or order-dependent — '
      + 'real timers or wall-clock time without control, unseeded randomness feeding an assertion, uncontrolled '
      + 'network access, or mutating shared or module-level state with no reset — such that the same test can '
      + 'pass and fail across runs or when run order changes, independent of any real code change.',
      "Weak: the test is mostly self-contained but has a narrower isolation gap — for example relying on a "
      + "previous test's side effect for convenience, or incomplete cleanup on a failure path — that would "
      + 'surface as flakiness or order-dependence under some conditions even if it usually passes today.',
      'Acceptable: the test sets up and tears down its own state, does not rely on other tests or execution '
      + 'order, and controls any time or randomness it depends on, though a rare or contrived edge case might '
      + 'still leak state.',
      'Strong: the test is fully self-contained — it creates and cleans up its own state, including on '
      + 'failure, controls or avoids real time, randomness, or network dependence, and its result is provably '
      + 'unaffected by run order or repetition.',
    ],
  },
  {
    id: 'diagnostic-quality',
    label: 'Diagnostic quality',
    applicabilityInstructions:
      "Decide whether there is enough evidence to judge diagnostic quality: whether the test's name and the "
      + 'evidence a failure would produce — assertion messages, matcher choice, what value would be shown on '
      + 'failure — let a reader identify which behavior broke without reading the implementation. Sufficient '
      + "evidence means the test's name, its structural ancestry, and its assertions are visible. Insufficient "
      + "evidence means the test's name or its assertions cannot be determined from the evidence shown.",
    applicabilityCriteria: {
      true: "The test's name, its structural ancestry, and its assertions are visible in the evidence.",
      false: "The test's name or its assertions cannot be determined from the evidence shown.",
    },
    qualityInstructions:
      "Judge diagnostic quality: if this test failed, would its name plus the failure output — the matcher "
      + 'used, the values it would show — tell a reader which specific behavior broke, without them needing to '
      + 'read the implementation? Consider whether the test name describes a concrete behavior or scenario '
      + "rather than a vague label, whether assertions use matchers that surface a useful diff on failure, and "
      + 'whether one test checks one coherent behavior rather than several unrelated ones bundled together.',
    qualityCriteria: [
      "Misleading: the test name is generic or unrelated to what is actually checked — for example 'works', "
      + "'test1', or a name describing a different behavior than the assertions cover — or the assertions are "
      + 'structured so a failure would give no usable information about which specific behavior broke, such as '
      + 'a single boolean or truthy check summarizing a large, multi-step operation.',
      'Weak: the test name is present but vague or only loosely tied to the specific behavior asserted, or it '
      + 'bundles several unrelated behaviors into one test body such that a failure would not indicate which '
      + 'one broke without extra investigation.',
      'Acceptable: the test name describes the behavior under test and the assertions would show a reasonably '
      + 'specific failure — matcher and values — letting a reader narrow down the problem without much extra '
      + 'investigation.',
      'Strong: the test name precisely names the scenario and expected behavior, the test checks one coherent '
      + 'behavior, and its assertions use matchers that would surface a specific, actionable diff identifying '
      + 'exactly what broke.',
    ],
  },
];

function toDimension(text: DimensionText): RubricDimension {
  return {
    id: text.id,
    label: text.label,
    applicability: {
      id: `${text.id}.applicable`,
      type: 'noul',
      instructions: withProvenanceGuidance(text.applicabilityInstructions),
      criteria: text.applicabilityCriteria,
    },
    quality: {
      id: `${text.id}.quality`,
      type: 'score',
      instructions: withQualityGuidance(text.qualityInstructions),
      criteria: text.qualityCriteria,
    },
  };
}

/**
 * The shipped, versioned rubric for Phase 4: the seven PRD dimensions, one
 * applicability `noul` question and one four-level quality `score` question
 * each (14 questions total), pinned to {@link JEV_MODEL_ID}. Validate with
 * {@link validateRubric} before composing a request from it (see
 * `buildJevRequest` in `src/domain/jev-request.ts`, which does this itself).
 *
 * Superseded as the active rubric by {@link RUBRIC_V2} (task C-2 of
 * `odd/tasks/classification-calibration.md`); kept exported, unchanged, and
 * still fully tested, because the 2026-09-20 discrimination-fixture
 * recording (`test/fixtures/recorded/discrimination-raw-2026-09-20.json`,
 * replayed by `test/classification-replay.test.ts`) is real provider output
 * captured against this exact wording — recomputing its verdicts requires
 * this exact `Rubric` value to keep existing, not a v2 stand-in.
 */
export const RUBRIC_V1: Rubric = {
  version: 1,
  model: JEV_MODEL_ID,
  dimensions: DIMENSION_TEXT.map(toDimension),
};

/**
 * Task C-2 (`odd/tasks/classification-calibration.md`) rewrites of the two
 * applicability questions measured to exclude themselves on real evidence
 * (see the task doc's "Measured evidence"): `determinism-isolation`
 * (applicability 0.13-0.20 on 5 of 11 discrimination-fixture tests,
 * including the one deliberately written to violate determinism) and
 * `falsifiability` (applicability 0.33-0.49, just under the 0.5 cut, on
 * several tests including a healthy control asserting an exact value).
 *
 * Both v1 questions asked, in effect, "is every possible influence on this
 * dimension visible?" — a question evidence bundles are deliberately built
 * to answer "no" to, since they carry only the test's own body plus a
 * minimal helper/production-seam/mock-target slice (`src/domain/evidence.ts`),
 * never the whole repository. The task doc's decision: "Applicability
 * questions must ask whether the shown evidence supports a judgment, not
 * whether every possible influence is visible. Absence of visible shared
 * state is evidence about determinism, not a reason to abstain." Both
 * rewrites below implement that decision directly, and each keeps a
 * concrete `false` criterion — inapplicable only when the test's own body
 * (`determinism-isolation`) or its assertions/exercised behavior
 * (`falsifiability`) are not shown in the evidence at all — so a genuinely
 * evidence-starved test still abstains rather than becoming
 * unconditionally applicable.
 *
 * `determinism-isolation`'s wording is deliberately scoped to what
 * `buildJevState` (`src/domain/jev-request.ts`) can actually put in front of
 * the model: the test's own body (a `kind: 'test'` fragment) and, when
 * evidence selection includes one, an in-scope hook fragment tagged
 * `selectionReason: 'hook-in-scope'` (`src/domain/evidence.ts`) — never a
 * structured `hooks` record, which `buildJevState` deliberately omits. The
 * question is worded around "the test's own body" being shown, not around
 * "hooks being shown", so a test with no in-scope hook at all is not read as
 * missing evidence.
 *
 * `falsifiability`'s wording separates two things v1 conflated: the test's
 * own assertions and what they are wired to (visible whenever the test body
 * is shown) from the deeper production implementation behind that behavior
 * (frequently not shown, since evidence selection sends only a minimal
 * seam). A falsifiability judgment needs the former, not the latter.
 */
const V2_APPLICABILITY_OVERRIDES: Readonly<Partial<Record<RubricDimensionId, { readonly instructions: string; readonly criteria: NoulCriteria }>>> = {
  'determinism-isolation': {
    instructions:
      'Decide whether the evidence shown supports a judgment on determinism and isolation for this specific '
      + "test — not whether every possible external influence on it has been ruled out. Inspect the test's own "
      + 'body, together with any in-scope hook fragment the evidence includes, for concrete hazards: real '
      + 'wall-clock time, unseeded randomness, uncontrolled network access, the filesystem, environment '
      + 'variables, or state written to or read from module-level or otherwise shared scope. If the body and '
      + 'any hooks shown contain none of these hazards, that absence is itself evidence the test is '
      + 'self-contained — treat it as support for a determinism judgment, not as a reason to abstain because '
      + "some other, unshown part of the codebase could theoretically interact with it. This question is "
      + "inapplicable only when the test's own body is not shown at all, so there is nothing to inspect for a "
      + 'hazard in the first place.',
    criteria: {
      true:
        "The test's own body is shown — together with any in-scope hook fragment the evidence includes, if "
        + 'there is one — so it can be inspected for a determinism or isolation hazard, whether or not one is '
        + 'actually found there.',
      false:
        "The test's own body is not shown in the evidence at all, so there is nothing to inspect for a "
        + 'determinism or isolation hazard.',
    },
  },
  falsifiability: {
    instructions:
      'Decide whether the evidence shown supports a judgment on falsifiability — not whether the full '
      + 'production implementation behind the tested behavior has been shown. Falsifiability asks whether '
      + "breaking the specific behavior the test names would break its assertions, and that can be judged "
      + "concretely once the test's own assertions and the call or behavior they are wired to are visible, even "
      + 'when the deeper implementation behind that call is not shown. Sufficient evidence means the assertions '
      + 'and what they are checking against are visible, so it is possible to reason about what would make them '
      + 'fail. This question is inapplicable only when the assertions themselves, or the behavior they '
      + 'exercise, are not shown at all — never merely because the code behind that behavior is absent from the '
      + 'evidence.',
    criteria: {
      true:
        "The test's assertions and the behavior or call they are wired to are visible, enough to reason "
        + 'concretely about what would make them fail — even when the deeper implementation behind that '
        + 'behavior is not shown.',
      false:
        "The test's assertions, or the behavior they exercise, are not shown in the evidence at all, so there "
        + 'is nothing to reason about what would make the test fail.',
    },
  },
};

const DIMENSION_TEXT_V2: readonly DimensionText[] = DIMENSION_TEXT.map((text) => {
  const override = V2_APPLICABILITY_OVERRIDES[text.id];
  if (override === undefined) return text;
  return {
    ...text,
    applicabilityInstructions: override.instructions,
    applicabilityCriteria: override.criteria,
  };
});

/**
 * The shipped, active rubric as of task C-2 (`odd/tasks/classification-calibration.md`):
 * identical to {@link RUBRIC_V1} in every field except the two rewritten
 * applicability questions above (`determinism-isolation`, `falsifiability`)
 * — every other dimension's applicability text, every dimension's quality
 * text, every label, and every question id are inherited byte-for-byte from
 * {@link RUBRIC_V1} via {@link DIMENSION_TEXT} (see `test/rubric.test.ts`,
 * which asserts that inheritance directly). Every real `--evaluate` request
 * construction (`src/adapters/jev-evaluation-port.ts`) uses this rubric, not
 * {@link RUBRIC_V1}.
 */
export const RUBRIC_V2: Rubric = {
  version: 2,
  model: JEV_MODEL_ID,
  dimensions: DIMENSION_TEXT_V2.map(toDimension),
};

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateNoulQuestion(expectedId: string, question: RubricNoulQuestion, seenQuestionIds: Set<string>): void {
  if (question.type !== 'noul') {
    throw new RangeError(`Rubric question ${expectedId} must have type "noul": ${question.type}`);
  }
  if (question.id !== expectedId) {
    throw new RangeError(`Rubric applicability question id must be "${expectedId}": got "${question.id}"`);
  }
  if (seenQuestionIds.has(question.id)) {
    throw new RangeError(`Duplicate rubric question id: ${question.id}`);
  }
  seenQuestionIds.add(question.id);
  if (!nonEmpty(question.instructions)) {
    throw new RangeError(`Rubric question ${question.id} must have non-empty instructions`);
  }
  if (question.criteria !== undefined) {
    if (!nonEmpty(question.criteria.true) || !nonEmpty(question.criteria.false)) {
      throw new RangeError(`Rubric question ${question.id} criteria.true and criteria.false must be non-empty`);
    }
  }
}

function validateScoreQuestion(expectedId: string, question: RubricScoreQuestion, seenQuestionIds: Set<string>): void {
  if (question.type !== 'score') {
    throw new RangeError(`Rubric question ${expectedId} must have type "score": ${question.type}`);
  }
  if (question.id !== expectedId) {
    throw new RangeError(`Rubric quality question id must be "${expectedId}": got "${question.id}"`);
  }
  if (seenQuestionIds.has(question.id)) {
    throw new RangeError(`Duplicate rubric question id: ${question.id}`);
  }
  seenQuestionIds.add(question.id);
  if (!nonEmpty(question.instructions)) {
    throw new RangeError(`Rubric question ${question.id} must have non-empty instructions`);
  }
  if (question.criteria.length !== RUBRIC_QUALITY_LEVEL_COUNT) {
    throw new RangeError(
      `Rubric question ${question.id} must define exactly ${RUBRIC_QUALITY_LEVEL_COUNT} ordered levels: `
      + `got ${question.criteria.length}`,
    );
  }
  for (const level of question.criteria) {
    if (!nonEmpty(level)) {
      throw new RangeError(`Rubric question ${question.id} has an empty quality level description`);
    }
  }
}

/**
 * Validates a {@link Rubric}'s shape deterministically, throwing
 * `RangeError` on the first violation found: a positive integer version,
 * the exact pinned {@link JEV_MODEL_ID}, at least one dimension, every
 * dimension id drawn from {@link RUBRIC_DIMENSION_IDS} with no duplicates,
 * a non-empty label, question ids following the `<dimension-id>.applicable`
 * / `<dimension-id>.quality` scheme with no duplicates across the whole
 * rubric, non-empty instructions everywhere, and exactly
 * {@link RUBRIC_QUALITY_LEVEL_COUNT} non-empty ordered levels per quality
 * question.
 *
 * Deliberately generic over dimension count (it does not require exactly
 * the seven {@link RUBRIC_DIMENSION_IDS}): that stronger, version-specific
 * guarantee is asserted directly against {@link RUBRIC_V1} by
 * `test/rubric.test.ts`, so this function stays reusable for a smaller
 * fixture rubric in tests and for a future rubric version that adds or
 * removes a dimension deliberately.
 */
export function validateRubric(rubric: Rubric): void {
  if (!Number.isInteger(rubric.version) || rubric.version <= 0) {
    throw new RangeError(`Rubric version must be a positive integer: ${rubric.version}`);
  }
  if (rubric.model !== JEV_MODEL_ID) {
    throw new RangeError(`Rubric model must be pinned to "${JEV_MODEL_ID}": got "${rubric.model}"`);
  }
  if (rubric.dimensions.length === 0) {
    throw new RangeError('Rubric must define at least one dimension');
  }

  const seenDimensionIds = new Set<string>();
  const seenQuestionIds = new Set<string>();
  for (const dimension of rubric.dimensions) {
    if (!RUBRIC_DIMENSION_ID_SET.has(dimension.id)) {
      throw new RangeError(`Unknown rubric dimension id: ${dimension.id}`);
    }
    if (seenDimensionIds.has(dimension.id)) {
      throw new RangeError(`Duplicate rubric dimension id: ${dimension.id}`);
    }
    seenDimensionIds.add(dimension.id);
    if (!nonEmpty(dimension.label)) {
      throw new RangeError(`Rubric dimension ${dimension.id} must have a non-empty label`);
    }

    validateNoulQuestion(`${dimension.id}.applicable`, dimension.applicability, seenQuestionIds);
    validateScoreQuestion(`${dimension.id}.quality`, dimension.quality, seenQuestionIds);
  }
}
