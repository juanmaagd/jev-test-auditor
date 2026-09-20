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
 ├─ SQLite history, comparisons, and JSONL export
 └─ Optional project skill ── lightweight runtime subagents
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

## Discovery, extraction, and the Phase 2 audit seam

1. Discover repository-local `.test`/`.spec` JavaScript, JSX, TypeScript, and TSX files with lexical ordering, default/configured exclusions, symlink containment, and conservative E2E signals.
2. Read source through a root-contained filesystem adapter. Discovery and reading inspect text only; they never execute audited files, package scripts, test runners, or configuration modules.
3. Attribute Jest/Vitest from syntax-aware static imports and package metadata. Conflicting evidence remains `unknown` and is preserved in the discovery record.
4. Parse JavaScript, JSX, TypeScript, and TSX with the TypeScript compiler API.
5. Extract `describe`, `test`, `it`, parameterized variants, modifiers, hooks, imports, mocks, and assertion calls.
6. Emit one `TestCase` per statically identifiable case. Dynamic cases that cannot be enumerated receive explicit extraction metadata rather than invented identities.
7. The application service composes discovery, safe source reading, and extraction through injected ports. It processes included files sequentially in repository-relative lexical order and returns per-file lineage, exclusions, root diagnostics, and `reportingOnly: true`.

`jev-test-auditor audit` projects this result to one deterministic JSON line containing the configured `rootDir`, included file path/framework/count summaries, excluded paths/reasons, totals, and diagnostics. Parser, read, and discovery diagnostics are informational for CLI policy: `audit` exits zero after emitting the summary; usage errors exit one.

Skipped and todo cases remain visible but are not silently treated as evaluated active tests. E2E framework files are excluded in v1.

## Context resolution

Evidence resolution and selection are hand-rolled and auditable: they never use `require.resolve`, `createRequire`, or Node module resolution, and they never import, require, or execute an audited file, helper, configuration module, package script, or test runner.

**Resolution (per file, once).** Only relative specifiers (`.`/`..`/`./`/`../`) are resolved. A specifier starting with `@/`, `~/`, or `#` is classified `alias-specifier`; every other non-relative specifier — including a scoped package such as `@babel/core` — is `bare-specifier`. Both are recorded as `unresolved` with that reason; neither is ever read. For a relative specifier, candidates are probed in this exact order: the literal path; then, only when the base's own extension has a TS-ESM rewrite (`.js`→`.ts`/`.tsx`, `.jsx`→`.tsx`, `.mjs`→`.mts`, `.cjs`→`.cts`), the rewritten path(s); then, unless the base already has a recognized source extension, the base with each of `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` appended; then, always, the base as a directory with `index<ext>` for each of those extensions. The first candidate that exists, stays within the repository root after `realpath` (rejecting a symlink escape), and is a regular file wins. **Deny is checked before any extension-support check and before the file is ever opened**: a repository-relative candidate matching a deny pattern is reported `denied` with the matching rule, never `unresolved` — denial always wins over "this extension isn't supported." Deny patterns without a `/` match the candidate's basename at any depth (e.g. `*.pem` denies `secrets/key.pem`); patterns with a `/` match the full path with the same glob semantics as repository discovery's excludes. Configured `deny` patterns are additive to `DEFAULT_EVIDENCE_DENY_PATTERNS`, never a replacement.

**Import depth (the helper hop).** Hop 1 is the test file's own relative imports. A hop-1 file is classified `helper` when it is itself a test file, sits under a `test`, `tests`, `__tests__`, or `__mocks__` path segment, or has `helper`, `fixture`, or `setup` in its basename (case-insensitive); everything else is `production`. Only `helper` files are expanded one further hop (hop 2, their own relative imports, resolved with the same rules); production files and every hop-2 file are terminal — never expanded further, regardless of role.

**Selection (per test case).** For the test body plus every in-scope hook, referenced import bindings (named, aliased, default, namespace, and `require(...)` destructures) are resolved to the smallest top-level declaration exporting that name in the target file — a whole function/class declaration, a whole `const`/`let`/`var` statement, or `export default`; a name only re-exported from elsewhere selects the re-export statement itself, never following into the next file. A module statically registered as a mock (`jest.mock`/`vi.mock`/`doMock`) reclassifies its otherwise `helper`/`production-seam` fragment as `mock-target`. Selection priority, highest first: the test body and its hooks (`test`), then hop-1 imports (`helper`/`production-seam`/`mock-target`), then hop-2 imports reached only through a hop-1 helper's own selected declaration text (not its whole file).

