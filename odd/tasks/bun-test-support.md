# Support bun:test and report unsupported frameworks honestly

## Objective

Stop reporting an unsupported test framework as an empty repository, and extract `bun:test` suites, cases, modifiers, hooks, mocks, and assertions with the same fidelity as Jest and Vitest.

## Problem

Auditing `~/Desktop/pr-hero` returned "173 files, 0 test cases, 0 diagnostics". The repository actually holds 175 TypeScript test files written against `bun:test`. Discovery found and included every file, attributed framework `unknown`, and extraction produced nothing — silently. A reader cannot distinguish "this repository has no tests" from "the auditor does not understand this framework".

Isolated with two identical files differing only in their import: `bun:test` yields framework `unknown` and zero cases with no diagnostic, while `vitest` yields one case.

## Why

Silence about an unsupported framework is the dishonesty the PRD forbids: operational gaps must stay visible and must never read as a clean result. Separately, `bun:test` is a real target — one of the user's own repositories uses it, and its Jest-compatible API is close enough that support is alias and attribution work rather than a new adapter.

## Authorized scope

- Emit an explicit, machine-readable diagnostic when a discovered test file's framework cannot be attributed, naming the evidence found, and surface it in the CLI summary and totals.
- Attribute and extract `bun:test`: suites, cases, modifiers, hooks, imports, mocks, assertions, and static parameter tables.
- Update README and technical design for the delivered behavior.
- Do not add other frameworks, other languages, `_test.ts`/`_spec.ts` filename patterns, or Bun-specific runtime behavior.

## Scope and constraints

- Never execute audited code, Bun, or any test runner.
- Keep one package, no new dependencies.
- A file whose framework stays `unknown` must still never produce invented test cases.
- Existing Jest and Vitest behavior must not change; their extraction tests stay green unmodified.
- Artifacts use English. Preserve unrelated untracked `.atl/` files. Conventional Commits without AI attribution.

## Verified provider facts (bun.com/docs/test, 2026-09-20)

- Module specifier `bun:test`; the runner is Jest-compatible but incomplete against Jest.
- Test and suite API: `describe`, `test`, `it`, `expect`, with `.only`, `.skip`, `.todo`, `.failing`, `.each`, `.if`, `.skipIf`, `.todoIf`.
- Concurrency modifiers: `test.concurrent` and `test.serial`; `test.serial` has no Vitest or Jest equivalent.
- Lifecycle hooks: `beforeAll`, `beforeEach`, `afterEach`, `afterAll`.
- Mocks: `mock()`, `spyOn()`, `mock.module()`, `mock.clearAllMocks()`, `mock.restore()`, plus `jest.fn()` and the rest of the `jest` object imported from `bun:test`.
- Default file patterns also include `*_test.*` and `*_spec.*` and the `.mjs`/`.cjs`/`.mts`/`.cts` extensions; both are out of scope here and recorded as deferred.

## Decisions

- `test.serial` becomes a first-class modifier kind rather than being dropped, since ordering is evidence for the determinism dimension.
- `jest.*` imported from `bun:test` is recorded with its Bun provenance, not silently merged into Jest attribution.
- The unsupported-framework diagnostic is emitted per file, with severity `warning`, and counted in totals so a CI reader sees it without reading every record.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 700 authored changed lines, generated files excluded.
- Chain strategy: cached `feature-branch-chain`.
- Tracker boundary: `feat/bun-test-support`, based on `main`.
- Remote pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged.
- TDD: enabled; require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.

## Acceptance criteria

- A discovered test file with an unattributable framework produces a warning diagnostic naming the evidence, visible in the CLI summary and counted in totals; auditing pr-hero before Bun support would have said so instead of reporting an empty result.
- `bun:test` files attribute framework `bun` and extract the same structures Jest and Vitest do.
- `test.serial` is preserved as a modifier.
- Jest and Vitest extraction behavior is unchanged.
- Auditing `~/Desktop/pr-hero` reports a realistic test-case count with no unsupported-framework warnings remaining.

