/**
 * Orchestrates one full benchmark pass — oracle proof AND Jev sample, for
 * every corpus case, persisted beside each other — through injected ports
 * (task P7-3, `odd/tasks/phase-7-benchmarks.md`). Exactly the same
 * "application orchestrates through ports" shape `src/application/audit.ts`
 * and `src/application/benchmark.ts` (task P7-2) already use: this module
 * owns no I/O and no execution logic of its own. Proving stays P7-2's job
 * (`proveCase`, reused unchanged); this module's own new work is sampling
 * (`BenchmarkSamplePort` — the real one is
 * `src/adapters/benchmark-sample-port.ts`) and, when a store is supplied,
 * persisting the combined result (`BenchmarkStorePort` —
 * `src/adapters/sqlite-benchmark-store.ts`).
 *
 * **Jev never labels its own benchmark** (Decisions): the oracle proof
 * (`proveCase`'s `CaseProof`) and the sample (`BenchmarkSamplePort.sample`)
 * are two independent calls, computed from the case's own committed bytes —
 * neither is ever derived from the other's result, and a case's persisted
 * `proofStatus` never depends on what Jev said.
 */
import type { CorpusCase } from '../domain/corpus.js';
import type {
  BenchmarkCaseRecordInput,
  BenchmarkStorePort,
} from '../domain/benchmark-store.js';
import type { ClassificationResult } from '../domain/classification.js';
import { proveCase, type CaseProof, type OracleObservationPort } from './benchmark.js';

/** Jev's sampled verdict for one case, or why sampling did not produce one — never a fabricated classification on failure. */
export type SampleResult =
  | {
    readonly kind: 'sampled';
    readonly classification: ClassificationResult;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
    readonly latencyMs?: number;
  }
  | { readonly kind: 'failed'; readonly errorKind: string; readonly errorMessage: string };

/**
 * Samples Jev's verdict for one corpus case's UNMODIFIED base test. The
 * production implementation (`src/adapters/benchmark-sample-port.ts`) runs
 * the real discovery/extraction/evidence/evaluation pipeline against the
 * case's own on-disk directory, bypassing the audit cache entirely (no
 * `AuditStorePort`/`AuditCacheKeyPort` wired at all — see that adapter's own
 * doc for why this is structural, not merely `--fresh`).
 */
export interface BenchmarkSamplePort {
  sample(corpusCase: CorpusCase): Promise<SampleResult>;
}

export interface RunBenchmarkPassPorts {
  readonly observe: OracleObservationPort;
  readonly sample: BenchmarkSamplePort;
  /** Opt-in, exactly like `AuditPorts.store` (`src/domain/audit.ts`): absent, this pass still proves and samples every case, but persists nothing — see `BenchmarkCaseRecordInput`'s own doc. */
  readonly store?: BenchmarkStorePort;
  readonly timeoutMs?: number;
}

export interface BenchmarkPassCaseResult {
  readonly proof: CaseProof;
  readonly sampleResult: SampleResult;
}

export interface BenchmarkPassResult {
  /** The persisted run's id — `undefined` exactly when `ports.store` was not supplied, mirroring `AuditResult.runId`'s own convention. */
  readonly runId?: string;
  readonly cases: readonly BenchmarkPassCaseResult[];
}

function toRecordInput(corpusCase: CorpusCase, proof: CaseProof, sampleResult: SampleResult): BenchmarkCaseRecordInput {
  return {
    caseId: corpusCase.id,
    operator: corpusCase.operator,
    operatorRole: corpusCase.operatorRole,
    oracleKind: corpusCase.oracleKind,
    expectedOutcome: corpusCase.expectedOutcome,
    // The corpus case's own committed fixture bytes — hashed by the adapter, never here (see
    // `BenchmarkCaseRecordInput`'s own doc for why `src/application` never touches `node:crypto`).
    fixtureFiles: [...corpusCase.productionSources, corpusCase.baseTest],
    proofStatus: proof.status,
    oracleRuns: proof.runs.map((run) => ({
      label: run.label,
      observation: run.observation,
      contentHash: run.contentHash,
      mutatedFiles: run.mutatedFiles,
    })),
    ...(sampleResult.kind === 'sampled'
      ? {
        sample: {
          classification: sampleResult.classification,
          policyVersion: sampleResult.classification.policyVersion,
          rubricVersion: sampleResult.classification.rubricVersion,
          model: sampleResult.classification.model,
          usage: sampleResult.usage,
          ...(sampleResult.latencyMs === undefined ? {} : { latencyMs: sampleResult.latencyMs }),
        },
      }
      : { sampleFailure: { errorKind: sampleResult.errorKind, errorMessage: sampleResult.errorMessage } }),
  };
}

/**
 * Proves and samples every case in `cases`, sequentially (mirroring
 * `proveCorpus`'s own bounded, predictable resource use — each case may
 * itself spawn 2-3 subprocesses for its proof, plus one real provider call
 * for its sample). When `ports.store` is supplied, brackets the whole pass
 * with `beginRun`/`finishRun` and persists each case's combined outcome as
 * it completes — exactly `runAudit`'s own opt-in persistence shape
 * (`src/application/audit.ts`). Absent a store, this still proves and
 * samples every case (so a caller can inspect `BenchmarkPassResult` in
 * memory) but writes nothing anywhere.
 */
export async function runBenchmarkPass(
  cases: readonly CorpusCase[],
  corpusDir: string,
  ports: RunBenchmarkPassPorts,
): Promise<BenchmarkPassResult> {
  const runId = ports.store === undefined ? undefined : await ports.store.beginRun(corpusDir);

  const results: BenchmarkPassCaseResult[] = [];
  for (const corpusCase of cases) {
    const proof = await proveCase(corpusCase, {
      observe: ports.observe,
      ...(ports.timeoutMs === undefined ? {} : { timeoutMs: ports.timeoutMs }),
    });
    const sampleResult = await ports.sample.sample(corpusCase);

    if (ports.store !== undefined && runId !== undefined) {
      await ports.store.recordCase(runId, toRecordInput(corpusCase, proof, sampleResult));
    }

    results.push({ proof, sampleResult });
  }

  if (ports.store !== undefined && runId !== undefined) await ports.store.finishRun(runId);

  return { ...(runId === undefined ? {} : { runId }), cases: results };
}
