# Fix-subagent brief

This is the complete brief for one `jev-test-audit` fix subagent. One subagent, one file — never
send this same brief to two subagents for the same `{{FILE_PATH}}` at once. Fill in every
`{{PLACEHOLDER}}` below before dispatching, then hand this whole document to the subagent as its
task.

## Task

Improve the semantic quality of the tests in `{{FILE_PATH}}` that `jev-test-auditor` flagged
below. You are fixing tests, not the feature they cover.

## File

`{{FILE_PATH}}`

## Findings for this file

`{{FINDINGS}}`

<!--
  Orchestrator: paste this file's `report-query.mjs file <path>` output — every judged test with
  its per-dimension level and status. A `needs-review` dimension means the model was uncertain,
  not that the test is broken; treat it as a prompt to double-check, not a confirmed defect.
-->

## Dimension guide

`{{DIMENSION_GUIDANCE}}`

<!--
  Orchestrator: paste ONLY the section(s) of references/dimensions.md matching this file's
  flagged dimensionId(s) above — what each checks, what misleading/weak means concretely, typical
  fixes. Never a relative path or the whole guide: this brief runs in the audited project, not in
  the skill's own directory, so a path here would not resolve.
-->

## Test command

`{{TEST_COMMAND}}`

<!-- Orchestrator: the project's own test command for this file, e.g. `npm test -- {{FILE_PATH}}`. -->

## Rules (non-negotiable)

- Edit **only** `{{FILE_PATH}}`. Touch no other file, especially no production source file.
- Never weaken, delete, or skip an assertion (no `.skip`, no `.todo`, no loosened matcher) to make
  a test pass. A fix must make the test a *better* check of real behavior, not a quieter one.
- Preserve every test's intent and public behavior under test; do not change what feature is
  covered unless the finding explicitly says the test targets the wrong behavior.
- After editing, run the exact test command above and capture its full output.
- If a genuine fix would require changing production code, or requires a product decision (e.g.
  "is this edge case even supposed to be supported?"), **stop immediately**, make no further
  edits, and report that instead of guessing.

## Return (structured result)

Report back, concisely:

- `file`: `{{FILE_PATH}}`
- `status`: one of `fixed`, `partially-fixed`, `blocked`
- `testsChanged`: names of the tests you edited
- `summary`: 1–3 sentences on what changed and why, per finding addressed
- `testCommandOutput`: the result of running the test command above (pass/fail, and the relevant
  failure output if it failed)
- `blockedOn` (only if `status` is `blocked` or `partially-fixed`): what production change or
  product decision is needed, and for which test(s)
