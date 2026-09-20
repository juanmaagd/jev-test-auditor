import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSqliteAuditStore,
  isSqliteExperimentalWarning,
  openSqliteAuditStoreForLookup,
  resolveAuditStorePaths,
  withSqliteExperimentalWarningSuppressed,
  type AuditStorePaths,
} from '../src/adapters/sqlite-audit-store.js';
import {
  AuditStoreCorruptError,
  AuditStoreSchemaVersionError,
  type AuditStorePort,
  type AuditStoreRunState,
  type AuditStoreWorkItemOutcome,
} from '../src/domain/audit.js';
import type { ClassificationResult } from '../src/domain/classification.js';
import type { JevEvaluation } from '../src/domain/jev-gateway.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDatabaseFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-audit-store-'));
  temporaryRoots.push(root);
  return join(root, 'nested', 'audit-store.sqlite3');
}

// --- resolveAuditStorePaths (mirrors resolveAuthStoragePaths's own convention) ---

describe('resolveAuditStorePaths', () => {
  it('uses XDG_CONFIG_HOME on POSIX when set', () => {
    const paths = resolveAuditStorePaths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/custom/config' }, homedir: '/home/user' });

    expect(paths.configDir).toBe(join('/custom/config', 'jev-test-auditor'));
    expect(paths.databaseFile).toBe(join('/custom/config', 'jev-test-auditor', 'audit-store.sqlite3'));
  });

  it('falls back to ~/.config on POSIX when XDG_CONFIG_HOME is unset', () => {
    const paths = resolveAuditStorePaths({ platform: 'darwin', env: {}, homedir: '/home/user' });

    expect(paths.configDir).toBe(join('/home/user', '.config', 'jev-test-auditor'));
  });

  it('uses APPDATA on Windows when set', () => {
    const paths = resolveAuditStorePaths({ platform: 'win32', env: { APPDATA: 'C:\\Users\\user\\AppData\\Roaming' }, homedir: 'C:\\Users\\user' });

    expect(paths.configDir).toBe(join('C:\\Users\\user\\AppData\\Roaming', 'jev-test-auditor'));
  });

  it('falls back to homedir/AppData/Roaming on Windows when APPDATA is unset', () => {
    const paths = resolveAuditStorePaths({ platform: 'win32', env: {}, homedir: 'C:\\Users\\user' });

    expect(paths.configDir).toBe(join('C:\\Users\\user', 'AppData', 'Roaming', 'jev-test-auditor'));
  });

  it('shares the same per-user config directory convention as auth storage, under its own file name', () => {
    const paths: AuditStorePaths = resolveAuditStorePaths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/custom/config' }, homedir: '/home/user' });

    expect(paths.configDir.endsWith('jev-test-auditor')).toBe(true);
    expect(paths.databaseFile.endsWith('audit-store.sqlite3')).toBe(true);
  });
});

// --- ExperimentalWarning suppression (Phase 5 Scope: "Suppress that one warning narrowly") ---

describe('sqlite experimental warning suppression', () => {
  it('isSqliteExperimentalWarning recognizes only the exact sqlite ExperimentalWarning shape', () => {
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')).toBe(true);
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature and might change at any time', 'DeprecationWarning')).toBe(false);
    expect(isSqliteExperimentalWarning('Something else entirely', 'ExperimentalWarning')).toBe(false);
    expect(isSqliteExperimentalWarning('deprecated thing', 'DeprecationWarning')).toBe(false);
  });

  it('suppresses only the sqlite ExperimentalWarning, forwards a different ExperimentalWarning and a different warning type untouched, and restores process.emitWarning afterward', async () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    const result = await withSqliteExperimentalWarningSuppressed(async () => {
      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning('Something else entirely', 'ExperimentalWarning');
      process.emitWarning('deprecated thing', 'DeprecationWarning');
      return 'loaded';
    });

    expect(result).toBe('loaded');
    // Mutation probe target: exactly the two non-sqlite warnings reached the underlying
    // emitWarning — a blanket filter (never calling through) would fail this at `toHaveBeenCalledTimes(2)`,
    // and a no-op filter (always calling through) would fail it at `not.toHaveBeenCalledWith` below.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('Something else entirely', 'ExperimentalWarning');
    expect(spy).toHaveBeenCalledWith('deprecated thing', 'DeprecationWarning');
    expect(spy).not.toHaveBeenCalledWith('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');

    // Restoration: process.emitWarning is back to the (spied) original, so a sqlite warning
    // emitted outside the wrapper's window reaches it again.
    expect(process.emitWarning).toBe(spy);
    process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    expect(spy).toHaveBeenCalledTimes(3);

    spy.mockRestore();
  });

  it('restores process.emitWarning even when the loader rejects', async () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const boom = new Error('loader boom');

    await expect(withSqliteExperimentalWarningSuppressed(async () => {
      throw boom;
    })).rejects.toBe(boom);

    expect(process.emitWarning).toBe(spy);
    spy.mockRestore();
  });

  // P5-1 verifier finding E: two overlapping (not merely nested) calls each save/restore
  // `process.emitWarning` independently. Call A resolving first must not restore the pre-A
  // baseline while call B is still active (dropping B's still-active suppression and letting a
  // real sqlite warning leak during the crossover window); and call B resolving afterward must
  // not permanently install A's now-stale wrapper instead of the true original.
  it('shares one patch across overlapping calls: an earlier call finishing does not drop a still-active later call\'s suppression, and the true original is restored only once the last call finishes', async () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const sqliteWarning = 'SQLite is an experimental feature and might change at any time';

    let resolveA: () => void = () => undefined;
    const aGate = new Promise<void>((resolve) => { resolveA = resolve; });
    let resolveB: () => void = () => undefined;
    const bGate = new Promise<void>((resolve) => { resolveB = resolve; });

    // Start A, then start B while A is still in flight — a genuine overlap, not clean nesting.
    const callA = withSqliteExperimentalWarningSuppressed(async () => {
      await aGate;
      return 'a';
    });
    const callB = withSqliteExperimentalWarningSuppressed(async () => {
      await bGate;
      return 'b';
    });

    // A resolves first, while B is still active.
    resolveA();
    await expect(callA).resolves.toBe('a');

    // The sqlite warning must still be suppressed here: A's own completion must not have
    // restored the pre-A baseline and dropped B's still-active patch.
    process.emitWarning(sqliteWarning, 'ExperimentalWarning');
    expect(spy).not.toHaveBeenCalledWith(sqliteWarning, 'ExperimentalWarning');

    // Now B (the last remaining call) resolves.
    resolveB();
    await expect(callB).resolves.toBe('b');

    // Only now, with no suppression call still active, must the true original be restored.
    expect(process.emitWarning).toBe(spy);
    process.emitWarning(sqliteWarning, 'ExperimentalWarning');
    expect(spy).toHaveBeenCalledWith(sqliteWarning, 'ExperimentalWarning');

    spy.mockRestore();
  });

  // A real, in-process "createSqliteAuditStore never lets the real node:sqlite warning through"
  // assertion is unreliable here: Node deduplicates that exact ExperimentalWarning once per
  // process regardless of how many times `node:sqlite` is imported (verified empirically —
  // `node -e "await import('node:sqlite'); await import('node:sqlite')"` prints it exactly once),
  // and this file's own top-level `DatabaseSync` import (used below for raw row inspection) races
  // the very call this test would exercise for that one-time opportunity. The real, end-to-end
  // proof — a fresh child process, immune to that cross-test/process-wide dedup — lives in
  // `test/bin-smoke.test.ts`, appended to its existing packed-binary build; the fake-loader tests
  // above are the deterministic proof of the suppression logic itself.
});

