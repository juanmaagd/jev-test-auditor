# jev-test-auditor

`jev-test-auditor` is a local-first CLI for auditing the semantic quality of existing JavaScript and TypeScript tests. **The current Phase 1 foundation does not audit tests yet:** its `audit` command only prints the resolved workspace configuration. Test discovery, evidence collection, evaluation, persistence, and reports are later phases.

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

The final command prints JSON for the resolved configuration. It does not scan tests or call an evaluator.

## Current CLI

```text
jev-test-auditor audit [options]
jev-test-auditor --help
```

| Command | Foundation behavior |
| --- | --- |
| `--help` | Prints usage and command information. |
| `audit` | Prints resolved configuration only; real auditing arrives in a later phase. |

## Delivery phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | One TypeScript package, inward dependency boundaries, configuration, and CLI entry point. | **Current and completed** |
| 2. Test understanding | Discover and parse Jest/Vitest tests and build minimal, provenance-aware evidence bundles. | Planned; not implemented |
| 3. Evaluation and reporting | Add Jev judgments, deterministic classification, persistence, caching, scheduling, JSON, and HTML reports. | Planned; not implemented |
| 4. Benchmarks and hardening | Add deterministic benchmarks, benchmark review tooling, calibration, privacy/recovery documentation, and release hardening. | Planned; not implemented |

## Product boundaries

- Supports JavaScript and TypeScript repositories, with Jest and Vitest as the V1 frameworks.
- Findings target test files only; narrowly related production code is supporting evidence, not an independent finding target.
- E2E frameworks, automatic test rewriting, general source review, and languages outside JavaScript/TypeScript are out of scope.
- CI is reporting-only in V1; findings do not fail a build.
- Normal operation is autonomous and does not require human-in-the-loop labeling or approval.

## Architecture

The repository remains one package and one process. Dependencies point inward: the CLI and adapters depend on application services, application services depend on domain contracts, and domain code does not import CLI, adapter, infrastructure, filesystem, or provider concerns.

See the [architecture diagram](docs/architecture.html), [product requirements](docs/PRD.md), [technical design](docs/technical-design.md), and [implementation plan](docs/implementation-plan.md).
