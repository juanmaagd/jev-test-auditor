# Repository gotchas

Invariants and traps a reviewer should check in every change to `jev-test-auditor`.

## Product boundaries

- The CLI is reporting-only. It never rewrites, deletes, or skips tests, and findings never change the exit code or fail CI. Test fixes belong to the `skills/jev-test-audit` agent skill, and only after the user approves them.
- Tests are the only finding targets. Production code is supporting evidence, never a finding.
- Nothing leaves the machine without `audit --evaluate`. Dry runs, `jta report`, and the plain `audit` make no network calls and need no API key.
- Never execute audited project code or configuration; parse it as text.

## Architecture

- Dependencies point inward: `cli` and adapters depend on application services; application depends on domain; domain imports no CLI, adapter, filesystem, or provider code.
- `docs/architecture.html` is generated from `docs/architecture.archify.json`. Never hand-edit the HTML.
- `examples/audit-report.html` must match the renderer. Regenerate it with `npm run report:example` after any change to `src/domain/html-report.ts` or the overview math.

## Cache and store

- The content-addressed cache key must not depend on the classification policy. It keeps a frozen `LEGACY_POLICY_VERSION_SLOT` (2) so existing entries stay hits; a cache hit re-derives the classification from stored raw answers under the current policy. Changing either rule re-bills every user's whole suite.
- The rubric version stays in the key: a rubric change really changes the questions.
- Store schema changes need a versioned migration and a test from the previous version. The read-only lookup (`--dry-run`) opens with `mode=ro`, never `immutable=1`, and never migrates.
- Cache lookups must stay indexed (`attempts.work_item_id`, `judgments.work_item_id`). A full scan per lookup made a mostly cached 7k-test run take over 10 minutes.

## Report semantics

- "Needs a change" means misleading or weak only. `needs-review` is uncertainty, shown as its own figure, never folded into the headline.
- Every percentage names its denominator (judged tests, not discovered), and an empty population renders `n/a`, never `0%` or `NaN`.
- The HTML report is a fixed-size overview: no per-test rows, no embedded report JSON, no `<script>`, no external references.
- `skills/jev-test-audit/assets/report-query.mjs` must stay zero-dependency and numerically identical to `summarizeReport` (`src/domain/report-overview.ts`), including adaptive folder grouping; parity tests enforce it.
- `.jta/` inside the audited project holds persisted reports and must stay excluded from discovery.

## Classification policy

- Thresholds are provisional. `CLASSIFICATION_POLICY_V3` uses `acceptableSideMin` 0.575 and `deficientSideMin` 0.65 because a blind review agreed with only 20% of deficient-side flips in the 0.575–0.65 band. Do not lower the deficient side without new labelled evidence.
- Keep older policy versions exported as historical artifacts; never mutate a shipped policy in place.

## Testing and delivery

- Strict TDD with Vitest: observe RED as an assertion failure, then GREEN, then refactor. Test public seams; prefer real domain logic and boundary fakes; do not mock internal classes.
- Tests never touch the real user store (`~/.config/jev-test-auditor`) or real projects; temp directories only.
- Known slow tests: `test/benchmark-cli-metrics.test.ts` and oracle-corpus integration tests can time out on loaded machines.
- Conventional Commits. No AI attribution lines in commits.
