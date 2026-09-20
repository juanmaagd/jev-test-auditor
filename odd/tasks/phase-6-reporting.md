# Build Phase 6 audit reports

## Objective

Turn the audit's in-memory result into a report a human and a machine can both trust: capture per-request latency, emit one versioned canonical JSON report that exposes every decision the run made, show progress while a long run is in flight, and render one self-contained offline HTML file from that same JSON.

## Problem

Phase 5 made runs durable and cheap to repeat, but the output is still ad-hoc terminal text. `evaluateJsonLine` (`src/cli/index.ts:416`) is the richest shape the CLI produces and it is not a report: it carries no version envelope, it is not self-describing, and nothing validates it. A long `--evaluate` run prints nothing until it finishes, so an audit of a real repository looks hung. Latency is captured nowhere at all — not in the gateway (`src/adapters/jev-http-gateway.ts:144`), not in the `attempts` table (`src/adapters/sqlite-audit-store.ts:198`), not in any result type — even though the technical design lists it as something both reports must expose. Cache status exists only as a run-level count, never per test case.

## Why

The JSON report is the contract every later phase reads: Phase 7's benchmarks compare runs, and the HTML renderer is defined as embedding that exact JSON. Versioning it now, before anything consumes it, is far cheaper than versioning it after. Progress matters because the first real run took roughly 1.9 seconds for 11 test cases at concurrency 4 — a repository with thousands will run long enough that silence reads as failure.

## Authorized scope

- Capture per-request wall-clock latency in the gateway, persist it, and surface it.
- Emit one versioned canonical JSON report with a stable schema, replacing ad-hoc `--evaluate --json` output as the canonical machine shape.
- Thread per-test-case cache status and incomplete-run visibility into that report.
- Report progress to the terminal during a run, through the existing checkpoint seam.
- Render one self-contained offline HTML file from the canonical JSON, written only on explicit request, and support `--open`.
- Update README and technical design for delivered behavior.
- Do not implement benchmarks, operators, oracles, the benchmark-review skill, calibrated thresholds, hosted dashboards, or other languages.

## Scope and constraints

- **The HTML report is written only with an explicit `--html <path>` (user decision, 2026-09-20).** Without that flag the tool writes no file. This preserves both Phase 5 guarantees exactly as they stand — an audit without `--evaluate` creates no database file or config directory, and `--dry-run` writes nothing to disk — so their existing tests (`test/cli.test.ts:2203`, `:1407`, `:600`) must keep passing unchanged. Emitting HTML unconditionally was considered and declined: it would turn "evaluate" into "write a file somewhere on your machine", which is precisely what Phase 5 spent its whole scope guaranteeing does not happen unasked.
- `--html <path>` parses like `--rootDir` (consumes the next argument) and requires `--evaluate`, mirroring the existing mutual-exclusion checks in `parseAuditOptions` (`src/cli/index.ts:342`). It is rejected with `--dry-run` and `--inspect-payloads`.
- `--open` requires `--html`; it opens the file that was just written and never anything else. Launching a viewer is a visible side effect of an explicit request, never a default.
- The HTML file is genuinely self-contained: the canonical JSON and every style and script are embedded. No CDN, no network fetch at render or at view time, no external asset. This keeps the project's zero-runtime-dependency posture and means the file still works on a machine with no internet.
- Reporting-only exit behavior is preserved and must stay proven: no finding and no infrastructure failure changes the exit status. `test/cli.test.ts:1232` already proves a `misleading` classification exits 0 — that test must keep passing.
- Latency capture must not change the gateway's existing timeout, abort, or 429/529 backoff behavior (`src/adapters/jev-http-gateway.ts:144`), and must not become a new throttle signal; P5-3's signal stays exactly as it is.
- Persisting latency changes the store schema, so it is a v2-to-v3 migration under Phase 5's existing rules: transactional, forward-only, idempotent on re-open, and a store at an unknown or newer version still fails with its named error. A v2 database must upgrade without losing a row, proven by a hand-built v2 fixture rather than only by fresh creation.
- The dry run's read-only store access must keep creating no file and no sidecar. If the v3 migration would be required to read a v2 store, a dry run must degrade to the existing disclosed "not consulted" path rather than migrating.
- Never execute audited code. The report never contains the API key, and evidence excerpts in the HTML follow the same provenance and truncation rules the bundle already applies.
- Artifacts use English. Preserve unrelated untracked `.atl/` files. Conventional Commits without AI attribution.