// --- Migrations ---

describe('createSqliteAuditStore migrations', () => {
  it('creates the schema from an empty file', async () => {
    const databaseFile = await tempDatabaseFile();

    const store = await createSqliteAuditStore({ databaseFile });
    await store.close();

    const db = new DatabaseSync(databaseFile);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map((row) => (row as { readonly name: string }).name);
      expect(tables).toEqual(expect.arrayContaining(['runs', 'work_items', 'attempts', 'judgments', 'errors', 'skips', 'schema_meta']));
      const version = (db.prepare('SELECT schema_version FROM schema_meta WHERE id = 1').get() as { readonly schema_version: number }).schema_version;
      // Phase 5, task P5-2 bumps the schema to version 2 (adds `work_items.cache_key`) — see the
      // "upgrades a v1 database to v2" test below for the migration-as-upgrade path.
      expect(version).toBe(2);
    } finally {
      db.close();
    }
  });

  // The only test that exercises MIGRATIONS[1] as an actual upgrade (version 1 -> 2), rather than
  // from-empty (version 0 -> 2 in one pass, which the "creates the schema from an empty file" test
  // above already covers but which alone could never distinguish "ran both migrations" from "only
  // ever knew how to create the newest schema directly").
  it('upgrades a hand-built v1 database to v2, adding work_items.cache_key without disturbing an already-written row', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });

    // Recreate exactly what MIGRATIONS[0] produces, plus a schema_meta row pinned at 1 — a
    // faithful stand-in for a real database written by a pre-P5-2 build.
    const v1Db = new DatabaseSync(databaseFile);
    v1Db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        root_dir TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
    `);
    v1Db.exec(`
      CREATE TABLE work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        test_case_id TEXT NOT NULL,
        repository_relative_path TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','running','completed','cached','uncertain','skipped','failed')),
        recorded_at TEXT NOT NULL
      ) STRICT;
    `);
    v1Db.exec(`
      CREATE TABLE attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER NOT NULL REFERENCES work_items(id),
        requested_model TEXT NOT NULL,
        responded_model TEXT NOT NULL,
        model_matches_pin INTEGER NOT NULL CHECK (model_matches_pin IN (0, 1)),
        attempts INTEGER NOT NULL,
        raw_answers TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL
      ) STRICT;
    `);
    v1Db.exec(`
      CREATE TABLE judgments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER NOT NULL REFERENCES work_items(id),
        status TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        rubric_version INTEGER NOT NULL,
        classification TEXT NOT NULL
      ) STRICT;
    `);
    v1Db.exec(`CREATE TABLE errors (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id INTEGER NOT NULL REFERENCES work_items(id), kind TEXT NOT NULL, message TEXT NOT NULL) STRICT;`);
    v1Db.exec(`CREATE TABLE skips (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id INTEGER NOT NULL REFERENCES work_items(id), reason TEXT NOT NULL) STRICT;`);
    v1Db.exec(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL) STRICT;`);
    v1Db.exec('INSERT INTO schema_meta (id, schema_version) VALUES (1, 1)');
    v1Db.prepare('INSERT INTO runs (id, root_dir, started_at) VALUES (?, ?, ?)').run('pre-existing-run', '/repo', '2026-01-01T00:00:00.000Z');
    v1Db.prepare(
      'INSERT INTO work_items (run_id, test_case_id, repository_relative_path, name, state, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('pre-existing-run', 'tc:v1:pre-existing', 'a.test.ts', 'pre-existing test', 'skipped', '2026-01-01T00:00:00.000Z');
    v1Db.close();

    const store = await createSqliteAuditStore({ databaseFile });
    await store.close();

    const db = new DatabaseSync(databaseFile);
    try {
      const version = (db.prepare('SELECT schema_version FROM schema_meta WHERE id = 1').get() as { readonly schema_version: number }).schema_version;
      expect(version).toBe(2);

      const columns = db.prepare('PRAGMA table_info(work_items)').all().map((row) => (row as { readonly name: string }).name);
      expect(columns).toContain('cache_key');

      const preExisting = db.prepare('SELECT * FROM work_items WHERE test_case_id = ?').get('tc:v1:pre-existing') as Record<string, unknown>;
      expect(preExisting['state']).toBe('skipped');
      expect(preExisting['repository_relative_path']).toBe('a.test.ts');
      expect(preExisting['cache_key']).toBeNull();

      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('pre-existing-run') as Record<string, unknown>;
      expect(run['root_dir']).toBe('/repo');
    } finally {
      db.close();
    }
  });

  it('is idempotent on re-open: re-opening an existing store neither recreates nor drops any table, and preserves already-written rows', async () => {
    const databaseFile = await tempDatabaseFile();

    const firstOpen = await createSqliteAuditStore({ databaseFile });
    const runId = await firstOpen.beginRun('/repo');
    await firstOpen.close();

    const secondOpen = await createSqliteAuditStore({ databaseFile });
    await secondOpen.close();

    const db = new DatabaseSync(databaseFile);
    try {
      const row = db.prepare('SELECT id, root_dir FROM runs WHERE id = ?').get(runId) as { readonly id: string; readonly root_dir: string } | undefined;
      expect(row).toEqual({ id: runId, root_dir: '/repo' });
    } finally {
      db.close();
    }
  });

  it('fails with a named, visible error when the recorded schema version is newer than this build supports', async () => {
    const databaseFile = await tempDatabaseFile();

    // Bootstrap a real store first so the schema (and schema_meta table) actually exist ...
    const bootstrap = await createSqliteAuditStore({ databaseFile });
    await bootstrap.close();

    // ... then tamper with the recorded version to simulate a future, unsupported schema.
    const db = new DatabaseSync(databaseFile);
    db.prepare('UPDATE schema_meta SET schema_version = 999 WHERE id = 1').run();
    db.close();

    await expect(createSqliteAuditStore({ databaseFile })).rejects.toThrow(AuditStoreSchemaVersionError);
    await expect(createSqliteAuditStore({ databaseFile })).rejects.toMatchObject({ foundVersion: 999, supportedVersion: 2 });
  });

  it('fails with a named, visible error when schema_meta exists but its row is missing or malformed, rather than silently recreating the database', async () => {
    const databaseFile = await tempDatabaseFile();

    const bootstrap = await createSqliteAuditStore({ databaseFile });
    await bootstrap.close();

    const db = new DatabaseSync(databaseFile);
    db.prepare('DELETE FROM schema_meta').run();
    db.close();

    await expect(createSqliteAuditStore({ databaseFile })).rejects.toThrow(AuditStoreCorruptError);
  });

  // P5-1 verifier finding D: only the "row missing" sub-case above was covered; a malformed
  // `schema_version` value (present but not a non-negative integer) had zero test coverage —
  // deleting that whole check left the suite green at 697/697.
  it.each([
    ['a string', "'not-a-number'"],
    ['a float', '1.5'],
    ['a negative number', '-1'],
  ])('fails with a named, visible error when schema_meta.schema_version is %s, rather than silently recreating the database', async (_label, sqlLiteral) => {
    const databaseFile = await tempDatabaseFile();

    const bootstrap = await createSqliteAuditStore({ databaseFile });
    await bootstrap.close();

    // `schema_meta` is a STRICT table, so a plain UPDATE would itself reject a wrong-typed
    // literal before this adapter's own validation ever runs. Recreate it as a plain (non-STRICT)
    // table to get the malformed value stored at all — reproducing what a hand-edited or
    // otherwise corrupted database file could contain.
    const db = new DatabaseSync(databaseFile);
    db.exec('DROP TABLE schema_meta');
    db.exec('CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, schema_version)');
    db.exec(`INSERT INTO schema_meta (id, schema_version) VALUES (1, ${sqlLiteral})`);
    db.close();

    await expect(createSqliteAuditStore({ databaseFile })).rejects.toThrow(AuditStoreCorruptError);
  });
});

