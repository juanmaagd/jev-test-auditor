# jev-test-auditor

`jev-test-auditor` is a local-first CLI for auditing the semantic quality of existing JavaScript and TypeScript tests. The pipeline discovers supported test files, reads them without executing project code, extracts deterministic structural test understanding, and — for every extracted test case — selects a minimal, provenance-aware local evidence bundle (the test body plus the smallest useful helper and production fragments it references). By default nothing built here is sent anywhere: discovery, extraction, evidence selection, and the default `audit` summary are entirely offline and need no API key. Real Jev evaluation is opt-in only (`audit --evaluate`, see below) — nothing leaves this machine unless that flag is passed, and `--evaluate` also persists its results to a local SQLite database (see "Audit store" below). Caching, resume, adaptive scheduling, HTML reports, and benchmarks/calibration are later phases.

## Quick path

Requires Node **>=22.13.0** — `audit --evaluate`'s local persistence (see "Audit store" below) uses the built-in `node:sqlite` module, unflagged only as of that release; it remains Stability 1.2 (release candidate).

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
| `audit` | Discovers `.test`/`.spec` JavaScript and TypeScript files, extracts Jest/Vitest/bun:test test cases, selects each test case's local evidence bundle, and prints a reporting-only JSON summary. Diagnostics do not change the zero exit status. |
| `audit --rootDir <path>` | Audits a configured repository root instead of the current directory. |
| `audit --inspect-payloads` | Prints the same summary line first, then one JSON line per selected evidence bundle (`canonicalizeEvidenceBundle` output), ordered by file path then test-case order. This is the local evidence state selected on disk — fragments, provenance, denials, truncation — **not** the Jev wire request shape, and it makes no network call either way. Cannot be combined with `--dry-run` or `--evaluate`. |
| `audit --dry-run` | Prints a no-network, no-write aggregate cost/call preview **instead of** the normal summary: exact discovered/evaluable/skipped-by-reason counts, exact initial Jev calls (one per evaluable test case), exact evidence bytes and exact real request bytes (the actual `state` plus every rubric question, measured by building each real request locally), plus clearly labeled *approximate* input-token and USD ranges converted from those request bytes via a versioned local pricing snapshot. Makes no network or provider call, requires no API key, and writes nothing to disk. Cannot be combined with `--inspect-payloads` or `--evaluate`. |
| `audit --dry-run --json` | Same dry-run preview as one machine-readable JSON line (stable key order) instead of the human-readable text report. Requires `--dry-run`. |
| `audit --evaluate` | Opt-in only. Sends every evaluable test case's local evidence bundle to TypeSafe's Jev model for a real semantic judgment, replacing the normal summary with a terminal evaluation report (status counts, skipped-by-reason, failed count, total usage input tokens, and the responded model id), and persists the run locally to SQLite (see "Audit store" below). Requires `TYPESAFE_API_KEY`; its absence is a usage error (exit 1, no network attempted). Cannot be combined with `--dry-run` or `--inspect-payloads`. See "Jev evaluation" below. |
| `audit --evaluate --json` | Same evaluation run as one deterministic canonical JSON line instead of the terminal report: per-test classification, per-dimension judgments, findings, model requested/responded/matchesPin, usage, policy/rubric versions, and evidence provenance counts. Requires `--evaluate`. |
| `audit --json` (alone) | Usage error (exit 1): `--json` requires `--dry-run` or `--evaluate`. |
| `auth login` | Stores a TypeSafe API key locally for this tool. Reads from a no-echo interactive prompt when stdin is a TTY; reads one trimmed line from stdin otherwise, so automation/CI can pipe a key in. **Never** accepts the key as a command-line argument — see "Local API key storage" below. |
| `auth status` | Reports whether a key is available, which source would win (`environment` or `stored`), and the stored file's path and permission status. Never prints the key itself. |
| `auth logout` | Deletes the locally stored key, if any, and reports honestly whether one existed. |