## Decisions

- The canonical JSON report gets an explicit top-level report version, independent of the store's internal schema version, the rubric version, and the classification policy version. Those three already exist and mean different things; conflating them would make the report lie about what changed.
- The HTML renderer consumes the canonical JSON and nothing else. It must be possible to render a report from a JSON file alone, with no repository and no database present, because that is what makes the file a real artifact rather than a view.
- Progress attaches at the `recordWorkItem` checkpoint seam (`src/application/audit.ts:365`, `:371`, `:386`, `:403`, `:416`), which already fires on every per-item state transition in real completion order. The domain stays free of I/O.
- Latency is wall-clock measured at the gateway around the whole call including its internal retries, and also reported per attempt where the gateway already distinguishes them, so a slow run can be told apart from a throttled one.
- Whether to persist a report manifest is decided by evidence, not by the plan's one-line mention: a report is regenerable from `loadRunState`, so a `reports` table is added only if something concrete needs to look a report up. This closes the gap left by Phase 5, where `docs/implementation-plan.md`'s work unit 5 lists a `reports` table that was never designed anywhere.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 4,000 authored changed lines, generated files excluded. Phase 3 overran roughly fourfold, Phase 4 roughly 3.6x, and Phase 5 delivered about 8,100 against a 3,000-line forecast — treat this as a floor, not a budget.
- Chain strategy: cached `feature-branch-chain`.
- Tracker boundary: `feat/phase-6-reporting`, based on `main` at `a92b4dd`.
- Planned local child slices: latency capture, canonical JSON report, terminal progress, HTML renderer.
- Remote tracker/child pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged.
- TDD: enabled by explicit user confirmation (carried forward); require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.

## Primary references

- Implementation plan, work unit 6: `docs/implementation-plan.md:62`
- Technical design, "Reports": `docs/technical-design.md:273`
- Phase 5 feature document, for the guarantees this phase must not break: `odd/tasks/phase-5-persistence.md`

## Acceptance criteria

- The canonical JSON report carries an explicit report version, validates against its own published schema, and has a stable key order proven by a golden test.
- The report exposes every datum the technical design names: discovery decisions, payload provenance, scores, probabilities, model and rubric versions, per-test-case cache status, usage, latency, and errors.
- An incomplete run is visible as incomplete in the report, never silently presented as a finished one.
- A `misleading` finding still exits 0, and so does an infrastructure failure; the existing proof of this keeps passing.
- Progress appears during a run and reflects real per-item state transitions, including cache hits, under concurrency.
- Without `--html`, no file is written; the Phase 5 no-write tests pass unchanged.
- `--html <path>` writes one file that opens with no network access and embeds its own JSON, styles, and scripts.
- The HTML report renders from a canonical JSON file alone, with no repository and no database present.
- A hand-built v2 database upgrades to v3 without losing a row, and a v3 store still refuses an unknown or newer version with its named error.

## Tasks

