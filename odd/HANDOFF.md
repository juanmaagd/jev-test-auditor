# Handoff — jev-test-auditor

Written 2026-09-21 for whoever picks this up next, in a fresh session. Read this first, then `docs/implementation-plan.md`. Everything below was verified against the repository on the day it was written; verify anything you are about to rely on rather than trusting this file, because it ages.

## Where things stand

Seven of nine delivery phases are done. `docs/implementation-plan.md` is the authoritative plan and `README.md`'s delivery table mirrors it.

| Phase | State |
| --- | --- |
| 1 Foundation, 2 Test understanding, 3 Evidence, 4 Jev MVP, 5 Persistence, 6 Reporting | Complete, merged into `main` |
| 7 Deterministic benchmarks | Complete, **not merged** |
| 8 Benchmark-review skill | Not started |
| 9 Calibration and first release | Not started |

**Start from `main`.** Phase 7 was fast-forwarded into `main` on 2026-09-21, so `main` is at `3e97c53` and contains everything described here. The chain left several intermediate branches (`feat/phase-7-*`, `feat/corpus-expected-outcome`, `feat/metrics-*`); they are history, not work in progress, and you can ignore them. Nothing has ever been pushed and no pull request exists — there is no upstream configured, so pushing is a decision the user has not yet made.

The working tree carries one unstaged change to `.gitignore` that belongs to the user, not to any task. Leave it alone. The untracked `.atl/` directory is also the user's.

Suite: 1,163 tests across 51 files, all passing. `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` are all clean.

## What the tool does today

`audit` discovers and parses tests without executing anything, selects a minimal provenance-aware evidence bundle per test case, and prints a human-readable summary including a cost estimate. `--json` gives the machine shape. `--dry-run` gives the cost preview alone. `--evaluate` sends bundles to Jev, classifies non-compensatorily, persists to SQLite, and prints a versioned canonical JSON report with `--json`; `--html <path>` renders that report into one self-contained offline file and `--open` opens it. `--fresh` bypasses the cache, `--resume <runId>` continues an interrupted run. `auth login|status|logout` manages the API key.

`benchmark` is a separate CLI (`src/cli/benchmark.ts`, built to `dist/cli/benchmark.js`). It proves corpus cases by execution, and with `--store <path>` samples Jev and persists runs; `--metrics <ids>` reports per-dimension metrics and `--jsonl <path>` exports.

## The next work, in the order it makes sense

**1. Grow the benchmark corpus.** The benchmark corpus has reached the target ceiling of 70 cases (`test/fixtures/corpus/discrimination/*/`) covering all seven rubric dimensions with exactly 10 proven cases per dimension (37 descriptive cases and 33 prescriptive controls). Each dimension has robust representation, comfortably clearing `MIN_SAMPLE_FOR_RATE = 5` and doubling statistical power for Wilson confidence intervals. Precision, recall, false-positive rate, stability, and calibration metrics compute reliably across all seven dimensions. Target for Phase 9 calibration is fully satisfied.

Money is not the constraint. Measured: one corpus case costs roughly USD 0.00025–0.0008, so five hundred cases at twenty repetitions is under USD 8. Authoring effort and statistical validity are the constraints.

**2. Phase 8 — the benchmark-review skill.** `docs/implementation-plan.md:76`. A development-only skill, never a product runtime dependency. It shards selected benchmark cases across blind read-only subagents that see the test, minimal production context, rubric, and oracle proof but **not** Jev's verdict; their assessments are frozen before a comparison stage sees both. It records the comparison without promoting it to ground truth.

**3. Phase 9 — calibration and first release.** `docs/implementation-plan.md:84`. Run the baseline, publish per-dimension metrics, and replace `CLASSIFICATION_POLICY_V2`'s provisional thresholds (`applicabilityMin: 0.5`, `sideMin: 0.65`, `criticalMin: 0.5`, cut points `[1,2,3]`, `src/domain/classification.ts:238`) with evidence-backed ones. Per `docs/technical-design.md:156`, recalibration is a **new policy version** such as `CLASSIFICATION_POLICY_V3`, never a silent edit of a shipped constant. Also: privacy, CI artifacts, failure recovery, contribution docs, an open-source license, and re-checking npm and GitHub name availability immediately before publishing.

## Decisions already made — do not relitigate these

