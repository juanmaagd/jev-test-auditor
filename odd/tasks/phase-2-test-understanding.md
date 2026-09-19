# Build Phase 2 test understanding

## Objective

Discover supported Jest and Vitest test files safely, extract statically identifiable test cases into stable domain records, and expose deterministic test-understanding results without executing repository code.

## Problem

The Phase 1 CLI has a trustworthy executable foundation but does not inspect tests. The auditor needs a deterministic understanding layer before it can assemble production context or ask Jev to judge test quality.

## Why

Semantic scoring is only as reliable as the test boundaries and evidence supplied to it. Discovery, identity, and extraction must therefore be proven independently from model behavior, persistence, and reporting.

## Authorized scope

- Add domain contracts for discovered files, test cases, source spans, modifiers, hooks, imports, mocks, assertions, parameterization, diagnostics, and stable identities.
- Discover JavaScript, JSX, TypeScript, and TSX Jest/Vitest test files inside one repository root without executing project scripts or configuration modules.
- Exclude E2E, generated, vendor, build, and configured paths explicitly.
- Parse supported test syntax with the existing TypeScript compiler API.
- Expand only statically provable parameter cases and record unsupported/dynamic registrations without inventing tests.
- Expose a deterministic application seam and a minimal CLI discovery summary.
- Update repository documentation for the behavior actually delivered.
- Do not implement production-context resolution, Jev calls, classification, SQLite, caching, scheduling, reports, benchmarks, fixes, or other languages.

## Scope and constraints

- Keep one package and one process; add no dependency unless evidence shows the existing TypeScript/Node toolchain is insufficient.
- Findings remain test-file-only; production source is not scanned as an independent target.
- Never import or execute audited files, Jest/Vitest configurations, package scripts, test runners, or parameter expressions.
- Normalize repository-relative paths to `/` and reject resolved paths outside the repository root.
- Stable identities use normalized path, structural ancestry, canonical parameter metadata, and normalized source hashes; line and column are presentation metadata only.
- Ambiguous framework attribution remains `unknown` instead of guessing.
- Dynamic or unsupported syntax remains explicit metadata with a reason.
- Artifacts use English.
- Preserve unrelated untracked `.atl/` files.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 1,450 authored changed lines, generated files excluded.
- Chain strategy: cached `feature-branch-chain`, explicitly confirmed for the ongoing local delivery chain.
- Tracker boundary: `feat/phase-2-test-understanding`, based on `feat/phase-1-foundation-cli`.
- Planned local child slices: identity, discovery, structural extraction, parameterization/signals, and application/CLI integration.
- Remote tracker/child pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged.
- TDD: enabled by explicit user confirmation; require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.

## Primary references

- Jest API: <https://jestjs.io/docs/api>
- Jest assertions: <https://jestjs.io/docs/expect>
- Jest mocks: <https://jestjs.io/docs/mock-function-api>
- Vitest test API: <https://vitest.dev/api/test>
- Vitest describe API: <https://vitest.dev/api/describe>
- Vitest setup and teardown: <https://vitest.dev/guide/learn/setup-teardown>
- Vitest mocks: <https://vitest.dev/api/vi>
- TypeScript Compiler API: <https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API>

## Acceptance criteria

- Discovery returns deterministic included and excluded records for supported test files and never executes repository code.
- E2E and root-escape candidates are excluded with explicit reasons.
- Extraction represents suites, tests, hooks, modifiers, imports, mocks, assertions, and parameterization from supported syntax.
- Static parameter cases receive separate stable identities; dynamic cases receive explicit metadata and no invented identities.
- Test identity remains stable when only line numbers move and changes when path, ancestry, parameter case, or normalized source changes.
- The CLI reports an honest deterministic discovery summary while remaining reporting-only.
- Tests pass the robust-testing three questions and critical mutations turn RED for the intended behavior.

## Tasks

- [x] **P2-1 — Define domain contracts and stable identity**
  - Add immutable test-understanding types, normalized source hashing, canonical serialization, and versioned `TestCaseId` generation.
  - Verify duplicate ancestry, line relocation, path/source changes, newline normalization, and static parameter identity.
  - Evidence: `2c77016` (`feat: add stable test case identity`) on `feat/phase-2-identity`; 5 files/23 tests, typecheck, build, lint, and diff check passed. Independent review found and verified the fix for omitted static parameter hashes; path, newline, ancestry, parameter, source, and runtime-validation mutations turned RED.
- [x] **P2-2 — Discover repository-local test files safely**
  - Add deterministic walking, supported filename filtering, explicit exclusions, framework evidence, and root/symlink containment.
  - Verify JS/JSX/TS/TSX, lexical ordering, configured exclusions, E2E reasons, ambiguous frameworks, and no code execution.
  - Evidence: `0052a18` (`feat: add safe test discovery`) on `feat/phase-2-discovery`; 6 files/47 tests, typecheck, build, lint, diff check, npm dry-run, and packed-install root API/CLI smokes passed. Independent review verified syntax-aware evidence, import precedence, E2E-v1 exclusions, diagnostics, and drive/UNC containment; critical discovery mutations turned RED.
- [x] **P2-3 — Extract structural test cases**
  - Parse suites, tests, modifiers, hooks, source spans, and framework aliases using the TypeScript compiler API.
  - Verify nested/duplicate names, skipped/todo/only/concurrent states, hook scope, malformed syntax diagnostics, and stable identities.
  - Evidence: `fef533a` (`feat: extract structural test cases`) on `feat/phase-2-structural-extraction`; 7 files/76 tests, typecheck, build, lint, diff check, and a built public-seam smoke passed. Independent review verified scope-aware ESM/CommonJS aliases, suite modifier and hook inheritance, dynamic non-invention, syntax diagnostics, cross-extension parsing, and nested-scope mutations.
- [ ] **P2-4 — Extract parameterization and static signals**
  - Add supported static parameter cases plus dynamic registration metadata, imports, mocks, assertions, and matcher details.
  - Verify literal and template tables, dynamic expressions, alias handling, Jest/Vitest mocks, negated assertions, and no expression execution.
- [ ] **P2-5 — Integrate the application and CLI seam**
  - Compose discovery and extraction with deterministic ordering and a minimal reporting-only CLI summary.
  - Update README/architecture-facing documentation for delivered behavior and run complete Phase 2 checks.

## Progress

- Current task: **P2-4**.
- Completed tasks: **P2-1, P2-2, P2-3**.
- Verification: P2-1 through P2-3 passed independent Luna review, complete local checks, and critical mutation probes. P2-3 contains 970 authored lines because the scope-aware structural traversal, stable identity integration, dynamic guards, and behavioral matrix form one coupled correctness boundary; splitting them would hide cross-scope false positives that the final review exposed.
- Running authored count: **2,163** lines across completed Phase 2 work-unit commits, generated lockfile excluded.
- Slice ledger:
  - `feat/phase-2-identity`: `2c77016` — stable identity contracts and implementation.
  - `feat/phase-2-discovery`: `0052a18` — safe static test discovery and installable public API.
  - `feat/phase-2-structural-extraction`: `fef533a` — scope-aware structural AST extraction.

## Next step

Create the P2-4 parameterization/signals child branch from `feat/phase-2-structural-extraction`, delegate static parameter expansion and evidence-signal extraction to Luna, and independently verify no-evaluation behavior and per-case identities.
