# Build Phase 8 benchmark-review skill

## Objective

Build the `jev-benchmark-review` development skill (`skills/jev-benchmark-review/SKILL.md`) to inspect immutable completed benchmark runs with lightweight read-only subagents, freeze blind assessments before comparing them with Jev results, and persist diagnostic classifications of discrepancies without promoting them to ground truth.

## Problem

Quantitative benchmark metrics from Phase 7 (precision, recall, Brier calibration, false-positive rate, stability) measure *that* a defect or disagreement occurred, but do not explain *why* Jev failed a specific case or whether the failure stemmed from model hallucination, rubric ambiguity, context truncation, or prompt confusion. Without a structured, double-blind review process, investigating disagreements suffers from confirmation bias (post-hoc rationalizing Jev's output) and risks polluting the deterministic oracle ground truth with subjective impressions.

## Why

Calibration and hardening in Phase 9 require evidence-backed insights into Jev's reasoning failures and borderline decisions to set optimal decision thresholds (`sideMin`, `criticalMin`, cut points). The review skill provides qualitative root-cause diagnosis for model errors and rubric ambiguities while strictly preserving the mechanical oracle as the sole source of ground truth.

## Authorized scope

1. Author the development skill specification at `skills/jev-benchmark-review/SKILL.md`.
2. Implement case selection and stratification from completed benchmark runs: filter by regressions, disagreements, or stratified per-dimension samples.
3. Implement blind worker payload generation: package base test code, production sources, rubric criteria, and deterministic oracle proofs into reviewer inputs, strictly excluding Jev's sample/verdict.
4. Implement blindness verification: structural/property tests ensuring zero leak of Jev's classification, scores, masses, or raw responses into reviewer payloads.
5. Implement structured reviewer assessment parsing, schema validation, and freezing.
6. Implement comparison and discrepancy classification: compare frozen assessments against Jev's verdicts and categorize discrepancies (`likely-model-error`, `rubric-ambiguity`, `context-selection-error`, `unsupported-disagreement`).
7. Persist review sessions, blind prompts, frozen findings, and discrepancy classifications in SQLite (migration v2 in `src/adapters/sqlite-benchmark-store.ts`).
8. Enforce architecture boundaries: static closure tests proving `src/cli/index.ts` never reaches the review skill or review persistence modules.

## Scope and constraints

- **The skill is a development tool, not a product runtime dependency.** Normal user audits (`audit`) do not invoke the review skill, do not require review dependencies, and never inherit its cost or latency.
- **Reviews never become ground truth.** Subagent or human judgments guide rubric refinement and threshold calibration, but never override an executable oracle proof.
- **The product never calls a secondary model via the CLI.** The review skill provides structured prompts and payload formatting for the surrounding agent runtime (Antigravity, Claude, Codex) to shard across subagents; the core codebase maintains zero external model API credentials beyond TypeSafe Jev.
- **Strict blindness is a hard invariant.** First-pass reviewers must never receive Jev's verdict, raw model answers, deficient mass, or classification level.
- **Domain stays pure.** `src/domain` modules have zero I/O, zero network, and zero process spawning.
- Conventional Commits without AI attribution. Preserve untracked `.atl/` and unstaged `.gitignore`.

## Decisions

- **Benchmark store schema migration v2 over a separate database:** Review runs belong conceptually with the benchmark runs they inspect. Adding schema version 2 to `sqlite-benchmark-store.ts` preserves WAL mode, transaction safety, and foreign database detection under `benchmark_schema_meta`.
- **Four-way discrepancy taxonomy:** Discrepancies between Jev and frozen blind assessments are categorized into exactly four mutually-exclusive buckets: `likely-model-error`, `rubric-ambiguity`, `context-selection-error`, and `unsupported-disagreement`.
- **Immutable input hashing:** Every review case record stores a SHA-256 hash of its blind input payload, ensuring auditability and replayability.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 1,800 authored lines across domain, store migration, tests, and skill documentation.
- Tracker boundary: `feat/phase-8-benchmark-review-skill`, based on `main` at `9b63f09`.
- Planned local child slices:
  1. `P8-1`: Domain review contracts, selection, blind payload generation, and discrepancy classification (`src/domain/benchmark-review.ts`).
  2. `P8-2`: Benchmark store migration v2 and review persistence port (`src/domain/benchmark-store.ts`, `src/adapters/sqlite-benchmark-store.ts`).
  3. `P8-3`: Application review orchestration and boundary tests (`src/application/benchmark-review.ts`, `test/benchmark-review-boundary.test.ts`).
  4. `P8-4`: Skill definition `skills/jev-benchmark-review/SKILL.md` and integration verification.
- Test runner: Vitest (Strict TDD: RED, GREEN, REFACTOR, mutation evidence).

## Primary references

- Implementation plan, work unit 8: `docs/implementation-plan.md:76`
- Technical design, "Benchmark agent-review skill": `docs/technical-design.md:396`
- PRD on benchmark review: `docs/PRD.md:148`

## Tasks

- [x] **P8-1 — Domain review contracts, blind payload generation, and discrepancy classification**
- [x] **P8-2 — Benchmark store schema v2 and persistence**
- [x] **P8-3 — Application review orchestration and boundary verification**
- [x] **P8-4 — Skill definition `skills/jev-benchmark-review/SKILL.md` and live verification**

## Outcome and Verification Summary

- **Skill registered**: `skills/jev-benchmark-review/SKILL.md` defines the end-to-end double-blind subagent review protocol.
- **Strict Blindness Invariant**: `assertPayloadIsBlind` structural assertion ensures zero Jev scores, confidence, masses, levels, or findings leak into reviewer payloads. Verified with unit and mutation testing.
- **Taxonomy of Discrepancies**: Fully implemented in `src/domain/benchmark-review.ts` and tested for `likely-model-error`, `unsupported-disagreement`, `rubric-ambiguity`, and `context-selection-error`.
- **Benchmark Store Schema v2**: Added `benchmark_review_runs` and `benchmark_review_cases` tables to `src/adapters/sqlite-benchmark-store.ts`, with migration v1 -> v2 and full transactional persistence.
- **Application Orchestration**: `src/application/benchmark-review.ts` provides `prepareReviewSession`, `recordWorkerAssessment`, and `completeReviewSession`.
- **Architectural Isolation**: `test/benchmark-review-boundary.test.ts` and `test/architecture-boundary.test.ts` prove static closure isolation — normal `audit` user CLI (`src/cli/index.ts`) has zero dependencies on review skill or review persistence modules.
- **Test Suite**: All 54 test files (1,181 tests) passing cleanly; `npm run typecheck` and `npm run lint` clean.