// --- WAL mode (Phase 5, task P5-3) ---------------------------------------------------------

describe('createSqliteAuditStore write performance mode', () => {
  it('opens the database in WAL journal mode, not the default rollback-journal mode', async () => {
    const databaseFile = await tempDatabaseFile();

    const store = await createSqliteAuditStore({ databaseFile });
    await store.close();

    // `journal_mode` is a persistent property of the database file itself (unlike `synchronous`,
    // which is per-connection and so cannot be observed this way from a freshly reopened handle),
    // so a fresh connection correctly reads back what the store set.
    const db = new DatabaseSync(databaseFile);
    try {
      const journalMode = (db.prepare('PRAGMA journal_mode').get() as { readonly journal_mode: string }).journal_mode;
      expect(journalMode).toBe('wal');
    } finally {
      db.close();
    }
  });

  // P5-1 verifier finding B's own tests (`createSqliteAuditStore native failure wrapping`, above)
  // already exercise a garbage file and a read-only file; this confirms the WAL pragma calls this
  // task added stay inside that same wrapping — a real regression this task introduced and fixed
  // during its own verification (setting WAL mode on a read-only file itself needs to write).
  it('still reports AuditStoreCorruptError, not a raw native error, when setting WAL mode fails on a read-only database file', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    await writeFile(databaseFile, Buffer.alloc(0));
    await chmod(databaseFile, 0o400);

    try {
      const error: unknown = await createSqliteAuditStore({ databaseFile }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuditStoreCorruptError);
      expect((error as Error).message).not.toContain('ERR_SQLITE_ERROR');
    } finally {
      await chmod(databaseFile, 0o600);
    }
  });
});

// --- Foreign database protection (P5-1 verifier finding B) ---------------------------------

describe('createSqliteAuditStore foreign database protection', () => {
  it('fails with a named, visible error rather than silently adopting a foreign database that has user tables but no schema_meta table', async () => {
    const databaseFile = await tempDatabaseFile();

    // Simulate another application's database: it has real tables, but never went through this
    // adapter's own migrations, so it has no `schema_meta` table at all — distinct from a
    // genuinely empty (never-touched) database, which must still migrate normally (see below).
    await mkdir(dirname(databaseFile), { recursive: true });
    const foreignDb = new DatabaseSync(databaseFile);
    foreignDb.exec('CREATE TABLE some_other_apps_table (id INTEGER PRIMARY KEY, payload TEXT)');
    foreignDb.close();

    await expect(createSqliteAuditStore({ databaseFile })).rejects.toThrow(AuditStoreCorruptError);

    // The foreign table must be left untouched — no partial adoption.
    const db = new DatabaseSync(databaseFile);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map((row) => (row as { readonly name: string }).name);
      expect(tables).toEqual(['some_other_apps_table']);
    } finally {
      db.close();
    }
  });

  it('still migrates normally from a genuinely empty database with no user tables at all, including an explicitly created zero-byte file', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    await writeFile(databaseFile, Buffer.alloc(0));

    const store = await createSqliteAuditStore({ databaseFile });
    await store.close();

    const db = new DatabaseSync(databaseFile);
    try {
      const version = (db.prepare('SELECT schema_version FROM schema_meta WHERE id = 1').get() as { readonly schema_version: number }).schema_version;
      expect(version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('fails with a named, visible error instead of a raw "table already exists" error when a foreign database\'s table names collide with ours', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });

    const foreignDb = new DatabaseSync(databaseFile);
    foreignDb.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY)');
    foreignDb.close();

    const error: unknown = await createSqliteAuditStore({ databaseFile }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuditStoreCorruptError);
    expect((error as Error).message).not.toContain('ERR_SQLITE_ERROR');
  });
});

// --- Wrapping raw native sqlite failures (P5-1 verifier finding B) -------------------------

describe('createSqliteAuditStore native failure wrapping', () => {
  it('wraps a native failure into a named error when the file is not a SQLite database at all', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    await writeFile(databaseFile, 'this is not a sqlite database file, just plain text padding padding padding');

    const error: unknown = await createSqliteAuditStore({ databaseFile }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuditStoreCorruptError);
    expect((error as Error).message).not.toContain('ERR_SQLITE_ERROR');
  });

  it('wraps a native failure into a named error when a directory exists where the database file should be', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(databaseFile, { recursive: true });

    const error: unknown = await createSqliteAuditStore({ databaseFile }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuditStoreCorruptError);
    expect((error as Error).message).not.toContain('ERR_SQLITE_ERROR');
  });

  it('wraps a native failure into a named error when the database file is read-only', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    await writeFile(databaseFile, Buffer.alloc(0));
    await chmod(databaseFile, 0o400);

    try {
      const error: unknown = await createSqliteAuditStore({ databaseFile }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuditStoreCorruptError);
      expect((error as Error).message).not.toContain('ERR_SQLITE_ERROR');
    } finally {
      // Restore write permission so afterEach's recursive rm can clean up the temp directory.
      await chmod(databaseFile, 0o600);
    }
  });
});

// --- Transactional rollback on a mid-write error ---