- [x] **P6-1 — Capture and persist per-request latency**
  - Measure wall-clock latency in the gateway around the whole call and per attempt, without changing timeout, abort, or backoff behavior.
  - Thread it through the evaluation result and persist it with a transactional v2-to-v3 migration.
  - Verify: a hand-built v2 database upgrades without losing a row; an unknown or newer version still fails with its named error; the dry run's read-only path still creates no file or sidecar; P5-3's throttle signal is unchanged.
  - Evidence: `ba799f7` (`feat: capture and persist per-request latency`) on `feat/phase-6-latency`, off `feat/phase-6-reporting`. 6 files, 359 insertions / 15 deletions. Suite 29 files/855 tests (850 on `main` before this phase), typecheck, lint, build, and diff check passed. Schema version 3 adds two nullable columns to `attempts`: `latency_ms`, the whole-call wall-clock total including every internal retry and the backoff wait between attempts, and `attempt_latencies_ms`, that same evaluation's per-attempt breakdown. Both are nullable deliberately, so a row recorded before this migration reads as "never captured" rather than as a fabricated zero — the migration never backfills. Latency rides on `JevEvaluation` itself, which is why no change was needed in `src/adapters/jev-evaluation-port.ts`, `src/application/audit.ts`, or `src/domain/audit.ts`: `runEvaluation` already passes the whole evaluation object to `recordWorkItem` (`src/application/audit.ts:407`), so the new fields reach the store by travelling inside it.
  - Orchestrator spot checks, run independently. The delegated worker's runtime stalled before it could update this document, so the tree was assessed directly rather than trusted from a report: 855 tests, typecheck, lint, build, and diff check all clean. The absence of the application and port files from the diff was investigated rather than assumed to be a gap, and traced to the whole-object hand-off at `audit.ts:407`. The specific risk named when delegating this task — that a new numeric column sits directly beside `attempts`, `input_tokens`, and `output_tokens`, which is exactly the adjacency P5-1's original swap-blind defect lived in — was tested by hand: swapping `output_tokens` with `latency_ms` in the insert turned 5 tests RED, including `expected 8642 to be 47`, a latency value landing in the token column. The non-symmetric fixtures did their job. The v2-to-v3 upgrade is proven by a hand-built v2 database (`test/sqlite-audit-store.test.ts:300`), not only by fresh creation.
  - Delivered by a worker whose runtime stalled at the documentation step; the implementation and its tests were already complete and verified in the tree, so the task was finished rather than restarted. This is recorded because the failure was the client runtime's, not the task's, and the distinction matters when reading this ledger later.