**Budgets, truncation, and omission.** Each fragment is capped at a configurable `maxFragmentBytes` (default 4 KiB); a fragment that overflows is truncated at the last full line that fits, falling back to a raw UTF-8-safe byte cut (never splitting a multi-byte character) only when not even one line fits. The whole bundle is capped at `maxBundleBytes` (default 16 KiB): fragments are added in priority order until one would overflow, that one fragment is truncated to the remaining budget (line-boundary only; no byte-cut fallback at this stage), and every fragment after it is recorded as `omitted` with a reason rather than silently dropped. Budgets are provisional pending later calibration.

**Canonical form.** Every fragment records repository-relative path, span, a SHA-256 content hash of its newline-normalized text, selection reason, and truncation state (`truncated`, `originalBytes`, `includedBytes`). `canonicalizeEvidenceBundle` serializes a bundle to one deterministic JSON string — fixed key order, fragments/denied/unresolved/omitted sorted independently of input order, paths normalized, content newline-normalized — so identical inputs always produce byte-identical output (what a later phase's cache hashes). `--inspect-payloads` prints exactly this canonical form, one JSON line per bundle, after the normal summary line: it is the local evidence state actually selected on disk, not the Jev wire request shape (`buildJevState`/`buildJevRequest`, below), and it involves no network call — enforced by a static check that `src/` never imports a raw network module and never calls a bare `fetch(...)` outside the one reviewed call site in the TypeSafe gateway adapter, alongside a runtime check that stubs `fetch` during a real audit run.

## Dry-run estimation

`src/domain/estimate.ts` is a pure domain module (no Node imports) that turns an already-built audit result into an aggregate cost/call preview, driven entirely by a versioned, injectable `JevEstimateSnapshot` (`JEV_ESTIMATE_SNAPSHOT` is the shipped instance: the exact pinned model `JEV_MODEL_ID` (`jev-1.13.0`, reused by identity rather than a re-typed literal so the estimator can never drift from the rubric's pin), USD 0.042 per 1,000,000 input tokens, output tokens unbilled, a 2.5–4.5 bytes-per-token range, a provisional 620–2,440-token per-request overhead range standing in for the rubric system prompt plus all 14 batched questions (now measurable exactly from the real `buildJevRequest` output, but this estimator still uses the provisional range for its no-network preview), one follow-up per test at most, a 64k-token provider request ceiling, `asOf: '2026-09-19'`). `validateJevEstimateSnapshot` rejects a non-positive/non-finite/inverted-range snapshot deterministically with `RangeError`, checked before any file is read. `JEV_VERIFIED_RATE_LIMITS`, recorded alongside the snapshot, documents the verified provider rate limits (250,000 input tokens/second, 1,200 requests/minute, 2026-09-20) as facts only — nothing in this phase reads or enforces them.

**Classification (`classifyTestCase`).** Every extracted test case is `skipped/skip` or `skipped/todo` when it carries that static modifier (checked first, so a skip/todo test with no built bundle still reports its modifier reason, never `evidence-unavailable`); `skipped/evidence-unavailable` when no modifier applies but evidence selection produced no bundle for it; `evaluable` otherwise — including a `skipIf`/`runIf` conditional modifier, which is a runtime condition rather than a statically known skip.

**Exact quantities.** `discovered` and `skipped`-by-reason counts come directly from that classification. `initialCalls` equals `evaluable` (one Jev request per evaluable test case, matching the "one state, all rubric questions batched" evaluation model). `evidenceBytes` is the exact sum of `canonicalizeEvidenceBundle(bundle)` UTF-8 byte lengths over every evaluable bundle — the same canonical form `--inspect-payloads` prints, so a byte-for-byte cross-check between the two flags is possible (and is exercised by the packed-install smoke test).

**Approximate ranges, explicitly labeled.** Each evaluable bundle's byte count converts to a token range by dividing by `bytesPerToken.{max,min}` and rounding outward (`floor` for the `min` bound, `ceil` for the `max` bound), so the reported range never under-covers the value it approximates; `requestOverheadTokens.{min,max}` is added once per evaluable call. `followUpCalls` is `{ min: 0, max: evaluable * maxFollowUpsPerTest }` — exact bounds on an inherently unknown count, since a follow-up only happens when an earlier result identifies a specific evidence need, never an automatic retry. Because a follow-up re-sends the same state, `estimatedFollowUpInputTokens.max` is `estimatedInputTokens.max * maxFollowUpsPerTest` (worst case: every evaluable test uses its full follow-up budget) and `.min` is `0` (best case: none do). `estimatedUsd` prices `estimatedInputTokens.min` (no follow-ups) through `estimatedInputTokens.max + estimatedFollowUpInputTokens.max` (every possible follow-up) at `usdPerMillionInputTokens`; Jev's output tokens are unbilled, so no output-token term is ever added. `bundlesOverCeiling` counts evaluable bundles whose own worst-case single-request tokens (`ceil(bytes / bytesPerToken.min) + requestOverheadTokens.max`) would exceed `requestTokenCeiling` — a coarse whole-request check (expected `0` under the current evidence budgets); this dry-run estimator never builds a real `JevRequest`, so it still approximates both this and the provider's finer 32k state-plus-longest-question sub-limit rather than computing them exactly. `checkJevRequestBudget` (`src/domain/jev-request.ts`) performs the exact check, against real per-question text, once a real request is actually composed for evaluation.

**CLI.** `audit --dry-run` runs the identical no-network, no-write discovery/extraction/evidence pipeline as a normal audit, then prints a concise human-readable report instead of the normal summary; `--dry-run --json` prints the same data as one stable-key-order JSON line. `--json` without `--dry-run`/`--evaluate`, `--dry-run` combined with `--inspect-payloads` or `--evaluate`, and `--evaluate` combined with `--inspect-payloads` are usage errors (exit 1) — detailed bundle rendering stays exclusive to `--inspect-payloads`; diagnostics from the underlying audit never change `--dry-run`'s exit code. `--dry-run` still uses this approximate token math (it never calls the provider); `audit --evaluate` (below) sends the exact request `state`/`questions` and reports exact usage from the provider's own response. A later phase adds cache-hit and billable-call accuracy to the dry-run estimate itself.

## Jev evaluation

One request represents one `TestCase` state, built by `buildJevState`/`buildJevRequest` (`src/domain/jev-request.ts`) from a `TestCase` and its `EvidenceBundle`: identity, structural ancestry, framework, modifiers, fragments (path, kind, selection reason, truncation, content — never hashes, spans, or byte counts, which carry no judgment-relevant meaning), and denied/unresolved/omitted provenance so the model can tell "withheld from me" from "does not exist." Independent questions share that state and are batched — 14 total, two per each of the rubric's seven dimensions (`RUBRIC_V1`, `src/domain/rubric.ts`):

- A `noul` applicability question asking whether the supplied state is sufficient to judge that dimension at all.
- A `score` quality question with four ordered levels: misleading, weak, acceptable, strong.

A dimension's score is ignored (excluded from the overall verdict) when its applicability `noul` is below `CLASSIFICATION_POLICY_V1.applicabilityMin`, or used only when its `confidence` meets `confidenceMin` — both provisional, uncalibrated thresholds (see Classification policy below). Follow-up requests remain out of scope for this phase; a dimension lacking sufficient evidence stays `needs-review` rather than triggering a second call.

The shipped rubric (`RUBRIC_V1`) pins the exact model id `JEV_MODEL_ID` (`jev-1.13.0`); every request carries this pin, and the response's own `model` is recorded and compared (`modelMatchesPin`) — a mismatch is always reported in the classification result, never hidden or silently retried. Raw answers (`JevEvaluation.answers`, with each answer's own `raw` field) remain stored on the normalized evaluation result so a policy change can be recomputed without another model call when question meaning and evidence are unchanged. The gateway (`src/adapters/jev-http-gateway.ts`) is a hand-rolled `fetch` client behind the `JevGatewayPort` domain port: `Authorization: Bearer` auth from `TYPESAFE_API_KEY` (validated eagerly at construction, so it is constructed only when evaluation is actually requested), a 60s timeout, bounded retry (3 retries, full-jitter exponential backoff, 500ms initial/30s cap) for 429/529 only honoring `retry-after`, and typed errors for every other failure. The API key is never accepted as a constructor argument on any thrown error type, and every server- or transport-derived string is redacted before it can reach an error message — the key cannot leak into a log, report, or diagnostic by construction, not by best-effort scrubbing.

**Opt-in wiring (`audit --evaluate`).** `src/adapters/jev-evaluation-port.ts` composes `buildJevRequest` + a `JevGatewayPort` + `classifyEvaluation` into the domain-typed `AuditEvaluationPort` (`src/domain/audit.ts`). `runAudit` (`src/application/audit.ts`) evaluates every evaluable test case — reusing `classifyTestCase` from `src/domain/estimate.ts` so "evaluable" is never redefined — if and only if `AuditPorts.evaluation` is present; when absent, evaluation is skipped entirely and nothing constructs a gateway or reads an API key. Evaluation runs through a fixed-size concurrency pool sized from `configuration.concurrency` (no adaptive throttling this phase), writing each result to its own index so ordering stays deterministic regardless of completion order. A rejected `evaluate` call is isolated to its own test case: it contributes no classification (never a fabricated verdict, never counted healthy) and produces one `evaluation-failed` diagnostic naming the test case id and the error's typed kind, merged into both that file's own diagnostics and the run's root diagnostics. The CLI (`src/cli/index.ts`) prints a terminal evaluation summary (status counts, skipped-by-reason, failed, total usage input tokens, responded model id, model-mismatch count, and a full diagnostics block) for `--evaluate`, or one deterministic canonical JSON line for `--evaluate --json` carrying every classification's dimensions, findings, model requested/responded/matchesPin, usage, policy/rubric versions, and per-test evidence provenance counts (fragment/truncation/denied/unresolved/omitted counts, looked up from that test case's bundle).

## Classification policy

Classification (`src/domain/classification.ts`) is deterministic, pure, and non-compensatory. Each dimension is judged independently (`judgeDimension`): a missing/malformed applicability answer, or a quality answer with `confidence` below `confidenceMin`, forces `needs-review`; `applicabilityProbability` below `applicabilityMin` excludes the dimension outright as `not-applicable`; otherwise the weighted `score` is compared against three fixed cut points (`levelCutPoints`, left-closed/right-open, top level unbounded) to land on `misleading`/`weak`/`acceptable`/`strong` — never rounded. The overall verdict (`classifyOverall`) is non-compensatory by construction: any judged `criticalLevel` (`misleading`) dimension forces the whole verdict to `misleading` before anything else is inspected, so no `strong` dimension anywhere can cancel it; any judged `weak` dimension (with no critical failure) forces `weak`; a model-pin mismatch, zero applicable dimensions, or any `needs-review` applicable dimension forces `needs-review`; `healthy` requires every applicable dimension to be judged acceptable or strong. `CLASSIFICATION_POLICY_V1`'s `applicabilityMin` (0.5), `confidenceMin` (0.6), and `levelCutPoints` (`[1, 2, 3]`) are provisional, uncalibrated thresholds versioned with the rubric — a later benchmark phase calibrates them; recalibration is a new policy version (e.g. `CLASSIFICATION_POLICY_V2`), never a silent edit of `CLASSIFICATION_POLICY_V1`.

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

## Benchmark agent-review skill

The repository includes a development skill, not a product runtime dependency. Given an immutable completed benchmark run, it selects disagreements, regressions, and calibrated samples, then shards them across lightweight read-only subagents provided by the active Codex or Claude environment. It never owns API credentials or calls a second model from the CLI.

First-pass workers receive the test, minimal production context, rubric, and available deterministic oracle proof, but not Jev's verdict. They return a structured assessment with evidence and uncertainty. After those results are frozen, a comparison stage may see both outputs to classify likely model error, rubric ambiguity, context-selection error, or unsupported disagreement.

SQLite records the skill version, worker runtime/model identity when available, immutable input hashes, prompts, structured findings, and comparison outcome. These judgments guide rubric refinement but do not become ground truth unless an executable oracle independently proves the claim. Normal audits never invoke this skill.

## Security and failure boundaries

- Credentials come from supported environment or local credential storage and never enter reports.
- Symlinks and resolved paths cannot escape the repository root.
- Payload and report size limits are explicit; truncation is recorded.
- Database writes use transactions and migrations; corrupt or incompatible stores fail visibly.
- API, parser, extraction, and rendering failures remain distinguishable.
- No finding or infrastructure failure changes the CI exit status because v1 is reporting-only.

## Evolution

Future language support replaces discovery, extraction, and executable-oracle adapters. The rubric concepts, scheduler, persistence, classification, and report contracts remain reusable only where benchmarks demonstrate equivalent meaning; the design avoids a speculative public plugin API in v1.
