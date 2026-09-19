# Build Phase 3 evidence bundles

## Objective

Assemble one minimal, deterministic, provenance-aware `EvidenceBundle` per extracted `TestCase`, containing the test fragment plus the smallest useful helper and production-seam fragments, without executing repository code, and expose it locally through `--inspect-payloads`.

## Problem

Phase 2 extracts stable test cases, imports, mocks, and assertions, but Jev cannot judge a test from its body alone. The auditor needs a bounded, inspectable evidence state that shows exactly which repository fragments would support a judgment and why.

## Why

Semantic scoring is only trustworthy when its evidence is minimal, reproducible, and traceable. Context selection must be proven deterministic and safe (containment, sensitive-path denial, budgets) before any model call exists, because Phase 5 caching hashes the bundle and reports expose its provenance.

## Authorized scope

- Add domain contracts for evidence bundles, fragments, provenance, selection reasons, truncation, denials, unresolved imports, and budgets.
- Resolve relative imports statically inside the repository root with extension and index probing.
- Deny sensitive, generated, and vendor paths before any content is read.
- Select the smallest useful helper and production-seam fragments referenced by the test body within per-fragment and per-bundle byte budgets, recording truncation.
- Extend configuration with evidence budgets and deny paths.
- Compose evidence building into the application seam and add `--inspect-payloads` with no network activity.
- Update README and technical design for delivered behavior.
- Do not implement Jev calls, rubric, classification, SQLite, caching, scheduling, HTML reports, benchmarks, or other languages.

## Scope and constraints

- One package, one process; no new dependencies.
- Findings remain test-file-only; helper and production files are supporting evidence and never independent targets.
- Never import, require, or execute audited files, configuration modules, package scripts, or test runners. Do not use `require.resolve`, `createRequire`, or Node module resolution; resolution is hand-rolled and auditable.
- Only relative specifiers are resolved. Bare, aliased, and `tsconfig` `paths` specifiers are recorded as `unresolved` with a reason.
- Reuse existing root-containment and realpath logic; reject symlink escapes.
- Fragments record repository-relative path, span, content hash, selection reason, and truncation state.
- Bundles are canonically serializable with stable field and fragment ordering so Phase 5 can hash them.
- `--inspect-payloads` output is the local evidence state, not the Jev wire request (that shape belongs to Phase 4).
- Artifacts use English. Preserve unrelated untracked `.atl/` files.
- Commits use Conventional Commits without AI attribution lines.

## Decisions

- Deny list defaults: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `**/secrets/**`, `**/.git/**`, `**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/coverage/**`, `**/vendor/**`, `*.min.js`, `*.map`, `*.d.ts`; configurable additively.
- Default budgets: 4 KiB per fragment and 16 KiB per bundle, overridable through configuration; exact values are provisional until Phase 9 calibration.
- Import depth: direct relative imports of the test file (depth 1), plus one extra hop only through helper files (user decision, 2026-09-19). A helper is a test file or a file under `test/`, `tests/`, `__tests__/`, or `__mocks__/`, or whose basename contains `helper`, `fixture`, or `setup`. Production files are never expanded further; all hops share the bundle budget.
- Default audit JSON adds only evidence totals; full bundles appear only with `--inspect-payloads`.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 1,450 authored changed lines, generated files excluded.
- Chain strategy: cached `feature-branch-chain`, carried forward from Phase 2.
- Tracker boundary: `feat/phase-3-evidence-bundles`, based on `main` at `8c2b242`.
- Planned local child slices: domain contracts, import resolution, fragment selection, application/CLI integration.
- Remote tracker/child pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged.
- TDD: enabled by explicit user confirmation (carried forward from Phase 2); require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.

## Acceptance criteria

- Each extracted test case produces one deterministic bundle; identical inputs produce byte-identical canonical serialization.
- Resolution never escapes the root, never reads denied paths, and never executes code.
- Unresolvable or non-relative imports appear as explicit unresolved provenance, never as invented fragments.
- Budgets are enforced with explicit truncation metadata.
- `--inspect-payloads` emits the exact local bundles with no network activity; default audit output stays one reporting-only JSON line.
- Exact payload golden tests, path-escape tests, truncation cases, and secret-path cases pass; critical mutations turn RED.