describe('createSqliteAuditStore transactional writes', () => {
  it('rolls back a mid-write transaction on a constraint violation, leaving no partial work-item record', async () => {
    const databaseFile = await tempDatabaseFile();
    const store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');

    // Deliberately malformed past the type system: `errorMessage: null` violates the `errors`
    // table's NOT NULL constraint, but only after `work_items` has already been inserted in the
    // same transaction — exercising rollback, not merely "the first statement failed".
    const badOutcome = {
      state: 'failed',
      identity: { testCaseId: 'tc:v1:bad' as TestCaseId, repositoryRelativePath: 'a.test.ts', name: 'bad' },
      errorKind: 'unknown',
      errorMessage: null,
    } as unknown as AuditStoreWorkItemOutcome;

    await expect(store.recordWorkItem(runId, badOutcome)).rejects.toThrow();

    // The failed write leaves no partial row, checked from a second, independent connection —
    // SQLite isolation alone would already hide an uncommitted-but-not-yet-rolled-back write from
    // this connection, so this alone does not yet prove `ROLLBACK` itself ran.
    const db = new DatabaseSync(databaseFile);
    try {
      const count = (db.prepare('SELECT COUNT(*) as count FROM work_items').get() as { readonly count: number }).count;
      expect(count).toBe(0);
    } finally {
      db.close();
    }

    // The real proof that `ROLLBACK` (not merely "never committed") ran: without it, `store`'s own
    // connection is left inside an open transaction, and its next `BEGIN` (the next
    // `recordWorkItem` call) fails with "cannot start a transaction within a transaction" — this
    // would fail even before reaching its own constraint check.
    const goodOutcome: AuditStoreWorkItemOutcome = {
      state: 'skipped',
      identity: { testCaseId: 'tc:v1:after-rollback' as TestCaseId, repositoryRelativePath: 'a.test.ts', name: 'after rollback' },
      reason: 'todo',
    };
    await expect(store.recordWorkItem(runId, goodOutcome)).resolves.toBeUndefined();
    await store.close();
  });
});

// --- Full write/read round trip through recordWorkItem ---

// P5-1 verifier finding A: every fixture value below is deliberately distinct and
// non-symmetric (never reusing the same literal for two different persisted columns), so a
// swap between any two columns in `insertAttempt`/`insertJudgment` (`src/adapters/sqlite-audit-store.ts`)
// turns this suite RED instead of going undetected — see the read-back assertions below, which
// check every one of those columns individually against its own distinct fixture value.
function sampleClassification(testCaseId: TestCaseId): ClassificationResult {
  return {
    testCaseId,
    repositoryRelativePath: 'a.test.ts',
    name: 'adds numbers',
    status: 'healthy',
    dimensions: [],
    findings: [],
    policyVersion: 3,
    rubricVersion: 6,
    model: { requested: 'jev-classification-requested', responded: 'jev-classification-responded', matchesPin: true },
    usage: { inputTokens: 100, outputTokens: 5 },
  };
}

function sampleEvaluation(): JevEvaluation {
  return {
    requestedModel: 'jev-eval-requested-model',
    respondedModel: 'jev-eval-responded-model',
    modelMatchesPin: true,
    answers: {
      'assertion-strength.applicable': { type: 'noul', probability: 0.9, raw: { type: 'noul', noul: 0.9 } },
    },
    usage: { inputTokens: 211, outputTokens: 47 },
    attempts: 9,
  };
}

describe('createSqliteAuditStore work-item persistence', () => {
  let store: AuditStorePort;
  let databaseFile: string;

  afterEach(async () => {
    await store?.close();
  });

  it('persists a completed work item with its raw answers, usage, and normalized judgment', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:abc' as TestCaseId;

    await store.recordWorkItem(runId, {
      state: 'completed',
      identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' },
      cacheKey: 'ck-completed-fixture',
      evaluation: sampleEvaluation(),
      classification: sampleClassification(testCaseId),
    });

    const db = new DatabaseSync(databaseFile);
    try {
      const workItem = db.prepare('SELECT * FROM work_items WHERE run_id = ?').get(runId) as Record<string, unknown>;
      expect(workItem['state']).toBe('completed');
      expect(workItem['test_case_id']).toBe(testCaseId);
      expect(workItem['cache_key']).toBe('ck-completed-fixture');

      const attempt = db.prepare('SELECT * FROM attempts WHERE work_item_id = ?').get(workItem['id'] as number) as Record<string, unknown>;
      // Every assertion below targets a fixture value that is unique across the whole row (see
      // `sampleEvaluation`'s comment) — a swap of any two of these columns in `insertAttempt`
      // (`src/adapters/sqlite-audit-store.ts`) fails exactly one of them.
      expect(attempt['requested_model']).toBe('jev-eval-requested-model');
      expect(attempt['responded_model']).toBe('jev-eval-responded-model');
      expect(attempt['model_matches_pin']).toBe(1);
      expect(attempt['attempts']).toBe(9);
      expect(attempt['input_tokens']).toBe(211);
      expect(attempt['output_tokens']).toBe(47);
      expect(JSON.parse(attempt['raw_answers'] as string)).toEqual(sampleEvaluation().answers);

      const judgment = db.prepare('SELECT * FROM judgments WHERE work_item_id = ?').get(workItem['id'] as number) as Record<string, unknown>;
      // Same non-symmetric-fixture discipline as `attempts` above: `policy_version` and
      // `rubric_version` are distinct (3 vs. 6), so a swap of those two columns in
      // `insertJudgment` fails one of these two assertions instead of going undetected.
      expect(judgment['status']).toBe('healthy');
      expect(judgment['policy_version']).toBe(3);
      expect(judgment['rubric_version']).toBe(6);
      expect(JSON.parse(judgment['classification'] as string)).toEqual(sampleClassification(testCaseId));
    } finally {
      db.close();
    }
  });

  it('persists a failed work item with its error kind and message', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:failed' as TestCaseId;

    await store.recordWorkItem(runId, {
      state: 'failed',
      identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'fails' },
      errorKind: 'rate-limit',
      errorMessage: 'Jev rate limit exceeded (429) after 4 attempt(s).',
    });

    const db = new DatabaseSync(databaseFile);
    try {
      const workItem = db.prepare('SELECT * FROM work_items WHERE run_id = ?').get(runId) as Record<string, unknown>;
      expect(workItem['state']).toBe('failed');
      const error = db.prepare('SELECT * FROM errors WHERE work_item_id = ?').get(workItem['id'] as number) as Record<string, unknown>;
      expect(error['kind']).toBe('rate-limit');
      expect(error['message']).toBe('Jev rate limit exceeded (429) after 4 attempt(s).');
    } finally {
      db.close();
    }
  });

  it('persists a skipped work item with its reason', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:skipped' as TestCaseId;

    await store.recordWorkItem(runId, {
      state: 'skipped',
      identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'todo test' },
      reason: 'todo',
    });

    const db = new DatabaseSync(databaseFile);
    try {
      const workItem = db.prepare('SELECT * FROM work_items WHERE run_id = ?').get(runId) as Record<string, unknown>;
      expect(workItem['state']).toBe('skipped');
      const skip = db.prepare('SELECT * FROM skips WHERE work_item_id = ?').get(workItem['id'] as number) as Record<string, unknown>;
      expect(skip['reason']).toBe('todo');
    } finally {
      db.close();
    }
  });

  it('finishRun sets the run\'s finished_at marker without touching its already-recorded work items', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:done' as TestCaseId;
    await store.recordWorkItem(runId, {
      state: 'skipped',
      identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'todo test' },
      reason: 'todo',
    });

    await store.finishRun(runId);

    const db = new DatabaseSync(databaseFile);
    try {
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown>;
      expect(run['finished_at']).not.toBeNull();
      const workItemCount = (db.prepare('SELECT COUNT(*) as count FROM work_items WHERE run_id = ?').get(runId) as { readonly count: number }).count;
      expect(workItemCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('creates the containing directory recursively when it does not exist yet', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });

    await expect(stat(databaseFile)).resolves.toBeDefined();
  });

  it('persists a cached work item with its cache key and reused judgment, and inserts no attempt row (no provider request was made)', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:cache-hit' as TestCaseId;

    await store.recordWorkItem(runId, {
      state: 'cached',
      identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' },
      cacheKey: 'ck-cache-hit-fixture',
      classification: sampleClassification(testCaseId),
    });

    const db = new DatabaseSync(databaseFile);
    try {
      const workItem = db.prepare('SELECT * FROM work_items WHERE run_id = ?').get(runId) as Record<string, unknown>;
      expect(workItem['state']).toBe('cached');
      expect(workItem['cache_key']).toBe('ck-cache-hit-fixture');

      const judgment = db.prepare('SELECT * FROM judgments WHERE work_item_id = ?').get(workItem['id'] as number) as Record<string, unknown>;
      expect(JSON.parse(judgment['classification'] as string)).toEqual(sampleClassification(testCaseId));

      const attemptCount = (db.prepare('SELECT COUNT(*) as count FROM attempts WHERE work_item_id = ?').get(workItem['id'] as number) as { readonly count: number }).count;
      expect(attemptCount).toBe(0);
    } finally {
      db.close();
    }
  });
});

