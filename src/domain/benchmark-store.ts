/**
 * Benchmark persistence types and port (task P7-3, `odd/tasks/phase-7-benchmarks.md`).
 * Pure — no I/O, no timers, no process spawning (enforced by
 * `test/architecture-boundary.test.ts`, exactly like every other `src/domain`
 * module). The real database (`src/adapters/sqlite-benchmark-store.ts`)
 * implements {@link BenchmarkStorePort}; this module only declares the shape
 * of what gets persisted and the port that persists it.
 *
 * **A benchmark run persists two independent things beside each other, never
 * one derived from the other** (Decisions: "Jev never labels its own
 * benchmark"): {@link BenchmarkOracleRunRecord}s are the executable proof
 * `src/application/benchmark.ts`'s `proveCase` already produces (task P7-2)
 * — ground truth, established by running mutated fixtures, never by asking
 * Jev anything. {@link BenchmarkSampleRecord} is Jev's own verdict on the
 * case's UNMODIFIED base test, sampled independently (task P7-3's own new
 * work — see `src/application/benchmark-run.ts`). Nothing in this module (or
 * downstream of it) ever derives one from the other.
 *
 * **Only proven cases count** (Decisions): every {@link BenchmarkCaseOutcome}
 * still carries its `proofStatus` verbatim — `'unverified'` cases are never
 * filtered out of what gets STORED (an honest, complete record of what this
 * run attempted), only out of anything that later computes agreement,
 * disagreement, or regression from stored runs
 * (`src/domain/benchmark-comparison.ts`).
 */
import type {
  BenchmarkCaseReviewComparison,
  BenchmarkReviewSelectionKind,
  BlindWorkerAssessment,
  FrozenWorkerAssessment,
} from './benchmark-review.js';
import type { ClassificationResult } from './classification.js';
import type {
  CorpusExpectedOutcome,
  CorpusOperatorId,
  CorpusOperatorRole,
  CorpusOracleKind,
} from './corpus.js';
import type { CaseProofStatus, Observation } from './oracle.js';

/** One oracle run's recorded observation, persisted beside its case — the same shape `application/benchmark.ts`'s `CaseProof.runs` entries already carry. */
export interface BenchmarkOracleRunRecord {
  readonly label: string;
  readonly observation: Observation;
  readonly contentHash: string;
  readonly mutatedFiles: readonly string[];
}

/**
 * Jev's sampled verdict for one case's unmodified base test (Decisions:
 * "Jev never labels its own benchmark" — this is an OBSERVATION about what
 * Jev said, never treated as ground truth anywhere downstream).
 * `policyVersion`/`rubricVersion`/`model` are carried independently of
 * `classification` (which also has its own copies) so a run-level version
 * check (`src/domain/benchmark-comparison.ts`) never has to reach into a
 * classification's own nested shape to answer "what version produced this
 * run" — exactly the identity the PRD requires every run to record.
 */
export interface BenchmarkSampleRecord {
  readonly classification: ClassificationResult;
  readonly policyVersion: number;
  readonly rubricVersion: number;
  readonly model: { readonly requested: string; readonly responded: string; readonly matchesPin: boolean };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs?: number;
}

/** Why a case has no {@link BenchmarkSampleRecord}: a sampling attempt was made and it did not produce a verdict (never silently absent). */
export interface BenchmarkSampleFailureRecord {
  readonly errorKind: string;
  readonly errorMessage: string;
}

/**
 * One case's full recorded outcome for one benchmark run: its corpus
 * identity (denormalized from `CorpusCase` so a stored run is self-describing
 * without re-reading the corpus), a content hash of the exact fixture bytes
 * that produced this outcome (`fixtureHash` — "fixture identity" for
 * comparison is id *and* bytes, never id alone: two runs sharing a `caseId`
 * whose `cart.ts` changed between them are not the same fixture), its oracle
 * proof, and exactly one of `sample`/`sampleFailure` (or neither, only if
 * sampling was never attempted at all — never both). This is the READ shape
 * (`BenchmarkStorePort.loadRun`'s own result) — see {@link BenchmarkCaseRecordInput}
 * for the WRITE shape `recordCase` actually takes, which carries the raw
 * fixture files instead of a precomputed hash.
 */
export interface BenchmarkCaseOutcome {
  readonly caseId: string;
  readonly operator: CorpusOperatorId;
  readonly operatorRole: CorpusOperatorRole;
  readonly oracleKind: CorpusOracleKind;
  readonly expectedOutcome: CorpusExpectedOutcome;
  readonly fixtureHash: string;
  readonly proofStatus: CaseProofStatus;
  readonly oracleRuns: readonly BenchmarkOracleRunRecord[];
  readonly sample?: BenchmarkSampleRecord;
  readonly sampleFailure?: BenchmarkSampleFailureRecord;
}

/** One committed fixture file's exact bytes, as `recordCase` receives them — never hashed by `src/application` (which stays free of `node:crypto`, like every application-layer module; see `test/architecture-boundary.test.ts`). */
export interface BenchmarkFixtureFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * `BenchmarkStorePort.recordCase`'s own input shape: everything
 * {@link BenchmarkCaseOutcome} carries, except `fixtureHash` is replaced by
 * `fixtureFiles` — the corpus case's own base test plus every production
 * source, unhashed. The adapter (`src/adapters/sqlite-benchmark-store.ts`)
 * computes and stores the content hash itself, so hashing stays adapter-side
 * I/O-adjacent work, never something `src/application/benchmark-run.ts` has
 * to do (it cannot: application-layer modules import nothing but other
 * relative domain/application modules).
 */
