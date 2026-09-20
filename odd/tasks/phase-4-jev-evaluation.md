# Build Phase 4 Jev evaluation

## Objective

Turn an evidence bundle into a real semantic verdict: compose the versioned seven-dimension rubric into one batched Jev request per evaluable test case, call the TypeSafe HTTP API, normalize raw answers, derive a deterministic non-compensatory classification in pure code, and report findings in the terminal and in canonical JSON.

## Problem

Phase 3 selects minimal, provenance-aware evidence for every test case and can estimate what evaluating it would cost, but nothing judges test quality yet. The CLI is still reporting-only and never leaves the machine.

## Why

This is the first end-to-end MVP: discovery → evidence → Jev → classification → report. It proves the product thesis before persistence, caching, HTML polish, and benchmarks are built on top of it.

## Authorized scope

- Add domain contracts for the rubric, questions, judgments, findings, classification, usage, and evaluation run results.
- Version the rubric and pin the exact model id; compose one request state plus all independent questions per evaluable test case.
- Implement a TypeSafe HTTP gateway adapter with authentication, timeout, bounded retry/backoff, and typed response normalization.
- Derive classification deterministically in pure code and keep raw answers reusable.
- Wire opt-in evaluation into the audit application and CLI with terminal output and canonical JSON.
- Update README and technical design for delivered behavior.
- Do not implement SQLite, caching, `--fresh`, resume, adaptive scheduling, HTML reports, benchmarks, calibrated thresholds, or other languages.

## Scope and constraints

