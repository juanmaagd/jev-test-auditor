import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSqliteAuditStore,
  isSqliteExperimentalWarning,
  resolveAuditStorePaths,
  withSqliteExperimentalWarningSuppressed,
  type AuditStorePaths,
} from '../src/adapters/sqlite-audit-store.js';
import {
  AuditStoreCorruptError,
  AuditStoreSchemaVersionError,
  type AuditStorePort,
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
      expect(version).toBe(1);
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
    await expect(createSqliteAuditStore({ databaseFile })).rejects.toMatchObject({ foundVersion: 999, supportedVersion: 1 });
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

function sampleClassification(testCaseId: TestCaseId): ClassificationResult {
  return {
    testCaseId,
    repositoryRelativePath: 'a.test.ts',
    name: 'adds numbers',
    status: 'healthy',
    dimensions: [],
    findings: [],
    policyVersion: 2,
    rubricVersion: 2,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 100, outputTokens: 5 },
  };
}

function sampleEvaluation(): JevEvaluation {
  return {
    requestedModel: 'jev-1.13.0',
    respondedModel: 'jev-1.13.0',
    modelMatchesPin: true,
    answers: {
      'assertion-strength.applicable': { type: 'noul', probability: 0.9, raw: { type: 'noul', noul: 0.9 } },
    },
    usage: { inputTokens: 100, outputTokens: 5 },
    attempts: 1,
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
      evaluation: sampleEvaluation(),
      classification: sampleClassification(testCaseId),
    });

    const db = new DatabaseSync(databaseFile);
    try {
      const workItem = db.prepare('SELECT * FROM work_items WHERE run_id = ?').get(runId) as Record<string, unknown>;
      expect(workItem['state']).toBe('completed');
      expect(workItem['test_case_id']).toBe(testCaseId);

      const attempt = db.prepare('SELECT * FROM attempts WHERE work_item_id = ?').get(workItem['id'] as number) as Record<string, unknown>;
      expect(attempt['requested_model']).toBe('jev-1.13.0');
      expect(attempt['model_matches_pin']).toBe(1);
      expect(attempt['input_tokens']).toBe(100);
      expect(JSON.parse(attempt['raw_answers'] as string)).toEqual(sampleEvaluation().answers);

      const judgment = db.prepare('SELECT * FROM judgments WHERE work_item_id = ?').get(workItem['id'] as number) as Record<string, unknown>;
      expect(judgment['status']).toBe('healthy');
      expect(judgment['policy_version']).toBe(2);
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
});
