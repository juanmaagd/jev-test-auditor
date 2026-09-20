# Build Phase 5 persistence, caching, and resilient scheduling

## Objective

Make an audit run durable and repeatable: persist immutable runs, work items, attempts, judgments, and usage in SQLite; derive a complete content-addressed cache key so an unchanged test is never paid for twice; and replace the fixed bounded pool with checkpointed scheduling that throttles under provider pressure and resumes an interrupted run by its run id.

## Problem

Phase 4 delivered the first end-to-end MVP, but every result is in-memory only. `runBoundedPool` (`src/application/audit.ts:48`) dispatches evaluations with a fixed concurrency and returns `{ kind: 'success' | 'failure' }` outcomes that are never written anywhere, so a killed process loses the whole run and a re-run re-bills every test case. `hashEvidenceBundle` (`src/adapters/evidence-hash.ts:11`) exists with a doc comment reserving it for Phase 5 caching and has zero production call sites. The dry-run estimator counts every evaluable test as billable (`src/domain/estimate.ts:246`), which the technical design already acknowledges as provisional.

## Why

The first real run measured roughly 72k input tokens for 11 test cases. Without a cache, auditing a real repository repeatedly is both slow and paid for from scratch every time, and any interruption throws away completed judgments that are already immutable facts. Persistence is also the precondition for Phase 6 report manifests and Phase 7 benchmark history.

## Authorized scope

- Add a domain store port and a `node:sqlite` adapter with versioned, transactional migrations.
- Persist immutable runs, work items with terminal states, attempts, raw answers, normalized judgments, usage, and errors.
- Implement the complete content-addressed cache key over normalized test source, evidence bundle, rubric/questions, exact model id, and policy-relevant request options; add `--fresh`.
- Replace the fixed bounded pool with a scheduler that observes request/token budgets, reduces concurrency under provider throttling, restores it after successful windows, and commits each terminal work-item state immediately.
- Add `--resume <runId>` so an interrupted run continues without duplicating or losing completed work.
- Feed cache-hit and billable-request counts into the dry-run estimate.
- Update README and technical design for delivered behavior.
- Do not implement HTML reports, `--open`, report manifests beyond what persistence needs, benchmarks, operators, oracles, the benchmark-review skill, calibrated thresholds, or other languages.

## Scope and constraints

