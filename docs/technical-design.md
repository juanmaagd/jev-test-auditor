# Jev Test Auditor — Technical Design

## Decision

Build one TypeScript CLI with a framework-neutral domain, Jest/Vitest evidence adapters, a TypeSafe Jev gateway, append-only SQLite persistence, and deterministic JSON/HTML reporting. The system scans only tests; production source is supporting evidence.

## Architecture

```text
CLI
 └─ Audit application
     ├─ Repository discovery
     ├─ Jest/Vitest test-case extraction
     ├─ Context resolver
     ├─ Evaluation scheduler ── TypeSafe Jev
     ├─ Classification policy
     ├─ SQLite run store and cache
     └─ JSON report ── self-contained HTML renderer

Benchmark application
 ├─ Git-versioned fixture/operator catalog
 ├─ Executable deterministic oracles
 ├─ Same evaluation scheduler and policy
 └─ SQLite history, comparisons, and JSONL export
```

Dependencies point inward: CLI and renderers depend on application services; application services depend on domain contracts; repository, Jev, SQLite, and filesystem concerns implement ports.

## Core domain

| Type | Responsibility |
| --- | --- |
| `TestCase` | Stable identity, file/line/name, framework, source, helpers, imports, and test kind. |
| `EvidenceBundle` | Minimal test, helper, production-seam, and provenance fragments sent for judgment. |
| `RubricVersion` | Seven dimension definitions, criteria, questions, and composition policy. |
| `DimensionJudgment` | Applicability probability, 0–3 score distribution, confidence, and model metadata. |
| `Finding` | Test-bound concern with evidence and derived status. |
| `AuditRun` | Immutable configuration, progress, usage, failures, and report identity. |

Identifiers use normalized repository-relative paths plus structural test ancestry and a source hash. Line numbers are presentation metadata, not identity.

## Discovery and extraction

1. Find workspace manifests and Jest/Vitest configuration without executing arbitrary project scripts.
2. Apply framework defaults plus user include/exclude overrides.
3. Parse JavaScript, JSX, TypeScript, and TSX with the TypeScript compiler API.
4. Extract `describe`, `test`, `it`, parameterized variants, modifiers, hooks, imports, mocks, and assertion calls.
5. Emit one `TestCase` per statically identifiable case. Dynamic cases that cannot be enumerated receive explicit extraction metadata rather than invented identities.

Skipped and todo cases remain visible but are not silently treated as evaluated active tests. E2E framework files are excluded in v1.

## Context resolution

The resolver follows imports from the test and ranks candidate symbols referenced by the arrange/act/assert body. It selects only the smallest useful helper and production fragments within configured budgets. It never creates findings for those files.

Every fragment records path, line range, content hash, selection reason, and truncation state. Sensitive paths and generated/vendor files are denied before content is read. `--inspect-payloads` renders the exact local request state without calling Jev.

## Jev evaluation

One request represents one `TestCase` state. Independent questions share that state and are batched. For each of the seven dimensions the rubric defines:

- A Noul question asking whether the supplied state is sufficient and applicable.
- A Score question with concrete 0–3 criteria: misleading, weak, acceptable, and strong.

The score is ignored when its gate is below the calibrated evidence threshold. Follow-up requests are allowed only when an earlier result identifies a specific evidence need; they are not automatic retries disguised as more votes.

The shipped rubric pins an exact Jev version. Raw answers remain stored so policy changes can be recomputed without another model call when question meaning and evidence are unchanged.

## Classification policy

Classification is deterministic and non-compensatory. `needs-review` represents insufficient evidence or confidence. Supported critical failures produce `misleading`; other deficient applicable dimensions produce `weak`; `healthy` requires all applicable dimensions to be acceptable or strong. Thresholds are data, versioned with the rubric, and unavailable until benchmark calibration.

## Persistence and cache

SQLite uses migrations and append-only evaluation records.

| Table group | Contents |
| --- | --- |
| Catalog | repositories, test cases, evidence bundles, rubric/model identities. |
| Execution | audit runs, work items, attempts, usage, errors, and checkpoints. |
| Results | raw answers, normalized judgments, findings, and report manifests. |
| Evaluation | fixture operators, oracle proofs, benchmark runs, metrics, and comparisons. |

The cache key hashes normalized test source, evidence bundle, rubric/questions, exact model, and policy-relevant request options. `--fresh` bypasses lookup but writes a new immutable result. Git stores benchmark fixtures and expected operator metadata; JSONL exports make SQLite data portable.

## Scheduling and recovery

A bounded worker pool observes request and token budgets. Provider throttling reduces concurrency; successful windows may restore it up to the configured ceiling. Transient failures use bounded exponential backoff with jitter. Each terminal work-item state is committed immediately, allowing an interrupted run to resume by run ID.

States are `pending`, `running`, `completed`, `cached`, `uncertain`, `skipped`, or `failed`. Only completed and valid cached judgments participate in quality classification.

## Reports

The versioned JSON schema is canonical. The HTML renderer embeds that JSON and static assets into one offline file. Both expose discovery decisions, payload provenance, scores, probabilities, model/rubric versions, cache status, usage, latency, and errors. CI always remains reporting-only in v1.

## Deterministic evaluation

Fixture operators introduce one known change, such as removing an assertion, weakening an expectation, adding shared state, mocking owned logic, pinning an implementation detail, or introducing uncontrolled time. Executable oracles validate the expected effect through production mutation, assertion mutation, semantics-preserving refactoring, or repeated/randomized execution.

Only dimensions proven by an operator and oracle count toward accuracy. Unproven real-world observations remain `unverified`. Jev never labels its own benchmark.

## Security and failure boundaries

- Credentials come from supported environment or local credential storage and never enter reports.
- Symlinks and resolved paths cannot escape the repository root.
- Payload and report size limits are explicit; truncation is recorded.
- Database writes use transactions and migrations; corrupt or incompatible stores fail visibly.
- API, parser, extraction, and rendering failures remain distinguishable.
- No finding or infrastructure failure changes the CI exit status because v1 is reporting-only.

## Evolution

Future language support replaces discovery, extraction, and executable-oracle adapters. The rubric concepts, scheduler, persistence, classification, and report contracts remain reusable only where benchmarks demonstrate equivalent meaning; the design avoids a speculative public plugin API in v1.