- [x] **P6-2 — Emit one versioned canonical JSON report**
  - Define the report envelope with an explicit report version, distinct from store schema, rubric, and policy versions, and publish its schema.
  - Expose discovery decisions, provenance, scores, probabilities, model and rubric versions, per-test-case cache status, usage, latency, and errors; mark an incomplete run as incomplete.
  - Verify: schema validation, a golden test for stable key order, a per-test-case cache-status test, an incomplete-run test, and that a `misleading` finding still exits 0.
  - Committed as `002e938` (`feat: emit one versioned canonical json report`).
  - Orchestrator spot checks, run independently of the writer. The key-order trap named when delegating this task was tested by hand: swapping `reportVersion` and `rootDir` in the builder turned 3 golden tests RED, so the golden genuinely enforces the contract rather than merely recording whatever the implementation produced. The published schema's required fields were read back directly and cover every datum the technical design names.
  - A test-suite defect was found during review and fixed in `14d6515`, separately from this task's own work. The key-safety test at `test/cli.test.ts:782` called `runCli(['audit', '--evaluate'])` with no `--rootDir`, so it audited the working directory — this repository itself. Its cost therefore grew with our own test suite: discovery, extraction, evidence selection, and since P5-3 three persisted checkpoints for every test case this project has. Measured in isolation it took 3.33 seconds against a 5,000 ms timeout, already two thirds of the budget with no contention, and it failed intermittently under load. P5-3 had hit this same test once and bought time with WAL; it returned as soon as the suite grew again. The test's actual claim is about key resolution, and auditing the repository was incidental to it, so it now audits a one-file fixture: 3.33 s became 25 ms. Reported honestly: the delegated worker had characterized this as a pre-existing unrelated flake, which understated it — the test was a timer this phase kept winding. Equally honestly, several other scattered failures observed during review were self-inflicted, caused by running two full suites concurrently on the same machine, and could not be reproduced once runs were serialized; five consecutive clean full-suite runs followed the fix.
  - Evidence: on `feat/phase-6-canonical-report`, off `feat/phase-6-latency`. 11 authored files (`docs/report-schema.json` generated, excluded from the count): `src/domain/report.ts` (new, `buildAuditReport`), `src/domain/report-schema.ts` (new, hand-rolled validator + `REPORT_JSON_SCHEMA`), `src/domain/audit.ts` (`TestCaseCacheStatus`/`TestCaseLatency`, `AuditEvaluationResult.cacheStatusByTestCaseId`/`.latencyByTestCaseId`, `EMPTY_AUDIT_EVALUATION_TOTALS`), `src/application/audit.ts` (`runEvaluation` populates the two new maps in its existing outcome-aggregation pass), `src/adapters/sqlite-audit-store.ts` (`AUDIT_STORE_SCHEMA_VERSION` export), `src/cli/index.ts` (`evaluateJsonLine` now calls `buildAuditReport`), plus `README.md`/`docs/technical-design.md` and three test files. 1,507 insertions / 119 deletions (authored; `docs/report-schema.json`'s 757 lines are generated from `REPORT_JSON_SCHEMA`, not hand-authored). Suite 30 files / 874 tests (up from 855 baseline: +1 application-layer cache-status/latency test in `test/audit.test.ts`, +16 new tests in the new `test/report.test.ts`, +2 new CLI-level tests in `test/cli.test.ts` — the two pre-existing goldens were updated in place, not added), typecheck, lint, build, and diff-check all passed.
  - **Report envelope**: `{ reportVersion, rootDir, reportingOnly, complete, incompleteReason?, versions: { storeSchema, rubric, policy }, modelRequested, discovery: { files, excluded, totals }, totals, latency, cacheStatus, classifications, diagnostics, resume? }`, built by `buildAuditReport(result, context)` — a pure domain function over `AuditResult` plus a small `AuditReportContext` of build-time constants (model/rubric/policy pins, store schema version) the CLI supplies. `reportVersion` (1) is independent of `versions.storeSchema`/`.rubric`/`.policy` and of each classification's own `rubricVersion`/`policyVersion`.
  - **Incomplete, precisely**: `complete: false` if and only if `result.evaluation === undefined` — in production, only when discovery failed before evaluation ever started. A failed work item, a resumed run (already fully resolved by the time `runAudit` returns — `runEvaluation` drives every outstanding item to terminal first), a model-pin mismatch, and a `needs-review` verdict are all deliberately NOT incompleteness — each is already a fully-disclosed per-test or per-run-summary outcome elsewhere in the same report. Proven both at the domain level (`test/report.test.ts`) and through the CLI's real `runAudit` pipeline with a throwing discovery port (`test/cli.test.ts`), asserting exit code 0 either way — the hard "no infrastructure failure changes the exit status" constraint holds for an incomplete run too.
  - **Per-test-case cache status**: three states — `cached` (served from the content-addressed cache), `fresh` (a genuinely new provider request this run), `not-evaluated` (dispatched but failed) — computed in `runEvaluation`'s existing outcome-aggregation loop (never a second traversal) and returned as `AuditEvaluationResult.cacheStatusByTestCaseId`. Skipped test cases never appear (caching is not a meaningful question for them — already covered by `totals.skipped`). The report's `cacheStatus` array walks `result.files`' own deterministic order (not the map's incidental insertion order); each `classifications[]` entry also carries a `cache` field (`cached`/`fresh` only — a `not-evaluated` item never produced a classification).
  - **Latency threading**: `AuditEvaluationResult.latencyByTestCaseId` (new), populated only for a genuinely fresh, successfully measured dispatch — never for a cache hit or a failure. The report's top-level `latency` aggregate (`measuredTestCases`, `totalMs`/`meanMs`/`minMs`/`maxMs`) omits the four statistics entirely when nothing was measured; each classification's own `latency` field mirrors `TestCaseLatency` when present.
  - **Schema validation without a runtime dependency**: chose a hand-rolled structural validator (`src/domain/report-schema.ts`, supporting the `type`/`enum`/`properties`/`required`/`additionalProperties`/`items` subset of JSON Schema) over a dev-only `ajv`, since the shape being validated is fixed and internally produced — no need for a general-purpose engine. `docs/report-schema.json` is generated from the in-code `REPORT_JSON_SCHEMA` constant; `test/report.test.ts` asserts the two stay byte-identical (mutation-tested: deleting a property from the published copy turns that test RED).
  - **Golden tests deliberately changed**: both pre-existing `--evaluate --json` golden tests in `test/cli.test.ts` (the single-not-applicable-dimension case and the mixed misleading/healthy case) were updated to the new envelope — an intentional, documented breaking change to `--evaluate --json`'s shape, per this task's own Decisions, never loosened to a substring match. A third golden was added (`threads a measured latency end to end...`) specifically because neither pre-existing fixture's gateway stub ever set `latencyMs`/`attemptLatenciesMs`, so updating them alone would prove nothing about the latency path.
  - **Mutation evidence** (each: broken, confirmed RED, restored, confirmed GREEN): (1) key-order — swapped `totals`/`latency` insertion order in `buildAuditReport`, turned the golden key-order test RED; (2) incomplete detection — forced `incompleteReasonFor` to always return `undefined`, turned both incomplete-run tests RED; (3) cache-status swap — swapped the `'fresh'`/`'cached'` literals in `runEvaluation`'s two assignment sites, turned the dedicated `test/audit.test.ts` cache-status test RED; (4) the specific latency/token adjacency warned about — substituted `classification.usage.inputTokens` for the real `latencyMs` when attaching a classification's `latency`, turned both the golden test and the dedicated latency test RED; (5) schema-sync — deleted `reportVersion` from the published `docs/report-schema.json`, turned the sync test RED.
  - **Decision gaps returned to the orchestrator** (not resolved here): whether payload provenance should also expose evidence fragment *content* (currently only denial/unresolved/omission decisions and counts — fragment text stays out, same open redaction question already flagged for persisted error messages); whether a fresh (non-resumed) run's `runId` should be threaded onto `AuditResult`/the report so a report can be looked up again without a `reports` table (currently it cannot — the Phase 5 implementation-plan gap stays open).