- No new runtime dependency: the gateway is a hand-rolled `fetch` client (user decision, 2026-09-20; the official SDK uses `globalThis.fetch` too, so latency is identical and only typings and retry helpers are reimplemented). Keep the gateway behind a port so switching to `@typesafe-ai/sdk` later is a one-adapter change.
- Evaluation is opt-in in this phase (`audit --evaluate`). Without it the CLI stays exactly as Phase 3 left it: offline, reporting-only, no API key required.
- Local key storage is a per-user file scoped to this tool, not a global environment variable (user decision, 2026-09-20). `TYPESAFE_API_KEY` remains supported and takes precedence so CI keeps injecting GitHub secrets. A system keychain was considered and declined for now.
- Never execute audited code. Evidence is the only thing sent; nothing else leaves the machine.
- The API key comes from `TYPESAFE_API_KEY` only. Never log, print, serialize, or include it in reports or errors.
- Requests pin the exact versioned model id `jev-1.13.0`; the response's `model` is recorded as the model that actually answered, and a mismatch is reported, never hidden.
- Provider facts (verified 2026-09-20 from docs.typesafe.ai): `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body `{ state, model, questions }`, answers keyed by question id, `usage.input_tokens`; `noul` returns a probability, `score` returns a probability-weighted value plus `legend`, `probabilities`, and `confidence`; errors 401, 422, 429, 529; retry 429/529 with exponential backoff honoring `retry-after`; limits 64k tokens per request, 32k for state plus the longest question, 250k tokens/second, 1,200 requests/minute; price USD 0.042 per million input tokens, output free.
- Missing evidence or insufficient certainty produces `needs-review`, never an invented score.
- Thresholds are provisional data versioned with the rubric, not calibrated claims; Phase 7 calibrates them.
- Artifacts use English. Preserve unrelated untracked `.atl/` files. Conventional Commits without AI attribution.

## Decisions

- Question set per request: for each of the seven dimensions one `noul` applicability/sufficient-evidence question and one `score` quality question with four ordered levels (`misleading`, `weak`, `acceptable`, `strong`) — 14 independent questions over one state.
- Request state is a structured JSON object built from the evidence bundle (test identity, name, ancestry, framework, modifiers, fragments with paths and roles, denied/unresolved/omitted provenance), not a prose blob.
- Provisional thresholds, versioned with the rubric: applicability `noul >= 0.5` makes a dimension applicable; a score below `0.5` distance from the next level is not rounded — the policy compares the weighted score against fixed cut points and requires `confidence >= 0.6` to use it, otherwise the dimension is `needs-review`.
- Follow-up requests are out of scope for this phase; a dimension lacking evidence stays `needs-review`.
- Concurrency in this phase is a fixed bounded pool from existing `concurrency` configuration, with no adaptive throttling (Phase 5).
- Fix the Phase 3 estimator snapshot model string to the exact `jev-1.13.0` and record the verified rate limits.
- An answer for a question id that was never requested is a `JevResponseError`, not silently ignored (P4-2 choice, fail closed).
- `createJevHttpGateway` validates the key eagerly, so P4-4 must construct the gateway only when `--evaluate` is requested; constructing it unconditionally would break the offline default.
- Packaging: `package.json` `files: ["dist"]` replaced ignoring `odd/`/`docs/` in `.gitignore` (commit `c6093a4`); the published package is 94 files.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 2,000 authored changed lines, generated files excluded; Phase 3 overran its forecast roughly fourfold, so treat this as a floor.
- Chain strategy: cached `feature-branch-chain`.
- Tracker boundary: `feat/phase-4-jev-evaluation`, based on `main` at `6377dd2`.
- Planned local child slices: rubric and request composition, HTTP gateway, classification policy, application/CLI reporting.
- Remote tracker/child pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged.
- TDD: enabled by explicit user confirmation (carried forward); require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.

## Primary references

- TypeSafe API: <https://docs.typesafe.ai/api>
- Models and limits: <https://docs.typesafe.ai/models>
- Primitives (noul, choice, score): <https://docs.typesafe.ai/primitives>
- Confidence: <https://docs.typesafe.ai/confidence>
- State: <https://docs.typesafe.ai/concepts/state>

## Acceptance criteria

- One request per evaluable test case carries the exact pinned model, the bundle-derived state, and all 14 independent questions, and fits the provider budgets.
- The gateway authenticates from the environment, times out, retries only 429/529 with bounded backoff honoring `retry-after`, and never leaks the key in logs, errors, or reports.
- Raw answers, probabilities, confidence, model id, and usage are preserved so policy changes can be recomputed without another call.
- Classification is pure, deterministic, non-compensatory, and produces `healthy`, `weak`, `misleading`, or `needs-review` with the rubric version recorded.
- Failures, unknowns, and skipped tests stay visible and are never counted as healthy.
- Without `--evaluate` the CLI behaves exactly as Phase 3, with no network and no API key needed, proven by tests.

## Tasks

- [x] **P4-1 — Version the rubric and compose Jev requests**
  - Add the versioned seven-dimension rubric, its 14 question definitions, the bundle-to-state projection, canonical request serialization, and provider budget checks.
  - Verify exact request golden, stable question ids, pinned model, budget rejection, and no network.
  - Evidence: `5257be7` (`feat: version the jev rubric and compose requests`) on `feat/phase-4-rubric-requests`; 6 files, 1,665 additions and 2 deletions (1,667 authored changed lines). Suite 17 files/324 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. `RUBRIC_V1` carries the seven PRD dimensions with concrete four-level criteria, stable `<dimension>.applicable`/`.quality` ids, and a fail-closed pin on `jev-1.13.0`. State projection sends identity, modifiers, fragments, and denied/unresolved/omitted provenance, and deliberately omits hashes, spans, and byte counts. Review correction: quality questions now carry their own withheld-evidence rule so denied, unresolved, omitted, or truncated evidence can never worsen a score; applicability keeps its separate note. Mutations on dropping a dimension, reversing level order, unpinning the model, dropping provenance from state, non-deterministic question order, and dropping the quality provenance note turned RED. Literal golden request verified by hand at 543 bytes.
- [x] **P4-2 — Implement the TypeSafe HTTP gateway**
  - Hand-rolled `fetch` client behind a port: auth from `TYPESAFE_API_KEY`, timeout, bounded retry for 429/529 honoring `retry-after`, typed normalization of noul/score answers and usage, typed errors.
  - Verify status handling, backoff bounds, key never logged or serialized, malformed/partial responses, model mismatch reporting, and abort behavior, all against a stubbed fetch.
  - Evidence: `a7be1b3` (`feat: add typesafe jev http gateway`) on `feat/phase-4-jev-gateway`; 5 files, 1,330 authored lines (686 of them tests). Suite 18 files/357 tests, typecheck, build, lint, and diff check passed. Observed RED twice: missing modules, then a stub adapter failing 24 of 29 assertions. Defaults: 60s timeout, 3 retries, 500ms initial backoff, 30s cap, full jitter, `retry-after` honored as seconds or HTTP-date and always capped. Typed errors for configuration, auth, request, rate limit, overloaded, timeout, abort, and response; only 429/529 retry. The key lives in a closure, never on the object, and every server- or transport-derived string is redacted, including the network-error path found during review. Timeout covers the whole body read through two abort controllers. The architecture test now allows exactly one reviewed bare `fetch(` call site in this adapter and fails if it disappears or a second appears; the network-import ban still covers it. Mutations on retrying 401, dropping the retry-after cap, unredacted 422, skipping a missing answer, hardcoding the model match, and accepting a non-finite probability turned RED.
- [x] **P4-3 — Derive deterministic classification**
  - Pure non-compensatory policy over normalized judgments with versioned provisional thresholds, evidence gating, and per-dimension findings.
  - Verify every policy branch, threshold boundaries, unknown/low-confidence gating, and that no strong dimension can cancel a critical failure.
  - Evidence: `eed2d2a` (`feat: derive deterministic test classification`) on `feat/phase-4-classification`; 3 files, 1,111 authored lines (663 of them tests), 58 new tests. Suite 19 files/415 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. `CLASSIFICATION_POLICY_V1` is provisional and uncalibrated: applicability `noul >= 0.5`, confidence `>= 0.6`, cut points [1, 2, 3] with half-open intervals where a score exactly at a cut point belongs to the higher level, so reaching a level requires the weighted score to actually reach it. Non-applicable dimensions are excluded; low confidence, missing, or malformed answers force `needs-review`; a model-pin mismatch forces `needs-review` regardless of scores; `healthy` requires every applicable dimension acceptable or strong. Findings include `needs-review` dimensions so uncertainty stays visible. A rubric/policy version mismatch throws. Mutations on compensatory averaging, dropping the model-mismatch rule, skipping the confidence gate, bypassing applicability, shifting cut-point comparisons, and letting needs-review reach healthy turned RED.
- [x] **P4-4 — Wire evaluation into the audit and CLI**
  - Add `audit --evaluate` with bounded concurrency, terminal summary, canonical JSON report including judgments, usage, and provenance, honest failure reporting, and documentation updates; align the estimator model string and README roadmap numbering.
  - Verify opt-in behavior, offline default, per-test failure isolation, deterministic JSON, exit codes, and packed-install smoke.
  - Evidence: `b6bd435` (`feat: evaluate tests with jev behind an opt-in flag`) on `feat/phase-4-application-cli`; 13 files, 1,617 additions and 58 deletions (1,675 authored changed lines). Suite 20 files/439 tests, typecheck, build, lint, and diff check passed. Observed RED before each step. The evaluation port's presence is the only gate: the gateway is constructed only when `--evaluate` is parsed, so the default stays offline with no key. `--dry-run`, `--evaluate`, and `--inspect-payloads` are mutually exclusive; `--json` requires one of the first two. A bounded pool writes results by index, so ordering never depends on completion order. A failed evaluation yields one `evaluation-failed` diagnostic with the test case id and typed error code, never the key or request, and no verdict. Totals separate evaluated, failed, skipped by reason, status counts, usage, responded model, and model mismatches. Estimator snapshot now reuses `JEV_MODEL_ID` and records the verified rate limits; README roadmap renumbered. Review correction: the first golden pinned an all-not-applicable case that no regression could break, so a second literal golden pins a mixed run where one test is `misleading` despite a `strong` dimension and another is `healthy`; a cut-point mutation turns only that golden RED. Manual check: default run offline, `--evaluate` without a key exits 1 with no connection attempted.

- [x] **P4-5 — Store the API key locally without a global environment variable**
  - Add `auth login`, `auth status`, and `auth logout`. Read the key from a no-echo prompt, never from an argument. Persist it in a per-user config file scoped to this tool with owner-only permissions. Resolve `TYPESAFE_API_KEY` first so CI keeps using GitHub secrets, then the stored file.
  - Verify precedence, file permissions, absent and corrupt files, that the key never appears in output or errors, and that `--evaluate` reports both ways to provide a key.
  - Evidence: `9cc6221` (`feat: store the typesafe api key locally`) on `feat/phase-4-auth-storage`; 9 files, 1,484 authored lines. Suite 21 files/487 tests, typecheck, build, lint, and diff check passed. `auth login` reads a hidden line on a TTY and one plain line otherwise, never an argument; `auth status` names the winning source and the file's permission state without ever printing the key; `auth logout` deletes it. Storage writes a temp file with mode 0600 and renames it, so the secret is never briefly world-readable, and a file with looser POSIX permissions is refused rather than used. Resolution prefers `TYPESAFE_API_KEY` so CI keeps injecting a GitHub secret, then the stored file; the no-key error names both. Mutations on write-then-rename removal, reversed precedence, printing the last four characters, accepting a blank key, ignoring loose permissions, and forcing hidden input turned RED. Manual check on a temp config home: file mode `.rw-------`, status and logout output carried no key. Noted gap: the storage and prompt adapters were verified by mutation rather than a literal missing-module RED.

## Progress

- Current task: **none — Phase 4 complete**.
- Completed tasks: **P4-1, P4-2, P4-3, P4-4, P4-5**.
- Running authored count: **7,267**, against a 2,000-line forecast; every slice carries its tests and docs, and P4-5 was added mid-phase by user decision.
- Slice ledger:
  - `feat/phase-4-rubric-requests`: `5257be7` — versioned rubric, state projection, request composition, and budget checks.
  - `feat/phase-4-jev-gateway`: `a7be1b3` — hand-rolled TypeSafe HTTP gateway behind a port.
  - `feat/phase-4-classification`: `eed2d2a` — provisional non-compensatory classification policy and findings.
  - `feat/phase-4-application-cli`: `b6bd435` — opt-in evaluation, bounded concurrency, terminal and JSON reporting, and documentation.
  - `feat/phase-4-auth-storage`: `9cc6221` — local API key storage, auth commands, and key resolution.

## Next step

Integrating the Phase 4 chain into `main` is the user's decision. Then run the first real evaluation against a small repository with a real key and read the judgments before planning Phase 5 (persistence, caching, `--fresh`, resume, adaptive scheduling). No Jev call has ever been made yet: every test uses a stubbed gateway.