// --- lookup (Phase 5, task P5-2) -----------------------------------------------------------

/** Same non-symmetric-fixture discipline as `sampleClassification` above: `status` is the field varied across fixtures below so a test can tell which of several stored judgments a `lookup` call actually returned. */
function classificationWithStatus(testCaseId: TestCaseId, status: ClassificationResult['status']): ClassificationResult {
  return { ...sampleClassification(testCaseId), status };
}

async function recordCompleted(
  store: AuditStorePort,
  runId: string,
  testCaseId: TestCaseId,
  cacheKey: string,
  status: ClassificationResult['status'],
  matchesPin: boolean,
): Promise<void> {
  // `lookup`'s pin filter reads `attempts.model_matches_pin` (populated from
  // `evaluation.modelMatchesPin`), not the classification's own denormalized `model.matchesPin`
  // copy — both must agree here, or this fixture would not exercise what it claims to.
  await store.recordWorkItem(runId, {
    state: 'completed',
    identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' },
    cacheKey,
    evaluation: { ...sampleEvaluation(), modelMatchesPin: matchesPin },
    classification: { ...classificationWithStatus(testCaseId, status), model: { requested: 'jev-eval-requested-model', responded: 'jev-eval-responded-model', matchesPin } },
  });
}

describe('createSqliteAuditStore lookup', () => {
  let store: AuditStorePort;
  let databaseFile: string;

  afterEach(async () => {
    await store?.close();
  });

  it('returns undefined on a miss (no work item was ever recorded under this key)', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });

    await expect(store.lookup('ck-never-recorded')).resolves.toBeUndefined();
  });

  it('returns the most recent completed judgment when several pin-matching completed judgments share one key', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-newest' as TestCaseId;

    await recordCompleted(store, runId, testCaseId, 'ck-shared', 'healthy', true);
    await recordCompleted(store, runId, testCaseId, 'ck-shared', 'weak', true);

    const hit = await store.lookup('ck-shared');
    expect(hit?.classification.status).toBe('weak');
  });

  it('skips a newer pin-mismatched judgment and returns an older pin-matching one under the same key', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-pin-skip' as TestCaseId;

    await recordCompleted(store, runId, testCaseId, 'ck-pin-skip', 'healthy', true);
    await recordCompleted(store, runId, testCaseId, 'ck-pin-skip', 'misleading', false);

    const hit = await store.lookup('ck-pin-skip');
    expect(hit?.classification.status).toBe('healthy');
  });

  it('returns undefined when every completed judgment under a key is pin-mismatched', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-all-mismatched' as TestCaseId;

    await recordCompleted(store, runId, testCaseId, 'ck-all-mismatched', 'healthy', false);
    await recordCompleted(store, runId, testCaseId, 'ck-all-mismatched', 'weak', false);

    await expect(store.lookup('ck-all-mismatched')).resolves.toBeUndefined();
  });

  it('never returns a cached work item\'s own judgment as a lookup source: a later cache hit recorded under the same key does not shadow the original completed judgment', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-not-cached-source' as TestCaseId;

    await recordCompleted(store, runId, testCaseId, 'ck-not-cached-source', 'healthy', true);
    // Simulates a second run's cache hit against the same key: recorded with a HIGHER id than
    // the completed row above. A `lookup` that forgot to filter on `state = 'completed'` would
    // return this row's own judgment instead — it deliberately carries a different `status`
    // (`misleading`) so that mistake is observable.
    await store.recordWorkItem(runId, {
      state: 'cached',
      identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' },
      cacheKey: 'ck-not-cached-source',
      classification: classificationWithStatus(testCaseId, 'misleading'),
    });

    const hit = await store.lookup('ck-not-cached-source');
    expect(hit?.classification.status).toBe('healthy');
  });

  // A `cached`/`failed`/`skipped` work item never gets its own `attempts` row through
  // `recordWorkItem` (only `insertAttempt` for `completed` does), so the INNER JOIN to `attempts`
  // in `lookup`'s query already excludes every non-completed row on its own — meaning the query's
  // explicit `w.state = 'completed'` predicate is not otherwise exercised by any test above (it
  // cannot turn RED by itself: removing it changes nothing while that join invariant holds). This
  // test manufactures the one case where it matters — a non-completed row that somehow does have
  // a matching `attempts`/`judgments` pair, bypassing `recordWorkItem` entirely via direct SQL, the
  // same technique the schema-corruption tests above use to simulate a state the port itself would
  // never produce.
  it('excludes a non-completed work item even if it somehow carries a matching attempts/judgments pair (defensive; direct SQL, since recordWorkItem itself never produces this shape)', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-defensive-state' as TestCaseId;

    const db = new DatabaseSync(databaseFile);
    try {
      const inserted = db.prepare(
        'INSERT INTO work_items (run_id, test_case_id, repository_relative_path, name, state, recorded_at, cache_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(runId, testCaseId, 'a.test.ts', 'adds numbers', 'failed', new Date().toISOString(), 'ck-defensive-state');
      const workItemId = Number(inserted.lastInsertRowid);
      db.prepare(
        'INSERT INTO attempts (work_item_id, requested_model, responded_model, model_matches_pin, attempts, raw_answers, input_tokens, output_tokens) VALUES (?, ?, ?, 1, 1, \'{}\', 0, 0)',
      ).run(workItemId, 'jev-eval-requested-model', 'jev-eval-responded-model');
      db.prepare(
        'INSERT INTO judgments (work_item_id, status, policy_version, rubric_version, classification) VALUES (?, ?, ?, ?, ?)',
      ).run(workItemId, 'misleading', 3, 6, JSON.stringify(sampleClassification(testCaseId)));
    } finally {
      db.close();
    }

    await expect(store.lookup('ck-defensive-state')).resolves.toBeUndefined();
  });

  it('never returns a completed work item recorded with no cache key', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-no-key' as TestCaseId;

    // No `cacheKey` at all — the exact shape a pre-P5-2 caller (or a caller that never wires
    // `AuditCacheKeyPort`) would still produce; see `AuditStoreWorkItemOutcome`'s own doc.
    await store.recordWorkItem(runId, {
      state: 'completed',
      identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' },
      evaluation: sampleEvaluation(),
      classification: sampleClassification(testCaseId),
    });

    // Querying with an empty string must not accidentally match a stored NULL.
    await expect(store.lookup('')).resolves.toBeUndefined();
  });

  it('a --fresh re-run appends a new completed judgment without mutating the prior one, and a later lookup returns the new one, never the old one', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-fresh' as TestCaseId;

    await recordCompleted(store, runId, testCaseId, 'ck-fresh', 'healthy', true);
    const beforeFresh = await store.lookup('ck-fresh');
    expect(beforeFresh?.classification.status).toBe('healthy');

    // A `--fresh` dispatch bypasses lookup but still writes a new immutable completed result
    // under the same key (see the domain port's own doc) — simulated here directly at the store
    // layer, independent of the application-layer `--fresh` wiring exercised in `audit.test.ts`.
    await recordCompleted(store, runId, testCaseId, 'ck-fresh', 'weak', true);

    const afterFresh = await store.lookup('ck-fresh');
    expect(afterFresh?.classification.status).toBe('weak');

    const db = new DatabaseSync(databaseFile);
    try {
      const completedCount = (
        db.prepare("SELECT COUNT(*) as count FROM work_items WHERE test_case_id = ? AND cache_key = ? AND state = 'completed'")
          .get(testCaseId, 'ck-fresh') as { readonly count: number }
      ).count;
      expect(completedCount).toBe(2);
    } finally {
      db.close();
    }
  });

  // Phase 5, task P5-3: `pending`/`running` checkpoints (recorded up front and on pickup by the
  // scheduler) are new non-terminal rows that did not exist when P5-2's `lookup` query was
  // written — a real regression risk the task explicitly calls out, not a hypothetical one.
  it('still returns only the completed judgment once pending and running checkpoints exist for the very same work item and run', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-with-checkpoints' as TestCaseId;
    const identity = { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' };

    // The realistic production sequence for one evaluable item: `pending` up front, `running` on
    // pickup, then its terminal `completed` record — all through the real port, exactly as
    // `runEvaluation` (`src/application/audit.ts`) now writes them.
    await store.recordWorkItem(runId, { state: 'pending', identity });
    await store.recordWorkItem(runId, { state: 'running', identity });
    await recordCompleted(store, runId, testCaseId, 'ck-with-checkpoints', 'healthy', true);

    const hit = await store.lookup('ck-with-checkpoints');
    expect(hit?.classification.status).toBe('healthy');
  });

  // Unlike the test above (the realistic shape `recordWorkItem` actually produces — a
  // pending/running row never carries a cache key, so the `attempts` INNER JOIN alone already
  // excludes it, exactly like the existing "excludes a non-completed work item" defensive test
  // above for `failed`), this manufactures the one case where the query's explicit
  // `w.state = 'completed'` predicate is independently provable for `pending`/`running` too: a
  // `running` row that somehow carries a matching cache key AND a matching attempts/judgments
  // pair, bypassing `recordWorkItem` via direct SQL — the same technique used above.
  it('excludes a running work item even if it somehow carries the same cache key and a matching attempts/judgments pair (defensive; direct SQL)', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:lookup-running-defensive' as TestCaseId;

    await recordCompleted(store, runId, testCaseId, 'ck-running-defensive', 'healthy', true);

    const db = new DatabaseSync(databaseFile);
    try {
      const inserted = db.prepare(
        'INSERT INTO work_items (run_id, test_case_id, repository_relative_path, name, state, recorded_at, cache_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(runId, testCaseId, 'a.test.ts', 'adds numbers', 'running', new Date().toISOString(), 'ck-running-defensive');
      const workItemId = Number(inserted.lastInsertRowid);
      db.prepare(
        'INSERT INTO attempts (work_item_id, requested_model, responded_model, model_matches_pin, attempts, raw_answers, input_tokens, output_tokens) VALUES (?, ?, ?, 1, 1, \'{}\', 0, 0)',
      ).run(workItemId, 'jev-eval-requested-model', 'jev-eval-responded-model');
      db.prepare(
        'INSERT INTO judgments (work_item_id, status, policy_version, rubric_version, classification) VALUES (?, ?, ?, ?, ?)',
      ).run(workItemId, 'misleading', 3, 6, JSON.stringify(classificationWithStatus(testCaseId, 'misleading')));
    } finally {
      db.close();
    }

    // A `lookup` that forgot the `state = 'completed'` filter (and happened to also lose the
    // `attempts` INNER JOIN's protection) could return either row here; this newer `running` row
    // deliberately carries a different `status` (`misleading`) than the real `completed` row
    // (`healthy`), so returning the wrong one is observable.
    const hit = await store.lookup('ck-running-defensive');
    expect(hit?.classification.status).toBe('healthy');
  });
});