- [ ] **P6-2b — Carry the run id in the report**
  - Thread a fresh run's `runId` through `AuditResult` so the canonical report identifies the persisted run it came from, not only a resumed one.
  - Update the published schema, the goldens, and the documentation deliberately; record that this closes the `reports` table question with no table.
  - Verify: a fresh run's report carries the id the store actually recorded, a resumed run's stays consistent with `resume.runId`, and a run with no store still produces a valid report without one.
- [ ] **P6-3 — Report progress during a run**
  - Attach a progress reporter to the existing checkpoint seam so per-item transitions, including cache hits, appear as they happen under concurrency.
  - Keep the domain free of I/O, and keep output sane when stdout is not a TTY.
  - Verify: progress reflects real transitions in completion order, a cache hit is distinguishable from a dispatch, and non-TTY output stays machine-safe and does not corrupt `--json`.
- [ ] **P6-4 — Render one self-contained offline HTML report**
  - Add `--html <path>` (requires `--evaluate`) and `--open` (requires `--html`), rendering the canonical JSON into one file with every style and script embedded.
  - Verify: no file without the flag and the Phase 5 no-write tests pass unchanged; the rendered file contains no external reference of any kind; it renders from a JSON file alone with no repository or database present.

## Progress

- Current task: **P6-2b — not started**.
- Completed tasks: **P6-1, P6-2**.
- Running authored count: **2,000** (374 + 1,626), against a 4,000-line forecast.
- Slice ledger:
  - `feat/phase-6-latency`: `ba799f7` — whole-call and per-attempt wall-clock latency in the gateway, carried on `JevEvaluation`, persisted by schema version 3's two nullable `attempts` columns.
  - `feat/phase-6-canonical-report` (off `feat/phase-6-latency`; not yet committed — left in the tree for the orchestrator to review and commit): the versioned canonical JSON report (`buildAuditReport`, `src/domain/report.ts`), per-test-case cache status and latency threaded onto `AuditEvaluationResult`, incomplete-run visibility, and a hand-rolled schema validator with a published `docs/report-schema.json`.

