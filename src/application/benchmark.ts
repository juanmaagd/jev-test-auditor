/**
 * Orchestrates one corpus case's proof through injected ports (task P7-2,
 * `odd/tasks/phase-7-benchmarks.md`) — exactly the same "application
 * orchestrates through ports" shape `src/application/audit.ts` already
 * uses. This module owns no I/O and no mutation logic of its own: it asks
 * `src/domain/oracle.ts` what to run ({@link buildOraclePlan}) and how to
 * judge what happened ({@link decideProof}), and asks its injected
 * `OracleObservationPort` (the real one is `src/adapters/oracle-runner.ts`)
 * to actually run each declared {@link OracleRun}.
 */
import type { CorpusCase } from '../domain/corpus.js';
import {
  buildOraclePlan,
  decideProof,
  type CaseProofStatus,
  type Observation,
  type OracleRun,
  type RunObservation,
} from '../domain/oracle.js';

export interface OracleObservationPort {
  observe(run: OracleRun, options?: { readonly timeoutMs?: number }): Promise<{ readonly observation: Observation; readonly contentHash: string }>;
}

export interface BenchmarkPorts {
  readonly observe: OracleObservationPort;
  readonly timeoutMs?: number;
}

/** One case's full recorded proof: every run this case's plan called for, what was observed for each, and the final decision — "record as data" from this phase's Decisions. */
export interface CaseProof {
  readonly caseId: string;
  readonly operator: CorpusCase['operator'];
  readonly operatorRole: CorpusCase['operatorRole'];
  readonly oracleKind: CorpusCase['oracleKind'];
  readonly expectedOutcome: CorpusCase['expectedOutcome'];
  readonly runs: readonly {
    readonly label: string;
    readonly mutatedFiles: readonly string[];
    readonly observation: Observation;
    readonly contentHash: string;
  }[];
  readonly status: CaseProofStatus;
}

function unrealizableProof(corpusCase: CorpusCase, reason: string): CaseProof {
  return {
    caseId: corpusCase.id,
    operator: corpusCase.operator,
    operatorRole: corpusCase.operatorRole,
    oracleKind: corpusCase.oracleKind,
    expectedOutcome: corpusCase.expectedOutcome,
    runs: [],
    status: { kind: 'unproven', reason },
  };
}

/**
 * Proves exactly one {@link CorpusCase}: builds its {@link OraclePlan}
 * (never running anything for a plan that comes back `'unrealizable'` —
 * reported unproven with that same reason, at zero spawn cost), runs every
 * declared {@link OracleRun} through `ports.observe` **in order**
 * (`baseline` always first, so a case whose own base test does not
 * genuinely pass never proceeds to a mutation run at all is still decided
 * correctly by `decideProof` even though every run here always executes —
 * this module intentionally does not short-circuit on an early bad
 * observation, since a full recorded proof, not just the first failure, is
 * what "record as data" calls for), and hands the full set of
 * {@link RunObservation}s to `decideProof`.
 */
export async function proveCase(corpusCase: CorpusCase, ports: BenchmarkPorts): Promise<CaseProof> {
  const planResult = buildOraclePlan(corpusCase);
  if (planResult.kind === 'unrealizable') {
    return unrealizableProof(corpusCase, planResult.reason);
  }

  const runs: { label: string; mutatedFiles: readonly string[]; observation: Observation; contentHash: string }[] = [];
  const observations: RunObservation[] = [];
  for (const run of planResult.plan.runs) {
    const outcome = await ports.observe.observe(run, ports.timeoutMs === undefined ? undefined : { timeoutMs: ports.timeoutMs });
    runs.push({
      label: run.label,
      mutatedFiles: run.mutatedFiles,
      observation: outcome.observation,
      contentHash: outcome.contentHash,
    });
    observations.push({ label: run.label, observation: outcome.observation, contentHash: outcome.contentHash });
  }

  const status = decideProof(corpusCase, observations);
  return {
    caseId: corpusCase.id,
    operator: corpusCase.operator,
    operatorRole: corpusCase.operatorRole,
    oracleKind: corpusCase.oracleKind,
    expectedOutcome: corpusCase.expectedOutcome,
    runs,
    status,
  };
}

/** Proves every case in `cases`, sequentially (bounded, predictable resource use — each case may itself spawn 2-3 subprocesses). */
export async function proveCorpus(cases: readonly CorpusCase[], ports: BenchmarkPorts): Promise<readonly CaseProof[]> {
  const proofs: CaseProof[] = [];
  for (const corpusCase of cases) {
    proofs.push(await proveCase(corpusCase, ports));
  }
  return proofs;
}
