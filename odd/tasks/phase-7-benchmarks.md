# Build Phase 7 deterministic benchmarks

## Objective

Replace author intent with executable proof. Build a Git-stored fixture corpus whose every case carries one controlled mutation, and executable oracles that prove each mutation had its expected effect before that case is allowed to count toward any metric. Only then can Phase 9 calibrate the classification policy's provisional thresholds against evidence instead of judgement.

## Problem

`CLASSIFICATION_POLICY_V2` (`src/domain/classification.ts:238`) ships `applicabilityMin: 0.5`, `sideMin: 0.65`, `criticalMin: 0.5`, and level cut points `[1, 2, 3]`. Those numbers have been provisional since Phase 4 and nothing has ever tested them against a known-correct answer. The only corpus that exists, `test/fixtures/discrimination/cart.test.ts`, labels its eight bad tests by author intent — a human wrote "this one is misleading" and nothing verified it. A threshold calibrated against intent is calibrated against the same judgement it is meant to replace.

## Why

Every quality claim this product makes rests on those thresholds. Until an operator and an oracle prove a case, a benchmark number is an opinion with a decimal point.

## Authorized scope

- Store the fixture corpus and its operator specifications in Git.
- Implement controlled mutation operators: removing an assertion, weakening an expectation, adding shared state, mocking owned logic, pinning an implementation detail, introducing uncontrolled time.
- Implement executable oracles that prove each operator's expected effect: production mutation, assertion mutation, semantics-preserving refactor, and repeated or randomized execution.
- Persist benchmark runs, oracle proofs, metrics, and comparisons; export JSONL behind an explicit flag.
- Report metrics per dimension.
- Do not implement the benchmark-review skill (Phase 8) or recalibrate any threshold (Phase 9).

## Scope and constraints

- **The never-execute guarantee is not weakened, it is bounded.** The audit pipeline still never executes audited source, package scripts, test runners, or configuration modules. Benchmark execution runs *our own* Git-stored fixtures, from a dedicated adapter, reachable only from an explicit benchmark command — never from `audit` under any flag. `test/evidence-resolution.test.ts:555` and `:571` (fixtures that throw if executed) and every `reportingOnly: true` assertion in `test/cli.test.ts` must keep passing untouched. A reader must be able to tell the two apart by which command they ran.
- Execution lives in an adapter. `src/domain` stays pure — no I/O, no timers, no process spawning — and `src/application` orchestrates through ports as it does everywhere else.
- **Benchmarks bypass the cache.** The cache key is pure content addressing (`src/adapters/cache-key.ts:78`), so a cached judgment for identical fixture bytes returns the first judgment ever recorded for them. Reusing it would measure the cache, not the model, and would make the PRD's required run-to-run stability metric impossible by construction. Benchmark sampling runs use `--fresh`.
- **Benchmark data does not live in the user's audit store.** Benchmark runs are keyed by Git fixture identity, not by an audited repository, and have a different lifecycle. Writing them into the store at the user's config home would mean a developer's benchmark work pollutes their own audit history. A separate database, under an explicit path, keeps the two apart.
- Recalibration is out of scope and stays out: per `docs/technical-design.md:156`, a new calibration is a new policy version such as `CLASSIFICATION_POLICY_V3`, never a silent edit of a shipped constant. Phase 7 produces the evidence; Phase 9 spends it.
- Only dimensions proven by an operator and an oracle count toward accuracy. An unproven observation stays `unverified` and must be visibly excluded from metrics, never quietly averaged in.
- Jev never labels its own benchmark.
- Artifacts use English. Preserve unrelated untracked `.atl/` files. Conventional Commits without AI attribution.

## Decisions

