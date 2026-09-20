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

- A workspace package whose declared entry point is generated output (musive-s1's `@musive/common` points at `packages/common/dist/index.js`, matched by the `**/dist/**` deny pattern) keeps the package directory as a fallback target; A-2 decides how to prefer source over build output.

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

## Measured effect (A-2, 2026-09-20)

| Repository | Fragments per test before | After | Unresolved before | After |
| --- | --- | --- | --- | --- |
| pr-hero | 1.44 | 2.33 | 17,316 | 7,665 |
| supermarket-pro | 3.23 | 3.82 | 13,998 | 17,619 |
| musive-s1 | 1.87 | 2.49 | 48,136 | 18,282 |
| jev-test-auditor (no aliases) | 2.73 | 2.73 | 1,294 | 1,294 |

supermarket-pro's unresolved total rose because resolution now reaches further: `alias-specifier` fell from 1,165 to zero, while `bare-specifier` rose from 12,813 to 17,599 as newly reachable helpers exposed their own real npm imports. musive-s1's denied count rose from 3 to 4,035, almost entirely `**/dist/**`, which is the source-preference rule refusing prebuilt workspace output.

## Acceptance criteria

- The three mechanisms resolve on their real repositories, and unresolved counts drop sharply while fragments per test rise.
- No resolved target escapes the repository root, enters `node_modules`, or bypasses the deny list.
- Nothing is executed: the no-execution canary tests still pass.
- A stale mapping is reported as `alias-mapped-not-found`, never silently dropped.
- Evidence density is measured before and after on pr-hero, supermarket-pro, and musive-s1, and the numbers are recorded here.

## Tasks

- [x] **A-1 — Read alias configuration statically**
  - Locate the nearest `tsconfig`/`jsconfig` and `package.json` for a file, parse JSONC, follow in-root `extends` chains, and build a deterministic mapping table with `baseUrl`, `paths`, subpath `imports`, and workspace package names.
  - Verify nearest-config selection, `extends` chains and cycles, out-of-root and `node_modules` refusal, malformed JSON, missing fields, and cache behavior.
  - Evidence: `86a0a9a` (`feat: read path alias configuration statically`) on `feat/alias-config-reader`; 4 files, 1,421 additions (1,421 authored changed lines, 563 of them tests). Suite 562 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. Nearest config wins with no cross-tree merging; `tsconfig` beats `jsconfig` at the same level; `package.json` `imports` uses its own nearest search; workspaces are read only from the root. `extends` follows strings and arrays left to right, child overrides parent wholesale, and `paths` resolve against the directory of whichever config supplies the effective `baseUrl` — tested in both directions. Condition preference for `imports` is `default`, `import`, `node`; unsupported conditions are recorded, never guessed. Review corrections: `config-unreadable` was declared but never emitted for a symlinked target escaping the root, and an absolute `extends` was being read as repository-root-relative, which let a decoy `<root>/etc/passwd.json` be inherited; both fixed with RED tests, the second including realpath handling for macOS `/tmp`. Mutations on root-first search, ignoring `baseUrl` for `paths`, following `extends` outside the root or into `node_modules`, dropping the cycle guard, ignoring condition preference, and restoring the root-relative absolute reading turned RED. Verified against the real repositories: pr-hero 16 `imports` entries, supermarket-pro frontend 6 `paths`, backend `baseUrl` only, musive-s1 8 inherited `paths` plus 10 workspace entries, zero refusals in all four.
- [x] **A-2 — Resolve mapped specifiers in evidence resolution**
  - Apply the mapping table before declaring a specifier unresolved, keeping probing, deny, and containment unchanged, and refine unresolved reasons.
  - Verify each mechanism end to end, precedence, stale mappings, denied targets, root escape attempts, and no execution.
  - Evidence: `ed4f4e5` (`feat: resolve aliased specifiers in evidence`) on `feat/alias-evidence-resolution`; 7 files, 719 additions and 51 deletions (770 authored changed lines, 351 of them tests). Suite 579 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation with all 35 pre-existing resolution tests staying green. Precedence follows TypeScript's real rule: exact star-less patterns beat wildcards, longest matching prefix wins among wildcards, and a matched entry's targets are tried in declaration order. Containment is re-checked after wildcard substitution because the captured text is caller-controlled. Workspace bare names try `packageDir/src/index`, then the package directory, then the declared entry, so a `dist` main is never preferred over source; a dist-only package is reported denied rather than dropped. `alias-mapped-not-found` fires only when a declared mapping matched and every target was missing; a `baseUrl` miss stays `bare-specifier`. Hop 2 uses the helper's own nearest config. Mutations on first-match precedence, skipping the deny check, using the test file's config for hop 2, dropping the new reason, resolving into `node_modules`, and reverting the source preference turned RED.
  - Open question recorded: a denied or out-of-root target is terminal and does not fall through to a later mechanism. Verified empirically inert on the three calibration repositories, but not proven safe in general.
- [x] **A-3 — Measure and document the effect**
  - Re-audit the three calibration repositories, record fragments per test and unresolved counts before and after, and update README and technical design.
  - Verify the recorded numbers against a real run.
  - Evidence: `02e75fe` (`docs: document alias resolution and its measured effect`) on `feat/alias-measurement-docs`; 2 files, 39 authored changed lines, no production code touched. Suite 579 tests, typecheck, build, lint, and diff check passed. The writer re-measured independently, building `bd74fbd` in a throwaway worktree for the before column, and all eight before/after cells matched A-2 exactly; the causal sub-claims were verified from `--inspect-payloads` rather than inferred. Three false claims were removed while checking them: both documents still said only relative specifiers resolve, the import-depth wording contradicted itself, and a first draft wrongly listed `.mjs`/`.cjs`/`.mts`/`.cts` as unresolved when those extensions do probe — the real bun deferral is a discovery-scope limit. The terminal-denial limitation was verified on musive-s1 before being described as inert rather than asserted.

## Progress

- Current task: **none — feature complete**.
- Completed tasks: **A-1, A-2, A-3**.
- Running authored count: **2,230**, against a 1,200-line forecast.
- Slice ledger:
  - `feat/alias-config-reader`: `86a0a9a` — static alias configuration reader.
  - `feat/alias-evidence-resolution`: `ed4f4e5` — alias matching, precedence, and source-preferring workspace resolution.
  - `feat/alias-measurement-docs`: `02e75fe` — independently re-measured documentation of the delivered behavior and its limits.

## Next step

Integrating this chain into `main` is the user's decision. The open evaluation question remains: no `--evaluate` run has happened since aliases resolve, so the effect of richer evidence on `needs-review` rates and on the provisional thresholds is still unmeasured.