The default summary's `totals` include evidence counters (`evidenceBundles`, `evidenceFragments`, `evidenceTruncatedFragments`, `evidenceOmitted`, `evidenceDenied`, `evidenceUnresolved`), and each file entry carries `evidenceBundleCount`. Bundle *contents* — fragment text, spans, hashes — never appear in the default line; only `--inspect-payloads` prints them.

**An unattributable framework is reported, never silently counted as zero tests.** A discovered, included test file whose framework cannot be attributed (no recognized import, or conflicting evidence — e.g. both Jest and Vitest imported) and that yields zero test cases produces one `unsupported-framework` warning diagnostic naming the test-framework-looking imports actually found (e.g. `node:test`), or stating plainly that none were found. It is merged into both that file's own diagnostics and the root `diagnostics`, exactly like an extraction diagnostic, and `totals.unsupportedFrameworkFiles` counts how many files carry one — so a reader sees "we don't understand this framework" without reading every record, instead of a report that reads identical to a genuinely empty repository. A recognized framework with genuinely zero test cases (an empty Vitest helper file, say) never produces this warning — it is about silence, not about the framework alone, and it never invents a framework or a test case.

**`bun:test` is a fully supported V1 framework, not just recognized evidence.** A file that statically imports (or `require`s) `bun:test` attributes framework `bun` and extracts the same suite/case/modifier/hook/mock/assertion/parameter-table structures Jest and Vitest do, including `test.serial` (preserved as its own modifier kind — bun-only, no Jest/Vitest equivalent) and the `mock`/`spyOn`/`jest` surface bun re-exports (recorded under a `bun.`-prefixed `MockApi`, e.g. `bun.mock.module`, `bun.jest.fn`, so a bun-provenanced call is never confused with real Jest). Conflicting framework evidence in the same file (e.g. both `bun:test` and `vitest` imported) stays `unknown`, exactly like a Jest/Vitest conflict. Still deliberately out of scope: `*_test.*`/`*_spec.*` filename patterns and the `.mjs`/`.cjs`/`.mts`/`.cts` discovery extensions bun also supports — a file only reaches extraction once discovery's existing `.test`/`.spec` JS/JSX/TS/TSX pattern matches it.

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

- **Costs money and sends evidence to TypeSafe.** Every evaluable test case's local evidence bundle (test body plus its minimal helper/production-seam fragments and provenance — never the whole repository, never audited code executed) is sent as one Jev request, batched with all 14 rubric questions (`RUBRIC_V2`, the shipped rubric as of `odd/tasks/classification-calibration.md` task C-2, which repairs the `determinism-isolation`/`falsifiability` applicability questions; `RUBRIC_V1` is kept only for replaying the pre-C-2 recorded evidence). Pricing is USD 0.042 per 1,000,000 input tokens (output tokens are unbilled); see `JEV_ESTIMATE_SNAPSHOT` in `src/domain/estimate.ts` and `audit --dry-run` for a no-network cost preview before spending anything for real. **The rubric's own questions dominate a request's bytes, not the evidence** — the first real run (11 requests, 2026-09-20, under `RUBRIC_V1`) measured the rubric text at ~93% of the average request's bytes, which is why `--dry-run` measures the real request instead of estimating from evidence bytes alone (see below).
- **Requires a TypeSafe API key** from `TYPESAFE_API_KEY` or `auth login` (see "Local API key storage" above) — never logged, printed, serialized, or included in any report or error message. Having neither is a usage error (exit 1) before any request is attempted.
- **Runs with bounded concurrency**: a fixed pool sized from configuration's `concurrency` (default 4), no adaptive throttling (a later phase's concern). Verified provider rate limits: 250,000 input tokens/second, 1,200 requests/minute (`JEV_VERIFIED_RATE_LIMITS`).
- **Never fabricates a verdict.** A failed evaluation (rate limit, timeout, malformed response, etc.) produces one `evaluation-failed` diagnostic naming the test case and the error's typed kind — never the API key or the request body — and contributes no classification; it is never counted as healthy.
- **Classification thresholds are provisional and versioned, not calibrated claims.** See "Classification policy" below for how a dimension's level and the overall verdict are actually decided, and the measured results recorded there.
- **`needs-review` means uncertainty, not a passing or failing grade.** It covers a model-pin mismatch, a dimension with a low-confidence or missing answer, or a test case where every dimension came back not-applicable — insufficient evidence or certainty, never an invented score.
- **A model-pin mismatch is always reported, never hidden**: every request pins the exact `jev-1.13.0` model id, and each classification's `model.matchesPin` — plus the run-level `modelMismatches` count in `--evaluate --json` — surfaces any response that answered with a different model.