- A fixture case is a triple: a base test that genuinely passes against its production code, one operator applied to it, and the oracle that proves the operator did what it claims. Missing any leg, the case does not count.
- Oracle proof is recorded as data, not as a passing test run. A benchmark that re-derives its own ground truth on every invocation is a benchmark that can drift silently.
- The corpus lives in Git so a case's history is reviewable, and so a proof can be re-run against the exact bytes that produced it.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 4,500 authored changed lines, generated files excluded. Every prior phase overran its forecast; treat this as a floor.
- Chain strategy: cached `feature-branch-chain`.
- Tracker boundary: `feat/phase-7-benchmarks`, based on `main` at `dd0b454`.
- Planned local child slices: corpus and operators, executable oracles, benchmark persistence and comparison, per-dimension metrics and JSONL export.
- Remote tracker/child pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged.
- TDD: enabled by explicit user confirmation (carried forward); require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.
- **API cost**: P7-1 and P7-2 make no provider call at all. Cost appears only from P7-3 onward, and the user decides the corpus size before the first sampling run.

## Primary references

- Implementation plan, work unit 7: `docs/implementation-plan.md:69`
- Technical design, "Deterministic evaluation": `docs/technical-design.md:332`
- PRD on benchmark reporting and blind review: `docs/PRD.md:148`
- The existing intent-labelled corpus this phase must supersede: `test/fixtures/discrimination/cart.test.ts`

## Acceptance criteria

- Every corpus case carries a base test, exactly one operator, and a recorded oracle proof; a case missing any of the three is excluded from metrics and visibly reported as excluded.
- Each operator's expected effect is proven by execution, not asserted by a comment or a filename.
- An unproven case is reported `unverified` and never averaged into an accuracy figure.
- Benchmark execution is unreachable from `audit` under every flag, and the existing never-execute tests pass untouched.
- Benchmark data is written to its own database, never to the user's audit store, and no benchmark command writes anything without an explicit path.
- Metrics are reported per dimension, and a dimension with no proven case reports that plainly rather than reporting zero.

## Tasks

