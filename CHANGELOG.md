# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `audit --evaluate --cache-only`: serves every evaluable test case from the local content-addressed cache only — no TypeSafe request ever, no API key needed. A hit is served and re-classified under the current policy exactly like an ordinary warm-cache hit; a miss is neither dispatched nor counted as failed — it is reported honestly under a new `totals.notCached` count (`Not in cache` in text/HTML/`jta report`). Additive report shape only: `totals.notCached` and the `cacheStatus` value `not-cached` are both optional in `docs/report-schema.json`, so `reportVersion` did not move and an older persisted report still validates. Cannot be combined with `--fresh` or `--resume` (`odd/tasks/cache-only-evaluation.md`).

## [0.1.1] - 2026-09-24

### Added

- Visual HTML overview: `audit --evaluate --html` / `jta report --html` now render a fixed-size aggregate overview — a headline needs-change/needs-review share, a status-share bar, per-dimension diverging bars, a folder × dimension heatmap with adaptive (depth-aware) folder grouping, a top-files ranking, a run-coverage funnel, and diagnostics grouped by code — instead of one row/block per test case (`odd/tasks/html-report-overview.md`). `--html` now also defaults to `report.html` in the invocation directory when no path is given.
- Persisted run reports and `jta report`: every `audit --evaluate` run now writes its canonical JSON report to `<rootDir>/.jta/` (self-ignoring, retaining the 5 most recent runs), and the new read-only `jta report [--last | --run <runId>] [--json | --html [path]] [--open] [--rootDir <dir>]` command reads it back with no API key, network access, or re-evaluation (`odd/tasks/persisted-run-reports.md`).
- Agent skill `skills/jev-test-audit`: a coding-agent skill that reads a persisted report through the bundled `report-query.mjs` query tool (`summary`, `worklist`, `file`, `test`, `folders`, `dimensions`, `batches`, `diff`, `runs` subcommands) and, only with explicit per-batch approval, dispatches one fix subagent per failing test file and verifies the result (`odd/tasks/user-audit-skill.md`).
- Needs-change vs needs-review semantics: the report, HTML overview, `jta report`, and the agent skill now report "needs a change" (misleading/weak — a confirmed defect) and "needs review" (uncertain, never a confirmed defect) as two separate, clearly labeled shares instead of folding them into one headline figure (`odd/tasks/report-needs-change-semantics.md`).
- Pre-dispatch progress: `--evaluate` now reports discovery/extraction/cache-check phases on stderr from the first second of a run, instead of staying silent until the first item dispatches (`odd/tasks/audit-run-responsiveness.md`).
- Store schema 4 adds indexes on `attempts(work_item_id)` and `judgments(work_item_id)`, keeping the content-addressed cache lookup fast as the store grows — measured roughly 2,000x faster on a synthetic 50,000-row store (`odd/tasks/audit-run-responsiveness.md`). An existing store auto-migrates to schema 4 the next time `--evaluate` opens it; a build older than this one refuses a schema-4 store outright (`AuditStoreSchemaVersionError`), so downgrading after upgrading is not supported.
- Policy-free cache: a cache hit now re-derives its classification under the *current* classification policy instead of the policy in force when it was originally recorded, so recalibrating thresholds no longer re-bills an entire suite (`odd/tasks/policy-free-cache-and-calibration.md`).
- `CLASSIFICATION_POLICY_V3`: asymmetric boundary-mass thresholds (`acceptableSideMin` 0.575, `deficientSideMin` 0.65, lowering only the acceptable side), informed by a blind review of in-band dimensions across three real suites (`odd/tasks/policy-free-cache-and-calibration.md`).
- `.github/workflows/ci.yml`: typecheck, lint, test, and build now run in CI on every push to `main` and on pull requests (reporting-only, as before — findings never fail a build).

### Changed

- The `--dry-run` read-only cache lookup now opens the audit store with `mode=ro` instead of `immutable=1`, so it no longer risks a crash or a silent under-count against a store another `--evaluate` process is actively writing to in WAL mode (`odd/tasks/audit-run-responsiveness.md`).
- The self-contained HTML report no longer embeds the full canonical JSON report; per-test detail lives only in `--evaluate --json` / `jta report --json` (`odd/tasks/html-report-overview.md`).
- The HTML report's calibration disclosure now states thresholds are provisional and partially calibrated by a blind review, rather than "uncalibrated".
- `.github/workflows/pr-hero.yml` and `pr-hero-force.yml` now pin `juanmaagd/pr-hero` to a specific commit SHA instead of tracking the moving `dev` branch.
- Run metadata (root, run id, versions, model) in the HTML report now renders after the data sections instead of before them.

### Fixed

- The declared Node.js floor is now `>=22.16.0` (was `>=22.13.0`). On 22.13.0, `node:sqlite` cannot open the `file:` URI the read-only cache lookup (`--dry-run`) and `jta report` rely on; verified against real Node builds. `package.json` `engines`, `install.sh`, README, and CONTRIBUTING agree, and `package-lock.json` is back in sync with `package.json`.
- `.jta/`, the persisted-report folder, is now excluded from discovery by default, so a repeat `--evaluate` run no longer discovers its own prior output as an ordinary excluded file.
- Two documentation wording slips: the read-only guarantee's WAL under-count case, and a mislabeled `wal_autocheckpoint` claim.

## [0.1.0] - 2026-09-22

Initial release: offline test discovery, extraction, and evidence selection for Jest/Vitest/bun:test; opt-in Jev evaluation (`audit --evaluate`) with deterministic, non-compensatory classification; local SQLite persistence, content-addressed caching, adaptive scheduling, and `--resume`; the versioned canonical JSON report; a self-contained offline HTML report; and the deterministic benchmark and calibration infrastructure.
