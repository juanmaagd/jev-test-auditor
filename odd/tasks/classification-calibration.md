# Calibrate classification against measured Jev behavior

## Objective

Stop reporting `needs-review` for dimensions the model actually judged clearly, and make the two dimensions that currently exclude themselves usable, so a verdict reflects test quality rather than an artifact of our own thresholds.

## Problem

Two real evaluation runs and one purpose-built discrimination fixture, all on 2026-09-20, produced three defects, none of them the model's fault:

1. **The confidence gate punishes adjacent-level spread, in both directions.** Good tests scoring 2.24 and 2.29 returned confidence 0.47 and 0.29 and became `needs-review`; clearly deficient dimensions scoring 1.31 to 1.82 returned confidence exactly 0 and also became `needs-review`. Confidence measures concentration, so whenever probability sits between two neighbouring levels it reads low — even when both neighbours fall on the same side of the only boundary the verdict cares about. On pr-hero this produced 41 `needs-review` out of 63 tests.
2. **`determinism-isolation` excludes itself.** Applicability landed at 0.13 to 0.20 in 5 of 11 fixture tests, including the test written specifically to violate determinism with `Math.random()` and module-level shared state. On pr-hero it was not applicable in 24 of 63.
3. **`falsifiability` excludes itself marginally.** Applicability landed at 0.33, 0.46, 0.47, and 0.49 — all just under the 0.5 cut — including a healthy control that asserts an exact value.

## Why

The product's promise is that uncertainty is reported honestly. Reporting our own miscalibration as model uncertainty breaks that promise in the most damaging way: a user sees a wall of `needs-review` and concludes the tool cannot judge, when the model judged clearly and we discarded the judgment.

## Authorized scope

- Replace the confidence gate with a policy that uses the answer's probability distribution across levels.
- Rewrite the applicability questions for `determinism-isolation` and `falsifiability`.
- Expose per-level probabilities in the JSON report so a reader can audit a verdict.
- Add offline regression tests built from the real recorded answers of the 2026-09-20 runs.
- Re-measure on the discrimination fixture and the pr-hero subset, and record the numbers.
- Do not change the seven dimensions, the four levels, the non-compensatory rule, the gateway, evidence selection, or anything in Phase 5.

## Scope and constraints

- Thresholds stay provisional and versioned; no calibrated-accuracy claim may appear anywhere.
- A rubric change is a rubric version change: bump it and keep the policy's `rubricVersion` pin honest.
- Recorded answers used as test fixtures are real provider output from the runs of 2026-09-20, stored verbatim; they are evidence, not hand-written expectations.
- Live validation runs cost money and are the user's call; the writer prepares them and reports the command, and only runs one when the task says so.
- Artifacts use English. Preserve unrelated untracked `.atl/` files. Conventional Commits without AI attribution.

## Measured evidence (2026-09-20)

- Discrimination fixture, 11 tests: 8 deliberately bad ones scored 0.00 to 1.28 and 3 good controls scored 2.24 to 2.87, with no overlap. Verdicts: 6 misleading, 2 weak, 2 needs-review, 1 healthy. Both `needs-review` verdicts were good tests blocked by the confidence gate.
- pr-hero subset, 63 tests: 16 healthy, 6 weak, 0 misleading, 41 needs-review. 411 scored dimensions, median 2.88, minimum 1.43, none below 1.
- Confidence is concentration, not `score - 2`: score 0.03 returned confidence 0.97, score 2.24 returned 0.47.

## Decisions

- The verdict only ever depends on one boundary: deficient (`misleading` or `weak`) versus acceptable (`acceptable` or `strong`). The new gate therefore asks whether the probability mass falls decisively on one side of that boundary, not whether it concentrates on a single level. Spread between two levels on the same side no longer produces `needs-review`.
- `misleading` still requires its own evidence: the mass on the critical level must clear its own threshold, so a dimension that is merely deficient cannot be reported as a critical failure.
- Applicability questions must ask whether the shown evidence supports a judgment, not whether every possible influence is visible. Absence of visible shared state is evidence about determinism, not a reason to abstain.

## Delivery

- Strategy: `auto-chain`.
- Forecast: approximately 900 authored changed lines, generated files excluded.
- Chain strategy: cached `feature-branch-chain`.
- Tracker boundary: `feat/classification-calibration`, based on `main`.
- Remote pull requests: not created; push and PR creation remain unauthorized remote operations.
- RDD: disabled/unmanaged.
- TDD: enabled; require observed RED, GREEN, REFACTOR, and critical mutation evidence.
- Test runner: Vitest.

## Acceptance criteria

- Replayed against the recorded answers, the three good controls classify as `healthy` and the eight bad tests stay `misleading` or `weak`; no bad test becomes acceptable.
- `determinism-isolation` is applicable for the test that uses `Math.random()` and shared module state.
- `falsifiability` is applicable for a test that asserts an exact returned value.
- The `needs-review` rate on the recorded pr-hero answers falls substantially, and the new rate is recorded here with its cause.
- Per-level probabilities appear in the JSON report.
- No accuracy claim is stated anywhere; thresholds remain provisional.

## Tasks

- [ ] **C-1 — Replace the confidence gate with a boundary-mass policy**
  - Decide a dimension from the probability distribution: deficient when the mass below the acceptable boundary clears its threshold, acceptable when the mass at or above it does, `needs-review` only when neither side does; keep a separate critical-level threshold for `misleading`. Expose per-level probabilities in the report.
  - Verify every branch and boundary, and replay the recorded 2026-09-20 answers as offline fixtures to prove the good controls become `healthy` and no bad test is absolved.
- [ ] **C-2 — Repair the two self-excluding applicability questions**
  - Rewrite the `determinism-isolation` and `falsifiability` applicability questions so they ask whether the shown evidence supports a judgment; bump the rubric version.
  - Verify wording changes are reflected in the rubric tests, then prepare the live validation command; the orchestrator runs it.
- [ ] **C-3 — Re-measure and document**
  - Re-run the discrimination fixture and the pr-hero subset live, record the before and after numbers here, and update README and technical design.
  - Verify the recorded numbers against the real runs.

## Progress

- Current task: **C-1**.
- Completed tasks: none.
- Running authored count: 0.

## Next step

Delegate C-1 to one writer with strict TDD, then review before the work-unit commit.
