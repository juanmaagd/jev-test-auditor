# Rubric dimensions

Plain-language guide to the 7 `RUBRIC_V2` dimensions (`src/domain/rubric.ts`), derived from their
real quality-question text. A fix subagent reads only the section(s) for its file's failing
dimensions — do not read the whole file into an unrelated fix.

## Falsifiability (`falsifiability`)

**What it checks:** would this test actually fail if the specific behavior it names stopped
working correctly?

- **Misleading:** the test cannot fail from a real regression — it asserts a mock was defined, a
  variable exists, a promise resolved without checking its value, a tautology, or the test body
  never actually invokes the behavior under test.
- **Weak:** it could catch some regressions but leaves an easy escape — e.g. it checks only that a
  call happened or that no error was thrown, without checking the produced value or state.
- **Typical fixes:** assert on the actual return value, state, or error the targeted behavior
  produces, not just "it ran" or "it didn't throw"; confirm the test body genuinely exercises the
  behavior under test rather than a structurally-guaranteed side effect.

## Behavioral focus (`behavioral-focus`)

**What it checks:** do the assertions target an observable outcome (a return value, thrown error,
emitted event, persisted state) rather than an incidental implementation detail?

- **Misleading:** every assertion targets an implementation detail invisible to any real caller —
  a specific private helper being called, internal call order/count, or an implementation-only
  field — with no assertion on any actual output or observable effect.
- **Weak:** mixes real outcome assertions with implementation-detail ones, or bundles a brittle
  call-order/argument check with the outcome check.
- **Typical fixes:** replace assertions on internal calls with assertions on what a caller of the
  code would actually observe; keep an interaction check only for a genuinely externally-visible
  effect (e.g. a required datastore write).

## Refactor resistance (`refactor-resistance`)

**What it checks:** would the test keep passing through an internal reorganization that preserves
external behavior?

- **Misleading:** coupled to internal structure that has nothing to do with the promised
  behavior — mocking or importing a deep internal module instead of the public seam, or asserting
  the exact sequence or count of internal helper calls.
- **Weak:** mostly coupled to the public seam, but has at least one assertion or mock reaching
  into an internal path not part of the code's public contract.
- **Typical fixes:** mock and import only the public entry point; assert on inputs, outputs, and
  externally observable effects, never on internal call shape or private structure.

## Assertion strength (`assertion-strength`)

**What it checks:** are the assertions precise, meaningful, and dependent on the actual result of
the act under test?

- **Misleading:** no assertion meaningfully constrains the outcome — missing assertions, a
  matcher-less assertion, an assertion against a fixed literal unconnected to the act under test
  (e.g. comparing a value to itself), or only checking that no error was thrown.
- **Weak:** assertions exist but are loose — truthiness, type, or definedness checks, or an
  unreviewed opaque snapshot, where a materially wrong result could still pass.
- **Typical fixes:** assert specific expected values or structured equality clearly derived from
  what the act under test should produce; replace a truthy/type-only check or an unreviewed
  snapshot with a concrete expected value.

## Test-double quality (`test-double-quality`)

**What it checks:** do mocks, stubs, spies, or fakes replace only appropriate boundaries (external
systems, slow or nondeterministic dependencies, explicitly out-of-scope collaborators) rather than
the behavior under test itself?

- **Misleading:** the test mocks or stubs the exact unit, function, or behavior it claims to
  verify, so it can pass with the real logic removed or broken.
- **Weak:** the test doubles reach further than necessary — mocking a collaborator that contains
  real logic relevant to the outcome, or returning canned values so generic the test would pass
  under many different, even wrong, implementations.
- **Typical fixes:** mock only genuine external boundaries (I/O, network, time, randomness,
  explicitly out-of-scope collaborators); keep the logic under test real and exercised, and give
  mocks realistic, case-specific behavior.

## Determinism and isolation (`determinism-isolation`)

**What it checks:** does the test produce the same pass/fail result every run, regardless of order
and repetition, without real wall-clock time, unseeded randomness, network access, or leftover
state from another test?

- **Misleading:** depends on something that makes the outcome unpredictable or order-dependent —
  real timers, unseeded randomness feeding an assertion, uncontrolled network access, or shared or
  module-level state mutated with no reset.
- **Weak:** mostly self-contained but has a narrower isolation gap — relying on a previous test's
  side effect for convenience, or incomplete cleanup on a failure path.
- **Typical fixes:** control or fake time and randomness; set up and tear down any shared or
  module-level state (including on a failure path); remove dependence on another test's side
  effects or on execution order.

## Diagnostic quality (`diagnostic-quality`)

**What it checks:** if this test failed, would its name plus the failure output tell a reader
which specific behavior broke, without reading the implementation?

- **Misleading:** the test name is generic or unrelated to what is actually checked (e.g.
  "works", "test1"), or a single boolean/truthy check summarizes a large, multi-step operation so
  a failure gives no usable information.
- **Weak:** the name is present but vague or only loosely tied to the specific behavior asserted,
  or the test bundles several unrelated behaviors so a failure would not indicate which one broke.
- **Typical fixes:** name the test after the specific scenario and expected behavior; split a
  test that bundles several unrelated behaviors into one test per behavior; use matchers that
  surface a specific, actionable diff on failure instead of a single pass/fail boolean.
