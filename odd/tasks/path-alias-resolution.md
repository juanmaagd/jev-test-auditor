# Resolve path aliases, subpath imports, and workspace packages

## Objective

Resolve the non-relative specifiers that real repositories actually use — TypeScript `paths`/`baseUrl`, Node subpath `imports`, and monorepo workspace package names — from statically declared configuration, so evidence bundles contain the production code a test really exercises instead of a list of unresolved names.

## Problem

Only relative specifiers resolve today. Everything else is recorded as `bare-specifier` or `alias-specifier` and dropped. Measured on real repositories:

| Repository | Fragments per test | Unresolved imports |
| --- | --- | --- |
| jev-test-auditor (relative imports) | 2.69 | 1,098 |
| pr-hero (subpath imports) | 1.44 | 17,316 |

At 1.44 fragments per test, Jev sees little more than the test body, so it judges tests without the code under test. That produces `needs-review` and low-confidence answers that look like model uncertainty but are really our own missing evidence.

## Why

Path aliases are the norm, not an edge case. The three repositories available for calibration use three different mechanisms between them, and none of them is relative-only. Every mapping involved is declared in a static configuration file that can be read without executing anything, so resolving them costs no safety.

## Authorized scope

- Read `tsconfig.json`/`jsconfig.json` `compilerOptions.baseUrl` and `paths`, following `extends` chains.
- Read `package.json` `imports` (Node subpath imports, `#name/*`).
- Read workspace package names from `package.json` `workspaces` globs and each package's own `name`.
- Apply those mappings inside evidence resolution, then reuse the existing extension/index probing, deny list, and containment rules unchanged.
- Refine unresolved reasons so a mapped-but-missing target is distinguishable from an unmapped specifier.
- Update README and technical design.
- Do not resolve into `node_modules`, do not execute any configuration file, do not add a bundler-specific mechanism (webpack/vite aliases), and do not change Jest/Vitest/bun extraction.

## Scope and constraints

- Never execute audited code or configuration. `tsconfig` is parsed as text/JSONC; a config that only evaluates at runtime is out of scope and stays unresolved with a reason.
- Every resolved candidate still passes realpath containment and the deny list before any read, exactly as today.
- Resolution stays deterministic and offline; configuration lookups are cached per run.
- An `extends` target outside the repository root, or inside `node_modules`, is refused and recorded, never followed.
- The nearest configuration wins: a file's mappings come from the closest `tsconfig`/`package.json` above it, not from the root only.
- A specifier that matches no mapping keeps its current `bare-specifier`/`alias-specifier` reason; nothing is invented.
- Artifacts use English. Preserve unrelated untracked `.atl/` files. Conventional Commits without AI attribution.

## Observed mechanisms in the calibration repositories (verified 2026-09-20)

- `pr-hero`: `package.json` `imports` with 16 entries such as `"#review/*": "./src/review/*.ts"`; no tsconfig `paths`.
- `supermarket-pro`: `frontend/tsconfig.json` declares `paths`; `backend/tsconfig.json` declares `baseUrl` only; four tsconfigs, several using `extends`.
- `musive-s1`: root `workspaces: ["packages/*"]`, eight tsconfigs, `packages/app/tsconfig.json` extends `../../tsconfigs/tsconfig.base.json` and declares both `baseUrl` and `paths`.

## Decisions

- Mapping precedence for a specifier: subpath `imports` (a `#` prefix is unambiguous) → tsconfig `paths` → workspace package name → `baseUrl`-relative. The first mechanism that produces an existing, in-root, non-denied file wins; document it.
- A specifier that a mapping resolved to a path that does not exist becomes `alias-mapped-not-found`, distinct from an unmapped alias, so a reader can tell a stale config from an unsupported one.
- Mappings are read once per run and cached by directory; the cache is part of the same run-scoped reader already used for source files.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 1,200 authored changed lines, generated files excluded.
- Chain strategy: cached `feature-branch-chain`.
- Tracker boundary: `feat/path-alias-resolution`, based on `main`.
- Remote pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged.
- TDD: enabled; require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.

## Acceptance criteria

- The three mechanisms resolve on their real repositories, and unresolved counts drop sharply while fragments per test rise.
- No resolved target escapes the repository root, enters `node_modules`, or bypasses the deny list.
- Nothing is executed: the no-execution canary tests still pass.
- A stale mapping is reported as `alias-mapped-not-found`, never silently dropped.
- Evidence density is measured before and after on pr-hero, supermarket-pro, and musive-s1, and the numbers are recorded here.

## Tasks

- [ ] **A-1 — Read alias configuration statically**
  - Locate the nearest `tsconfig`/`jsconfig` and `package.json` for a file, parse JSONC, follow in-root `extends` chains, and build a deterministic mapping table with `baseUrl`, `paths`, subpath `imports`, and workspace package names.
  - Verify nearest-config selection, `extends` chains and cycles, out-of-root and `node_modules` refusal, malformed JSON, missing fields, and cache behavior.
- [ ] **A-2 — Resolve mapped specifiers in evidence resolution**
  - Apply the mapping table before declaring a specifier unresolved, keeping probing, deny, and containment unchanged, and refine unresolved reasons.
  - Verify each mechanism end to end, precedence, stale mappings, denied targets, root escape attempts, and no execution.
- [ ] **A-3 — Measure and document the effect**
  - Re-audit the three calibration repositories, record fragments per test and unresolved counts before and after, and update README and technical design.
  - Verify the recorded numbers against a real run.

## Progress

- Current task: **A-1**.
- Completed tasks: none.
- Running authored count: 0.

## Next step

Delegate A-1 to one writer with strict TDD, then review before the work-unit commit.