## Tasks

- [x] **P3-1 — Define evidence bundle domain contracts**
  - Add `EvidenceBundle`, `EvidenceFragment` (kind `test` | `helper` | `production-seam` | `mock-target`), selection reasons, truncation, denied and unresolved provenance, budgets, and canonical serialization with stable ordering; reuse normalized-source SHA-256 hashing for content hashes.
  - Verify canonical ordering, hash stability under newline changes, budget validation, and path normalization.
  - Evidence: `4a91962` (`feat: add evidence bundle domain contracts`) on `feat/phase-3-evidence-domain`; 6 files, 756 additions and 5 deletions (761 authored changed lines). Suite 10 files/144 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. Orchestrator review found sort-before-normalize and unenforced byte accounting; both fixed with RED tests (normalize before sort; `includedBytes` equals UTF-8 bytes of normalized content; `truncated` consistent). Mutations on kind order, newline normalization, budget validation, path normalization, normalize-before-sort, and byte check turned RED. Shared `sha256` extracted to `src/adapters/hash.ts` with identity tests unchanged. Contract for P3-3: `buildEvidenceBundle` validates and throws; selection must truncate before building.
- [x] **P3-2 — Resolve relative imports safely**
  - Hand-rolled static resolver for relative specifiers with extension/index probing, realpath containment, deny-before-read, and unresolved reasons for bare/alias specifiers.
  - Classify resolved files as helper or production and expand exactly one extra hop through helpers.
  - Verify path escape, symlink escape, denied secret paths, index/extension probing order, bare specifiers, helper classification, helper-hop limit, cycles, and no execution.
  - Evidence: `d0505ab` (`feat: resolve relative evidence imports safely`) on `feat/phase-3-import-resolution`; 6 files, 1,046 additions and 3 deletions (1,049 authored changed lines, 564 of them tests). Suite 11 files/178 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. Probing order: exact, TS-ESM rewrite, extension append (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`), then `index<ext>`. Deny patterns without `/` match the basename at any depth; patterns with `/` match the full path. `@/`, `~/`, `#` are `alias-specifier`; every other non-relative specifier, including scoped aliases, is `bare-specifier` (review removed an unverifiable npm-scope allowlist). Mutations on deny-before-read, production expansion, lexical escape, probe order, dedupe, realpath containment, and the `#` alias branch turned RED. Reused `importRecordsFor` and discovery glob helpers. Known gaps: a helper read failure rejects the whole resolution (P3-4 handles errors per test); unresolved/denied entries carry no importer.
- [ ] **P3-3 — Select minimal helper and production fragments**
  - Map test-body identifiers to import bindings and top-level declarations in resolved files; choose the smallest declaration spans; enforce per-fragment and per-bundle budgets; order deterministically.
  - Verify named/default/namespace imports, mock targets, unreferenced imports omitted, truncation, budget exhaustion, and deterministic ordering.
- [ ] **P3-4 — Integrate application, configuration, and CLI**
  - Add an evidence port to `runAudit`, configuration for budgets and deny paths, evidence totals in the default JSON line, and `--inspect-payloads`; update README (fix the Phase 2 row that claims evidence bundles) and technical design.
  - Verify golden payloads, CLI flags, no network, reporting-only exit behavior, and packed-install smoke.

## Progress

- Current task: **P3-3**.
- Completed tasks: **P3-1, P3-2**.
- Running authored count: **1,810**, above the 1,450 forecast; P3-1 and P3-2 each exceed the ~400-line per-task heuristic because contracts/canonicalization and the resolver's containment/deny/cycle rules each form one boundary with exhaustive tests. Each task stays its own chained slice.
- Slice ledger:
  - `feat/phase-3-evidence-domain`: `4a91962` — evidence bundle domain contracts and canonical serialization.
  - `feat/phase-3-import-resolution`: `d0505ab` — safe static relative import resolution with one helper hop.

## Next step

Branch `feat/phase-3-fragment-selection` from `feat/phase-3-import-resolution` and delegate P3-3 to one writer with strict TDD, then review before the work-unit commit.