- SQLite driver is the built-in `node:sqlite` (user decision, 2026-09-20). It keeps the package at zero runtime dependencies, which is the posture `package.json` has today. `better-sqlite3` was considered and declined because it would add the project's first native dependency and a compile/prebuild step to a published CLI.
- `node:sqlite` was unflagged in Node **v22.13.0** (2025-01-07, commit `55239a48b6`, PR #55890), so `engines.node` moves from `>=22.12.0` to `>=22.13.0`. Verified against the Node 22.13.0 release notes, not from memory.
- The module is Stability 1.2 (release candidate) and emits an `ExperimentalWarning` on use. Suppress that one warning narrowly at the adapter boundary; never install a blanket warning filter that would hide unrelated Node warnings.
- Use `DatabaseSync` with prepared statements and `STRICT` tables. Statements are finalized; writes run inside transactions.
- Persistence is append-only. `--fresh` bypasses cache lookup but still writes a new immutable result; it never mutates or deletes a prior judgment.
- The cache key must include the rubric version. Rubric v2 rewrote the applicability questions, so a key that omits it would serve pre-v2 judgments for post-v2 questions. This is a required test, not a note.
- The gateway keeps its own per-call timeout, abort, and 429/529 backoff (`src/adapters/jev-http-gateway.ts:144`). Phase 5 scheduling wraps the outer dispatch loop in `runEvaluation`; it does not reimplement or bypass gateway retry.
- The store is opt-in and constructed lazily, following the `--evaluate` gateway pattern (`src/cli/index.ts:556`). An offline audit without evaluation must not create or open a database file.
- A corrupt or schema-incompatible store fails visibly with a named error; it is never silently recreated or migrated backwards.
- Never execute audited code. The database lives outside the audited repository's source tree and never contains the API key.
- Artifacts use English. Preserve unrelated untracked `.atl/` files. Conventional Commits without AI attribution.

## Decisions

- Cache key basis: `sha256` over a canonical serialization that already exists — `canonicalizeJevRequest` (`src/domain/jev-request.ts:369`) deterministically serializes `{ state, model, questions }`, where state derives from the evidence bundle and test case, model is the pinned `jev-1.13.0`, and questions come from `RUBRIC_V2`. The key adds the normalized full test source hash, the rubric version, and the classification policy version on top of that serialization, so a policy or rubric change invalidates cleanly.
- Work-item states are the design's seven: `pending`, `running`, `completed`, `cached`, `uncertain`, `skipped`, `failed`. Only `completed` and valid `cached` judgments participate in quality classification.
- Store port lives in `src/domain/audit.ts` beside `AuditEvidencePort` and `AuditEvaluationPort`, as an optional `store?:` field on `AuditPorts`, wired in `createProductionPorts` (`src/cli/index.ts:142`). The domain never imports the adapter.
- Adaptive throttling is derived from observed provider responses (429/529 and `retry-after`), not from a wall-clock heuristic, and never exceeds the configured `concurrency` ceiling.
- `--resume <runId>` parses like `--rootDir` (consumes the next argument); `--fresh` parses like `--evaluate` (boolean). Both are rejected without `--evaluate`.
- Database location defaults under the per-user config home already used by auth storage, not inside the audited repository, and is overridable by configuration.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 3,000 authored changed lines, generated files excluded. Phase 3 overran roughly fourfold and Phase 4 overran roughly 3.6x (7,267 against 2,000), so treat this as a floor, not a budget.
- Chain strategy: cached `feature-branch-chain`.
- Tracker boundary: `feat/phase-5-persistence`, based on `main` at `6e76d25`.
- Planned local child slices: store and migrations, cache key and `--fresh`, resilient scheduling, resume, cache-aware estimation.
- Remote tracker/child pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged (`gentle-ai review mode status`, decided by global, read 2026-09-20).
- TDD: enabled by explicit user confirmation (carried forward); require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.

## Primary references

- `node:sqlite` API: <https://nodejs.org/api/sqlite.html>
- Node 22.13.0 release notes (sqlite unflag): <https://nodejs.org/en/blog/release/v22.13.0>
- Technical design, "Persistence and cache" and "Scheduling and recovery": `docs/technical-design.md:165`
- Implementation plan, work unit 5: `docs/implementation-plan.md:55`

## Acceptance criteria

- Migrations create the schema from empty, are idempotent on re-open, run in a transaction, and a store at an unknown or newer schema version fails with a named, visible error.
- Two consecutive evaluations of an unchanged repository issue provider requests only on the first; the second reports every test case as `cached` with the same judgments.
- Changing the rubric version, the model id, the classification policy version, the test source, or any evidence fragment invalidates the key and forces a new request. Each of those five inputs has its own test.
- `--fresh` issues new requests despite a warm cache and appends a new immutable result without altering the prior one.
- An evaluation interrupted mid-run leaves every already-terminal work item committed; `--resume <runId>` completes only the outstanding items and duplicates none.
- Provider throttling lowers effective concurrency and a clean window restores it, never above the configured ceiling.
- `audit --dry-run` reports cache hits and billable requests separately, and its billable count matches what a subsequent real run actually issues.
- An offline audit without `--evaluate` creates no database file.
- No `ExperimentalWarning` reaches the CLI output, and unrelated Node warnings still do.

## Tasks

- [ ] **P5-1 — Persist runs and judgments in SQLite behind a port**
  - Define the store port in the domain, implement the `node:sqlite` adapter with versioned transactional migrations, and wire it lazily from the CLI.
  - Persist runs, work items with terminal states, attempts, raw answers, normalized judgments, usage, and errors as append-only records.
  - Bump `engines.node` to `>=22.13.0` and suppress only the sqlite `ExperimentalWarning`.
  - Verify: migration from empty, idempotent re-open, incompatible-version failure, transaction rollback on a mid-write error, no database file without `--evaluate`, and that no secret is ever stored.
- [ ] **P5-2 — Key, store, and reuse judgments by content**
  - Compose the complete cache key over normalized test source, evidence bundle, canonical request serialization, rubric version, model id, and classification policy version.
  - Look up before dispatch, record `cached` work items, and add `--fresh` as an append-only bypass.
  - Verify: warm-cache reuse, one invalidation test per key input, `--fresh` appends without mutating, and a pre-v2 rubric judgment never serves a v2 question set.
- [ ] **P5-3 — Schedule evaluations with adaptive throttling and checkpoints**
  - Replace `runBoundedPool` in the evaluation path with a scheduler that commits each terminal work-item state immediately and observes request and token budgets.
  - Reduce concurrency on provider throttling and restore it after successful windows, never above the configured ceiling; keep gateway-level retry untouched.
  - Verify: a stubbed gateway that returns 429 lowers concurrency, a clean window restores it, and every terminal state is committed before the next item starts.
- [ ] **P5-4 — Resume an interrupted run by run id**
  - Add `--resume <runId>`, reload outstanding work items from the store, and complete only those.
  - Verify: a gateway fake that throws mid-run leaves completed work committed; resuming issues requests only for outstanding items, duplicates none, and produces the same final report as an uninterrupted run.
- [ ] **P5-5 — Make the dry-run estimate cache-aware**
  - Feed per-test-case cache-hit lookups into `estimateDryRun` so `initialCalls`, estimated tokens, and estimated cost count only billable requests.
  - Verify: cold estimate unchanged from today, warm estimate reports hits and a reduced billable count, and the billable count equals the requests a following real run issues.

## Progress

- Current task: **P5-1 — not started**.
- Completed tasks: none.
- Running authored count: **0**, against a 3,000-line forecast.
- Slice ledger: empty.

## Next step

Delegate P5-1 on a child branch off `feat/phase-5-persistence` with strict TDD, then review, verify, and commit before opening P5-2.