- [x] **P7-1 — Store a fixture corpus with controlled operators**
  - Define the corpus format in Git: for each case, the base test, its production code, exactly one declared operator, and the operator's expected effect.
  - Implement the six operators as declarative specifications, not yet as executed mutations.
  - Supersede the intent-labelled discrimination fixture by expressing its cases in the new format, keeping the originals for comparison.
  - Verify: the corpus parses deterministically; a case declaring two operators or none is rejected; a declared expected effect is required; no provider call and no file write occur.
  - Delivered on child branch `feat/phase-7-corpus` (off `feat/phase-7-benchmarks`, not merged, not committed — the branch was created and left with working-tree changes for the orchestrator to review and commit, per delegation instructions). Route: direct-inline single-writer delegation (one bounded task, not SDD).
  - Format decision, mid-task revision: the orchestrator asked, before any file existed, that production code be its own addressable per-case content (not inlined into the test, not a bare path) and that a case declare an expected effect on both the test side (what the operator changes about the test) and the production side (the falsifiable claim the oracle proves by acting on production), plus a required `oracleKind` naming which of the four `docs/technical-design.md:332` oracle kinds is meant to prove it. The shape below already stored production files as their own addressable entries; `testEffect`/`productionEffect`/`oracleKind` were added before any corpus file was written, so no format was retrofitted after the fact.
  - On-disk shape: one directory per case under `test/fixtures/corpus/<suite>/<case-id>/` — a `case.json` sidecar (`id`, `operators` (array, must resolve to exactly one), `oracleKind`, `testEffect`, `productionEffect`, `testFile`, `productionFiles`) plus the base test and every production file as real, byte-exact `.ts` files. Chosen over one manifest holding blob strings so a case's history is ordinary reviewable Git source (diffable, syntax-highlighted), and a later proof can be re-run against the exact bytes committed. Base-test files are named `test.ts`, never `*.test.ts`/`*.spec.ts`, so Vitest's default collection never executes them.
  - `src/domain/corpus.ts` (pure, zero non-relative imports, verified by `test/architecture-boundary.test.ts`): `parseCorpusCaseManifest` validates a manifest's raw JSON bytes (rejects invalid JSON, a non-object top level, any unknown field — including a hand-authored `"proofStatus"` — a missing/empty `id`, `operators` whose length is not exactly 1 or whose one entry is not a known operator id, a missing/unknown `oracleKind`, a missing/empty `testEffect`/`productionEffect`, and a `testFile`/`productionFiles` entry that escapes its case directory); `buildCorpusCase` combines a validated manifest with the adapter-read file bytes, cross-checks the paths match, and assigns `proofStatus: 'unverified'` itself (never read from disk, so a manifest cannot forge a proof).
  - `src/adapters/corpus-store.ts`: `loadCorpusCase` reads one case directory's bytes and calls the domain parser; `loadCorpusFromDirectory` reads every immediate subdirectory in sorted order (`readdir`'s own order is unspecified) and rejects a case whose manifest `id` does not match its own directory name (stricter than only rejecting duplicates, and it makes duplicates structurally impossible since directory names are already unique).
  - Unproven vs. proven is structural, not conventional: every `CorpusCase` P7-1 can produce carries the literal `proofStatus: 'unverified'`, and the type has no proof-shaped field at all yet — P7-2 adds the proven counterpart once an oracle can run. A case declaring an operator/oracleKind/effect pair with no proof reads as exactly "claim pending," never as a pass or a fail.
  - Ported the 11-case `test/fixtures/discrimination/cart.test.ts` (originals untouched) into `test/fixtures/corpus/discrimination/`, one directory per test, each with its own extracted single-test `test.ts` and a copy of the exact `cart.ts`/`audit-log.ts` bytes it needs. Operator assignment is this task's own analysis of what each test actually does (not a re-run of any oracle). `oracleKind` is declared independently per case from what its own `productionEffect` claim actually needs, not from a fixed operator→oracle table: the five cases whose only production-code hazard is an assertion too weak to reach it (`exposes-checkout-helper`, `works-boolean-check`, `computes-subtotal-truthy`, `discount-returns-number`, `checkout-tautology`) declare `production-mutation` (there is no meaningful assertion left to mutate — `expect(25).toBe(25)` has nothing an assertion-mutation oracle can act on); the two cases whose claim is specifically about the assertion's own strength on an otherwise-correct call (`subtotal-exact-value`, `discount-throws-range-error`) declare `assertion-mutation`; `mocks-discount-logic`/`checkout-applies-percent` declare `production-mutation`; `spies-on-math-round` declares `semantics-preserving-refactor`; `records-history-shared-state` declares `repeated-randomized-execution`, with its `productionEffect` rewritten to a claim that oracle can actually check (two runs sharing one loaded module, not a mid-test state reset the four named oracle kinds have no mechanism for). An earlier draft assigned `oracleKind` from operator identity alone and left 5 of 11 cases contradicting their own `productionEffect`; caught and corrected before reporting, not left in the corpus. **Gap, returned rather than resolved:** the ported set never uses `introduce-uncontrolled-time` (the original fixture's nondeterministic case uses unseeded randomness and shared module state, not real wall-clock time) — orchestrator to decide whether to author a new case for it or accept the gap. **`operator` means something different depending on which of the two groups a case is in — a P7-2 design input to return, not smooth over.** For the 3 good-control cases, `operator` is *prescriptive*: P7-2 is expected to actually apply it (apply the named operator to the base test) to produce a variant, then compare the base test and that variant against one production mutation — `productionEffect` is a claim about that comparison. **Correction:** only 2 of these 3 (`subtotal-exact-value`, `discount-throws-range-error`) are `assertion-mutation`; the third, `checkout-applies-percent`, is `production-mutation` — the same oracle kind as several *descriptive* cases below — and is prescriptive anyway. That is exactly why `oracleKind` cannot carry the prescriptive/descriptive distinction on its own, contrary to what the original bullet here implied. For the other 8 cases, `operator` is *descriptive*: the flaw it names is already present in the base test as written, P7-2 runs the named oracle against the base test unmodified, and never applies the operator at all — `productionEffect` is a claim about the base test alone. `oracleKind` was assumed at the time of this bullet's original writing to be what tells P7-2 which of the two a given case is; the Correction above shows that assumption doesn't hold for `checkout-applies-percent`. Nothing in the manifest stated the distinction more directly than that now-superseded inference, which is exactly the ambiguity a future P7-1 revision (or P7-2 itself) may want to make an explicit field rather than an inference from `oracleKind` — resolved by the bullet directly below.
  - **Resolved (follow-up change, branch `feat/corpus-expected-outcome`):** every case now also declares `operatorRole` (`'prescriptive'` | `'descriptive'`, explicit, required, structural — no longer inferred from `oracleKind`) and `expectedOutcome` (`'expected-to-fail'` | `'expected-to-keep-passing'`, a raw, oracle-kind-agnostic prediction of the base test's own pass/fail outcome under its declared oracle, quoting the tail of each case's own `productionEffect` claim). Both are required and validated exactly like `oracleKind`, closing this ambiguity without relying on `oracleKind` as a proxy. `expectedOutcome` is deliberately not a goodness signal: `spies-on-math-round` (`'descriptive'`, deliberately bad) predicts `'expected-to-fail'`, the same value the 3 `'prescriptive'` good controls predict, because a test that pins an implementation detail breaks on a behavior-preserving refactor for the wrong reason.
  - TDD: strict RED-implement-GREEN per module, observed directly (see this report's mutation-evidence log for exact commands/output). Adapter (`src/adapters/corpus-store.ts`) was genuinely test-first: `test/corpus-store.test.ts` (7 cases) written and run RED (`Cannot find module '../src/adapters/corpus-store.js'`) before the adapter existed; implemented once, GREEN on the first run. Domain module (`src/domain/corpus.ts`) was drafted first by mistake, caught before any test ran against it, moved out of `src/domain` so `test/corpus.test.ts` (26 cases) could be written and run genuinely RED against a missing module (`Cannot find module '../src/domain/corpus.js'`), then restored unmodified; GREEN on the first run after restoring (26/26) — disclosed here rather than described as clean test-first authorship it was not.
  - Mutation evidence (each: break, observed RED, restore, observed GREEN, confirmed byte-identical restore via `diff`). First attempt, disclosed rather than discarded: swapping the `operator` value directly between two of `test/corpus.test.ts`'s own `DISTINCT_FIXTURES` entries **stayed GREEN** — that fixture array is read for both the parser's input AND the test's expected value, so moving the two together proves nothing about the parser. Corrected to: (1) fed a hardcoded `operators: ['remove-assertion']` into every synthetic fixture's input JSON while leaving assertions pointed at each fixture's real operator (decoupling input from expectation) — 5/6 per-fixture assertions went RED, proving the parser threads the declared operator through rather than returning a constant; (2) removed the `operators.length !== 1` check — RED on both "rejects two operators" and "rejects no operators"; (3) removed the non-empty check shared by `testEffect`/`productionEffect` — RED on both; (4) removed the unknown-top-level-key rejection — RED on the `"proofStatus"` smuggling test; (5) removed the `..`/absolute-path rejection in `isSafeRelativePath` — RED on both the `testFile`- and `productionFiles`-escape tests; (6) removed `buildCorpusCase`'s declared-vs-received path cross-check — RED on all three of its mismatch tests; (7) in the adapter, removed the sorted-order sort before parsing — **stayed GREEN on this filesystem** (`readdir` already returns alphabetical order on this APFS volume in this test), so that specific test does not by itself pin ordering on every OS — the sort is still correct defense-in-depth (Node's `readdir` order is unspecified), but this is disclosed rather than claimed as proven-by-mutation; (8) removed the adapter's manifest-id-vs-directory-name check — RED; (9) swapped `operators` between two *real, Git-stored* `case.json` files (`exposes-checkout-helper` and `spies-on-math-round`), added first a dedicated assertion pinning every real case's operator and oracleKind (`test/corpus-store.test.ts`, "parses each real discrimination case with its own declared operator and oracleKind") — RED, then restored both files byte-identical (verified with `diff`) — GREEN.
  - Verification: `npx vitest run` 1020 passed across 38 files (987 baseline + 33 new: 26 + 7); `npm run typecheck` clean; `npm run lint` clean; `npm run build` clean; `git diff --check` clean. `test/evidence-resolution.test.ts` and `test/cli.test.ts` re-run in isolation, unchanged, 155/155 passed.
  - Files: `src/domain/corpus.ts` (+299), `src/adapters/corpus-store.ts` (+78), `src/index.ts` (+14, new exports only), `test/corpus.test.ts` (+246), `test/corpus-store.test.ts` (+158), `test/fixtures/corpus/discrimination/**` (33 files, +343 lines: 11×`case.json` + 11×`test.ts` + 10×`cart.ts` + 1×`audit-log.ts`), `docs/technical-design.md` (+8/-0), this file (+21/-5, net edits to the P7-1 task entry, Progress, and Slice ledger). Authored total ≈1,162 lines (`git diff --stat` on tracked files + `wc -l` on new files).
- [ ] **P7-2 — Prove each operator by execution**
  - Implement the oracle runner in a dedicated adapter that spawns a test runner against corpus fixtures only, reachable from an explicit benchmark command and never from `audit`.
  - Record each proof as data: which operator, which oracle, what was observed, and whether the expected effect held.
  - Verify: a case whose mutation does not produce its expected effect is reported unproven rather than silently counted; the audit path cannot reach the runner; the never-execute tests pass untouched; execution is bounded and cannot hang a run.
- [ ] **P7-3 — Persist benchmark runs and comparisons**
  - Add a separate benchmark database with its own migrations, storing runs, operator identities, oracle proofs, and per-case outcomes.
  - Compare two benchmark runs by fixture identity, reporting agreements, disagreements, and regressions.
  - Verify: a fresh database migrates from empty; the user's audit store is never touched; a comparison across differing rubric or policy versions is refused or clearly labelled rather than silently compared.
- [ ] **P7-4 — Report metrics per dimension and export JSONL**
  - Compute per-dimension precision, recall, false-positive rate, `needs-review` routing, probability calibration, run-to-run stability, cost, and latency, counting only proven cases.
  - Export benchmark data as JSONL behind an explicit path flag, mirroring how `--html` is gated.
  - Verify: a dimension with no proven case says so instead of reporting zero; unproven cases are excluded and counted separately; no file is written without the flag.

## Progress

- Current task: **P7-2 — not started** (P7-1 delivered, awaiting orchestrator review/commit on `feat/phase-7-corpus`).
- Completed tasks: **P7-1** (corpus format + parser + ported discrimination corpus; not yet committed — see P7-1's evidence bullet above).
- Running authored count: **≈1,162** (`git diff --stat` on tracked files: 38 lines across `src/index.ts`/`docs/technical-design.md`/this file, plus `wc -l` on the 6 untracked new source/test files: 781, plus the 33 untracked fixture files: 343), against a 4,500-line forecast (P7-1 only; nothing committed yet).
- Slice ledger: `feat/phase-7-corpus` (child of `feat/phase-7-benchmarks`, off `main`@`dd0b454`) — P7-1's uncommitted working-tree changes. No PR opened; no commit made, per this delegation's explicit instruction to leave commit/push/branch-switch to the orchestrator.

## Open questions carried forward

- Inherited and still open: `store.databasePath` and `ResolvedConfiguration.schedule` are reachable only programmatically, with no CLI flag.
- Inherited and still open: whether the gateway's `redact()` scrubs everything sensitive before an error message reaches a shareable file. Phase 6 proved hostile text cannot break the HTML page; it did not prove redaction is complete.
- Corpus size is a user decision and is deliberately deferred to P7-3, the first task that spends money.

## Next step

Delegate P7-1 on a child branch off `feat/phase-7-benchmarks` with strict TDD, then review, verify, and commit before opening P7-2.