export interface BenchmarkCaseRecordInput {
  readonly caseId: string;
  readonly operator: CorpusOperatorId;
  readonly operatorRole: CorpusOperatorRole;
  readonly oracleKind: CorpusOracleKind;
  readonly expectedOutcome: CorpusExpectedOutcome;
  readonly fixtureFiles: readonly BenchmarkFixtureFile[];
  readonly proofStatus: CaseProofStatus;
  readonly oracleRuns: readonly BenchmarkOracleRunRecord[];
  readonly sample?: BenchmarkSampleRecord;
  readonly sampleFailure?: BenchmarkSampleFailureRecord;
}

export interface BenchmarkReviewRunRecord {
  readonly id: string;
  readonly benchmarkRunId: string;
  readonly selectionKind: BenchmarkReviewSelectionKind;
  readonly startedAt: string;
  readonly finishedAt?: string | undefined;
}

export interface BenchmarkReviewCaseRecord {
  readonly id: number;
  readonly reviewRunId: string;
  readonly caseId: string;
  readonly inputPayloadHash: string;
  readonly frozenAt: string;
  readonly workerRuntime: string;
  readonly workerModel?: string | undefined;
  readonly assessment: BlindWorkerAssessment;
  readonly comparison: BenchmarkCaseReviewComparison;
  readonly recordedAt: string;
}

export interface RecordReviewCaseInput {
  readonly frozenAssessment: FrozenWorkerAssessment;
  readonly comparison: BenchmarkCaseReviewComparison;
}

/**
 * The benchmark persistence port (task P7-3, extended for review persistence in P8-2),
 * append-only exactly like {@link BenchmarkStorePort}'s audit-store sibling
 * (`AuditStorePort`, `src/domain/audit.ts`): `beginRun`/`finishRun` bracket
 * one benchmark run, `recordCase` is called once per corpus case, and
 * `loadRun` reads a previously persisted run back for comparison
 * (`src/domain/benchmark-comparison.ts`). A completely separate database
 * from {@link AuditStorePort} (Decisions: "Benchmark data does not live in
 * the user's audit store") — the production adapter
 * (`src/adapters/sqlite-benchmark-store.ts`) never opens, reads, or writes
 * the audit store's own file.
 */
export interface BenchmarkStorePort {
  /** Starts a new run record for `corpusDir` and returns its generated run id. */
  beginRun(corpusDir: string): Promise<string>;
  /** Persists one case's full outcome for `runId`. See {@link BenchmarkCaseRecordInput}'s own doc for why this takes raw fixture files rather than a precomputed hash. */
  recordCase(runId: string, input: BenchmarkCaseRecordInput): Promise<void>;
  /** Marks `runId` finished. */
  finishRun(runId: string): Promise<void>;
  /** Loads every case outcome recorded for `runId`, in recording order; `undefined` when no run with `runId` exists at all. */
  loadRun(runId: string): Promise<readonly BenchmarkCaseOutcome[] | undefined>;
  /** Starts a new review run inspecting `benchmarkRunId` with the given case selection strategy. */
  beginReview(benchmarkRunId: string, selectionKind: BenchmarkReviewSelectionKind): Promise<string>;
  /** Records one reviewed case's frozen assessment and discrepancy comparison for `reviewRunId`. */
  recordReviewCase(reviewRunId: string, input: RecordReviewCaseInput): Promise<void>;
  /** Marks `reviewRunId` finished. */
  finishReview(reviewRunId: string): Promise<void>;
  /** Loads all review runs recorded for `benchmarkRunId`, in recording order. */
  loadReviewsForRun(benchmarkRunId: string): Promise<readonly BenchmarkReviewRunRecord[]>;
  /** Loads one review run by its id, or undefined if not found. */
  loadReview(reviewRunId: string): Promise<BenchmarkReviewRunRecord | undefined>;
  /** Loads all reviewed case records for `reviewRunId`, in recording order. */
  loadReviewCases(reviewRunId: string): Promise<readonly BenchmarkReviewCaseRecord[]>;
  /** Releases the underlying database handle. Safe to call once. */
  close(): Promise<void>;
}

export type BenchmarkStoreErrorCode = 'schema-version' | 'corrupt';

abstract class BenchmarkStoreErrorBase extends Error {
  abstract readonly code: BenchmarkStoreErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The benchmark store's recorded schema version is newer than this build
 * supports. Never silently recreated and never migrated backwards — mirrors
 * {@link AuditStoreSchemaVersionError}'s own contract exactly (see
 * `src/domain/audit.ts`), for the store this task adds.
 */
export class BenchmarkStoreSchemaVersionError extends BenchmarkStoreErrorBase {
  readonly code = 'schema-version' as const;
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(foundVersion: number, supportedVersion: number) {
    super(
      `Benchmark store schema version ${foundVersion} is newer than this build supports (up to version `
      + `${supportedVersion}). Refusing to migrate backwards or silently recreate the database; use a `
      + 'build that supports this schema version, or point the store at a fresh database file.',
    );
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}

/**
 * The database at the configured path cannot be treated as this adapter's
 * own benchmark store — never guessed at, never silently recreated or
 * adopted. Mirrors {@link AuditStoreCorruptError}'s own contract (see
 * `src/domain/audit.ts`), including the case this store adds a dedicated
 * test for: a real, valid audit store file (`audit-store.sqlite3`) opened as
 * a benchmark store has user tables but no `benchmark_schema_meta` table, so
 * it is refused exactly like any other foreign database — never silently
 * treated as an empty benchmark store to migrate into.
 */
export class BenchmarkStoreCorruptError extends BenchmarkStoreErrorBase {
  readonly code = 'corrupt' as const;

  constructor(detail: string) {
    super(`Benchmark store is corrupt, foreign, or otherwise unusable: ${detail}`);
  }
}

export type BenchmarkStoreError = BenchmarkStoreSchemaVersionError | BenchmarkStoreCorruptError;
