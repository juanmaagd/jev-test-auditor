import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSqliteBenchmarkStore,
} from '../src/adapters/sqlite-benchmark-store.js';
import { createSqliteAuditStore } from '../src/adapters/sqlite-audit-store.js';
import {
  BenchmarkStoreCorruptError,
  BenchmarkStoreSchemaVersionError,
  type BenchmarkCaseRecordInput,
  type BenchmarkStorePort,
} from '../src/domain/benchmark-store.js';
import type {
  BenchmarkCaseReviewComparison,
  FrozenWorkerAssessment,
} from '../src/domain/benchmark-review.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDatabaseFile(name = 'benchmark-store.sqlite3'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-benchmark-store-'));
  temporaryRoots.push(root);
  return join(root, 'nested', name);
}

function sampleInput(caseId: string, overrides: Partial<Omit<BenchmarkCaseRecordInput, 'sample'>> = {}): BenchmarkCaseRecordInput {
  return {
    caseId,
    operator: 'remove-assertion',
    operatorRole: 'descriptive',
    oracleKind: 'production-mutation',
    expectedOutcome: 'expected-to-fail',
    fixtureFiles: [
      { path: 'test.ts', contents: `// ${caseId} test` },
      { path: 'cart.ts', contents: `// ${caseId} production` },
    ],
    proofStatus: { kind: 'proven' },
    oracleRuns: [
      { label: 'baseline', observation: { kind: 'passed' }, contentHash: 'ch-baseline', mutatedFiles: [] },
      { label: 'base-under-mutation', observation: { kind: 'failed', detail: 'assertion failed' }, contentHash: 'ch-mutation', mutatedFiles: ['cart.ts'] },
    ],
    sample: {
      classification: {
        testCaseId: `tc:${caseId}` as never,
        repositoryRelativePath: 'test.ts',
        name: caseId,
        status: 'misleading',
        dimensions: [],
        findings: [],
        policyVersion: 2,
        rubricVersion: 2,
        model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
        usage: { inputTokens: 321, outputTokens: 65 },
      },
      policyVersion: 2,
      rubricVersion: 2,
      model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
      usage: { inputTokens: 321, outputTokens: 65 },
      latencyMs: 987,
    },
    ...overrides,
  };
}

/** An unproven case with a sample FAILURE (never a `sample` at all) — a distinct shape `sampleInput`'s `Omit<..., 'sample'>` overrides cannot express (`exactOptionalPropertyTypes` forbids `sample: undefined`), so built directly. */
function unprovenSampleFailureInput(caseId: string): BenchmarkCaseRecordInput {
  const full = sampleInput(caseId, {
    proofStatus: { kind: 'unproven', reason: 'baseline-failed: the case\'s base test did not pass' },
  });
  const rest: Omit<BenchmarkCaseRecordInput, 'sample'> = {
    caseId: full.caseId,
    operator: full.operator,
    operatorRole: full.operatorRole,
    oracleKind: full.oracleKind,
    expectedOutcome: full.expectedOutcome,
    fixtureFiles: full.fixtureFiles,
    proofStatus: full.proofStatus,
    oracleRuns: full.oracleRuns,
  };
  return {
    ...rest,
    sampleFailure: { errorKind: 'evaluation-failed', errorMessage: 'Jev rate limit exceeded (429) after 4 attempt(s).' },
  };
}

