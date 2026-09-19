# jev-test-auditor — Implementation Plan

## Delivery goal

Ship a trustworthy local CLI that discovers Jest/Vitest tests, evaluates each test through bounded Jev judgments, persists reproducible results, and produces portable reports. Build deterministic evaluation infrastructure before treating thresholds as stable.

## Proposed repository shape

```text
src/
  domain/          test cases, rubric, judgments, findings, run states
  application/     audit, benchmark, scheduling, classification
  adapters/        AST, repository, context, TypeSafe, SQLite, reports
  cli/             commands, progress, configuration
evals/
  fixtures/        Git-versioned benchmark projects and cases
  operators/       controlled bad-test transformations and oracles
skills/
  jev-benchmark-review/  benchmark-only subagent investigation skill
docs/              product, design, operation, and contribution guides
```

Start as one package. Extract packages or a public adapter API only after a second language demonstrates a real boundary.

## Work units

### 1. Establish the executable foundation

- Create the TypeScript Node CLI package, formatting, linting, build, and test commands.
- Define dependency rules that keep domain code independent of adapters.
- Implement configuration loading with zero-config defaults and observable resolved settings.
- Verify: CLI help and configuration tests; architecture dependency check.

### 2. Discover and parse supported tests

- Detect workspaces, Jest/Vitest projects, and supported test files without executing project scripts.
- Parse JS, JSX, TS, and TSX into stable `TestCase` identities.
- Support suites, hooks, modifiers, and statically identifiable parameterized cases.
- Verify: fixture corpus across Jest/Vitest and syntax variants; no E2E files included.

### 3. Build minimal evidence bundles

- Resolve imports, helpers, mocks, assertions, and directly related production seams.
- Enforce repository boundaries, sensitive paths, size budgets, and provenance.
- Add `--inspect-payloads` without network activity.
- Verify: exact payload golden tests, path-escape tests, truncation and secret-path cases.

### 4. Implement Jev judgments and classification

- Version the seven-dimension rubric and exact Jev model.
- Batch applicability Noul and quality Score questions per test state.
- Normalize raw responses and apply the non-compensatory policy in pure code.
- Verify: API contract fixtures, policy table tests, unknown/evidence-gating cases.

### 5. Add persistence, caching, and resilient scheduling

- Introduce SQLite migrations for immutable runs, attempts, judgments, usage, and reports.
- Implement the complete content-addressed cache key and `--fresh` behavior.
- Add bounded concurrency, adaptive throttling, retries, checkpoints, and resume.
- Verify: migration, cache invalidation, interruption/restart, and terminal-state tests.

### 6. Deliver audit reports

- Implement `audit` with terminal progress and reporting-only exit behavior.
- Emit a versioned canonical JSON report.
- Render one self-contained offline HTML report and support `--open`.
- Verify: schema validation, snapshot of large derived output, offline rendering, and incomplete-run visibility.

### 7. Build deterministic benchmarks

- Store fixture specifications and controlled operators in Git.
- Implement production mutation, assertion mutation, semantics-preserving refactor, and repeated/randomized execution oracles.
- Persist benchmark comparisons and export JSONL.
- Verify: each operator proves its expected effect before its case counts toward metrics.

### 8. Create the benchmark-review skill

- Follow the project skill style guide and register `skills/jev-benchmark-review/SKILL.md`.
- Read immutable benchmark artifacts and shard selected cases across lightweight read-only subagents.
- Freeze blind assessments before comparing them with Jev results.
- Persist diagnostic classifications without promoting them to ground truth.
- Verify: schema/fixture tests for selection, sharding, blindness, comparison, and persistence; no normal-audit dependency.

### 9. Calibrate and harden the first release

- Run the deterministic baseline and publish per-dimension metrics, cost, and latency.
- Set provisional thresholds from evidence and record their rubric version.
- Document privacy, configuration, CI artifacts, failure recovery, and contribution workflows.
- Recheck npm/GitHub name availability and select an open-source license immediately before publishing.
- Verify: clean install in representative Jest and Vitest repositories; full benchmark reproducibility.

## Implementation order

```text
1 → 2 → 3 → 4 → 5 → 6
              └────→ 7 → 8 → 9
```

The first usable audit arrives after unit 6. Threshold claims and releases wait for units 7–9.

## Quality gates

| Gate | Required evidence |
| --- | --- |
| Test extraction | Stable identities and expected case counts across fixtures. |
| Payload safety | Exact provenance, no path escape, explicit truncation and exclusions. |
| Jev integration | Pinned model, stored raw answers, typed normalization, recorded usage. |
| Classification | Pure deterministic tests for every policy branch. |
| Recovery | Interrupted runs resume without duplicating or losing completed work. |
| Reporting | JSON validates; HTML opens offline and exposes partial/failure states. |
| Benchmark validity | Operators pass executable oracles before contributing labels. |
| Agent review | Blind input separation and benchmark-only dependency are mechanically verified. |

## Deferred decisions

- Exact baseline thresholds, until the first deterministic benchmark exists.
- Second language/framework, until the JS/TS adapter boundary is proven.
- Public plugin API, hosted dashboard, automatic fixes, and blocking CI policy.
