# Jev Test Auditor — Product Requirements

## Executive summary

Build an open-source, local-first CLI that audits the semantic quality of existing JavaScript and TypeScript tests. The tool discovers Jest and Vitest test cases, gives Jev a small evidence package for each case, evaluates seven quality dimensions, and produces transparent JSON and HTML reports. It helps developers detect tests that increase coverage without reliably protecting behavior.

## Quick path

```bash
npx <package> audit --open
```

The command detects the repository and test framework, scans all supported tests, reuses valid cached judgments, evaluates stale cases concurrently, and opens a self-contained report.

## Problem

AI coding agents and humans can write tests that look legitimate and raise coverage while remaining weak, brittle, tautological, over-mocked, or non-diagnostic. Coverage tools report execution, not whether an assertion would detect a meaningful behavioral regression.

Existing code-review tools are too broad. This product focuses exclusively on the quality of tests that already exist. It may read narrowly related production code as evidence, but it never turns production files into independent findings.

## Users and jobs

| User | Job to be done |
| --- | --- |
| AI-assisted developer | Check whether generated tests protect behavior before trusting them. |
| Repository maintainer | Audit a complete test suite and prioritize suspicious cases. |
| Tool or agent author | Consume structured findings in an automated workflow. |
| CI operator | Publish a non-blocking quality report without changing merge policy. |

The operator supplies commands and policy. Individual test labeling, approval, and review are not part of normal execution.

## Product principles

1. **Evidence over vibes.** Every finding identifies the test, dimension, evidence, context, model result, and derivation policy.
2. **Tests are the product boundary.** Only test cases receive scores and findings.
3. **Uncertainty is not quality.** Missing evidence produces `needs-review`, not a fabricated low or high score.
4. **Rules are hypotheses.** The initial rubric may evolve through deterministic evaluation; it is not treated as unquestionable truth.
5. **Code owns policy.** Jev supplies bounded judgments and probabilities; deterministic code composes classifications and workflow decisions.
6. **Automation must scale.** Runs are parallel, cached, append-only, resumable, and require no human-in-the-loop labeling.

## V1 scope

### Included

- JavaScript and TypeScript repositories.
- Jest and Vitest.
- Unit, integration, and component tests.
- Full-suite discovery on every audit.
- Per-test semantic evaluation with narrow production context.
- Terminal summary, canonical JSON report, and self-contained HTML report.
- Reporting-only CI usage.
- Deterministic benchmark generation and historical evaluation storage.

### Excluded

- Playwright, Cypress, browser/device automation, and deployed E2E testing.
- Missing-test or production-coverage analysis.
- General source-code review.
- Automatic test rewriting or deletion.
- CI blocking based on findings.
- Human labeling as part of evaluation runs.
- Support for languages outside JavaScript and TypeScript.

## Quality model

Every discovered test is evaluated across seven dimensions:

| Dimension | Question |
| --- | --- |
| Falsifiability | Would the test fail when the intended behavior breaks? |
| Behavioral focus | Does it assert an observable outcome rather than incidental interaction? |
| Refactor resistance | Can internals change while preserved behavior keeps the test green? |
| Assertion strength | Are assertions precise, meaningful, and dependent on the act? |
| Test-double quality | Are mocks, stubs, and fakes used at appropriate boundaries? |
| Determinism and isolation | Can the test run alone, in any order, and repeatedly with the same result? |
| Diagnostic quality | Do the name and failure evidence identify the broken behavior? |

Each dimension contains two independent judgments:

- An applicability/sufficient-evidence probability.
- A quality score from 0 to 3: `misleading`, `weak`, `acceptable`, or `strong`.

The application ignores quality scores without sufficient evidence.

## Global classification

The overall status is derived in code and is deliberately non-compensatory:

| Status | Meaning |
| --- | --- |
| `healthy` | Every applicable dimension is acceptable or strong. |
| `needs-review` | Evidence or model certainty is insufficient for a reliable classification. |
| `weak` | At least one applicable dimension is deficient without a supported critical flaw. |
| `misleading` | A supported critical flaw means the test may create false confidence. |

