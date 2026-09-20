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

- [ ] **P6-1 — Capture and persist per-request latency**
  - Measure wall-clock latency in the gateway around the whole call and per attempt, without changing timeout, abort, or backoff behavior.
  - Thread it through the evaluation result and persist it with a transactional v2-to-v3 migration.
  - Verify: a hand-built v2 database upgrades without losing a row; an unknown or newer version still fails with its named error; the dry run's read-only path still creates no file or sidecar; P5-3's throttle signal is unchanged.
- [ ] **P6-2 — Emit one versioned canonical JSON report**
  - Define the report envelope with an explicit report version, distinct from store schema, rubric, and policy versions, and publish its schema.
  - Expose discovery decisions, provenance, scores, probabilities, model and rubric versions, per-test-case cache status, usage, latency, and errors; mark an incomplete run as incomplete.
  - Verify: schema validation, a golden test for stable key order, a per-test-case cache-status test, an incomplete-run test, and that a `misleading` finding still exits 0.
- [ ] **P6-3 — Report progress during a run**
  - Attach a progress reporter to the existing checkpoint seam so per-item transitions, including cache hits, appear as they happen under concurrency.
  - Keep the domain free of I/O, and keep output sane when stdout is not a TTY.
  - Verify: progress reflects real transitions in completion order, a cache hit is distinguishable from a dispatch, and non-TTY output stays machine-safe and does not corrupt `--json`.
- [ ] **P6-4 — Render one self-contained offline HTML report**
  - Add `--html <path>` (requires `--evaluate`) and `--open` (requires `--html`), rendering the canonical JSON into one file with every style and script embedded.
  - Verify: no file without the flag and the Phase 5 no-write tests pass unchanged; the rendered file contains no external reference of any kind; it renders from a JSON file alone with no repository or database present.

## Progress

- Current task: **P6-1 — not started**.
- Completed tasks: none.
- Running authored count: **0**, against a 4,000-line forecast.
- Slice ledger: empty.

## Open questions carried forward

- Inherited from Phase 5 and still open: `store.databasePath` and `ResolvedConfiguration.schedule` are reachable only programmatically, with no CLI flag or configuration-file loader.
- Inherited from Phase 5 and still open: error messages now persist to disk, which raises the stakes on the gateway's existing `redact()`. The HTML report makes this sharper, because a persisted error message would now also be rendered into a shareable file.
- `docs/implementation-plan.md`'s work unit 5 lists a `reports` table that was never designed. This phase decides by evidence whether one is needed and updates that bullet either way, so the plan stops asserting something that does not exist.

## Next step

Delegate P6-1 on a child branch off `feat/phase-6-reporting` with strict TDD, then review, verify, and commit before opening P6-2.
