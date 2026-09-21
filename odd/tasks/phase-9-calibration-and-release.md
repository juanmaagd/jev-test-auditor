# Build Phase 9 calibration and release hardening

## Objective

Calibrate classification policy thresholds from benchmark evidence, document privacy, security, and contribution workflows, add the open-source license, harden package distribution metadata, and verify full clean installability and reproducibility for v1.

## Problem

Prior to Phase 9:
1. `CLASSIFICATION_POLICY_V2`'s thresholds (`applicabilityMin: 0.5`, `sideMin: 0.65`, `criticalMin: 0.5`, level cut points `[1, 2, 3]`) are explicitly marked provisional versioned guesses. Now that Phase 7 scaled the proven benchmark corpus to 70 cases (10 per rubric dimension across all 7 dimensions), we must verify these thresholds against the recorded evidence and establish calibrated policy claims.
2. The repository lacks a standard open-source license file (`LICENSE`), despite PRD and implementation plan requirements.
3. Privacy guarantees (never-execute invariant, zero source leakage in reports, reporting-only CI, local-first storage) and contribution/failure-recovery workflows are scattered across internal docs rather than assembled for users and contributors.
4. `package.json` lacks license and repository metadata, and release distribution artifacts (`npm pack`) must be tested for completeness and minimal footprint.

## Why

V1 release readiness requires evidence-backed calibration, unambiguous legal distribution terms (open-source license), documented privacy boundaries, and verified clean installation in consumer projects.

## Authorized scope

1. **Threshold calibration & policy verification**:
   - Verify `CLASSIFICATION_POLICY_V2` / `CLASSIFICATION_POLICY_V3` against the recorded discrimination and corpus evidence.
   - Formalize the calibrated policy with version pinning against `RUBRIC_V2`.
   - Add offline regression tests ensuring calibration preserves discrimination power without regressions.
2. **Hardening & Documentation**:
   - Author `docs/privacy.md` detailing the never-execute guarantee, evidence redaction, offline reports, and credential security.
   - Author `CONTRIBUTING.md` outlining contribution guidelines, TDD rules, architecture boundaries, and conventional commits.
   - Update `README.md` delivery tables and usage guides.
3. **Packaging & License**:
   - Add the open-source `LICENSE` (MIT License).
   - Update `package.json` with `license`, `repository`, and clean export definitions.
4. **Verification & Quality Gates**:
   - Verify `npm pack --dry-run` to ensure only compiled `dist/` and necessary metadata are published.
   - Verify clean execution in representative fixtures.
   - Run complete test suite, typecheck, lint, and build.

## Scope and constraints

- Inward architecture boundaries remain absolute.
- The never-execute guarantee must never be weakened.
- Strictly no AI attribution or "Co-Authored-By" in commits.
- Preserve unstaged `.gitignore` and untracked `.atl/`.

## Delivery

- Tracker boundary: `feat/phase-9-calibration-and-release`, based on `main` at `29870c2`.
- Planned local child tasks:
  - `P9-1`: Threshold verification, policy calibration, and offline calibration regression tests.
  - `P9-2`: Hardening and documentation (`docs/privacy.md`, `CONTRIBUTING.md`, `README.md`).
  - `P9-3`: License and package metadata hardening (`LICENSE`, `package.json`).
  - `P9-4`: Packaging check (`npm pack --dry-run`) and full verification suite pass.

## Tasks

- [x] **P9-1 — Threshold verification, policy calibration, and offline calibration regression tests**
- [x] **P9-2 — Hardening and documentation (privacy, contributing, readme)**
- [x] **P9-3 — Open-source license and package metadata hardening**
- [x] **P9-4 — Packaging verification, clean install check, and full test suite pass**