describe('createSqliteBenchmarkStore migrations', () => {
  it('creates the schema from an empty file', async () => {
    const databaseFile = await tempDatabaseFile();

    const store = await createSqliteBenchmarkStore({ databaseFile });
    await store.close();

    const db = new DatabaseSync(databaseFile);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map((row) => (row as { readonly name: string }).name);
      expect(tables).toEqual(expect.arrayContaining([
        'benchmark_runs', 'benchmark_cases', 'benchmark_oracle_runs', 'benchmark_samples',
        'benchmark_sample_failures', 'benchmark_schema_meta',
        'benchmark_review_runs', 'benchmark_review_cases',
      ]));
      const version = (db.prepare('SELECT schema_version FROM benchmark_schema_meta WHERE id = 1').get() as { readonly schema_version: number }).schema_version;
      expect(version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('migrates a schema v1 database to v2, preserving existing runs and adding review tables', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    const db = new DatabaseSync(databaseFile);
    db.exec(`
      CREATE TABLE benchmark_schema_meta (id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL);
      INSERT INTO benchmark_schema_meta (id, schema_version) VALUES (1, 1);
      CREATE TABLE benchmark_runs (id TEXT PRIMARY KEY, corpus_dir TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT) STRICT;
      CREATE TABLE benchmark_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES benchmark_runs(id), case_id TEXT NOT NULL, operator TEXT NOT NULL, operator_role TEXT NOT NULL, oracle_kind TEXT NOT NULL, expected_outcome TEXT NOT NULL, fixture_hash TEXT NOT NULL, proof_status TEXT NOT NULL, proof_reason TEXT, recorded_at TEXT NOT NULL) STRICT;
      CREATE TABLE benchmark_oracle_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, benchmark_case_id INTEGER NOT NULL REFERENCES benchmark_cases(id), label TEXT NOT NULL, observation_kind TEXT NOT NULL, observation_detail TEXT, content_hash TEXT NOT NULL, mutated_files TEXT NOT NULL) STRICT;
      CREATE TABLE benchmark_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, benchmark_case_id INTEGER NOT NULL REFERENCES benchmark_cases(id), status TEXT NOT NULL, policy_version INTEGER NOT NULL, rubric_version INTEGER NOT NULL, model_requested TEXT NOT NULL, model_responded TEXT NOT NULL, model_matches_pin INTEGER NOT NULL, classification TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, latency_ms INTEGER) STRICT;
      CREATE TABLE benchmark_sample_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, benchmark_case_id INTEGER NOT NULL REFERENCES benchmark_cases(id), kind TEXT NOT NULL, message TEXT NOT NULL) STRICT;
      INSERT INTO benchmark_runs (id, corpus_dir, started_at) VALUES ('v1-run', 'test/corpus', '2026-09-20T00:00:00.000Z');
    `);
    db.close();

    const store = await createSqliteBenchmarkStore({ databaseFile });
    const run = await store.loadRun('v1-run');
    expect(run).toEqual([]);

    const verifyDb = new DatabaseSync(databaseFile);
    try {
      const version = (verifyDb.prepare('SELECT schema_version FROM benchmark_schema_meta WHERE id = 1').get() as { readonly schema_version: number }).schema_version;
      expect(version).toBe(2);
      const tables = verifyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map((row) => (row as { readonly name: string }).name);
      expect(tables).toContain('benchmark_review_runs');
      expect(tables).toContain('benchmark_review_cases');
    } finally {
      verifyDb.close();
      await store.close();
    }
  });

  it('is idempotent on re-open: preserves an already-written run', async () => {
    const databaseFile = await tempDatabaseFile();

    const first = await createSqliteBenchmarkStore({ databaseFile });
    const runId = await first.beginRun('test/fixtures/corpus/discrimination');
    await first.close();

    const second = await createSqliteBenchmarkStore({ databaseFile });
    const loaded = await second.loadRun(runId);
    await second.close();

    expect(loaded).toEqual([]);
  });

  it('fails with a named, visible error when the recorded schema version is newer than this build supports', async () => {
    const databaseFile = await tempDatabaseFile();
    const bootstrap = await createSqliteBenchmarkStore({ databaseFile });
    await bootstrap.close();

    const db = new DatabaseSync(databaseFile);
    db.prepare('UPDATE benchmark_schema_meta SET schema_version = 999 WHERE id = 1').run();
    db.close();

    await expect(createSqliteBenchmarkStore({ databaseFile })).rejects.toThrow(BenchmarkStoreSchemaVersionError);
    await expect(createSqliteBenchmarkStore({ databaseFile })).rejects.toMatchObject({ foundVersion: 999, supportedVersion: 2 });
  });

  it('fails with a named, visible error rather than silently adopting a foreign database with user tables but no benchmark_schema_meta table', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    const foreignDb = new DatabaseSync(databaseFile);
    foreignDb.exec('CREATE TABLE some_other_apps_table (id INTEGER PRIMARY KEY)');
    foreignDb.close();

    await expect(createSqliteBenchmarkStore({ databaseFile })).rejects.toThrow(BenchmarkStoreCorruptError);

    const db = new DatabaseSync(databaseFile);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => (row as { readonly name: string }).name);
      expect(tables).toEqual(['some_other_apps_table']);
    } finally {
      db.close();
    }
  });

  // The concrete misconfiguration this store's OWN (distinct) meta table name exists to catch —
  // see `sqlite-store-common.ts`'s `SqliteStoreSchema.metaTableName` doc. A real, valid audit store
  // has real user tables (`runs`, `work_items`, ...) but no `benchmark_schema_meta` table, so it is
  // refused exactly like any other foreign database, never silently adopted, and never touched.
  it('refuses a real audit store file opened as a benchmark store, leaving it byte-identical', async () => {
    const databaseFile = await tempDatabaseFile('audit-store.sqlite3');
    const auditStore = await createSqliteAuditStore({ databaseFile });
    await auditStore.beginRun('/some/repo');
    await auditStore.close();
    const before = await readFile(databaseFile);

    await expect(createSqliteBenchmarkStore({ databaseFile })).rejects.toThrow(BenchmarkStoreCorruptError);

    const after = await readFile(databaseFile);
    expect(after.equals(before)).toBe(true);
  });
});