## Audit store (SQLite persistence)

`audit --evaluate` persists every terminal work-item outcome to a local, per-user SQLite database, in addition to printing the evaluation report: runs, work items and their terminal states, attempts (raw answers and token usage), normalized judgments, errors, and skips. **The API key never reaches the database.**

- **Strictly opt-in.** An audit without `--evaluate` creates no database file and no config directory at all — the store is only constructed after a usable API key has already resolved, exactly like the evaluation port it is gated behind.
- **Storage location**: the same per-user config home convention as the stored API key (see "Local API key storage" above) — POSIX: `$XDG_CONFIG_HOME/jev-test-auditor`, or `~/.config/jev-test-auditor` when unset; Windows: `%APPDATA%\jev-test-auditor` — under its own `audit-store.sqlite3` file (so it never collides with `credentials.json`), inside a directory created owner-only (`0o700` on POSIX; Windows does not enforce this, same as the credentials directory above). Overridable with the `store.databasePath` configuration key (`store: { databasePath: '/custom/path.sqlite3' }`), the same override pattern as `evidence: { maxFragmentBytes, maxBundleBytes }` below.
- **Append-only.** No run, work item, attempt, judgment, error, or skip record is ever updated or deleted once written — history accumulates across every `--evaluate` run. The one exception is a run's own `finished_at` marker, set once when that run completes; it never rewrites a fact already recorded about a test case.
- **Not yet built**: content-addressed caching, `--fresh`, `--resume`, and adaptive scheduling — see "Delivery phases" below.

## Classification policy

Each rubric dimension is judged independently, then combined into one non-compensatory verdict per test: `healthy`, `weak`, `misleading`, or `needs-review`. The verdict only ever depends on a single boundary — deficient (`misleading`/`weak`) versus acceptable (`acceptable`/`strong`) — and any judged `misleading` dimension forces the whole test `misleading` regardless of what else scored well; a strong dimension never cancels a critical failure elsewhere.

As of `odd/tasks/classification-calibration.md` task C-1, a dimension's level is decided from the quality answer's probability distribution across its four levels, not from `confidence` or the weighted `score` alone. For each applicable dimension the tool computes:

- `deficientMass` — the probability on `misleading` + `weak`.
- `acceptableMass` — the probability on `acceptable` + `strong`.
- `criticalMass` — the probability on `misleading` alone.

A dimension is deficient when `deficientMass` clears `sideMin` (0.65) and acceptable when `acceptableMass` does; a deficient dimension is reported `misleading` only when `criticalMass` also clears `criticalMin` (0.5), otherwise `weak`. `needs-review` at the dimension level now means the mass genuinely straddles that one boundary — not that the answer merely leaned toward two adjacent levels on the same side of it, which is what the earlier `confidence`-based gate mistook for uncertainty.

`score` and `confidence` are still reported on every dimension for transparency and audit — the full `probabilities`/`deficientMass`/`acceptableMass`/`criticalMass` breakdown appears in `--evaluate --json` — but neither is consulted to decide a level any more. That means a dimension can show a `score` under 2 (nominally "weak" by the old cut points) and still be reported `acceptable`: on the recorded pr-hero run below, one dimension scored 1.97 with a distribution of `{weak: 0.06, acceptable: 0.91, strong: 0.03}` — 94% of the mass on acceptable-or-better — and was correctly reported `acceptable`. A sub-2 score on a `healthy` test is not a bug; it means the model leaned decisively toward one side even though its weighted mean happened to sit near the old boundary.

