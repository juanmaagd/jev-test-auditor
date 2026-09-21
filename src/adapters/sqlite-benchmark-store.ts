/**
 * The `node:sqlite` benchmark persistence adapter (task P7-3,
 * `odd/tasks/phase-7-benchmarks.md`): implements {@link BenchmarkStorePort}
 * (`src/domain/benchmark-store.ts`) with its own local SQLite database —
 * versioned transactional migrations, `STRICT` tables, prepared statements,
 * and WAL mode, all reused unchanged from
 * `src/adapters/sqlite-store-common.ts` (itself extracted from
 * `src/adapters/sqlite-audit-store.ts`, Phase 5, task P5-1). See that shared
 * module's own doc for why the migration engine and the `node:sqlite`
 * `ExperimentalWarning` suppression are shared rather than copy-pasted.
 *
 * **A completely separate database from the audit store** (Decisions:
 * "Benchmark data does not live in the user's audit store" — hard
 * constraint). Three independent things make that true, not just discipline:
 *
 * 1. No default path resolution at all — unlike
 *    `resolveAuditStorePaths` (`src/adapters/sqlite-audit-store.ts`), this
 *    module has no per-user config-home convention. `createSqliteBenchmarkStore`
 *    always takes an explicit `databaseFile`; the CLI (`src/cli/benchmark.ts`)
 *    requires an explicit `--store <path>` before ANY benchmark sampling or
 *    persistence happens (mirroring how `--html` gates writing a report file
 *    — see that CLI's own doc).
 * 2. A distinct meta table name (`benchmark_schema_meta`, never the audit
 *    store's `schema_meta`) — see `sqlite-store-common.ts`'s own doc for why
 *    this specific choice is what makes opening a real audit store file
 *    HERE fail with a legible "foreign database" error instead of either
 *    succeeding against the wrong schema or reporting a confusing
 *    "newer than this build supports." `test/sqlite-benchmark-store.test.ts`'s
 *    own "refuses a real audit store file" test proves this directly: a real
 *    `audit-store.sqlite3`, opened through THIS adapter, is refused and left
 *    byte-identical.
 * 3. Nothing in this file ever imports `sqlite-audit-store.js` — reachable
 *    only by constructing its own connection from scratch.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BenchmarkStoreCorruptError,
  BenchmarkStoreSchemaVersionError,
  type BenchmarkCaseOutcome,
  type BenchmarkCaseRecordInput,
  type BenchmarkFixtureFile,
  type BenchmarkOracleRunRecord,
  type BenchmarkReviewCaseRecord,
  type BenchmarkReviewRunRecord,
  type BenchmarkSampleRecord,
  type BenchmarkStorePort,
  type RecordReviewCaseInput,
} from '../domain/benchmark-store.js';
import type {
  BenchmarkCaseReviewComparison,
  BenchmarkReviewSelectionKind,
  BlindWorkerAssessment,
} from '../domain/benchmark-review.js';
import type { Observation } from '../domain/oracle.js';
import type { ClassificationResult } from '../domain/classification.js';
import {
  loadSqliteModule,
  migrateSqliteStore,
  type SchemaErrorFactories,
  type SqliteMigration,
  type SqliteStoreSchema,
} from './sqlite-store-common.js';

/** Owner-only, mirroring `src/adapters/sqlite-audit-store.ts`'s own `DIRECTORY_MODE`. */
const DIRECTORY_MODE = 0o700;

const SCHEMA_VERSION = 2;

