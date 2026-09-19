# jev-test-auditor

`jev-test-auditor` is a local-first CLI for auditing the semantic quality of existing JavaScript and TypeScript tests. The current Phase 2 pipeline discovers supported test files, reads them without executing project code, and extracts deterministic structural test understanding. Evaluation, persistence, and quality findings are later phases.

## Quick path

From the repository root:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run lint
node dist/cli/index.js --help
node dist/cli/index.js audit
```

The final command prints one deterministic reporting-only JSON summary. It does not execute tests or call an evaluator.

## Current CLI

```text
jev-test-auditor audit [options]
jev-test-auditor --help
```

| Command | Foundation behavior |
| --- | --- |
| `--help` | Prints usage and command information. |
| `audit` | Discovers `.test`/`.spec` JavaScript and TypeScript files, extracts Jest/Vitest test cases, and prints a reporting-only JSON summary. Diagnostics do not change the zero exit status. |

## Delivery phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | One TypeScript package, inward dependency boundaries, configuration, and CLI entry point. | **Completed** |
| 2. Test understanding | Discover and parse Jest/Vitest tests and build minimal, provenance-aware evidence bundles. | **Current and completed** |
| 3. Evaluation and reporting | Add Jev judgments, deterministic classification, persistence, caching, scheduling, JSON, and HTML reports. | Planned; not implemented |
| 4. Benchmarks and hardening | Add deterministic benchmarks, benchmark review tooling, calibration, privacy/recovery documentation, and release hardening. | Planned; not implemented |

## Product boundaries

- Supports JavaScript and TypeScript repositories, with Jest and Vitest as the V1 frameworks.
- Findings target test files only; narrowly related production code is supporting evidence, not an independent finding target.
- E2E frameworks, automatic test rewriting, general source review, and languages outside JavaScript/TypeScript are out of scope.
- Discovery is repository-local and lexical. Generated/vendor/build paths, symlink escapes, and conservative E2E signals are excluded explicitly.
- The audit pipeline is reporting-only: it never executes audited source, package scripts, test runners, or configuration modules. Read and parse diagnostics are emitted in JSON and do not fail the audit.
- Phase 2 emits structural test understanding only. Jev evaluation, scoring, persistence, HTML reports, and SQLite remain future phases.
- CI is reporting-only in V1; findings do not fail a build.
- Normal operation is autonomous and does not require human-in-the-loop labeling or approval.

## Architecture

The repository remains one package and one process. Dependencies point inward: the CLI and adapters depend on application services, application services depend on domain contracts, and domain code does not import CLI, adapter, infrastructure, filesystem, or provider concerns.

See the [architecture diagram](docs/architecture.html), [product requirements](docs/PRD.md), [technical design](docs/technical-design.md), and [implementation plan](docs/implementation-plan.md).
