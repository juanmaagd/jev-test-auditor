# Build the Phase 1 foundation

## Objective

Turn the approved design into a small executable TypeScript foundation with a clear architecture map and phased delivery boundaries.

## Problem

The product is defined, but the repository has no executable package or visual map showing how the CLI, application flow, domain policy, and adapters fit together. Starting feature work without those boundaries would invite accidental coupling and premature abstractions.

## Why

A minimal foundation makes the next work units faster while preserving the central constraint: one package, simple inward dependencies, and no speculative plugin system.

## Authorized scope

- Create and validate a visual architecture diagram.
- Define the four delivery phases that group the approved implementation work units.
- Create the TypeScript CLI package foundation, configuration seam, domain primitives, and dependency-boundary check.
- Create a repository `AGENTS.md` that keeps future implementation aligned with the architecture, TDD workflow, and autonomous product constraints.
- Add tests and user-facing documentation for the foundation.
- Do not implement test discovery, Jev calls, SQLite persistence, reports, benchmarks, publishing, or remote operations.

## Scope and constraints

- Keep one package and one process.
- Keep domain code independent from filesystem, CLI, TypeSafe, and persistence adapters.
- Preserve zero-config behavior and observable resolved configuration.
- Treat only test files as future finding targets.
- Artifacts use English.
- Preserve unrelated untracked `.atl/` files.

## Delivery

- Strategy: `ask-on-risk`.
- Forecast: approximately 350 authored changed lines, generated diagram output excluded.
- Chain strategy: not required unless the running authored count exceeds approximately 400 lines.
- RDD: disabled/unmanaged.
- TDD: enabled by explicit user confirmation; require observed RED, GREEN, and REFACTOR evidence.
- Test runner: Vitest.

## Phases

1. **Foundation** — architecture map, CLI contract, configuration, domain boundaries, and build checks.
2. **Test understanding** — Jest/Vitest discovery, static extraction, stable identities, and minimal evidence bundles.
3. **Audit execution** — Jev judgments, deterministic classification, SQLite/cache/recovery, and JSON/HTML reports.
4. **Trust and release** — deterministic benchmarks, blind agent-review skill, calibration, hardening, and release documentation.

## Acceptance criteria

- A validated, self-contained architecture diagram explains the runtime and benchmark paths without implying multiple deployable services.
- The repository exposes a runnable CLI help path and a deterministic configuration seam.
- Domain modules have no imports from adapter or CLI modules.
- Applicable tests and build checks pass with observed evidence.
- Work remains within Phase 1 scope.

## Tasks

- [x] **FOUND-1 — Map the simple architecture and phase boundaries**
  - Produce the architecture source and self-contained HTML diagram.
  - Keep the primary runtime path to at most ten conceptual nodes.
  - Verify the diagram schema, quality profile, rendered layout, and phase mapping.
  - Evidence: commit `3ef4fe4`; `docs/architecture.archify.json` and `docs/architecture.html`; showcase validation passed 9/9 with 0 errors and 0 warnings; automated browser evidence passed at 1440×900, 1600×1000, 1920×1080, and 2048×1320 in both captured themes; visual inspection passed in light and dark; specification SHA-256 `8687798e50fe9841c7c948604fd0615be2f5e612398182639cdedec1facecbbe`; artifact SHA-256 `70fb4e9b524be0fbc7d5010421984a8701eae62d8fe3abf3d85ea7a38e0d9f7f`; two focused visual correction rounds. Focused runtime harness: N/A because this work unit contains a static documentation artifact. Rollback boundary: remove the two architecture artifacts and this task evidence without affecting the approved PRD or technical design.
- [ ] **FOUND-2 — Establish the executable package foundation**
  - Use strict TDD with Vitest and record observed RED, GREEN, and REFACTOR evidence.
  - Add the TypeScript Node package, CLI entry point, resolved configuration seam, domain primitives, and dependency-boundary check.
  - Add `AGENTS.md` with concise repository-specific implementation rules.
  - Verify CLI help, configuration behavior, architecture boundaries, type checking, and build output.
- [ ] **FOUND-3 — Close and document the foundation**
  - Document local development and the phase boundaries from the executable perspective.
  - Run the complete foundation checks and reconcile implementation evidence.

## Progress

- Current task: **FOUND-2**.
- Completed tasks: **FOUND-1**.
- Verification: the delivered architecture passes showcase validation, browser containment/readability checks, and perceptual inspection in light and dark themes.

## Next step

Delegate **FOUND-2** to a Luna implementation worker, then review its TDD evidence, architecture boundaries, and diff before integration.
