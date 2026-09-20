# jev-test-auditor

`jev-test-auditor` is a local-first CLI for auditing the semantic quality of existing JavaScript and TypeScript tests. The pipeline discovers supported test files, reads them without executing project code, extracts deterministic structural test understanding, and — for every extracted test case — selects a minimal, provenance-aware local evidence bundle (the test body plus the smallest useful helper and production fragments it references). By default nothing built here is sent anywhere: discovery, extraction, evidence selection, and the default `audit` summary are entirely offline and need no API key. Real Jev evaluation is opt-in only (`audit --evaluate`, see below) — nothing leaves this machine unless that flag is passed. Persistence, caching, resilience, HTML reports, and benchmarks/calibration are later phases.

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
jev-test-auditor auth <login|status|logout>
jev-test-auditor --help
```

| Command / option | Behavior |
| --- | --- |
| `--help` | Prints usage and command information. |
| `audit` | Discovers `.test`/`.spec` JavaScript and TypeScript files, extracts Jest/Vitest test cases, selects each test case's local evidence bundle, and prints a reporting-only JSON summary. Diagnostics do not change the zero exit status. |
| `audit --rootDir <path>` | Audits a configured repository root instead of the current directory. |
| `audit --inspect-payloads` | Prints the same summary line first, then one JSON line per selected evidence bundle (`canonicalizeEvidenceBundle` output), ordered by file path then test-case order. This is the local evidence state selected on disk — fragments, provenance, denials, truncation — **not** the Jev wire request shape, and it makes no network call either way. Cannot be combined with `--dry-run` or `--evaluate`. |
| `audit --dry-run` | Prints a no-network, no-write aggregate cost/call preview **instead of** the normal summary: exact discovered/evaluable/skipped-by-reason counts, exact initial Jev calls (one per evaluable test case) and evidence bytes, plus clearly labeled *approximate* input-token and USD ranges from a versioned local pricing/overhead snapshot. Makes no network or provider call, requires no API key, and writes nothing to disk. Cannot be combined with `--inspect-payloads` or `--evaluate`. |
| `audit --dry-run --json` | Same dry-run preview as one machine-readable JSON line (stable key order) instead of the human-readable text report. Requires `--dry-run`. |
| `audit --evaluate` | Opt-in only. Sends every evaluable test case's local evidence bundle to TypeSafe's Jev model for a real semantic judgment, replacing the normal summary with a terminal evaluation report (status counts, skipped-by-reason, failed count, total usage input tokens, and the responded model id). Requires `TYPESAFE_API_KEY`; its absence is a usage error (exit 1, no network attempted). Cannot be combined with `--dry-run` or `--inspect-payloads`. See "Jev evaluation" below. |
| `audit --evaluate --json` | Same evaluation run as one deterministic canonical JSON line instead of the terminal report: per-test classification, per-dimension judgments, findings, model requested/responded/matchesPin, usage, policy/rubric versions, and evidence provenance counts. Requires `--evaluate`. |
| `audit --json` (alone) | Usage error (exit 1): `--json` requires `--dry-run` or `--evaluate`. |
| `auth login` | Stores a TypeSafe API key locally for this tool. Reads from a no-echo interactive prompt when stdin is a TTY; reads one trimmed line from stdin otherwise, so automation/CI can pipe a key in. **Never** accepts the key as a command-line argument — see "Local API key storage" below. |
| `auth status` | Reports whether a key is available, which source would win (`environment` or `stored`), and the stored file's path and permission status. Never prints the key itself. |
| `auth logout` | Deletes the locally stored key, if any, and reports honestly whether one existed. |

The default summary's `totals` include evidence counters (`evidenceBundles`, `evidenceFragments`, `evidenceTruncatedFragments`, `evidenceOmitted`, `evidenceDenied`, `evidenceUnresolved`), and each file entry carries `evidenceBundleCount`. Bundle *contents* — fragment text, spans, hashes — never appear in the default line; only `--inspect-payloads` prints them.

## Local API key storage (`auth login` / `auth status` / `auth logout`)

`--evaluate` needs a TypeSafe API key. Local storage is a per-user file scoped to this tool, not a global environment variable — `TYPESAFE_API_KEY` remains supported and is checked first, so CI keeps injecting it as a GitHub repository secret.

- **Precedence**: `TYPESAFE_API_KEY` (non-blank) wins whenever it is set, so CI/automation setups are unaffected; otherwise the locally stored file's key is used; otherwise `--evaluate` is a usage error (exit 1, no network attempted) that names both ways to provide a key.
- **`auth login`** reads the key from a no-echo interactive prompt when stdin is a TTY (raw mode, no character echoed, Ctrl+C cancels cleanly and always restores the terminal), or one trimmed line from stdin otherwise, so scripted/CI setup can pipe a key in. The key is **never** accepted as a command-line argument — that would leak it into shell history and the process list. A blank/whitespace-only key is rejected; nothing is written.
- **`auth status`** reports whether a key is available, which source would win (`environment` or `stored`), and the stored file's path and permission state. It never prints the key, or any part of it (no masking, no last-four characters).
- **`auth logout`** deletes the stored file and reports honestly whether one existed.
- **Storage location**:
  - POSIX: `$XDG_CONFIG_HOME/jev-test-auditor/credentials.json`, or `~/.config/jev-test-auditor/credentials.json` when `XDG_CONFIG_HOME` is unset.
  - Windows: `%APPDATA%\jev-test-auditor\credentials.json`.
  - The containing directory is created with mode `0o700` and the file with mode `0o600`, both set **at creation** (never write-then-`chmod`, which would leave a window where the file is world-readable) via a temp-file-plus-atomic-rename sequence.
  - On POSIX, a stored file whose permissions are more permissive than owner-only is refused (fail closed) rather than silently trusted — `auth status`/`--evaluate` report the problem and how to fix it (`chmod 600 <path>`, or `auth login` again to recreate it).
  - **Windows does not enforce file permissions.** This tool does not verify or claim to verify them there; `auth status` says so plainly.
- **The stored file holds the key in plaintext**, readable by any process running as the same user. A system keychain was considered and deliberately deferred (Phase 4 Decisions) — do not treat this file as hardened secret storage. Prefer `TYPESAFE_API_KEY` for shared/CI machines.
- **CI guidance**: add the key as a GitHub repository secret and inject it as the `TYPESAFE_API_KEY` environment variable in the workflow step that runs `audit --evaluate`. `auth login`'s interactive prompt is for local developer use only.

## Jev evaluation (`audit --evaluate`)

`--evaluate` is opt-in only. Without it, `jev-test-auditor` never leaves this machine: no gateway is constructed, no API key is read, and no network call is ever attempted — proven by tests that stub `fetch` to throw during a real audit run. Passing `--evaluate`:

- **Costs money and sends evidence to TypeSafe.** Every evaluable test case's local evidence bundle (test body plus its minimal helper/production-seam fragments and provenance — never the whole repository, never audited code executed) is sent as one Jev request. Pricing is USD 0.042 per 1,000,000 input tokens (output tokens are unbilled); see `JEV_ESTIMATE_SNAPSHOT` in `src/domain/estimate.ts` and `audit --dry-run` for a no-network cost preview before spending anything for real.
- **Requires a TypeSafe API key** from `TYPESAFE_API_KEY` or `auth login` (see "Local API key storage" above) — never logged, printed, serialized, or included in any report or error message. Having neither is a usage error (exit 1) before any request is attempted.
- **Runs with bounded concurrency**: a fixed pool sized from configuration's `concurrency` (default 4), no adaptive throttling (a later phase's concern). Verified provider rate limits: 250,000 input tokens/second, 1,200 requests/minute (`JEV_VERIFIED_RATE_LIMITS`).
- **Never fabricates a verdict.** A failed evaluation (rate limit, timeout, malformed response, etc.) produces one `evaluation-failed` diagnostic naming the test case and the error's typed kind — never the API key or the request body — and contributes no classification; it is never counted as healthy.
- **Thresholds are provisional and uncalibrated.** `CLASSIFICATION_POLICY_V1`'s applicability/confidence/level cut points are versioned guesses, not validated claims — a later benchmark phase calibrates them.
- **`needs-review` means uncertainty, not a passing or failing grade.** It covers a model-pin mismatch, a dimension with a low-confidence or missing answer, or a test case where every dimension came back not-applicable — insufficient evidence or certainty, never an invented score.
- **A model-pin mismatch is always reported, never hidden**: every request pins the exact `jev-1.13.0` model id, and each classification's `model.matchesPin` — plus the run-level `modelMismatches` count in `--evaluate --json` — surfaces any response that answered with a different model.

## Dry-run cost and call estimate

`audit --dry-run` (and `--dry-run --json`) previews the aggregate Jev calls and cost an audit would make, without ever calling Jev, requiring an API key, or writing anything to disk. It runs the exact same no-network, no-write discovery/extraction/evidence pipeline as a normal audit, then reports:

- **Exact**: discovered test-case count; `evaluable` count and `skipped` count broken down by reason (`skip`, `todo`, `evidence-unavailable` — no evidence bundle was built for that test case); `initialCalls` (one Jev call per evaluable test case); `evidenceBytes` (the exact sum of `canonicalizeEvidenceBundle` UTF-8 byte lengths over every evaluable bundle). A conditional `skipIf`/`runIf` modifier counts as evaluable — it is a runtime condition, not a statically known skip.
- **A possible range, exactly bounded**: `followUpCalls` (`0` to `evaluable * maxFollowUpsPerTest`) — a follow-up call happens only when an earlier Jev result identifies a specific evidence need, never an automatic retry, so the true count is unknown ahead of time but its upper bound is exact.
- **Clearly labeled approximate**: `estimatedInputTokens`, `estimatedFollowUpInputTokens`, and `estimatedUsd` ranges, derived from evidence bytes through a versioned local `bytesPerToken`/`requestOverheadTokens`/`usdPerMillionInputTokens` pricing snapshot (`JEV_ESTIMATE_SNAPSHOT` in `src/domain/estimate.ts`; the exact pinned model `jev-1.13.0`, USD 0.042 per 1,000,000 input tokens, output tokens unbilled, as of 2026-09-19). `bundlesOverCeiling` counts evaluable bundles whose own worst-case tokens would exceed the provider's 64k-token request ceiling (expected `0` under the current evidence budgets).
- `--dry-run` still previews with approximate token math (evidence bytes divided by a bytes-per-token range) rather than the exact wire request; `audit --evaluate` (see below) sends the exact request and reports exact usage from the provider's own response. A later phase adds cache-hit and billable-call accuracy on top of that.

## Delivery phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | One TypeScript package, inward dependency boundaries, configuration, and CLI entry point. | **Completed** |
| 2. Test understanding | Discover and parse Jest/Vitest tests into deterministic structural test understanding (test cases, imports, mocks, assertions). | **Completed** |
| 3. Evidence and context | For every extracted test case, resolve its relative imports safely and select the smallest useful helper/production-seam evidence within configured budgets, exposed locally through `--inspect-payloads`, plus a no-network `--dry-run` cost/call estimate. | **Completed** |
| 4. Jev evaluation MVP | Versioned rubric and request composition, a TypeSafe HTTP gateway, deterministic non-compensatory classification, opt-in `audit --evaluate` wiring with terminal and canonical JSON reporting, and local per-user API key storage (`auth login`/`status`/`logout`). | **Completed** |
| 5. Persistence, caching, and resilience | SQLite run store and cache, `--fresh`/resume, adaptive scheduling, and provider-throttling resilience. | Planned; not implemented |
| 6. HTML reporting | Self-contained offline HTML renderer embedding the canonical JSON report. | Planned; not implemented |
| 7. Benchmarks and calibration | Deterministic benchmark corpus, executable oracles, and calibrating `CLASSIFICATION_POLICY_V1`'s provisional thresholds. | Planned; not implemented |

## Evidence bundles

- **Budgets**: each fragment is capped at `maxFragmentBytes` (default 4 KiB) and each bundle at `maxBundleBytes` (default 16 KiB), overridable through configuration (`evidence: { maxFragmentBytes, maxBundleBytes }`); values are provisional until later calibration. A fragment that would overflow is truncated at the last fitting line (falling back to a UTF-8-safe byte cut); a fragment that cannot fit at all is recorded as `omitted` rather than invented.
- **Deny list**: sensitive, generated, and vendor paths (`.env*`, `*.pem`, `*.key`, `**/node_modules/**`, `**/dist/**`, and more — see `DEFAULT_EVIDENCE_DENY_PATTERNS`) are denied *before* any read. Configuration (`evidence: { deny: [...] }`) adds patterns on top of these defaults; it can never remove or replace them.
- **Import depth**: direct relative imports of the test file (hop 1), plus one extra hop only through helper files (a test file, a file under `test`/`tests`/`__tests__`/`__mocks__`, or a file whose basename contains `helper`, `fixture`, or `setup`). Production files are never expanded further. Only relative specifiers are resolved; bare and aliased specifiers are recorded as `unresolved` with a reason.
- **Failure isolation, two levels, never a placeholder bundle**: uncertainty is not quality, so a failure never produces an empty-but-structurally-valid bundle standing in for "this test genuinely has no supporting evidence." A whole-file failure (e.g. a helper read failing) is isolated to that file — one `evidence-failed` diagnostic naming the path, an empty `evidence` array for that file, every other file unaffected. A single test case's selection failing does not drop that file's other bundles, and produces no bundle of its own — only one `evidence-selection-failed` diagnostic naming that test case's id and name. Either way the diagnostic is merged into both the file's own diagnostics and the root `diagnostics` (with the file path attached), exactly like an extraction diagnostic. `evidenceBundleCount` and the evidence totals always reflect only the bundles that were actually built. Nothing here executes audited code, package scripts, test runners, or configuration modules.
- **Nothing is sent anywhere by default**: evidence selection is entirely local, and no network call is ever made unless `--evaluate` is explicitly passed. `src/` contains no raw network module import (no `node:http`/`node:https`/`node:net`/`node:tls`/`undici`) anywhere, and exactly one reviewed `fetch(...)` call site exists in the whole codebase — the TypeSafe HTTP gateway adapter used only by `--evaluate` — enforced by an architecture test alongside the inward-dependency check.

## Product boundaries

- Supports JavaScript and TypeScript repositories, with Jest and Vitest as the V1 frameworks.
- Findings target test files only; narrowly related production code is supporting evidence, not an independent finding target.
- E2E frameworks, automatic test rewriting, general source review, and languages outside JavaScript/TypeScript are out of scope.
- Discovery is repository-local and lexical. Generated/vendor/build paths, symlink escapes, and conservative E2E signals are excluded explicitly.
- The audit pipeline is reporting-only: it never executes audited source, package scripts, test runners, or configuration modules. Read and parse diagnostics are emitted in JSON and do not fail the audit.
- Phases 2 and 3 emit structural test understanding and local evidence bundles only, with no network access. Phase 4 adds real Jev evaluation and classification, opt-in only via `--evaluate`. Persistence, caching, resilience, HTML reports, and SQLite remain future phases.
- CI is reporting-only in V1; findings do not fail a build.
- Normal operation is autonomous and does not require human-in-the-loop labeling or approval.

## Architecture

The repository remains one package and one process. Dependencies point inward: the CLI and adapters depend on application services, application services depend on domain contracts, and domain code does not import CLI, adapter, infrastructure, filesystem, or provider concerns.

See the [architecture diagram](docs/architecture.html), [product requirements](docs/PRD.md), [technical design](docs/technical-design.md), and [implementation plan](docs/implementation-plan.md).