const MIGRATIONS: readonly SqliteMigration[] = [
  (db) => {
    db.exec(`
      CREATE TABLE benchmark_runs (
        id TEXT PRIMARY KEY,
        corpus_dir TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
    `);
    db.exec(`
      CREATE TABLE benchmark_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES benchmark_runs(id),
        case_id TEXT NOT NULL,
        operator TEXT NOT NULL,
        operator_role TEXT NOT NULL CHECK (operator_role IN ('prescriptive','descriptive')),
        oracle_kind TEXT NOT NULL,
        expected_outcome TEXT NOT NULL CHECK (expected_outcome IN ('expected-to-fail','expected-to-keep-passing')),
        fixture_hash TEXT NOT NULL,
        proof_status TEXT NOT NULL CHECK (proof_status IN ('proven','unproven')),
        proof_reason TEXT,
        recorded_at TEXT NOT NULL
      ) STRICT;
    `);
    db.exec('CREATE INDEX idx_benchmark_cases_run_id ON benchmark_cases (run_id);');
    db.exec('CREATE INDEX idx_benchmark_cases_case_id ON benchmark_cases (case_id);');
    db.exec(`
      CREATE TABLE benchmark_oracle_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        benchmark_case_id INTEGER NOT NULL REFERENCES benchmark_cases(id),
        label TEXT NOT NULL,
        observation_kind TEXT NOT NULL,
        observation_detail TEXT,
        content_hash TEXT NOT NULL,
        mutated_files TEXT NOT NULL
      ) STRICT;
    `);
    db.exec(`
      CREATE TABLE benchmark_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        benchmark_case_id INTEGER NOT NULL REFERENCES benchmark_cases(id),
        status TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        rubric_version INTEGER NOT NULL,
        model_requested TEXT NOT NULL,
        model_responded TEXT NOT NULL,
        model_matches_pin INTEGER NOT NULL CHECK (model_matches_pin IN (0, 1)),
        classification TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        latency_ms INTEGER
      ) STRICT;
    `);
    db.exec(`
      CREATE TABLE benchmark_sample_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        benchmark_case_id INTEGER NOT NULL REFERENCES benchmark_cases(id),
        kind TEXT NOT NULL,
        message TEXT NOT NULL
      ) STRICT;
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE benchmark_review_runs (
        id TEXT PRIMARY KEY,
        benchmark_run_id TEXT NOT NULL REFERENCES benchmark_runs(id),
        selection_kind TEXT NOT NULL CHECK (selection_kind IN ('all','disagreements','regressions','stratified')),
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
    `);
    db.exec('CREATE INDEX idx_benchmark_review_runs_benchmark_run_id ON benchmark_review_runs (benchmark_run_id);');
    db.exec(`
      CREATE TABLE benchmark_review_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_run_id TEXT NOT NULL REFERENCES benchmark_review_runs(id),
        case_id TEXT NOT NULL,
        input_payload_hash TEXT NOT NULL,
        frozen_at TEXT NOT NULL,
        worker_runtime TEXT NOT NULL,
        worker_model TEXT,
        assessment TEXT NOT NULL,
        comparison TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;
    `);
    db.exec('CREATE INDEX idx_benchmark_review_cases_review_run_id ON benchmark_review_cases (review_run_id);');
    db.exec('CREATE INDEX idx_benchmark_review_cases_case_id ON benchmark_review_cases (case_id);');
  },
];

const BENCHMARK_SQLITE_SCHEMA: SqliteStoreSchema = {
  metaTableName: 'benchmark_schema_meta',
  schemaVersion: SCHEMA_VERSION,
  migrations: MIGRATIONS,
};

const BENCHMARK_SQLITE_ERRORS: SchemaErrorFactories<BenchmarkStoreCorruptError | BenchmarkStoreSchemaVersionError> = {
  corrupt: (detail) => new BenchmarkStoreCorruptError(detail),
  tooNew: (foundVersion, supportedVersion) => new BenchmarkStoreSchemaVersionError(foundVersion, supportedVersion),
};

function isBenchmarkStoreError(error: unknown): error is BenchmarkStoreCorruptError | BenchmarkStoreSchemaVersionError {
  return error instanceof BenchmarkStoreCorruptError || error instanceof BenchmarkStoreSchemaVersionError;
}