// --- loadRunState (Phase 5, task P5-4: --resume) -----------------------------------------

describe('createSqliteAuditStore loadRunState', () => {
  let store: AuditStorePort;
  let databaseFile: string;

  afterEach(async () => {
    await store?.close();
  });

  it('returns undefined when no run exists with this id', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });

    await expect(store.loadRunState('no-such-run')).resolves.toBeUndefined();
  });

  it('reports the run\'s own rootDir, and finished: false until finishRun is called, true afterward', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo/resume-rootdir');

    const beforeFinish = await store.loadRunState(runId);
    expect(beforeFinish?.rootDir).toBe('/repo/resume-rootdir');
    expect(beforeFinish?.finished).toBe(false);

    await store.finishRun(runId);

    const afterFinish = await store.loadRunState(runId);
    expect(afterFinish?.finished).toBe(true);
  });

  it(
    'takes the LAST recorded row per identity (highest id, insertion order), not the first: a pending-then-running-then-completed '
    + 'trail resolves to exactly one terminal work item (completed) — a MIN(id) bug would instead see the first (pending) row and '
    + 'report zero terminal work items',
    async () => {
      databaseFile = await tempDatabaseFile();
      store = await createSqliteAuditStore({ databaseFile });
      const runId = await store.beginRun('/repo');
      const testCaseId = 'tc:v1:resume-trail' as TestCaseId;
      const identity = { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' };

      await store.recordWorkItem(runId, { state: 'pending', identity });
      await store.recordWorkItem(runId, { state: 'running', identity });
      await recordCompleted(store, runId, testCaseId, 'ck-resume-trail', 'healthy', true);

      const state = await store.loadRunState(runId);
      expect(state?.terminalWorkItems).toHaveLength(1);
      expect(state?.terminalWorkItems[0]?.state).toBe('completed');
    },
  );

  it('never includes an item whose only recorded row is pending or running (never reached a terminal state) — this is the outstanding set a caller must dispatch', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const pendingOnly = { testCaseId: 'tc:v1:resume-pending-only' as TestCaseId, repositoryRelativePath: 'a.test.ts', name: 'still pending' };
    const runningOnly = { testCaseId: 'tc:v1:resume-running-only' as TestCaseId, repositoryRelativePath: 'a.test.ts', name: 'still running' };

    await store.recordWorkItem(runId, { state: 'pending', identity: pendingOnly });
    await store.recordWorkItem(runId, { state: 'pending', identity: runningOnly });
    await store.recordWorkItem(runId, { state: 'running', identity: runningOnly });

    const state = await store.loadRunState(runId);
    expect(state?.terminalWorkItems).toEqual([]);
  });

  it('reconstructs a completed work item\'s raw evaluation and classification exactly, field for field, from distinct non-symmetric fixture values', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:resume-completed' as TestCaseId;
    const identity = { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' };

    await store.recordWorkItem(runId, {
      state: 'completed',
      identity,
      cacheKey: 'ck-resume-completed',
      evaluation: sampleEvaluation(),
      classification: sampleClassification(testCaseId),
    });

    const state = await store.loadRunState(runId);
    expect(state?.terminalWorkItems).toHaveLength(1);
    const outcome = state?.terminalWorkItems[0];
    expect(outcome?.state).toBe('completed');
    if (outcome?.state !== 'completed') throw new Error('unreachable');
    expect(outcome.identity).toEqual(identity);
    // Every field below is a distinct, non-symmetric fixture value (see `sampleEvaluation`'s own
    // comment) — a swap of any two columns in the reconstruction fails exactly one assertion.
    expect(outcome.evaluation).toEqual(sampleEvaluation());
    expect(outcome.classification).toEqual(sampleClassification(testCaseId));
  });

  it('reconstructs a cached work item\'s reused classification', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:resume-cached' as TestCaseId;
    const identity = { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' };

    await store.recordWorkItem(runId, {
      state: 'cached',
      identity,
      cacheKey: 'ck-resume-cached',
      classification: sampleClassification(testCaseId),
    });

    const state = await store.loadRunState(runId);
    const outcome = state?.terminalWorkItems[0];
    expect(outcome?.state).toBe('cached');
    if (outcome?.state !== 'cached') throw new Error('unreachable');
    expect(outcome.classification).toEqual(sampleClassification(testCaseId));
  });

  it('reconstructs a failed work item\'s error kind and message', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:resume-failed' as TestCaseId;
    const identity = { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'fails' };

    await store.recordWorkItem(runId, { state: 'failed', identity, errorKind: 'rate-limit', errorMessage: 'Jev rate limit exceeded (429) after 4 attempt(s).' });

    const state = await store.loadRunState(runId);
    const outcome = state?.terminalWorkItems[0];
    expect(outcome?.state).toBe('failed');
    if (outcome?.state !== 'failed') throw new Error('unreachable');
    expect(outcome.errorKind).toBe('rate-limit');
    expect(outcome.errorMessage).toBe('Jev rate limit exceeded (429) after 4 attempt(s).');
  });

  it('reconstructs a skipped work item\'s reason', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:resume-skipped' as TestCaseId;
    const identity = { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'todo test' };

    await store.recordWorkItem(runId, { state: 'skipped', identity, reason: 'todo' });

    const state = await store.loadRunState(runId);
    const outcome = state?.terminalWorkItems[0];
    expect(outcome?.state).toBe('skipped');
    if (outcome?.state !== 'skipped') throw new Error('unreachable');
    expect(outcome.reason).toBe('todo');
  });

  it('never leaks another run\'s work items into this run\'s terminalWorkItems', async () => {
    databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runA = await store.beginRun('/repo');
    const runB = await store.beginRun('/repo');
    await store.recordWorkItem(runA, { state: 'skipped', identity: { testCaseId: 'tc:v1:run-a' as TestCaseId, repositoryRelativePath: 'a.test.ts', name: 'a' }, reason: 'todo' });
    await store.recordWorkItem(runB, { state: 'skipped', identity: { testCaseId: 'tc:v1:run-b' as TestCaseId, repositoryRelativePath: 'a.test.ts', name: 'b' }, reason: 'skip' });

    const state: AuditStoreRunState | undefined = await store.loadRunState(runA);
    expect(state?.terminalWorkItems).toHaveLength(1);
    expect(state?.terminalWorkItems[0]?.identity.testCaseId).toBe('tc:v1:run-a');
  });
});