This is `CLASSIFICATION_POLICY_V2`, paired with `RUBRIC_V2` (task C-2, which rewrote the `determinism-isolation` and `falsifiability` applicability questions so they ask whether the shown evidence supports a judgment, not whether every possible influence is visible — the two dimensions were excluding themselves on tests Jev could actually judge). Both are what the shipped `--evaluate` path uses; `CLASSIFICATION_POLICY_V1` and `RUBRIC_V1` remain exported only to replay real provider output recorded before this change.

**Thresholds remain provisional and versioned, not calibrated claims.** `applicabilityMin` (0.5), `sideMin` (0.65), and `criticalMin` (0.5) were picked mid-gap from ranges observed in one recorded run, not fit to a validated outcome; Phase 7 ("Benchmarks and calibration") is what calibrates them, and any recalibration ships as a new policy version, never a silent edit.

### Measured results (2026-09-20)

Two real recorded runs, replayed and re-run against `test/fixtures/recorded/`:

| Discrimination fixture — 11 tests, 3 good controls / 8 deliberately bad | Before | V2 policy, same recorded answers | After |
| --- | --- | --- | --- |
| healthy | 0 | 3 | 3 |
| weak | 2 | 2 | 1 |
| misleading | 6 | 6 | 7 |
| needs-review | 3 | 0 | 0 |

The middle column isolates the policy change from provider variance: it is `CLASSIFICATION_POLICY_V2` replayed against the exact same `discrimination-raw-2026-09-20.json` answers as "Before" (`test/classification-replay.test.ts`, task C-1 alone, before the rubric fix) — no new model call, same evidence, same answers. It already proves "no bad test absolved": all 6 misleading and 2 weak verdicts are unchanged, and only the 3 good controls move, from `needs-review` to `healthy`. "After" is a separate, later live run with the rubric fix as well, so its difference from the middle column reflects a fresh provider call plus the rubric change, not the classification policy alone.

| pr-hero subset — 63 real tests | Before | After |
| --- | --- | --- |
| healthy | 16 | 56 |
| weak | 6 | 0 |
| misleading | 0 | 0 |
| needs-review | 41 | 7 |
| not-applicable dimension judgments | 30 (24 `determinism-isolation` + 6 `falsifiability`) | 0 |

"Before" is `CLASSIFICATION_POLICY_V1` + `RUBRIC_V1`, replayed against `discrimination-raw-2026-09-20.json`'s real recorded answers (`test/classification-replay.test.ts`) and, separately, the live `pr-hero-subset-2026-09-20.json` run. "After" is `CLASSIFICATION_POLICY_V2` + `RUBRIC_V2`, live: `discrimination-rubric-v2-2026-09-20.json` and `pr-hero-subset-calibrated-2026-09-20.json`.

On pr-hero, 6 tests moved `weak` → `healthy` and 34 moved `needs-review` → `healthy`; 16 were already `healthy` and 7 stayed `needs-review`; no test moved toward a more severe status. Across the 433 dimensions that run actually judged, zero reported a deficient level (`misleading`/`weak`) whose `acceptableMass` exceeded its `deficientMass` — the reported level and the mass behind it never disagree.

On the discrimination fixture, `determinism-isolation` applicability rose from below the 0.5 threshold on 7 of 11 tests (0.12–0.18) to 0.89–0.96 on all 11; `falsifiability` rose from below threshold on 4 of 11 tests (0.35–0.48) to 0.72–0.97 on all 11. One test, `records history across runs`, moved `weak` → `misleading` — not toward healthier: once `determinism-isolation` became applicable it scored `misleading` on its own (`deficientMass` 0.97, `criticalMass` 0.74), a real defect the self-excluding v1 question had hidden.

