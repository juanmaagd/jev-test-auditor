# Calibrate classification against measured Jev behavior

## Objective

Stop reporting `needs-review` for dimensions the model actually judged clearly, and make the two dimensions that currently exclude themselves usable, so a verdict reflects test quality rather than an artifact of our own thresholds.

## Problem

Two real evaluation runs and one purpose-built discrimination fixture, all on 2026-09-20, produced three defects, none of them the model's fault:

1. **The confidence gate punishes adjacent-level spread, in both directions.** Good tests scoring 2.24 and 2.29 returned confidence 0.47 and 0.29 and became `needs-review`; clearly deficient dimensions scoring 1.31 to 1.82 returned confidence exactly 0 and also became `needs-review`. Confidence measures concentration, so whenever probability sits between two neighbouring levels it reads low — even when both neighbours fall on the same side of the only boundary the verdict cares about. On pr-hero this produced 41 `needs-review` out of 63 tests.
2. **`determinism-isolation` excludes itself.** Applicability landed at 0.12 to 0.18 in 7 of 11 fixture tests, including the test written specifically to violate determinism with `Math.random()` and module-level shared state. On the pr-hero subset it accounted for 24 of the 30 not-applicable dimensions.
3. **`falsifiability` excludes itself marginally.** Applicability landed between 0.35 and 0.48 in 4 of 11 fixture tests — all just under the 0.5 cut — including a healthy control that asserts an exact value.

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

All figures below are counted from `test/fixtures/recorded/discrimination-raw-2026-09-20.json`, the canonical raw recording. An earlier set of applicability figures in this document came from a superseded report file and was corrected during C-3.

- Discrimination fixture, 11 tests: 8 deliberately bad ones scored 0.00 to 1.28 and 3 good controls scored 2.24 to 2.87, with no overlap. Verdicts under the original policy: 6 misleading, 2 weak, 3 needs-review, 0 healthy. **Correction (C-1):** an earlier summary in this session said 1 healthy and 2 needs-review; recomputing the shipped policy directly against the recorded answers gives 3 of 3 good controls as `needs-review`, because the third also carries a dimension the confidence gate blocked. The recorded JSON is the evidence of record.
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

- [x] **C-1 — Replace the confidence gate with a boundary-mass policy**
  - Decide a dimension from the probability distribution: deficient when the mass below the acceptable boundary clears its threshold, acceptable when the mass at or above it does, `needs-review` only when neither side does; keep a separate critical-level threshold for `misleading`. Expose per-level probabilities in the report.
  - Verify every branch and boundary, and replay the recorded 2026-09-20 answers as offline fixtures to prove the good controls become `healthy` and no bad test is absolved.
  - Evidence: `2632152` (`feat: classify from probability mass instead of confidence`) on `feat/boundary-mass-policy`; 8 files, 1,261 additions and 114 deletions (1,375 authored changed lines). Suite 647 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. `CLASSIFICATION_POLICY_V2` decides from the distribution: deficient when the mass at or below `weak` clears `sideMin`, acceptable when the mass at or above `acceptable` clears it, `needs-review` only when the mass straddles that single boundary; `misleading` additionally requires `criticalMass >= criticalMin`. `V1` stays exported and its tests untouched. Thresholds come from the recording, not intuition: `sideMin 0.65` sits mid-gap between the highest straddling deficient mass (0.58) and the lowest decisive one (0.71), while every good control's acceptable mass was at least 0.81; `criticalMin 0.5` sits in the empty gap between critical masses of 0 to 0.26 and 0.78 to 1. A floating-point slack of 1e-9 was added after a boundary test exposed that `0.3 + 0.35` lands one ULP below `0.65`. Per-level probabilities and the three masses now appear per dimension in the report. The production port was switched to V2 in the same slice, because a policy the CLI never runs is not delivered; both CLI goldens were re-derived by hand and cross-checked against the compiled pipeline, and the mixed-run golden needed real redesign since its stub reused one distribution for every dimension. Replay over the recorded answers: 6 misleading, 2 weak, 0 needs-review, 3 healthy, against 6 / 2 / 3 / 0 before — no bad test was absolved. A live run of the shipped CLI over the fixture with the recorded answers replayed reproduced those counts exactly. Mutations on restoring the confidence gate, dropping the critical-mass check, removing the floating-point slack, letting the acceptable/strong distinction reach `needs-review`, skipping distribution validation, and reverting the port to V1 turned RED.