// --- canonicalizeRootDir and rootDirCanonical (defect fix, 2026-09-20) -----------------------
//
// A run's persisted `rootDir` must identify a repository, not just record whatever spelling the
// caller happened to pass. These tests exercise the adapter's own canonicalization in isolation
// from `runAudit`'s orchestration (covered separately in `test/resume.test.ts` and
// `test/resume-root-dir-identity.test.ts`).

describe('createSqliteAuditStore canonicalizeRootDir', () => {
  let store: AuditStorePort;

  afterEach(async () => {
    await store?.close();
  });

  it('resolves a relative rootDir to an absolute path', async () => {
    const databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });

    const canonical = await store.canonicalizeRootDir('.');

    expect(canonical).not.toBe('.');
    expect(canonical.startsWith('/')).toBe(true);
    expect(canonical).toBe(await store.canonicalizeRootDir(process.cwd()));
  });

  // The one test that actually discriminates "resolve only" from "resolve then realpath": a
  // symlinked ANCESTOR (never the leaf itself — `discoverTestFiles`/`readSourceFile` already
  // reject a symlinked leaf for their own, unrelated reasons, which would fail this test for the
  // wrong reason). Built explicitly rather than relying on this dev machine's own macOS `/var` ->
  // `/private/var` layout, so the test is portable to any platform/filesystem.
  it('two different-looking paths to the same repository, reached through a symlinked ancestor directory, canonicalize identically', async () => {
    const databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const parent = await mkdtemp(join(tmpdir(), 'jev-audit-store-symlink-'));
    temporaryRoots.push(parent);
    const realParent = join(parent, 'real-parent');
    await mkdir(join(realParent, 'repo'), { recursive: true });
    const linkParent = join(parent, 'link-parent');
    await symlink(realParent, linkParent);

    const throughSymlinkedAncestor = await store.canonicalizeRootDir(join(linkParent, 'repo'));
    const direct = await store.canonicalizeRootDir(join(realParent, 'repo'));

    expect(throughSymlinkedAncestor).toBe(direct);
  });

  it('a rootDir that does not exist on disk still resolves, without throwing, to its plain absolute form', async () => {
    const databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const parent = await mkdtemp(join(tmpdir(), 'jev-audit-store-missing-'));
    temporaryRoots.push(parent);
    const missing = join(parent, 'never-created');

    await expect(store.canonicalizeRootDir(missing)).resolves.toBe(missing);
  });
});

describe('createSqliteAuditStore loadRunState rootDirCanonical', () => {
  let store: AuditStorePort;

  afterEach(async () => {
    await store?.close();
  });

  it('reports rootDirCanonical: true for a run recorded with an absolute rootDir', async () => {
    const databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/already/absolute/repo');

    const state = await store.loadRunState(runId);

    expect(state?.rootDirCanonical).toBe(true);
  });

  it('reports rootDirCanonical: false for a run recorded with a relative rootDir (e.g. a pre-fix "." default)', async () => {
    const databaseFile = await tempDatabaseFile();
    store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('.');

    const state = await store.loadRunState(runId);

    expect(state?.rootDirCanonical).toBe(false);
  });
});