## Tasks

- [x] **B-1 — Report an unattributable framework instead of an empty result**
  - Emit a per-file warning diagnostic with the attribution evidence found, count it in totals, and surface it in the CLI summary and JSON.
  - Verify a file with an unknown framework, a file with conflicting evidence, and that Jest/Vitest files emit nothing new.
  - Evidence: `63daa3c` (`feat: report unattributable test frameworks`) on `feat/unsupported-framework-diagnostic`; 9 files, 222 additions and 6 deletions (228 authored changed lines). Suite 515 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. The check lives in extraction, which already knows both the attributed framework and the extracted count, and fires only when the framework is `unknown` and no case was extracted; a recognized framework with zero cases stays silent. `AuditTotals.unsupportedFrameworkFiles` counts affected files and the CLI needed no change because it serializes totals verbatim. The packed smoke fixture gained two expected warnings for its syntax-error and non-framework files. Mutations on dropping the warning, warning on recognized empty files, omitting the evidence, dropping the total, and firing when cases exist turned RED. Re-audit of `~/Desktop/pr-hero`: 173 files, 173 `unsupported-framework` warnings naming `bun:test`, where before it reported zero tests and zero diagnostics.
- [x] **B-2 — Extract bun:test**
  - Attribute `bun:test` as framework `bun`; support its suite/case API, modifiers including `test.serial`, hooks, mocks (`mock`, `spyOn`, `mock.module`, and `jest.*` from `bun:test`), assertions, and static parameter tables.
  - Verify against real fixtures plus a re-audit of `~/Desktop/pr-hero`, and confirm Jest and Vitest behavior is untouched.
  - Evidence: `f5e8bbd` (`feat: extract bun test suites`) on `feat/bun-test-extraction`; 9 files, 532 additions and 83 deletions (615 authored changed lines). Suite 530 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. Framework `bun` is attributed from a static `bun:test` import or require with the existing precedence; conflicting evidence still resolves to `unknown`. `MockApi` gained the bun forms including `bun.mock.module` and a `bun.jest.*` set, so bun provenance is never recorded as plain Jest, and the module-specifier predicate became an explicit set instead of a suffix heuristic. `TestModifierKind` gained `serial` and `todoIf`; bun's `.if` maps to `runIf` and `.failing` to `fails`, both gated to bun so Jest 28's real `test.failing` is untouched. Mutations on attributing bun as vitest, dropping `serial`, recording bun's `jest.fn` as Jest, ignoring scope shadowing, reverting attribution, and dropping `bun.mock.module` from mock-target reclassification turned RED. Re-audit of `~/Desktop/pr-hero`: 173 files, 3,597 test cases, 33 dynamic, 0 diagnostics, 0 unsupported-framework files, all attributed `bun`. Hand spot-checks on three files matched, including a template-literal test name correctly recorded as dynamic. Known gaps: a bare `jest.fn()` never imported from `bun:test` is unrecognized; `vi` re-exported from `bun:test` is unhandled; two-level namespace chains such as `t.mock.module(...)` are unsupported; `_test`/`_spec` filename patterns and `.mjs`/`.cjs`/`.mts`/`.cts` extensions remain deferred.

## Progress

- Current task: **none — feature complete**.
- Completed tasks: **B-1, B-2**.
- Running authored count: **843**, against a 700-line forecast.
- Slice ledger:
  - `feat/unsupported-framework-diagnostic`: `63daa3c` — honest unsupported-framework reporting.
  - `feat/bun-test-extraction`: `f5e8bbd` — bun:test attribution, modifiers, mocks, and extraction.

## Next step

Integrating this chain into `main` is the user's decision. The pr-hero re-audit exposed the next problem, tracked in `odd/tasks/path-alias-resolution.md`: its evidence density is 1.44 fragments per test against 2.69 here, because 17,316 subpath imports stay unresolved.
