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

- [ ] **P7-1 — Store a fixture corpus with controlled operators**
  - Define the corpus format in Git: for each case, the base test, its production code, exactly one declared operator, and the operator's expected effect.
  - Implement the six operators as declarative specifications, not yet as executed mutations.
  - Supersede the intent-labelled discrimination fixture by expressing its cases in the new format, keeping the originals for comparison.
  - Verify: the corpus parses deterministically; a case declaring two operators or none is rejected; a declared expected effect is required; no provider call and no file write occur.
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

- Current task: **P7-1 — not started**.
- Completed tasks: none.
- Running authored count: **0**, against a 4,500-line forecast.
- Slice ledger: empty.

## Open questions carried forward

- Inherited and still open: `store.databasePath` and `ResolvedConfiguration.schedule` are reachable only programmatically, with no CLI flag.
- Inherited and still open: whether the gateway's `redact()` scrubs everything sensitive before an error message reaches a shareable file. Phase 6 proved hostile text cannot break the HTML page; it did not prove redaction is complete.
- Corpus size is a user decision and is deliberately deferred to P7-3, the first task that spends money.

## Next step

Delegate P7-1 on a child branch off `feat/phase-7-benchmarks` with strict TDD, then review, verify, and commit before opening P7-2.