// --- openSqliteAuditStoreForLookup (Phase 5, task P5-5: read-only cache consultation for
// `audit --dry-run`, which must never create, migrate, or write to the audit store) ---------

describe('openSqliteAuditStoreForLookup', () => {
  it(
    'reports { available: false, reason: \'no-store\' } and creates no file of any kind '
    + 'when no database file exists at the given path',
    async () => {
      const databaseFile = await tempDatabaseFile();

      const result = await openSqliteAuditStoreForLookup({ databaseFile });

      expect(result).toEqual({ available: false, reason: 'no-store' });
      await expect(stat(databaseFile)).rejects.toThrow();
      await expect(stat(`${databaseFile}-wal`)).rejects.toThrow();
      await expect(stat(`${databaseFile}-shm`)).rejects.toThrow();
    },
  );

  it(
    'reads a real completed judgment through the exact same lookup rule as the live store, '
    + 'without creating a -wal/-shm sidecar and without changing the main file\'s bytes',
    async () => {
      const databaseFile = await tempDatabaseFile();
      const store = await createSqliteAuditStore({ databaseFile });
      const runId = await store.beginRun('/repo');
      const testCaseId = 'tc:v1:readonly-hit' as TestCaseId;
      await store.recordWorkItem(runId, {
        state: 'completed',
        identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' },
        cacheKey: 'ck-readonly-hit',
        evaluation: sampleEvaluation(),
        classification: sampleClassification(testCaseId),
      });
      await store.close(); // WAL checkpoints and its sidecars disappear on a clean close (P5-3 evidence).

      const beforeBytes = await readFile(databaseFile);
      const beforeHash = createHash('sha256').update(beforeBytes).digest('hex');

      const result = await openSqliteAuditStoreForLookup({ databaseFile });
      if (!result.available) throw new Error('expected the store to be available for lookup');
      const hit = await result.lookup.lookup('ck-readonly-hit');
      const miss = await result.lookup.lookup('ck-does-not-exist');
      await result.lookup.close();

      expect(hit).toEqual({ classification: sampleClassification(testCaseId) });
      expect(miss).toBeUndefined();

      const afterBytes = await readFile(databaseFile);
      const afterHash = createHash('sha256').update(afterBytes).digest('hex');
      expect(afterHash).toBe(beforeHash);
      expect(afterBytes.byteLength).toBe(beforeBytes.byteLength);
      await expect(stat(`${databaseFile}-wal`)).rejects.toThrow();
      await expect(stat(`${databaseFile}-shm`)).rejects.toThrow();
    },
  );

  it('a row still sitting only in an uncheckpointed WAL sidecar (the store never closed cleanly) is invisible to the read-only reader — documented limitation, not a bug: a subsequent real --evaluate opens the store normally and sees it', async () => {
    const databaseFile = await tempDatabaseFile();
    // Bootstrap and close once first, so the schema itself (and nothing else) is checkpointed into
    // the main file — otherwise the schema would ALSO still be sitting only in the WAL below, and
    // the read-only reader would degrade to "not consulted" (schema-outdated) rather than ever
    // reaching this row's own miss, which is a distinct outcome from the one this test claims to
    // prove. (Caught by this task's own refactor of `openSqliteAuditStoreForLookup`'s return shape:
    // the original version of this test used `lookup?.lookup(...)` — with `lookup` itself possibly
    // `undefined` for exactly this reason — so it passed vacuously regardless of which case actually
    // occurred; `expect(hit).toBeUndefined()` could never tell "unavailable" apart from "available
    // but a genuine miss".)
    await (await createSqliteAuditStore({ databaseFile })).close();

    const store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const testCaseId = 'tc:v1:uncheckpointed' as TestCaseId;
    await store.recordWorkItem(runId, {
      state: 'completed',
      identity: { testCaseId, repositoryRelativePath: 'a.test.ts', name: 'adds numbers' },
      cacheKey: 'ck-uncheckpointed',
      evaluation: sampleEvaluation(),
      classification: sampleClassification(testCaseId),
    });
    // Deliberately never closed — simulates a store still open elsewhere / not yet checkpointed.

    try {
      const result = await openSqliteAuditStoreForLookup({ databaseFile });
      if (!result.available) throw new Error(`expected the store to be available for lookup (schema already checkpointed), got reason: ${result.reason}`);
      const hit = await result.lookup.lookup('ck-uncheckpointed');
      await result.lookup.close();

      expect(hit).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('surfaces AuditStoreSchemaVersionError for a store newer than this build supports — the same error a subsequent --evaluate would also refuse with', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    const db = new DatabaseSync(databaseFile);
    db.exec('CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL) STRICT;');
    db.exec('INSERT INTO schema_meta (id, schema_version) VALUES (1, 999)');
    db.close();

    await expect(openSqliteAuditStoreForLookup({ databaseFile })).rejects.toThrow(AuditStoreSchemaVersionError);
  });

  it(
    'degrades to { available: false, reason: \'schema-outdated\' } for a hand-built v1 database — a subsequent '
    + '--evaluate would migrate it forward and then dispatch every evaluable test case, which "not consulted" already matches',
    async () => {
      const databaseFile = await tempDatabaseFile();
      await mkdir(dirname(databaseFile), { recursive: true });
      const db = new DatabaseSync(databaseFile);
      db.exec('CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL) STRICT;');
      db.exec('INSERT INTO schema_meta (id, schema_version) VALUES (1, 1)');
      db.close();

      await expect(openSqliteAuditStoreForLookup({ databaseFile })).resolves.toEqual({ available: false, reason: 'schema-outdated' });
    },
  );

  it(
    'degrades to { available: false, reason: \'schema-outdated\' } for a genuinely empty (zero-byte) file — a '
    + 'subsequent --evaluate would migrate it from scratch and dispatch everything',
    async () => {
      const databaseFile = await tempDatabaseFile();
      await mkdir(dirname(databaseFile), { recursive: true });
      await writeFile(databaseFile, Buffer.alloc(0));

      await expect(openSqliteAuditStoreForLookup({ databaseFile })).resolves.toEqual({ available: false, reason: 'schema-outdated' });
    },
  );

  it('surfaces AuditStoreCorruptError for a foreign database with tables but no schema_meta table — the same error a subsequent --evaluate would also refuse with', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    const foreignDb = new DatabaseSync(databaseFile);
    foreignDb.exec('CREATE TABLE some_other_apps_table (id INTEGER PRIMARY KEY, payload TEXT)');
    foreignDb.close();

    await expect(openSqliteAuditStoreForLookup({ databaseFile })).rejects.toThrow(AuditStoreCorruptError);
  });

  it('surfaces AuditStoreCorruptError, not a raw native error, for a file that is not a SQLite database at all', async () => {
    const databaseFile = await tempDatabaseFile();
    await mkdir(dirname(databaseFile), { recursive: true });
    await writeFile(databaseFile, 'not a sqlite database, just plain bytes');

    const error: unknown = await openSqliteAuditStoreForLookup({ databaseFile }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuditStoreCorruptError);
    expect((error as Error).message).not.toContain('ERR_SQLITE_ERROR');
  });
});