- **SQLite driver is the built-in `node:sqlite`**, not `better-sqlite3`. Keeps the package at zero runtime dependencies. This forced `engines.node` to `>=22.13.0`, the release that unflagged the module.
- **The HTML report is written only with an explicit `--html <path>`.** Emitting it unconditionally would turn "evaluate" into "write a file somewhere on your machine", which Phase 5 spent its whole scope preventing.
- **The report does not contain evidence fragment source content**, only provenance decisions and counts. The HTML is built to be handed to someone, and fragments are source code from the audited repository — embedding them means sharing a report silently shares the code. `--inspect-payloads` exists for deliberate local inspection.
- **The report version is its own thing**, independent of the store schema version, the rubric version, and the classification policy version. All four appear separately.
- **Benchmarks bypass the cache structurally**, not by flag: the sampling adapter never wires a store or cache-key port into `runAudit`, so no lookup path exists. The cache key is pure content addressing, so a cached judgment would return the first verdict ever recorded for those bytes — you would be measuring your cache, and run-to-run stability would be unmeasurable by construction.
- **Benchmark data lives in its own database**, never the user's audit store. Its meta table is named `benchmark_schema_meta`, and that distinct name is the mechanism that makes opening an audit store through the benchmark adapter fail as a foreign database rather than as a confusing version mismatch.
- **There is no `reports` table** and none is needed: the canonical report carries its own `runId`, which is what makes a report traceable to its run. `docs/implementation-plan.md` work unit 5 was corrected to say so.

## The guarantee that must never be weakened

The audit pipeline **never executes audited source, package scripts, test runners, or configuration modules**. It is stated in `README.md:21` and `:285`, embedded in the shipped HTML disclosure (`src/domain/html-report.ts`), and enforced by `test/evidence-resolution.test.ts:555` and `:571` — fixtures that throw if executed, asserted to have been resolved as evidence anyway — plus every `reportingOnly: true` assertion in `test/cli.test.ts`.

Phase 7 added the project's first process spawn, and bounded it rather than weakening the guarantee: benchmark execution runs only Git-stored corpus fixtures, from `src/adapters/oracle-runner.ts`, reachable only from `src/cli/benchmark.ts` and never from `audit`. That boundary is enforced by a static import-graph closure test (`test/benchmark-cli-boundary.test.ts`) with positive and negative controls. Mutations run on a scratch copy; the corpus is hash-checked byte-identical after every run.

If you extend benchmark execution, keep it on that side of the line, and keep the boundary test honest.

## How this project works

Every phase has a feature document under `odd/tasks/` carrying objective, authorized scope, constraints, decisions, acceptance criteria with evidence, a task ledger with commit hashes, and open questions. Read the one for whatever you are continuing. Phase 7's is `odd/tasks/phase-7-benchmarks.md`.

TDD is enabled and strict: observed RED before implementation, then GREEN, then refactor, with **critical mutation evidence** for every behavior — break it one way, confirm the suite turns red, restore. Vitest is the runner. Conventional Commits, no AI attribution.

## The lesson this codebase paid for, twice over

Across three phases, **more than ten tests were found that could not fail**. Not one was caught by reading code or by watching the suite go green. Every single one was caught by deliberately breaking the implementation and noticing the test did not care.

The shapes they took:

- Symmetric fixtures, where adjacent columns held the same value, so swapping them changed nothing.
- A test varying three things at once, so it could not fail if any one of them broke.
- Tests that could not discriminate the case they claimed to cover from its neighbour.
- Eight tests sharing one `rootDir` string — which let a **silent cross-repository corruption defect** survive a full review, because a test that never varies a value cannot detect that the value carries no meaning.
- A vacuous assertion defeated by Node's per-process warning deduplication.
- Optional chaining that turned "the thing did not exist" into a passing expectation.
- A golden that proved stability and never correctness.
- An assertion passing on a substring that also appeared in an unrelated part of the output — the embedded JSON's own key name.
- A canary paired with a stub that bypassed the code path the canary was meant to guard.
- Accuracy denominators counting repeated measurements of one case as independent samples, which printed `5/5 (100.0%)` from a single observation.

So: **verify a test by running it against a deliberately wrong implementation, not by observing that it passes.** Green does not mean it is watching. Green can mean it is not looking.

The same principle applies to the product's own output. A metric that cannot be wrong and a test that cannot fail are the same disease: both give confidence without giving information. That is why every rate in the benchmark report carries its sample count inseparably, and why a dimension with no proven case says so instead of reporting zero.

## Memory

Engram holds the durable record under these topic keys: `odd/phase-5-persistence/*`, `odd/phase-6-reporting/tasks`, `odd/phase-7-benchmarks/complete`, `odd/readable-audit-summary/findings`. Search before assuming something is new.