function wrapNativeSqliteError(error: unknown, databaseFile: string): BenchmarkStoreCorruptError | BenchmarkStoreSchemaVersionError {
  if (isBenchmarkStoreError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new BenchmarkStoreCorruptError(`the native sqlite driver rejected "${databaseFile}": ${detail}`);
}

/**
 * Deterministic sha256 over a corpus case's own fixture bytes: every file's
 * path and contents, sorted by path so file ORDER never changes the hash —
 * only content does. Computed here, adapter-side, precisely because
 * `src/application` cannot touch `node:crypto` at all (see
 * `BenchmarkCaseRecordInput`'s own doc in `src/domain/benchmark-store.ts`).
 */
function hashFixture(files: readonly BenchmarkFixtureFile[]): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    hash.update(`path:${file.path}\0`);
    hash.update(file.contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function observationKind(observation: Observation): string {
  return observation.kind;
}

function observationDetail(observation: Observation): string | null {
  if (observation.kind === 'failed') return observation.detail ?? null;
  if (observation.kind === 'runner-error') return observation.detail;
  return null;
}

function parseObservation(kind: string, detail: string | null): Observation {
  if (kind === 'passed') return { kind: 'passed' };
  if (kind === 'timed-out') return { kind: 'timed-out' };
  if (kind === 'failed') return { kind: 'failed', ...(detail === null ? {} : { detail }) };
  if (kind === 'runner-error') return { kind: 'runner-error', detail: detail ?? '' };
  throw new BenchmarkStoreCorruptError(`benchmark_oracle_runs.observation_kind is not a recognized observation kind: ${JSON.stringify(kind)}`);
}

function insertCase(db: DatabaseSync, runId: string, input: BenchmarkCaseRecordInput, fixtureHash: string): number {
  const proofReason = input.proofStatus.kind === 'unproven' ? input.proofStatus.reason : null;
  const result = db.prepare(`
    INSERT INTO benchmark_cases
      (run_id, case_id, operator, operator_role, oracle_kind, expected_outcome, fixture_hash, proof_status, proof_reason, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    input.caseId,
    input.operator,
    input.operatorRole,
    input.oracleKind,
    input.expectedOutcome,
    fixtureHash,
    input.proofStatus.kind,
    proofReason,
    new Date().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

function insertOracleRun(db: DatabaseSync, benchmarkCaseId: number, run: BenchmarkOracleRunRecord): void {
  db.prepare(`
    INSERT INTO benchmark_oracle_runs (benchmark_case_id, label, observation_kind, observation_detail, content_hash, mutated_files)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(benchmarkCaseId, run.label, observationKind(run.observation), observationDetail(run.observation), run.contentHash, JSON.stringify(run.mutatedFiles));
}

function insertSample(db: DatabaseSync, benchmarkCaseId: number, sample: BenchmarkSampleRecord): void {
  db.prepare(`
    INSERT INTO benchmark_samples
      (benchmark_case_id, status, policy_version, rubric_version, model_requested, model_responded, model_matches_pin, classification, input_tokens, output_tokens, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    benchmarkCaseId,
    sample.classification.status,
    sample.policyVersion,
    sample.rubricVersion,
    sample.model.requested,
    sample.model.responded,
    sample.model.matchesPin ? 1 : 0,
    JSON.stringify(sample.classification),
    sample.usage.inputTokens,
    sample.usage.outputTokens,
    sample.latencyMs ?? null,
  );
}

function insertSampleFailure(db: DatabaseSync, benchmarkCaseId: number, kind: string, message: string): void {
  db.prepare('INSERT INTO benchmark_sample_failures (benchmark_case_id, kind, message) VALUES (?, ?, ?)').run(benchmarkCaseId, kind, message);
}

interface BenchmarkCaseRow {
  readonly id: number;
  readonly case_id: string;
  readonly operator: string;
  readonly operator_role: string;
  readonly oracle_kind: string;
  readonly expected_outcome: string;
  readonly fixture_hash: string;
  readonly proof_status: string;
  readonly proof_reason: string | null;
}

function loadOracleRuns(db: DatabaseSync, benchmarkCaseId: number): readonly BenchmarkOracleRunRecord[] {
  const rows = db.prepare('SELECT label, observation_kind, observation_detail, content_hash, mutated_files FROM benchmark_oracle_runs WHERE benchmark_case_id = ? ORDER BY id ASC').all(benchmarkCaseId) as unknown as readonly {
    readonly label: string;
    readonly observation_kind: string;
    readonly observation_detail: string | null;
    readonly content_hash: string;
    readonly mutated_files: string;
  }[];
  return rows.map((row) => ({
    label: row.label,
    observation: parseObservation(row.observation_kind, row.observation_detail),
    contentHash: row.content_hash,
    mutatedFiles: JSON.parse(row.mutated_files) as readonly string[],
  }));
}

function loadSample(db: DatabaseSync, benchmarkCaseId: number): BenchmarkSampleRecord | undefined {
  const row = db.prepare(`
    SELECT policy_version, rubric_version, model_requested, model_responded, model_matches_pin, classification, input_tokens, output_tokens, latency_ms
    FROM benchmark_samples WHERE benchmark_case_id = ?
  `).get(benchmarkCaseId) as {
    readonly policy_version: number;
    readonly rubric_version: number;
    readonly model_requested: string;
    readonly model_responded: string;
    readonly model_matches_pin: number;
    readonly classification: string;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly latency_ms: number | null;
  } | undefined;
  if (row === undefined) return undefined;
  return {
    classification: JSON.parse(row.classification) as ClassificationResult,
    policyVersion: row.policy_version,
    rubricVersion: row.rubric_version,
    model: { requested: row.model_requested, responded: row.model_responded, matchesPin: row.model_matches_pin === 1 },
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
    ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
  };
}

function loadSampleFailure(db: DatabaseSync, benchmarkCaseId: number): { readonly errorKind: string; readonly errorMessage: string } | undefined {
  const row = db.prepare('SELECT kind, message FROM benchmark_sample_failures WHERE benchmark_case_id = ?').get(benchmarkCaseId) as
    | { readonly kind: string; readonly message: string }
    | undefined;
  if (row === undefined) return undefined;
  return { errorKind: row.kind, errorMessage: row.message };
}

export interface CreateSqliteBenchmarkStoreOptions {
  readonly databaseFile: string;
}

/**
 * Creates the production {@link BenchmarkStorePort}: creates the containing
 * directory if needed, opens (or creates) `options.databaseFile`, and runs
 * migrations before returning. Always requires an explicit `databaseFile` —
 * see this module's own doc for why there is deliberately no default path
 * resolution.
 */
export async function createSqliteBenchmarkStore(options: CreateSqliteBenchmarkStoreOptions): Promise<BenchmarkStorePort> {
  const sqliteModule = await loadSqliteModule();
  await mkdir(dirname(options.databaseFile), { recursive: true, mode: DIRECTORY_MODE });

  let db: DatabaseSync;
  try {
    db = new sqliteModule.DatabaseSync(options.databaseFile);
  } catch (error) {
    throw wrapNativeSqliteError(error, options.databaseFile);
  }

  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    migrateSqliteStore(db, BENCHMARK_SQLITE_SCHEMA, BENCHMARK_SQLITE_ERRORS);
  } catch (error) {
    db.close();
    throw wrapNativeSqliteError(error, options.databaseFile);
  }

  return {
    async beginRun(corpusDir: string): Promise<string> {
      const runId = randomUUID();
      db.prepare('INSERT INTO benchmark_runs (id, corpus_dir, started_at) VALUES (?, ?, ?)').run(runId, corpusDir, new Date().toISOString());
      return runId;
    },

    async recordCase(runId: string, input: BenchmarkCaseRecordInput): Promise<void> {
      db.exec('BEGIN');
      try {
        const fixtureHash = hashFixture(input.fixtureFiles);
        const benchmarkCaseId = insertCase(db, runId, input, fixtureHash);
        for (const run of input.oracleRuns) insertOracleRun(db, benchmarkCaseId, run);
        if (input.sample !== undefined) insertSample(db, benchmarkCaseId, input.sample);
        if (input.sampleFailure !== undefined) insertSampleFailure(db, benchmarkCaseId, input.sampleFailure.errorKind, input.sampleFailure.errorMessage);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async finishRun(runId: string): Promise<void> {
      db.prepare('UPDATE benchmark_runs SET finished_at = ? WHERE id = ?').run(new Date().toISOString(), runId);
    },

    async loadRun(runId: string): Promise<readonly BenchmarkCaseOutcome[] | undefined> {
      const runRow = db.prepare('SELECT id FROM benchmark_runs WHERE id = ?').get(runId);
      if (runRow === undefined) return undefined;

      const caseRows = db.prepare(`
        SELECT id, case_id, operator, operator_role, oracle_kind, expected_outcome, fixture_hash, proof_status, proof_reason
        FROM benchmark_cases WHERE run_id = ? ORDER BY id ASC
      `).all(runId) as unknown as readonly BenchmarkCaseRow[];

      return caseRows.map((row): BenchmarkCaseOutcome => {
        const sample = loadSample(db, row.id);
        const sampleFailure = loadSampleFailure(db, row.id);
        return {
          caseId: row.case_id,
          operator: row.operator as BenchmarkCaseOutcome['operator'],
          operatorRole: row.operator_role as BenchmarkCaseOutcome['operatorRole'],
          oracleKind: row.oracle_kind as BenchmarkCaseOutcome['oracleKind'],
          expectedOutcome: row.expected_outcome as BenchmarkCaseOutcome['expectedOutcome'],
          fixtureHash: row.fixture_hash,
          proofStatus: row.proof_status === 'proven' ? { kind: 'proven' } : { kind: 'unproven', reason: row.proof_reason ?? '' },
          oracleRuns: loadOracleRuns(db, row.id),
          ...(sample === undefined ? {} : { sample }),
          ...(sampleFailure === undefined ? {} : { sampleFailure }),
        };
      });
    },

    async beginReview(benchmarkRunId: string, selectionKind: BenchmarkReviewSelectionKind): Promise<string> {
      const reviewId = randomUUID();
      db.prepare(`
        INSERT INTO benchmark_review_runs (id, benchmark_run_id, selection_kind, started_at)
        VALUES (?, ?, ?, ?)
      `).run(reviewId, benchmarkRunId, selectionKind, new Date().toISOString());
      return reviewId;
    },

    async recordReviewCase(reviewRunId: string, input: RecordReviewCaseInput): Promise<void> {
      db.prepare(`
        INSERT INTO benchmark_review_cases
          (review_run_id, case_id, input_payload_hash, frozen_at, worker_runtime, worker_model, assessment, comparison, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reviewRunId,
        input.frozenAssessment.caseId,
        input.frozenAssessment.inputPayloadHash,
        input.frozenAssessment.frozenAt,
        input.frozenAssessment.workerIdentity?.runtime ?? 'unknown',
        input.frozenAssessment.workerIdentity?.model ?? null,
        JSON.stringify(input.frozenAssessment.assessment),
        JSON.stringify(input.comparison),
        new Date().toISOString(),
      );
    },

    async finishReview(reviewRunId: string): Promise<void> {
      db.prepare('UPDATE benchmark_review_runs SET finished_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        reviewRunId,
      );
    },

    async loadReviewsForRun(benchmarkRunId: string): Promise<readonly BenchmarkReviewRunRecord[]> {
      interface ReviewRunRow {
        readonly id: string;
        readonly benchmark_run_id: string;
        readonly selection_kind: string;
        readonly started_at: string;
        readonly finished_at: string | null;
      }
      const rows = db.prepare(`
        SELECT id, benchmark_run_id, selection_kind, started_at, finished_at
        FROM benchmark_review_runs WHERE benchmark_run_id = ? ORDER BY started_at ASC
      `).all(benchmarkRunId) as unknown as readonly ReviewRunRow[];

      return rows.map((r): BenchmarkReviewRunRecord => ({
        id: r.id,
        benchmarkRunId: r.benchmark_run_id,
        selectionKind: r.selection_kind as BenchmarkReviewSelectionKind,
        startedAt: r.started_at,
        ...(r.finished_at === null ? {} : { finishedAt: r.finished_at }),
      }));
    },

    async loadReview(reviewRunId: string): Promise<BenchmarkReviewRunRecord | undefined> {
      interface ReviewRunRow {
        readonly id: string;
        readonly benchmark_run_id: string;
        readonly selection_kind: string;
        readonly started_at: string;
        readonly finished_at: string | null;
      }
      const row = db.prepare(`
        SELECT id, benchmark_run_id, selection_kind, started_at, finished_at
        FROM benchmark_review_runs WHERE id = ?
      `).get(reviewRunId) as ReviewRunRow | undefined;

      if (row === undefined) return undefined;
      return {
        id: row.id,
        benchmarkRunId: row.benchmark_run_id,
        selectionKind: row.selection_kind as BenchmarkReviewSelectionKind,
        startedAt: row.started_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      };
    },

    async loadReviewCases(reviewRunId: string): Promise<readonly BenchmarkReviewCaseRecord[]> {
      interface ReviewCaseRow {
        readonly id: number;
        readonly review_run_id: string;
        readonly case_id: string;
        readonly input_payload_hash: string;
        readonly frozen_at: string;
        readonly worker_runtime: string;
        readonly worker_model: string | null;
        readonly assessment: string;
        readonly comparison: string;
        readonly recorded_at: string;
      }
      const rows = db.prepare(`
        SELECT id, review_run_id, case_id, input_payload_hash, frozen_at, worker_runtime, worker_model, assessment, comparison, recorded_at
        FROM benchmark_review_cases WHERE review_run_id = ? ORDER BY id ASC
      `).all(reviewRunId) as unknown as readonly ReviewCaseRow[];

      return rows.map((r): BenchmarkReviewCaseRecord => ({
        id: r.id,
        reviewRunId: r.review_run_id,
        caseId: r.case_id,
        inputPayloadHash: r.input_payload_hash,
        frozenAt: r.frozen_at,
        workerRuntime: r.worker_runtime,
        ...(r.worker_model === null ? {} : { workerModel: r.worker_model }),
        assessment: JSON.parse(r.assessment) as BlindWorkerAssessment,
        comparison: JSON.parse(r.comparison) as BenchmarkCaseReviewComparison,
        recordedAt: r.recorded_at,
      }));
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
