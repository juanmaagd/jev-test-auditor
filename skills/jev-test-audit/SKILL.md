---
name: jev-test-audit
description: "Trigger: audit test quality, jta report, jev-test-auditor results, fix weak/misleading tests, needs-review tests. Explain a persisted jev-test-auditor report and, only with approval, dispatch fix subagents and verify."
license: Apache-2.0
metadata:
  author: "juanmaagd"
  version: "1.0"
---

## Activation Contract

Load when the user asks to review, explain, or act on `jev-test-auditor`/`jta` results — "audit my tests", "what's wrong with my tests", "fix the misleading/weak tests" — or right after a `jta audit --evaluate` run. Scope: this repo's own Jest/Vitest tests that `jev-test-auditor` judged. Never a general source-code review.

## Hard Rules

- Never load a full report (`.jta/latest.json`, `jta report --json`) into context. Always pipe it through `node skills/jev-test-audit/assets/summarize.mjs` and read only the compact JSON it prints.
- Get results with `jta report --last --json` — free, offline. Suggest `jta audit --evaluate` only when no report exists yet, and never run it without the user's explicit consent: it costs money and sends evidence to TypeSafe. Offer `jta audit --dry-run` first so the user sees the cost.
- No test edit without the user's explicit approval of that batch. Ever.
- One fix subagent per file, never two writers on the same file; cap concurrent subagents (e.g. 3–5).
- A fix subagent edits test files only, never production code, and must never weaken, delete, or skip an assertion to make a test pass.
- `needs-review` means the model was uncertain, not that the test is broken — never present it as a defect.

## Decision Gates

| Situation | Action |
|---|---|
| No persisted report | Say so; suggest `jta audit --dry-run` for cost, then `--evaluate` only with consent |
| Report has needs-change tests | Summarize via `summarize.mjs`, explain plainly, then propose a batch fix plan |
| User approves some batches | Dispatch one subagent per approved file only |
| A fix needs a production change or a product decision | Subagent stops and reports; never edit production code to unblock it |
| Fixes landed | Run the project's tests; offer a consented re-audit to compare before/after |

## Execution Steps

1. Run `jta report --last --json | node skills/jev-test-audit/assets/summarize.mjs -` (or a report path / `--root`). No report yet: follow the Decision Gate above.
2. Read only the summary JSON. Explain needs-change count/share with its denominator, the worst folders/dimensions, and what each dimension means in plain language.
3. Re-run with `--worklist` (optionally `--folder`/`--status`/`--dimension`/`--limit`) for the per-file worklist.
4. Present a fix plan in batches by file or folder. Ask which batches to fix, then stop and wait.
5. For each approved file, dispatch one fix subagent with `assets/fixer-brief.md` filled in (file path, that file's findings, the project's test command). Respect the concurrency cap.
6. Collect each subagent's structured result; run the project's test command yourself over the touched files and report the outcome honestly.
7. Offer a consented re-audit (`jta audit --evaluate`) to compare before/after via `jta report`.

## Output Contract

Return: the needs-change summary (count/share/denominator, worst folders/dimensions), the proposed batches and which were approved, each subagent's file/status/summary, the test command's result, and any before/after comparison run. Never print full report JSON or an unapproved edit.

## References

- `assets/summarize.mjs` — standalone report summarizer (see its own `--help`).
- `assets/fixer-brief.md` — brief template for one fix subagent.