describe('createSqliteBenchmarkStore case persistence and round trip', () => {
  let store: BenchmarkStorePort;
  let databaseFile: string;

  afterEach(async () => {
    await store?.close();
  });

  it('persists a proven case with its sample and reads it back unchanged, including a deterministic fixture hash', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteBenchmarkStore({ databaseFile });
    const runId = await store.beginRun('test/fixtures/corpus/discrimination');

    await store.recordCase(runId, sampleInput('proven-case'));
    await store.finishRun(runId);

    const loaded = await store.loadRun(runId);
    expect(loaded).toHaveLength(1);
    const outcome = loaded![0]!;
    expect(outcome.caseId).toBe('proven-case');
    expect(outcome.operatorRole).toBe('descriptive');
    expect(outcome.proofStatus).toEqual({ kind: 'proven' });
    expect(outcome.oracleRuns).toEqual([
      { label: 'baseline', observation: { kind: 'passed' }, contentHash: 'ch-baseline', mutatedFiles: [] },
      { label: 'base-under-mutation', observation: { kind: 'failed', detail: 'assertion failed' }, contentHash: 'ch-mutation', mutatedFiles: ['cart.ts'] },
    ]);
    expect(outcome.sample?.classification.status).toBe('misleading');
    expect(outcome.sample?.policyVersion).toBe(2);
    expect(outcome.sample?.rubricVersion).toBe(2);
    expect(outcome.sample?.usage).toEqual({ inputTokens: 321, outputTokens: 65 });
    expect(outcome.sample?.latencyMs).toBe(987);
    expect(outcome.sampleFailure).toBeUndefined();
    expect(typeof outcome.fixtureHash).toBe('string');
    expect(outcome.fixtureHash.length).toBeGreaterThan(0);

    // Deterministic: recording the identical fixture bytes (same paths, same contents) for a
    // second, differently-identified case produces the same hash — the hash is a function of the
    // fixture bytes alone, never the caseId.
    await store.recordCase(runId, sampleInput('same-bytes-different-id', {
      fixtureFiles: [
        { path: 'test.ts', contents: '// proven-case test' },
        { path: 'cart.ts', contents: '// proven-case production' },
      ],
    }));
    const reloaded = await store.loadRun(runId);
    const first = reloaded!.find((entry) => entry.caseId === 'proven-case')!;
    const second = reloaded!.find((entry) => entry.caseId === 'same-bytes-different-id')!;
    expect(second.fixtureHash).toBe(first.fixtureHash);
  });

  it('persists an unproven case with its reason and a sample failure (never a fabricated sample)', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteBenchmarkStore({ databaseFile });
    const runId = await store.beginRun('test/fixtures/corpus/discrimination');

    await store.recordCase(runId, unprovenSampleFailureInput('unproven-case'));

    const loaded = await store.loadRun(runId);
    const outcome = loaded![0]!;
    expect(outcome.proofStatus).toEqual({ kind: 'unproven', reason: 'baseline-failed: the case\'s base test did not pass' });
    expect(outcome.sample).toBeUndefined();
    expect(outcome.sampleFailure).toEqual({ errorKind: 'evaluation-failed', errorMessage: 'Jev rate limit exceeded (429) after 4 attempt(s).' });
  });

  it('produces a different fixture hash for different fixture bytes', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteBenchmarkStore({ databaseFile });
    const runId = await store.beginRun('test/fixtures/corpus/discrimination');

    await store.recordCase(runId, sampleInput('case-a'));
    await store.recordCase(runId, sampleInput('case-b', {
      caseId: 'case-b',
      fixtureFiles: [{ path: 'test.ts', contents: '// entirely different bytes' }, { path: 'cart.ts', contents: '// also different' }],
    }));

    const loaded = await store.loadRun(runId);
    const a = loaded!.find((entry) => entry.caseId === 'case-a')!;
    const b = loaded!.find((entry) => entry.caseId === 'case-b')!;
    expect(a.fixtureHash).not.toBe(b.fixtureHash);
  });

  it('loadRun returns undefined for a run id that was never recorded', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteBenchmarkStore({ databaseFile });

    await expect(store.loadRun('does-not-exist')).resolves.toBeUndefined();
  });

  it('rolls back a mid-write transaction on failure, leaving no partial case record', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteBenchmarkStore({ databaseFile });
    const runId = await store.beginRun('test/fixtures/corpus/discrimination');

    const badInput = {
      ...sampleInput('bad-case'),
      oracleKind: null,
    } as unknown as BenchmarkCaseRecordInput;

    await expect(store.recordCase(runId, badInput)).rejects.toThrow();

    const db = new DatabaseSync(databaseFile);
    try {
      const count = (db.prepare('SELECT COUNT(*) as count FROM benchmark_cases').get() as { readonly count: number }).count;
      expect(count).toBe(0);
    } finally {
      db.close();
    }

    // Proof the transaction actually rolled back (not merely never committed): the connection is
    // not left inside an open transaction, so the next recordCase call succeeds normally.
    await expect(store.recordCase(runId, sampleInput('good-case-after-rollback'))).resolves.toBeUndefined();
  });
});

