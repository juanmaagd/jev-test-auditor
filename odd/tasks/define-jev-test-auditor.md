# Define the Jev test auditor

## Objective

Turn the validated product decisions into an engineering-ready PRD, technical design, and implementation plan for an open-source semantic test linter powered by Jev.

## Problem

Agent-written tests can increase coverage without reliably detecting broken behavior. The project needs a focused tool that audits existing Jest and Vitest tests, explains weaknesses with evidence, and scales to large repositories through cheap parallel judgments.

## Why

The repository is empty and the product boundaries currently exist only in conversation. Durable documents are needed before implementation so product intent, evaluation policy, and architecture do not drift.

## Authorized scope

- Create planning and architecture documentation only.
- Initialize local project documentation structure and record decisions.
- Do not implement the CLI, Jev integration, parser, database, or dashboard.
- Do not push, publish, open a pull request, or perform remote writes.

## Scope and constraints

- V1 supports JavaScript and TypeScript unit, integration, and component tests using Jest or Vitest.
- Repository discovery and findings target test files only.
- Narrowly related production code may be read as supporting evidence.
- The tool is local-first, CLI-first, zero-config by default, and reporting-only in CI.
- Jev judgments are multidimensional, evidence-gated, version-pinned, cached, parallel, and resumable.
- Evaluation workflows are autonomous and deterministic; no human-in-the-loop labeling.
- Git fixtures are canonical; SQLite stores append-only evaluation history.
- Reports are JSON plus self-contained HTML.
- Documentation artifacts use English.

## Delivery

- Strategy: `single-pr`
- Forecast: approximately 475 authored changed lines after the accepted benchmark-review addition, generated files excluded.
- Running authored count: 570 lines in committed work units before final evidence bookkeeping.
- Chain strategy: not applicable; the user explicitly chose one delivery.
- Size exception: accepted for the initial documentation set because the repository is new and the three artifacts form one coherent definition.
- RDD: disabled/unmanaged.
- TDD: not applicable to documentation-only work.

## Acceptance criteria

- The PRD states the problem, users, product behavior, success measures, requirements, and explicit non-goals.
- The technical design defines boundaries, data flow, Jev question composition, persistence, caching, concurrency, privacy, and reporting.
- The implementation plan is ordered into coherent work units with verification and dependencies.
- All three documents agree on terminology, v1 scope, classifications, and operational policy.
- No source implementation is added.

## Tasks

- [x] **DOC-1 — Product requirements**
  - Create `docs/PRD.md` from the validated discovery decisions.
  - Check: every agreed product constraint is represented and open questions are explicit.
  - Evidence: commit `1d48484`; validation script passed for 188 lines and all required sections; `git diff --check` passed. An initial case-sensitive keyword check produced a false negative for `Reporting-only` and passed after the checker was corrected.
- [x] **DOC-2 — Technical design**
  - Create `docs/technical-design.md` with architecture, data contracts, orchestration, persistence, privacy, and failure behavior.
  - Check: design supports every PRD requirement without expanding v1 scope.
  - Evidence: commit `214ffa2`; validation script passed for 113 lines and required architecture/PRD invariants; `git diff --check` passed.
- [x] **DOC-2A — Benchmark agent-review workflow**
  - Update the PRD and technical design for a benchmark-only project skill that dispatches lightweight subagents without an LLM API integration.
  - Preserve blind first-pass review, deterministic oracle authority, immutable artifacts, and persisted comparison evidence.
  - Check: normal audits remain independent of the agent skill and its cost/latency.
  - Evidence: commit `d784678`; validation confirmed blind review, no secondary-model API dependency, deterministic-oracle authority, and isolation from normal audits; `git diff --check` passed.
- [x] **DOC-3 — Implementation plan and consistency verification**
  - Create `docs/implementation-plan.md` with sequenced work units and acceptance checks.
  - Validate cross-document terminology, links, scope, and Markdown structure.
  - Check: no unresolved contradiction blocks implementation.
  - Evidence: commit `428215b`; implementation plan created with 9 ordered work units and quality gates; cross-document validation passed for naming, scope, benchmark-agent boundaries, Markdown structure, and local links; `git diff --check` passed. The first validation caught and removed one stale `<package>` placeholder.

## Progress

- Current task: none.
- Completed tasks: DOC-1, DOC-2, DOC-2A, DOC-3.
- Verification: all three documents passed naming, scope, benchmark-agent, Markdown, local-link, and whitespace checks.

## Next step

Implementation requires a separate explicit authorization; no product source code has been added.