## What P6-2 can now read

`JevEvaluation.latencyMs` (whole call, retries and backoff included) and `JevEvaluation.attemptLatenciesMs` (per HTTP attempt, backoff excluded), both optional — absent means never captured, never zero. Persisted as `attempts.latency_ms` and `attempts.attempt_latencies_ms`, and reconstructed by `loadRunState` without fabricating a value for a pre-P6-1 row.

## What P6-3 and P6-4 can now read

- **P6-3 (terminal progress)** can attach at the same `recordWorkItem` checkpoint seam P6-2 left untouched (`src/application/audit.ts:370`, `:403`, `:416`+ — `pending`/`running`/terminal writes); P6-2 added no new I/O to that seam, and the new `cacheStatusByTestCaseId`/`latencyByTestCaseId` maps are built entirely from the existing `outcomes` pass, not from a new dispatch-time hook, so a progress reporter has nothing new to wire around.
- **P6-4 (HTML renderer)** can render from `buildAuditReport`'s output alone (a parsed JSON file, no repository, no database) — see `docs/technical-design.md`'s "Reports" section, "What P6-4 can now rely on," for the exact list of what the JSON carries and the two things it deliberately does not (fragment content; a durable run id).

## Open questions carried forward

- Inherited from Phase 5 and still open: `store.databasePath` and `ResolvedConfiguration.schedule` are reachable only programmatically, with no CLI flag or configuration-file loader.
- Inherited from Phase 5 and still open: error messages now persist to disk, which raises the stakes on the gateway's existing `redact()`. The HTML report makes this sharper, because a persisted error message would now also be rendered into a shareable file.
- `docs/implementation-plan.md`'s work unit 5 lists a `reports` table that was never designed. P6-2 still decides against building one now (no concrete lookup-by-id need yet — see this task's own "Decision gaps returned to the orchestrator"), so the plan bullet stays open rather than resolved.
- Resolved by the orchestrator, not left open: the report does **not** expose evidence fragment source content, only the provenance decisions and counts it already carries. The reason is not convenience, it is exposure. The HTML report is an artifact built to be handed to someone else, and fragment content is source code from the audited repository; embedding it by default would mean sharing a report silently shares the code it was derived from. Phase 5 spent its entire scope establishing that nothing leaves the machine unless explicitly asked for, and `--inspect-payloads` already exists precisely so fragment content can be inspected locally and deliberately. If a future phase wants content inside a report it must be an explicit opt-in flag, and it must be obvious in the output that the file now contains source.
- Resolved by the orchestrator, not left open: a fresh run's `runId` **should** reach the report. It makes the report traceable to the persisted run that produced it, which is what Phase 7's benchmark comparisons need, and it lets a reader correlate a report with `--resume` and with the store without a manifest table. It also settles the `reports` table question by evidence rather than by the plan's one-line mention: with the run id in the report, nothing concrete needs a lookup table, so none is built. Scheduled as P6-2b below.

## Next step

Delegate P6-3 (terminal progress during a run) on a child branch off `feat/phase-6-canonical-report` once it is reviewed and committed. It attaches to the existing `recordWorkItem` checkpoint seam — see "What P6-3 and P6-4 can now read" above.