describe('createSqliteBenchmarkStore review persistence', () => {
  let store: BenchmarkStorePort;
  let databaseFile: string;

  afterEach(async () => {
    await store?.close();
  });

  it('persists a review run and review cases, and loads them back', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteBenchmarkStore({ databaseFile });
    const runId = await store.beginRun('test/fixtures/corpus/discrimination');
    await store.recordCase(runId, sampleInput('case-1'));
    await store.finishRun(runId);

    const reviewId = await store.beginReview(runId, 'disagreements');
    const frozenAssessment: FrozenWorkerAssessment = {
      caseId: 'case-1',
      inputPayloadHash: 'hash-abc',
      frozenAt: '2026-09-21T21:00:00.000Z',
      workerIdentity: { runtime: 'antigravity-subagent', model: 'claude-3-7-sonnet' },
      assessment: {
        caseId: 'case-1',
        assessedDimensions: [
          {
            dimensionId: 'falsifiability',
            level: 'misleading',
            score: 0,
            confidence: 0.9,
            reasoning: 'flawed test',
            evidenceCitations: ['expect(1).toBe(1)'],
          },
        ],
        overallUncertainty: 0.05,
      },
    };

    const comparison: BenchmarkCaseReviewComparison = {
      caseId: 'case-1',
      agreement: false,
      discrepancyKind: 'likely-model-error',
      explanation: 'Jev failed, reviewer matched ground truth.',
      jevOutcome: { status: 'healthy', levels: { falsifiability: 'acceptable' } },
      reviewerOutcome: { levels: { falsifiability: 'misleading' }, uncertainty: 0.05 },
      oracleGroundTruth: { operatorRole: 'descriptive', expectedOutcome: 'expected-to-fail', proofStatus: { kind: 'proven' } },
    };

    await store.recordReviewCase(reviewId, { frozenAssessment, comparison });
    await store.finishReview(reviewId);

    const reviews = await store.loadReviewsForRun(runId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.id).toBe(reviewId);
    expect(reviews[0]?.benchmarkRunId).toBe(runId);
    expect(reviews[0]?.selectionKind).toBe('disagreements');
    expect(reviews[0]?.finishedAt).toBeDefined();

    const cases = await store.loadReviewCases(reviewId);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.caseId).toBe('case-1');
    expect(cases[0]?.inputPayloadHash).toBe('hash-abc');
    expect(cases[0]?.workerRuntime).toBe('antigravity-subagent');
    expect(cases[0]?.workerModel).toBe('claude-3-7-sonnet');
    expect(cases[0]?.assessment.caseId).toBe('case-1');
    expect(cases[0]?.comparison.discrepancyKind).toBe('likely-model-error');
  });
});
