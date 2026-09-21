---
name: jev-benchmark-review
description: Inspect immutable completed benchmark runs with lightweight read-only subagents, freeze blind assessments without seeing Jev's output, and persist diagnostic classifications of discrepancies without overriding the deterministic oracle ground truth.
---

# Benchmark Review Skill (`jev-benchmark-review`)

Development skill for qualitative root-cause inspection of benchmark results. Discrepancies between Jev's evaluation and deterministic oracle ground truth are investigated using lightweight, double-blind subagents provided by the surrounding agent environment (Antigravity, Claude, Codex).

## Product & Boundary Invariants

- **Development tool only**: Normal user audits (`jev-test-auditor audit`) never invoke, depend on, or bundle this skill.
- **Reviews never become ground truth**: Subagent or human findings guide rubric wording and policy threshold calibration, but never override an executable oracle proof (`production-mutation`, `assertion-mutation`, `semantics-preserving-refactor`, or `repeated-execution`).
- **No external model calls from CLI**: The CLI never owns secondary model API credentials. Inspection is driven by runtime subagents in the ambient development harness.
- **Strict blindness invariant**: First-pass reviewer payloads must never contain Jev scores, confidence, masses, classification levels, overall status, or findings.
- **Immutable audit trail**: Every review case record stores a SHA-256 hash of its blind input payload, timestamp, and worker identity in SQLite schema v2.

## Review Workflow

### Phase 1: Case Selection & Stratification

Select target cases from a completed benchmark run in the benchmark store (`--store <path> --run <run-id>`):

1. **`disagreements`** (default): Cases where Jev's verdict diverged from deterministic oracle ground truth (e.g. descriptive flaw called healthy, or prescriptive test called misleading).
2. **`regressions`**: Cases that passed in a baseline benchmark run but failed in the candidate run.
3. **`stratified`**: Balanced sampling across all 7 rubric dimensions (`falsifiability`, `assertion-strength`, `refactor-resistance`, `error-path-coverage`, `determinism`, `independence`, `setup-minimalism`).
4. **`all`**: Comprehensive review of all cases in the run.

Optional constraints:
- `--limit <N>`: Maximum number of cases to inspect.
- `--dimension <id>`: Scopes review to a specific rubric dimension.

### Phase 2: Blind Worker Payload Generation

For each selected case, package the input bundle using `prepareReviewSession`:
- `testSource`: Complete source code of the base test under review.
- `productionSources`: Array of production files (`path`, `contents`) available to the test.
- `oracleProof`: Verified oracle proof status (`proven`) and execution observations (mutations applied, test failure details).
- `rubricCriteria`: Criteria descriptions and evaluation questions from `RUBRIC_V2.dimensions`.

**Blindness Invariant Check**: The payload is validated with `assertPayloadIsBlind`. If any Jev sample field is present (`sample`, `classification`, `score`, `confidence`, `deficientMass`, `acceptableMass`, `criticalMass`, `findings`, `model`, `usage`, `latencyMs`), execution throws immediately.

### Phase 3: Subagent Execution Prompt

The ambient orchestrator shards blind payloads across read-only worker subagents with the following prompt:

```markdown
You are an expert test quality evaluator conducting a double-blind rubric assessment.
Evaluate the following test file against the provided production sources and rubric criteria.
You do NOT know what the model under evaluation concluded.

Test source:
\`\`\`typescript
{testSource}
\`\`\`

Production sources:
{productionSources}

Deterministic oracle proof:
{oracleProof}

Rubric criteria:
{rubricCriteria}

Analyze each applicable rubric dimension carefully. Return your structured judgment in exact JSON format:
{
  "caseId": "{caseId}",
  "assessedDimensions": [
    {
      "dimensionId": "falsifiability",
      "level": "misleading" | "weak" | "acceptable" | "strong",
      "score": 0, // 0 to 3
      "confidence": 0.95, // 0.0 to 1.0
      "reasoning": "Detailed technical explanation citing lines of code",
      "evidenceCitations": ["line or code fragment"]
    }
  ],
  "overallUncertainty": 0.05, // 0.0 (certain) to 1.0 (completely uncertain)
  "notes": "Optional notes on context adequacy or rubric ambiguity"
}
```

### Phase 4: Freezing Assessments

Before comparing against Jev, freeze the worker's response using `freezeWorkerAssessment`:
- Calculates SHA-256 hash of the exact input payload.
- Attaches ISO 8601 timestamp (`frozenAt`).
- Records worker identity (`runtime`, `model`).

### Phase 5: Discrepancy Classification

Compare the frozen assessment against Jev's recorded sample and oracle ground truth using `compareReviewAssessment`:

1. **`likely-model-error`**:
   - Jev misclassified the case (e.g. called a descriptive flaw healthy).
   - The blind reviewer concurred with the proven oracle ground truth.
   - Action: Feeds Phase 9 threshold calibration or model fine-tuning candidates.

2. **`unsupported-disagreement`**:
   - The blind reviewer contradicted the proven deterministic oracle.
   - Action: Reviewer hallucination or human reviewer error; rejected as invalid critique.

3. **`rubric-ambiguity`**:
   - Disagreement accompanied by high reviewer uncertainty (`overallUncertainty >= 0.5`) or notes citing wording interpretation issues.
   - Action: Feeds rubric wording refinement in future rubric versions.

4. **`context-selection-error`**:
   - Reviewer notes or reasoning cite missing imports, truncated helper files, or omitted dependency context.
   - Action: Feeds extraction and evidence-bundle resolver improvements.

### Phase 6: Persistence & Reporting

Persist review records into SQLite schema v2 via `recordWorkerAssessment` and `completeReviewSession`:
- `benchmark_review_runs`: Records review run ID, target benchmark run ID, selection strategy, start/finish timestamps.
- `benchmark_review_cases`: Records case ID, input payload hash, frozen assessment JSON, discrepancy comparison JSON.
- Generates an aggregate summary breakdown of agreements and discrepancies by category.