- [x] **C-2 — Repair the two self-excluding applicability questions**
  - Rewrite the `determinism-isolation` and `falsifiability` applicability questions so they ask whether the shown evidence supports a judgment; bump the rubric version.
  - Verify wording changes are reflected in the rubric tests, then prepare the live validation command; the orchestrator runs it.
  - Evidence: `bed5eb7` (`feat: repair self-excluding applicability questions`) on `feat/applicability-questions`; 15 files, 466 additions and 81 deletions (547 authored changed lines). Suite 667 tests, typecheck, build, lint, and diff check passed. Observed RED before implementation. `RUBRIC_V2` rewrites only the two applicability questions: determinism now asks whether the test body and any in-scope hooks can be inspected for a hazard, and says explicitly that the absence of a hazard is evidence rather than a reason to abstain; falsifiability asks whether the assertions and the behavior they are wired to are visible, and says the deeper implementation being absent is not a reason to abstain. Both keep a concrete inapplicable criterion, the shared provenance guidance is unchanged, and a dedicated test asserts the other five dimensions and all seven quality questions stay byte-identical to `RUBRIC_V1`, which remains exported for the recorded replay. The policy's `rubricVersion` pin moved to 2 and the shipped port constructs v2. Mutations on dropping the inapplicable criterion, leaving the pin at rubric 1, editing an untouched dimension, and reverting the port to v1 turned RED.
  - Live validation, `audit --rootDir test/fixtures/discrimination --evaluate` on 2026-09-20, recorded at `test/fixtures/recorded/discrimination-rubric-v2-2026-09-20.json`: determinism applicability rose from 0.12–0.18 to 0.89–0.96 and falsifiability from 0.35–0.48 to 0.72–0.97, so both dimensions are applicable across all eleven tests. Verdicts: 7 misleading, 1 weak, 3 healthy, 0 needs-review. All three good controls are healthy, no deliberately bad test was absolved, and `records history across runs` moved from weak to misleading because determinism now applies and scores it 0.29 with 0.97 deficient mass and 0.74 critical mass — a real defect the previous rubric let escape.
- [x] **C-3 — Re-measure and document**
  - Re-run the discrimination fixture and the pr-hero subset live, record the before and after numbers here, and update README and technical design.
  - Verify the recorded numbers against the real runs.
  - Evidence: `8dc8ff8` (`docs: document the calibrated classification policy`) on `feat/calibration-measurement`; README and technical design gained a Classification policy section, three stale V1 references were fixed, and 667 tests, typecheck, build, lint, and diff check passed with no production behavior touched. The writer verified every figure against the recorded JSON and found two of the orchestrator's numbers wrong: applicability before the fix was 0.12–0.18 on 7 of 11 tests for determinism and 0.35–0.48 on 4 of 11 for falsifiability, not the ranges this document previously carried, and the pr-hero subset had 30 not-applicable dimensions, not 26. The wrong figures came from a superseded report file, which has been deleted; the raw recording is the canonical evidence and this document, the rubric docstring, and both published documents now agree with it.
  - Measured effect, pr-hero subset of 63 tests: 16 healthy / 6 weak / 0 misleading / 41 needs-review became 56 / 0 / 0 / 7, with 30 not-applicable dimensions becoming zero. Six tests moved weak to healthy and 34 moved needs-review to healthy; none moved toward severity. The weak-to-healthy moves are the expected-value-versus-mass correction: one dimension scored 1.97, inside the weak band, while 91 percent of its probability sat on `acceptable`. Across all 433 judged dimensions no reported level contradicted its mass decision.

## Progress

- Current task: **none — feature complete**.
- Completed tasks: **C-1, C-2, C-3**.
- Running authored count: **2,018**, against a 900-line forecast.
- Slice ledger:
  - `feat/boundary-mass-policy`: `2632152` — boundary-mass classification policy, wired into the shipped CLI.
  - `feat/applicability-questions`: `bed5eb7` — rubric v2 applicability rewrites, validated live.
  - `feat/calibration-measurement`: `8dc8ff8` — verified documentation of the calibrated policy and its limits.

## Next step

Integrating this chain into `main` is the user's decision. What remains unmeasured is accuracy: the deliberately bad tests were obvious by construction, only three good controls exist, and no ground truth independent of author intent exists yet. That needs the deterministic mutation benchmarks.