A strong score in one dimension cannot cancel a critical failure in another. Numeric thresholds remain provisional until deterministic benchmarks establish a baseline.

## Primary workflow

1. Discover Jest and Vitest test files and parse individual test cases.
2. Resolve only the helpers and production seam needed to understand each test.
3. Build a minimal, inspectable Jev state for one test.
4. Batch independent rubric questions over that state.
5. Evaluate tests concurrently within provider limits.
6. Persist every completed, cached, uncertain, skipped, or failed result.
7. Derive classifications in deterministic code.
8. Emit terminal, JSON, and HTML reports.

## User-facing requirements

### Zero-config audit

- `npx <package> audit --open` works without generating configuration.
- Framework, workspace, and test discovery decisions appear in the report.
- An optional initialization command creates configuration only for overrides.

### Complete but incremental scanning

- Every run discovers the full supported test suite.
- Cached results are reused only when test source, production context, rubric, questions, and exact model version are unchanged.
- `--fresh` bypasses the cache.

### Transparent reports

- JSON is the canonical report representation.
- HTML is a self-contained projection of that JSON and requires no server.
- Findings show file, line, test name, dimension, evidence, score, probabilities, model version, and context provenance.
- Summaries distinguish new, cached, uncertain, skipped, and failed evaluations.

### CI behavior

- Findings never fail the build in v1.
- Operational failures and incomplete analysis remain visible and are never counted as healthy tests.
- JSON and HTML outputs can be archived as CI artifacts.

### Privacy

- Requests contain only the current test, indispensable helpers, directly related production code, and minimal metadata.
- Sensitive and irrelevant paths are excluded.
- `--inspect-payloads` exposes locally what would be sent.
- The tool never sends an entire repository as one state.

## Evaluation requirements

- Fixtures and expected transformations are versioned in Git.
- SQLite stores append-only cases, runs, judgments, metrics, failures, and provenance.
- JSONL exports support backup, CI, and interchange.
- Benchmarks use controlled transformations and executable oracles rather than Jev-generated labels.
- Real-world cases without deterministic ground truth may be observed but do not count toward accuracy.
- Every run records exact model, rubric, question, test, and context identities.

Benchmark reporting is broken down by dimension and includes precision, recall, false-positive rate, correct `needs-review` routing, probability calibration, run-to-run stability, cost, latency, and regressions. Targets are set only after the first baseline.

## Reliability requirements

- Concurrency is bounded and configurable.
- Rate limiting adapts to provider responses and token budgets.
- Transient failures use bounded retries with backoff.
- Results are persisted immediately and interrupted runs resume safely.
- Permanent failures remain `failed`; they are never converted into healthy results.

## Success criteria

- A new user can produce a navigable report with one audit command and an API credential.
- Every reported concern is traceable to a test, evidence, rubric version, question version, and exact model version.
- Re-running unchanged tests produces cache hits without changing classifications.
- Interrupted large runs resume without losing completed work.
- Benchmark comparisons can identify per-dimension regressions between rubric or model versions.
- V1 never reports production files as independent findings or blocks CI.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Semantic findings look authoritative without proof | Separate evidence, model certainty, quality, and deterministic verification status. |
| The initial rubric contains bad assumptions | Version rules and test them with counterexamples and executable transformations. |
| Context selection biases judgments | Record payload provenance and benchmark context-resolution changes. |
| Large suites exceed provider limits | Use bounded concurrency, caching, retries, checkpointing, and resumable runs. |
| Reports leak source or secrets | Minimize payloads, exclude sensitive paths, and keep inspection available locally. |

## Open questions

- Final product and npm package name.
- Open-source license.
- Exact baseline thresholds after the deterministic corpus exists.
- Which later ecosystem should validate the language-adapter boundary first.

These questions do not block the technical design or the first implementation slice.
