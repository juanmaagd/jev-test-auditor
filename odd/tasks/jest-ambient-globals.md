# Attribute Jest from project configuration when imports name nothing

## Objective

Stop reporting `framework: 'unknown'` for a Jest file that never imports `@jest/globals` — NestJS's standard test setup, and most plain Jest projects, leave `describe`/`it`/`expect` as ambient globals — by falling back to the project's own configuration once a file's own imports attribute nothing.

## Problem

Auditing a NestJS backend (`~/Desktop/supermarket-pro/backend`, `--rootDir src/modules/auth`) reported all 11 spec files as `framework: 'unknown'` while correctly extracting 196 test cases. `frameworkForModule` (`src/adapters/test-extraction.ts`) attributes a framework from an import specifier only, and these files import none. The project's runner is `"test": "jest"` in `package.json`, but that `package.json` lives three directories above `--rootDir` — outside the audited root entirely — so discovery's own `readPackageEvidence` (`src/adapters/repository-discovery.ts`, which reads only `rootDir`'s own `package.json`) never sees it either. The resulting `unknown` reaches the Jev request state (`testCase.framework`, `src/domain/jev-request.ts`), so every test case was judged without knowing its framework.

## Why

This is not an edge case: it is NestJS's default Jest setup, and any plain Jest project that never bothered importing `@jest/globals`. A large class of real Jest repositories was silently misreported.

## Authorized scope

- When a file yields test cases but no framework could be attributed from imports, fall back to the project's own configuration to attribute Jest: the `jest` key in the nearest `package.json`, a `jest.config.{js,cjs,mjs,ts,json}` file's presence, or a `"test": "jest"`-style runner script.
- Import-based attribution always wins; config is a fallback only, consulted when imports attributed nothing.
- Never execute project code or configuration. `jest.config.js`/`.cjs`/`.mjs`/`.ts` are JS/TS files — detected by presence only, never opened, imported, or evaluated. `jest.config.json` and `package.json` are read as plain JSON.
- Vitest and bun projects must not be misattributed as Jest; ambiguous or conflicting project evidence stays `unknown`.
- Update README and technical design.
- Do not change discovery, evidence selection, the rubric, the cache key, the store, or any report shape beyond the framework value flowing through.

## Decisions

- The fallback lives outside `src/adapters/test-extraction.ts` entirely, as a new adapter (`src/adapters/jest-project-config.ts`) wired through a new optional `AuditPorts.jestFrameworkHint` port, consumed by `src/application/audit.ts`. `extractTestCases` was already exactly correct for this (`bindings.frameworks[0] ?? request.frameworkHint ?? 'unknown'`, and outright `'unknown'` whenever a file's own imports name more than one framework) — the bug was that nothing fed it a config-aware hint when discovery itself came back `unknown`. No change was needed or made to `test-extraction.ts`.
- The nearest-`package.json` search deliberately walks upward past `rootDir` itself using real filesystem parents (`--rootDir` is routinely a subdirectory of the real project, as in the reported case), bounded by the first `package.json` found or a directory's own `.git` boundary — never unbounded.
- A `jest.config.*` file (including the JSON variant) is evidence by presence alone: the filename itself is unambiguous evidence no other tool would place, so opening it adds a parse-failure mode with no corresponding gain.
- Conflicting evidence at the same package root (a `vitest` dependency, a `"test": "vitest"`/`"test": "bun test"` script, or a `vitest.config.*` file) beats positive Jest evidence and keeps the file `unknown` — a project mid-migration must never be guessed.
- The corrected framework is reflected onto `AuditFileResult.discovered.framework` (what the CLI summary and `audit --json` print) once extraction's own result differs from discovery's; `discovered.frameworkEvidence` is left untouched, since `FrameworkEvidenceSource` (`src/domain/discovery.ts`) has no `'config'` member and discovery itself is out of scope.
- The new `jestFrameworkHint` port is optional on `AuditPorts` so every existing test double is unaffected; production wiring (`src/cli/index.ts`) always supplies it.

## Constraints observed

- Artifacts use English. Conventional Commits without AI attribution. `.gitignore` and `.atl/` left untouched.
- Strict Vitest TDD: RED observed before each implementation, minimum implementation, then refactor; mutation evidence recorded per behavior.

## Note on process

Delivered directly on `feat/jest-ambient-globals` as one focused, fully-specified change handed down with exact file/line references, not routed through this repository's own exploration/proposal ODD phases — this document exists only so the extensive in-code cross-references to `odd/tasks/jest-ambient-globals.md` resolve to something real. No commit was made (explicitly out of scope for this task); there is therefore no Delivery/Tasks/Progress ledger here the way `bun-test-support.md`/`path-alias-resolution.md` carry one.
