/**
 * The production {@link BenchmarkSamplePort} (task P7-3,
 * `odd/tasks/phase-7-benchmarks.md`): samples Jev's verdict for one corpus
 * case's UNMODIFIED base test by running the real discovery, extraction,
 * evidence, and evaluation pipeline — `runAudit`
 * (`src/application/audit.ts`) — pointed at the case's own on-disk
 * directory, treating it exactly like a miniature repository being audited.
 * This is deliberately the SAME pipeline `audit --evaluate` uses (PRD:
 * "Every run records exact model, rubric, question, test, and context
 * identities"), never a second, hand-rolled evaluation path that could drift
 * from what a real audit actually sends.
 *
 * **Sampling bypasses the cache — structurally, not merely via `--fresh`.**
 * The `AuditPorts` this function builds carry NO `store` and NO `cacheKey`
 * port at all: `runAudit`'s own cache lookup only ever runs when BOTH are
 * present (see `AuditPorts.cacheKey`'s own doc), so there is no code path
 * here that could consult a cache even in error — not "the cache is bypassed
 * this call" but "there is no cache reachable from this call at all."
 * `options.fresh: true` is passed anyway, both to document the intent
 * directly at the call site and as redundant defense-in-depth. Proven by
 * test (`test/benchmark-sample-port.test.ts`): two samples of the identical
 * corpus case, against a gateway that returns a distinguishable answer each
 * call, both reach the gateway and return different classifications.
 *
 * **Never touches the user's audit store.** No `AuditStorePort` is
 * constructed anywhere in this file, and nothing here ever imports
 * `sqlite-audit-store.js` — proven by test (a real audit store, created
 * before sampling, is byte-identical after) and structurally by
 * `test/benchmark-cli-boundary.test.ts`'s closure assertion that
 * `src/cli/benchmark.ts` never reaches `sqlite-audit-store.ts` or
 * `cache-key.ts`.
 *
 * **`jestFrameworkHint` is also omitted**, unlike `audit`'s own
 * `createProductionPorts` (`src/cli/index.ts`): it exists to read a
 * project's OWN `package.json`/`jest.config.*` for ambient-Jest attribution
 * when import-based detection is `'unknown'` — every corpus fixture already
 * imports `vitest` explicitly (`test/fixtures/corpus/discrimination/*\/test.ts`),
 * so import-based attribution always succeeds here, and reading a
 * `package.json` outside the case's own directory would be unneeded I/O this
 * adapter has no reason to perform.
 */
import { join } from 'node:path';
import type { AuditPorts } from '../domain/audit.js';
import { runAudit } from '../application/audit.js';
import { resolveConfiguration } from '../domain/config.js';
import type { CorpusCase } from '../domain/corpus.js';
import type { JevGatewayPort } from '../domain/jev-gateway.js';
import type { BenchmarkSamplePort, SampleResult } from '../application/benchmark-run.js';
import { createAuditEvidencePort } from './evidence-audit-port.js';
import { createJevEvaluationPort } from './jev-evaluation-port.js';
import { discoverTestFiles } from './repository-discovery.js';
import { readSourceFile } from './source-reader.js';
import { extractTestCases } from './test-extraction.js';

/**
 * Creates the production {@link BenchmarkSamplePort}, pinned to `corpusDir`
 * (the directory `--corpus` names — e.g. `test/fixtures/corpus/discrimination`)
 * and `gateway` (a real `JevGatewayPort`, injected by the CLI composition
 * root exactly like `audit --evaluate` injects one — see
 * `src/cli/benchmark.ts`). `sample` resolves each case's own directory as
 * `join(corpusDir, corpusCase.id)` — safe because P7-1's own loader already
 * guarantees `corpusCase.id === <its own directory's basename>`
 * (`loadCorpusFromDirectory`, `src/adapters/corpus-store.ts`).
 */
export function createBenchmarkSamplePort(corpusDir: string, gateway: JevGatewayPort): BenchmarkSamplePort {
  const evaluationPort = createJevEvaluationPort(gateway);

  return {
    async sample(corpusCase: CorpusCase): Promise<SampleResult> {
      const caseDir = join(corpusDir, corpusCase.id);
      const request = resolveConfiguration({
        rootDir: caseDir,
        include: [corpusCase.baseTest.path],
        concurrency: 1,
      });
      const ports: AuditPorts = {
        discovery: { discover: discoverTestFiles },
        sourceReader: { read: readSourceFile },
        extractor: { extract: extractTestCases },
        evidence: createAuditEvidencePort(),
        evaluation: evaluationPort,
        // Deliberately absent: `store`, `cacheKey`, `jestFrameworkHint` — see this module's own doc.
      };

      const result = await runAudit(request, ports, { fresh: true });

      if (result.evaluation === undefined) {
        return {
          kind: 'failed',
          errorKind: 'sample-shape-mismatch',
          errorMessage: `case "${corpusCase.id}": evaluation did not run at all (no evaluation port reached runAudit's opt-in gate)`,
        };
      }

      const { classifications, totals } = result.evaluation;
      if (classifications.length !== 1) {
        if (totals.failed === 1) {
          const failureDiagnostic = result.diagnostics.find((diagnostic) => diagnostic.code === 'evaluation-failed');
          if (failureDiagnostic !== undefined) {
            return { kind: 'failed', errorKind: failureDiagnostic.code, errorMessage: failureDiagnostic.message };
          }
        }
        const diagnosticText = result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('; ');
        return {
          kind: 'failed',
          errorKind: 'sample-shape-mismatch',
          errorMessage: `case "${corpusCase.id}": expected exactly one classification, got ${classifications.length} `
            + `(evaluated=${totals.evaluated}, cached=${totals.cached}, failed=${totals.failed}, skipped=${totals.skipped.total}); `
            + `diagnostics: ${diagnosticText.length > 0 ? diagnosticText : 'none'}`,
        };
      }

      const classification = classifications[0]!;
      const latency = result.evaluation.latencyByTestCaseId.get(classification.testCaseId);
      return {
        kind: 'sampled',
        classification,
        usage: classification.usage,
        ...(latency === undefined ? {} : { latencyMs: latency.latencyMs }),
      };
    },
  };
}
