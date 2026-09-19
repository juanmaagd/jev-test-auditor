# Repository Guide

## Product boundaries

- `jev-test-auditor` audits the semantic quality of existing JavaScript and TypeScript tests.
- Tests are the only finding targets; production code is narrow supporting evidence only.
- V1 supports Jest and Vitest. Do not add E2E, automatic rewrites, general source review, or human labeling.
- Keep one package and one process. Avoid speculative plugin APIs and premature abstractions.

## Architecture

Dependencies point inward: `cli` and adapters depend on application services; application services depend on domain contracts; domain code imports no CLI, adapter, infrastructure, filesystem, or provider code.

`docs/architecture.html` is generated from `docs/architecture.archify.json`; regenerate it from the source and never hand-edit the HTML.

## Testing

- Strict TDD is enabled and Vitest is the exact runner.
- For each behavior, observe RED for an assertion failure, then GREEN, then a small REFACTOR.
- Test public seams and observable outcomes. Prefer real domain logic and boundary fakes; do not mock internal classes.
- Every critical branch needs a real mutation check. Tests must be deterministic, isolated, diagnostic, and resilient to refactoring.

## Commands

```bash
npm test
npm run typecheck
npm run build
npm run lint
```

The CLI foundation can be exercised with `node dist/cli/index.js --help` after `npm run build`.

## Product operation

Normal execution is autonomous: no human-in-the-loop labeling or approval is required. CI is reporting-only in v1; findings never fail a build.

## Artifacts and safety

Technical artifacts use English. Do not perform remote, publish, push, or release operations without explicit authorization for the destination and operation.