**What this shows, and what it does not.** Both runs show the same shape: severity was preserved on tests deliberately written to be bad, while a real repository's verdicts stopped being dominated by `needs-review`. It does **not** show that the classifier is accurate. The discrimination fixture's bad tests are obvious by construction, written with the rubric in mind; it has only 3 good controls; and neither run has ground truth independent of the fixture author's own intent. Accuracy is a later-phase question, answered by Phase 7's deterministic mutation benchmarks and executable oracles, not by these two runs.

## Dry-run cost and call estimate

`audit --dry-run` (and `--dry-run --json`) previews the aggregate Jev calls and cost an audit would make, without ever calling Jev, requiring an API key, or writing anything to disk. It runs the exact same no-network, no-write discovery/extraction/evidence pipeline as a normal audit, then reports:

- **Exact**: discovered test-case count; `evaluable` count and `skipped` count broken down by reason (`skip`, `todo`, `evidence-unavailable` — no evidence bundle was built for that test case); `initialCalls` (one Jev call per evaluable test case); `evidenceBytes` (the exact sum of `canonicalizeEvidenceBundle` UTF-8 byte lengths over every evaluable bundle — the local evidence footprint, kept for its own sake); `requestBytes` (the exact sum of `canonicalizeJevRequest(buildJevRequest({testCase, bundle, rubric}))` UTF-8 byte lengths over every evaluable test case — the actual request Jev would receive, `state` plus every rubric question); `rubricBytesPerRequest` (the exact byte length of just the rubric's own `questions` map, the same for every request under a given rubric, independent of test-case count — this is what makes `requestBytes` so much larger than `evidenceBytes`). A conditional `skipIf`/`runIf` modifier counts as evaluable — it is a runtime condition, not a statically known skip.
- **A possible range, exactly bounded**: `followUpCalls` (`0` to `evaluable * maxFollowUpsPerTest`) — a follow-up call happens only when an earlier Jev result identifies a specific evidence need, never an automatic retry, so the true count is unknown ahead of time but its upper bound is exact.
- **Clearly labeled approximate**: `estimatedInputTokens`, `estimatedFollowUpInputTokens`, and `estimatedUsd` ranges, converted from `requestBytes` (not `evidenceBytes`) through a versioned local `bytesPerToken`/`usdPerMillionInputTokens` pricing snapshot (`JEV_ESTIMATE_SNAPSHOT` in `src/domain/estimate.ts`; the exact pinned model `jev-1.13.0`, USD 0.042 per 1,000,000 input tokens, output tokens unbilled, as of 2026-09-20). `bytesPerToken` (`3.0`–`4.8`) is calibrated from the first real Jev run's measured ratio of 4.458 bytes/token (320,360 canonical request bytes / 71,855 billed input tokens across 11 requests) — provisional, from one real run of English/TypeScript content, not a broad statistical sample. The bounds are deliberately asymmetric: a ratio above `max` only overestimates cost (harmless), but a ratio below `min` would understate what is actually billed, so `min` is set well below the single observed sample rather than tight around it — JSON-heavy or non-Latin/CJK evidence can tokenize below even this floor, a known current limit. `bundlesOverCeiling` counts evaluable test cases whose own real request's worst-case tokens would exceed the provider's 64k-token request ceiling (expected `0` under the current evidence budgets).
- **No more guessed overhead.** A previous version of this estimator added a guessed `requestOverheadTokens` range (620–2,440 tokens) on top of evidence bytes to stand in for the rubric's cost. The first real run showed that guess was wrong by roughly 2.5x (the rubric alone costs ~5,900 tokens per request) and unnecessary — the rubric is in the repository, so `--dry-run` now builds the real request and measures it instead of guessing. `requestOverheadTokens` no longer exists on `JEV_ESTIMATE_SNAPSHOT`.
- `audit --evaluate` (see below) sends this exact same request and reports exact usage from the provider's own response. A later phase adds cache-hit and billable-call accuracy on top of that.

## Delivery phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | One TypeScript package, inward dependency boundaries, configuration, and CLI entry point. | **Completed** |
| 2. Test understanding | Discover and parse Jest/Vitest/bun:test tests into deterministic structural test understanding (test cases, imports, mocks, assertions). | **Completed** |
| 3. Evidence and context | For every extracted test case, resolve its relative imports safely and select the smallest useful helper/production-seam evidence within configured budgets, exposed locally through `--inspect-payloads`, plus a no-network `--dry-run` cost/call estimate. | **Completed** |
| 4. Jev evaluation MVP | Versioned rubric and request composition, a TypeSafe HTTP gateway, deterministic non-compensatory classification, opt-in `audit --evaluate` wiring with terminal and canonical JSON reporting, and local per-user API key storage (`auth login`/`status`/`logout`). | **Completed** |
| 5. Persistence, caching, and resilience | SQLite run store and cache, `--fresh`/resume, adaptive scheduling, and provider-throttling resilience. | **In progress** — SQLite run store shipped (task P5-1, see "Audit store" above); cache, `--fresh`/`--resume`, and adaptive scheduling not yet built |
| 6. HTML reporting | Self-contained offline HTML renderer embedding the canonical JSON report. | Planned; not implemented |
| 7. Benchmarks and calibration | Deterministic benchmark corpus, executable oracles, and calibrating the classification policy's provisional thresholds. | Planned; not implemented |

## Evidence bundles

- **Budgets**: each fragment is capped at `maxFragmentBytes` (default 4 KiB) and each bundle at `maxBundleBytes` (default 16 KiB), overridable through configuration (`evidence: { maxFragmentBytes, maxBundleBytes }`); values are provisional until later calibration. A fragment that would overflow is truncated at the last fitting line (falling back to a UTF-8-safe byte cut); a fragment that cannot fit at all is recorded as `omitted` rather than invented.
- **Deny list**: sensitive, generated, and vendor paths (`.env*`, `*.pem`, `*.key`, `**/node_modules/**`, `**/dist/**`, and more — see `DEFAULT_EVIDENCE_DENY_PATTERNS`) are denied *before* any read. Configuration (`evidence: { deny: [...] }`) adds patterns on top of these defaults; it can never remove or replace them.
- **Import depth**: direct imports of the test file (hop 1), plus one extra hop only through helper files (a test file, a file under `test`/`tests`/`__tests__`/`__mocks__`, or a file whose basename contains `helper`, `fixture`, or `setup`). Production files are never expanded further. A relative specifier resolves lexically; a non-relative specifier is checked against the importing file's own alias configuration first (see below) before falling back to `unresolved` (`bare-specifier`/`alias-specifier`).
- **Alias, subpath import, and workspace resolution**: a non-relative specifier is checked against the importing file's own statically declared configuration — read as text and never executed — before it is ever classified `bare-specifier`/`alias-specifier`. Three mechanisms are read, each from the **nearest** configuration above the importing file, not just the repository root:
  - **Node subpath `imports`** — the nearest `package.json`'s `imports` map, `#name`/`#name/*` keys only. A conditional value picks `default`, then `import`, then `node`; any other condition is recorded (`imports-unsupported-conditions`) rather than guessed at.
  - **TypeScript/JavaScript `paths` and `baseUrl`** — `tsconfig.json`/`jsconfig.json` `compilerOptions.paths`, following in-root `extends` chains (`tsconfig.json` wins over `jsconfig.json` at the same directory level; a nearer directory always wins over a farther one). `paths` targets resolve relative to the effective `baseUrl`'s directory when one exists anywhere in the chain, matching TypeScript's own rule, or relative to the directory of whichever config declared `paths` when no `baseUrl` exists at all. An `extends` target outside the repository root or inside `node_modules` is refused and recorded, never followed; a cycle is caught and recorded, never recursed into. `baseUrl` alone (no `paths`) also acts as a bare `*` catch-all, applied last and only when nothing else matched — a `baseUrl`-only config never mislabels an ordinary npm import (e.g. `lodash`) as a stale alias, because an unmatched `baseUrl` catch-all does not produce `alias-mapped-not-found`.
  - **Workspace package names** — read once from the **root** `package.json`'s `workspaces` globs and each member package's own `name` (workspaces are root-only; the other two mechanisms use the nearest config). A bare package name prefers real source over generated output: `packageDir/src/index`, then the package directory's own top-level files, then the package's declared `exports['.']`/`main` entry — so a package whose declared entry is `dist` build output resolves to source when source exists, and is reported `denied` (never silently dropped) only when it does not. A `name/*` subpath maps straight to `dir/*`, without consulting `exports` subpaths other than `.`.

  Precedence when more than one mechanism could apply: `imports` → `paths` → `workspace` → `baseUrl`. Within one mechanism, TypeScript's own matching rule applies: an exact (star-less) pattern always beats a wildcard; among matching wildcards, the longest prefix wins, ties broken by declaration order; a pattern with two or more `*` never matches anything. A matched entry's targets are tried in declaration order, re-checking containment after wildcard substitution (the specifier's captured text is caller-controlled). Every resolved target — mapped or relative — still passes the same extension/index probing, deny list, and realpath containment described above, unchanged. A specifier matched by a declared `imports`/`paths`/workspace entry whose every target is missing is reported `alias-mapped-not-found`, distinguishing a stale mapping from a specifier no mechanism recognized. A hop-2 helper file's specifiers use the **helper's own** nearest configuration, never the test file's.

  **Not resolved**: bundler-specific aliases (webpack/vite `resolve.alias` and similar plugins), anything that would require executing project code or configuration, `node_modules` contents (including an `extends` target that resolves into `node_modules`, such as an npm-published base tsconfig), and `exports` conditional subpaths other than `.` on a workspace package. Separately, and unchanged from relative resolution: discovery itself still only finds `.test`/`.spec` JS/JSX/TS/TSX files, so the deferred `*_test.*`/`*_spec.*` filename patterns and extra test-file extensions bun also supports never reach resolution at all — that limit is about which test files are found, not which of a found file's imports resolve.

  **Known limitation.** When an alias-mapped specifier's first existing target is denied, resolves outside the repository root, or has an unsupported extension, resolution stops there — it does not fall through to try a later-precedence mechanism for the same specifier, even if one would have resolved differently. Checked on musive-s1, the only repository with denials: every denial is a workspace package's `dist` entry, and the only lower-precedence mechanism left to fall through to is `baseUrl` (`.` at each package's own directory) — no package tree contains a literal `@<scope>/<name>` subdirectory a `baseUrl` catch-all could ever have matched instead, so the divergence was inert here. It is not proven correct in general.

  **Measured effect**, re-measured independently 2026-09-20 against the same four repositories A-2 recorded, and matching A-2's numbers exactly in every cell: "before" ran `bd74fbd` (the commit immediately before alias resolution was wired into evidence resolution) built in a throwaway git worktree; "after" ran this branch's build (`audit --rootDir <repo>`):

  | Repository | Mechanism(s) present | Fragments / tests (before → after) | Fragments per test (before → after) | Unresolved (before → after) | Denied (before → after) |
  | --- | --- | --- | --- | --- | --- |
  | pr-hero | subpath `imports` | 5,188/3,597 → 8,372/3,597 | 1.44 → 2.33 | 17,316 → 7,665 | 0 → 0 |
  | supermarket-pro | tsconfig `paths`/`baseUrl` | 21,560/6,677 → 25,480/6,677 | 3.23 → 3.82 | 13,998 → 17,619 | 0 → 0 |
  | musive-s1 | workspaces + inherited `paths` | 12,773/6,828 → 16,993/6,828 | 1.87 → 2.49 | 48,136 → 18,282 | 3 → 4,035 |
  | jev-test-auditor (this repo, no aliases) | none | 1,505/552 → 1,505/552 | 2.73 → 2.73 | 1,294 → 1,294 | 0 → 0 |

  This is not a uniform win, and the unresolved count is not a quality metric on its own — it only reflects how much of the dependency graph became reachable. supermarket-pro's unresolved total **rose**: resolving `paths`/`baseUrl` makes previously-unreachable helper files reachable, and those helpers import their own real npm packages. Measured directly: `alias-specifier` fell from 1,165 to 0, while `bare-specifier` rose from 12,813 to 17,599 as the newly reachable helpers exposed those imports (12,813 + 1,165 + 20 `unsupported-extension` = 13,998 before; 17,599 + 0 + 20 = 17,619 after). musive-s1's denied count rose from 3 to 4,035 — verified as 4,032 `**/dist/**` refusals plus the 3 pre-existing `**/node_modules/**` ones — almost entirely the source-preference rule refusing a workspace package's prebuilt `dist` output once the workspace mechanism made that package reachable at all. The metric that matters is fragments per test: it rose in every repository with a resolvable mechanism, and did not move for this repository, which has none.
- **Failure isolation, two levels, never a placeholder bundle**: uncertainty is not quality, so a failure never produces an empty-but-structurally-valid bundle standing in for "this test genuinely has no supporting evidence." A whole-file failure (e.g. a helper read failing) is isolated to that file — one `evidence-failed` diagnostic naming the path, an empty `evidence` array for that file, every other file unaffected. A single test case's selection failing does not drop that file's other bundles, and produces no bundle of its own — only one `evidence-selection-failed` diagnostic naming that test case's id and name. Either way the diagnostic is merged into both the file's own diagnostics and the root `diagnostics` (with the file path attached), exactly like an extraction diagnostic. `evidenceBundleCount` and the evidence totals always reflect only the bundles that were actually built. Nothing here executes audited code, package scripts, test runners, or configuration modules.
- **Nothing is sent anywhere by default**: evidence selection is entirely local, and no network call is ever made unless `--evaluate` is explicitly passed. `src/` contains no raw network module import (no `node:http`/`node:https`/`node:net`/`node:tls`/`undici`) anywhere, and exactly one reviewed `fetch(...)` call site exists in the whole codebase — the TypeSafe HTTP gateway adapter used only by `--evaluate` — enforced by an architecture test alongside the inward-dependency check.

## Product boundaries

- Supports JavaScript and TypeScript repositories, with Jest, Vitest, and bun:test as the V1 frameworks.
- Findings target test files only; narrowly related production code is supporting evidence, not an independent finding target.
- E2E frameworks, automatic test rewriting, general source review, and languages outside JavaScript/TypeScript are out of scope.
- Discovery is repository-local and lexical. Generated/vendor/build paths, symlink escapes, and conservative E2E signals are excluded explicitly.
- A test file whose framework cannot be attributed is reported (`unsupported-framework` diagnostic, `totals.unsupportedFrameworkFiles`), never silently treated as zero tests — see "Current CLI" above.
- The audit pipeline is reporting-only: it never executes audited source, package scripts, test runners, or configuration modules. Read and parse diagnostics are emitted in JSON and do not fail the audit.
- Phases 2 and 3 emit structural test understanding and local evidence bundles only, with no network access. Phase 4 adds real Jev evaluation and classification, opt-in only via `--evaluate`. Phase 5 adds local SQLite persistence of evaluation results, also behind `--evaluate` (see "Audit store" above); caching, resume, adaptive scheduling, HTML reports, and benchmarks/calibration remain future work.
- CI is reporting-only in V1; findings do not fail a build.
- Normal operation is autonomous and does not require human-in-the-loop labeling or approval.

## Architecture

The repository remains one package and one process. Dependencies point inward: the CLI and adapters depend on application services, application services depend on domain contracts, and domain code does not import CLI, adapter, infrastructure, filesystem, or provider concerns.

See the [architecture diagram](docs/architecture.html), [product requirements](docs/PRD.md), [technical design](docs/technical-design.md), and [implementation plan](docs/implementation-plan.md).
