---
name: jev-test-audit
description: "Trigger: audit test quality, jta report, jev-test-auditor results, fix weak/misleading tests, needs-review tests. Explain a persisted jev-test-auditor report and, only with approval, dispatch fix subagents and verify."
license: Apache-2.0
metadata:
  author: "juanmaagd"
  version: "1.0"
---

## Activation Contract

Load when the user asks to review, explain, or act on `jev-test-auditor`/`jta` results — "audit my tests", "what's wrong with my tests", "fix the misleading/weak tests" — or right after a `jta audit --evaluate` run. Scope: the audited project's own Jest/Vitest tests, never a general source-code review.

## Hard Rules

- This skill's `assets/`/`references/` live next to this file (e.g. `~/.claude/skills/jev-test-audit/`) — resolve every skill path relative to *its own directory*, never the audited project's.
- Never load a full report (`.jta/latest.json`, `jta report --json`) into context. Query it only through `assets/report-query.mjs` subcommands (`--help` lists them).
- Get results with `jta report --last --json` — free, offline. Suggest `jta audit --evaluate` only when no report exists yet, and never run it without the user's explicit consent: it costs money and sends evidence to TypeSafe. Offer `jta audit --dry-run` first so the user sees the cost.
- No test edit without the user's explicit approval of that batch. Ever.
- One fix subagent per file, never two writers on the same file; cap concurrent subagents (e.g. 3–5).
- A fix subagent edits test files only, never production code, and must never weaken, delete, or skip an assertion to make a test pass.
- `needs-review` means the model was uncertain, not that the test is broken — never present it as a defect.

## Decision Gates

| Situation | Action |
|---|---|
| No persisted report | Say so; suggest `jta audit --dry-run` for cost, then `--evaluate` only with consent |
| Report has needs-change tests | `summary`, then `dimensions`/`folders`; explain plainly, then propose batches |
| User approves some batches | Dispatch one subagent per approved file only, briefed with that file's own detail |
| A fix needs a production change or a product decision | Subagent stops and reports; never edit production code to unblock it |
| Fixes landed | Run the project's tests; offer a consented re-audit, then `diff` to compare |

## Execution Steps

1. Run `report-query.mjs summary --root <project>` (same `.jta/latest.json` that `jta report --last --json` reads). No report yet: follow the Decision Gate above.
2. Explain needs-change count/share with its denominator; run `dimensions`/`folders` for the worst ones, explained via `references/dimensions.md`.
3. Run `batches --by file` (or `--by folder [--max-tests N]`). Present the plan, ask which batches to fix, then stop and wait.
4. Per approved file: run `file <path>`, inline it into `assets/fixer-brief.md`'s findings placeholder and paste the matching `references/dimensions.md` section(s) into its dimension-guidance placeholder, dispatch one fix subagent per file. Respect the concurrency cap.
5. Collect each result; run the project's test command yourself over touched files and report honestly.
6. Offer a consented re-audit (`jta audit --evaluate`), then `diff <beforeRunId> <afterRunId>` to compare.

## Output Contract

Return: the needs-change summary (count/share/denominator, worst folders/dimensions), the proposed batches and which were approved, each subagent's file/status/summary, the test command's result, and any `diff` comparison run. Never print full report JSON or an unapproved edit.

## References

- `assets/report-query.mjs` — report query tool; `--help` lists every subcommand (`summary`, `worklist`, `file`, `test`, `folders`, `dimensions`, `batches`, `diff`, `runs`).
- `assets/fixer-brief.md` — brief template for one fix subagent.
- `references/dimensions.md` — what each rubric dimension checks and typical fixes.
