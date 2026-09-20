/**
 * The `node:sqlite` audit persistence adapter (Phase 5, task P5-1):
 * implements {@link AuditStorePort} (`src/domain/audit.ts`) with a local,
 * per-user SQLite database — versioned transactional migrations, `STRICT`
 * tables, prepared statements, and append-only writes.
 *
 * `node:sqlite`'s value export (`DatabaseSync`) is loaded through a dynamic
 * `import('node:sqlite')` rather than a static import, specifically so its
 * one-time `ExperimentalWarning` (`SQLite is an experimental feature and
 * might change at any time`) can be suppressed narrowly — see
 * {@link withSqliteExperimentalWarningSuppressed} and
 * {@link isSqliteExperimentalWarning}. A static `import { DatabaseSync }
 * from 'node:sqlite'` would evaluate (and warn) before this module's own
 * code ever runs, which the suppression window could not then wrap. Only
 * *types* are imported statically (`import type`), which never loads the
 * module or triggers the warning.
 *
 * Default database location mirrors `src/adapters/auth-storage.ts`'s own
 * per-user config home convention (Phase 5 Decisions: "Database location
 * defaults under the per-user config home already used by auth storage"),
 * under its own file name so the two never collide; `ConfigurationOverrides.store.databasePath`
 * (`src/domain/config.ts`) overrides it. The database always lives outside
 * the audited repository and never receives the API key — nothing in
 * {@link AuditStoreWorkItemOutcome} carries one.
 */
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  AuditStoreCorruptError,
  AuditStoreSchemaVersionError,
  type AuditStorePort,
  type AuditStoreWorkItemIdentity,
  type AuditStoreWorkItemOutcome,
  type WorkItemState,
} from '../domain/audit.js';
import type { ClassificationResult } from '../domain/classification.js';
import type { JevEvaluation } from '../domain/jev-gateway.js';

const APP_DIR_NAME = 'jev-test-auditor';
const DATABASE_FILE_NAME = 'audit-store.sqlite3';
/** Owner-only: mirrors `src/adapters/auth-storage.ts`'s `DIRECTORY_MODE` — this directory may also hold evidence excerpts from the audited repository's source. */
const DIRECTORY_MODE = 0o700;

export interface AuditStorePaths {
  readonly configDir: string;
  readonly databaseFile: string;
}

export interface AuditStorePathEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

function defaultPathEnvironment(): AuditStorePathEnvironment {
  return { platform: process.platform, env: process.env, homedir: homedir() };
}

/**
 * Resolves the default audit store paths: same per-user config home
 * convention as `resolveAuthStoragePaths` (`src/adapters/auth-storage.ts`)
 * — `$XDG_CONFIG_HOME/jev-test-auditor` (else `~/.config/jev-test-auditor`)
 * on POSIX, `%APPDATA%\jev-test-auditor` on Windows — under this adapter's
 * own `audit-store.sqlite3` file name.
 */
export function resolveAuditStorePaths(environment: AuditStorePathEnvironment = defaultPathEnvironment()): AuditStorePaths {
  const { platform, env, homedir: home } = environment;

  if (platform === 'win32') {
    const appData = env['APPDATA']?.trim();
    const base = appData && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming');
    const configDir = join(base, APP_DIR_NAME);
    return { configDir, databaseFile: join(configDir, DATABASE_FILE_NAME) };
  }

  const xdgConfigHome = env['XDG_CONFIG_HOME']?.trim();
  const base = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(home, '.config');
  const configDir = join(base, APP_DIR_NAME);
  return { configDir, databaseFile: join(configDir, DATABASE_FILE_NAME) };
}

// --- ExperimentalWarning suppression (Phase 5 Scope: "Suppress that one warning narrowly ... never install a blanket warning filter") ---

const SQLITE_EXPERIMENTAL_WARNING_TYPE = 'ExperimentalWarning';
const SQLITE_EXPERIMENTAL_WARNING_TEXT = 'SQLite is an experimental feature';

/**
 * True only for the exact `node:sqlite` experimental-feature warning shape
 * Node emits (`process.emitWarning(message, 'ExperimentalWarning')` with
 * `message` containing {@link SQLITE_EXPERIMENTAL_WARNING_TEXT}). Exported
 * so the narrowness this adapter depends on is directly unit-testable,
 * independent of Node's own one-warning-per-process deduplication.
 */
export function isSqliteExperimentalWarning(warning: unknown, warningType: unknown): boolean {
  return (
    warningType === SQLITE_EXPERIMENTAL_WARNING_TYPE
    && typeof warning === 'string'
    && warning.includes(SQLITE_EXPERIMENTAL_WARNING_TEXT)
  );
}

// Module-level suppression state (P5-1 verifier finding E): a naive save/restore of
// `process.emitWarning` per call breaks under two overlapping (not merely nested) calls — call A
// resolving first would restore the pre-A baseline, dropping call B's still-active patch (letting
// a real sqlite warning leak during the crossover window), and call B resolving afterward would
// then permanently install A's now-stale wrapper instead of the true original. Instead, exactly
// one shared patch is installed by the first entrant and removed by the last, tracked by a depth
// counter — every overlapping call, however its lifetimes interleave, shares that single patch
// and its one captured `trueOriginalEmitWarning`, so an unrelated warning still reaches it and
// the true original is restored exactly once, when the last suppression ends.
let suppressionDepth = 0;
let trueOriginalEmitWarning: typeof process.emitWarning | undefined;

/**
 * Runs `loader` with `process.emitWarning` temporarily wrapped so that
 * exactly the `node:sqlite` experimental-feature warning (see
 * {@link isSqliteExperimentalWarning}) never reaches Node's default handler,
 * while every other warning — including a *different* `ExperimentalWarning`
 * — is forwarded to the original `process.emitWarning` untouched. Safe under
 * overlapping concurrent calls (see the module-level state comment above):
 * the true original is restored only once every overlapping call —
 * including one that rejects — has finished, never mid-overlap.
 */
export async function withSqliteExperimentalWarningSuppressed<T>(loader: () => Promise<T>): Promise<T> {
  if (suppressionDepth === 0) {
    // Deliberately NOT `.bind()`ed: binding would produce a new function object every call, so
    // restoring `process.emitWarning = trueOriginalEmitWarning` afterward would never restore the
    // exact reference that was there before (breaking identity checks). `process.emitWarning`
    // does not rely on `this`, so calling the captured reference directly (never through
    // `process.`) is safe.
    const original = process.emitWarning;
    trueOriginalEmitWarning = original;
    process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
      if (isSqliteExperimentalWarning(warning, rest[0])) return;
      (original as (...args: unknown[]) => void)(warning, ...rest);
    }) as typeof process.emitWarning;
  }

  suppressionDepth += 1;
  try {
    return await loader();
  } finally {
    suppressionDepth -= 1;
    if (suppressionDepth === 0) {
      process.emitWarning = trueOriginalEmitWarning as typeof process.emitWarning;
      trueOriginalEmitWarning = undefined;
    }
  }
}

async function loadSqliteModule(): Promise<typeof import('node:sqlite')> {
  return withSqliteExperimentalWarningSuppressed(() => import('node:sqlite'));
}

// --- Schema / versioned migrations ------------------------------------------------------

const SCHEMA_VERSION = 1;

type Migration = (db: DatabaseSync) => void;

/**
 * Ordered migrations, index `n` taking the schema from version `n` to
 * `n + 1`. `migrate` (below) applies every migration whose index is `>=`
 * the store's current recorded version, inside one transaction, then
 * records {@link SCHEMA_VERSION} — so migrations never re-run destructively
 * on an already-migrated store (idempotent re-open).
 */
const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        root_dir TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
    `);
    db.exec(`
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
    db.exec(`
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
    db.exec(`
      CREATE TABLE judgments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER NOT NULL REFERENCES work_items(id),
        status TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        rubric_version INTEGER NOT NULL,
        classification TEXT NOT NULL
      ) STRICT;
    `);
    db.exec(`
      CREATE TABLE errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER NOT NULL REFERENCES work_items(id),
        kind TEXT NOT NULL,
        message TEXT NOT NULL
      ) STRICT;
    `);
    db.exec(`
      CREATE TABLE skips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER NOT NULL REFERENCES work_items(id),
        reason TEXT NOT NULL
      ) STRICT;
    `);
  },
];

function schemaMetaTableExists(db: DatabaseSync): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get() !== undefined;
}

/**
 * Every user table name already present in `db`, excluding SQLite's own
 * internal `sqlite_%` tables (e.g. `sqlite_sequence`). Used only to
 * distinguish a genuinely empty database (nothing here yet — safe to
 * migrate) from a foreign one that already holds someone else's tables but
 * never went through this adapter's own migrations (P5-1 verifier finding B).
 */
function listUserTableNames(db: DatabaseSync): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all()
    .map((row) => (row as { readonly name: string }).name);
}

/**
 * Reads the store's recorded schema version: `0` for a genuinely empty
 * database (no `schema_meta` table yet, and no other tables either —
 * nothing has ever been written here). Throws {@link AuditStoreCorruptError}
 * when:
 *
 * - `schema_meta` is absent but the database already contains other user
 *   tables — a foreign database belonging to another application must
 *   never be silently adopted as a fresh audit store (P5-1 verifier
 *   finding B);
 * - `schema_meta` exists but its one expected row is missing, or its
 *   `schema_version` is not a non-negative integer — an unknown version,
 *   never guessed at or silently recreated.
 */
function readSchemaVersion(db: DatabaseSync): number {
  if (!schemaMetaTableExists(db)) {
    const foreignTables = listUserTableNames(db);
    if (foreignTables.length > 0) {
      throw new AuditStoreCorruptError(
        `the database already contains table(s) ${foreignTables.join(', ')} but no schema_meta table — `
        + 'refusing to adopt what looks like a foreign database as a fresh audit store',
      );
    }
    return 0;
  }

  const row = db.prepare('SELECT schema_version FROM schema_meta WHERE id = 1').get() as
    | { readonly schema_version: unknown }
    | undefined;
  if (row === undefined) {
    throw new AuditStoreCorruptError('the schema_meta table exists but has no row with id = 1');
  }
  const { schema_version: version } = row;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new AuditStoreCorruptError(`schema_meta.schema_version is not a non-negative integer: ${JSON.stringify(version)}`);
  }
  return version;
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL
    ) STRICT;
  `);
  db.prepare(
    'INSERT INTO schema_meta (id, schema_version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version',
  ).run(version);
}

/**
 * Applies every pending migration transactionally and records the new
 * schema version. Throws {@link AuditStoreSchemaVersionError} when the
 * store's recorded version is already newer than {@link SCHEMA_VERSION}
 * this build supports — never migrated backwards, never silently
 * recreated (Phase 5 Scope). A no-op (no transaction opened at all) when
 * the store is already at the current version — idempotent re-open.
 */
function migrate(db: DatabaseSync): void {
  const currentVersion = readSchemaVersion(db);
  if (currentVersion > SCHEMA_VERSION) {
    throw new AuditStoreSchemaVersionError(currentVersion, SCHEMA_VERSION);
  }
  if (currentVersion === SCHEMA_VERSION) return;

  db.exec('BEGIN');
  try {
    for (let version = currentVersion; version < SCHEMA_VERSION; version += 1) {
      const migration = MIGRATIONS[version];
      if (migration === undefined) throw new Error(`unreachable: missing migration for schema version ${version + 1}`);
      migration(db);
    }
    writeSchemaVersion(db, SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// --- Row writers -------------------------------------------------------------------------

function insertWorkItem(db: DatabaseSync, runId: string, identity: AuditStoreWorkItemIdentity, state: WorkItemState): number {
  const result = db.prepare(
    'INSERT INTO work_items (run_id, test_case_id, repository_relative_path, name, state, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(runId, identity.testCaseId, identity.repositoryRelativePath, identity.name, state, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function insertAttempt(db: DatabaseSync, workItemId: number, evaluation: JevEvaluation): void {
  db.prepare(`
    INSERT INTO attempts
      (work_item_id, requested_model, responded_model, model_matches_pin, attempts, raw_answers, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workItemId,
    evaluation.requestedModel,
    evaluation.respondedModel,
    evaluation.modelMatchesPin ? 1 : 0,
    evaluation.attempts,
    JSON.stringify(evaluation.answers),
    evaluation.usage.inputTokens,
    evaluation.usage.outputTokens,
  );
}

function insertJudgment(db: DatabaseSync, workItemId: number, classification: ClassificationResult): void {
  db.prepare(
    'INSERT INTO judgments (work_item_id, status, policy_version, rubric_version, classification) VALUES (?, ?, ?, ?, ?)',
  ).run(workItemId, classification.status, classification.policyVersion, classification.rubricVersion, JSON.stringify(classification));
}

function insertError(db: DatabaseSync, workItemId: number, kind: string, message: string): void {
  db.prepare('INSERT INTO errors (work_item_id, kind, message) VALUES (?, ?, ?)').run(workItemId, kind, message);
}

function insertSkip(db: DatabaseSync, workItemId: number, reason: string): void {
  db.prepare('INSERT INTO skips (work_item_id, reason) VALUES (?, ?)').run(workItemId, reason);
}

export interface CreateSqliteAuditStoreOptions {
  readonly databaseFile: string;
}

/**
 * `true` for an error already produced by this module's own domain error
 * types — those are already named and visible, and must pass through
 * {@link wrapNativeSqliteError} unchanged rather than being wrapped again.
 */
function isAuditStoreError(error: unknown): error is AuditStoreCorruptError | AuditStoreSchemaVersionError {
  return error instanceof AuditStoreCorruptError || error instanceof AuditStoreSchemaVersionError;
}

/**
 * Wraps a raw failure from the native `node:sqlite` driver — `ERR_SQLITE_ERROR`
 * for a file that is not a SQLite database at all, a directory where the
 * file should be, a read-only file, or a foreign database whose table names
 * collide with ours (`table ... already exists`) — into
 * {@link AuditStoreCorruptError}, so none of those ever escape to a caller
 * as a raw native error (P5-1 verifier finding B). An error already thrown
 * by this adapter's own domain checks (see {@link isAuditStoreError}) is
 * rethrown unchanged, never double-wrapped.
 */
function wrapNativeSqliteError(error: unknown, databaseFile: string): AuditStoreCorruptError | AuditStoreSchemaVersionError {
  if (isAuditStoreError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AuditStoreCorruptError(`the native sqlite driver rejected "${databaseFile}": ${detail}`);
}

/**
 * Creates the production {@link AuditStorePort}: creates the containing
 * directory if needed, opens (or creates) `options.databaseFile`, and runs
 * migrations before returning — so a caller's first write is always against
 * an already-current schema. Never called unconditionally: the CLI
 * composition root (`src/cli/index.ts`) constructs this lazily, only when
 * `--evaluate` was requested, exactly like {@link createJevEvaluationPort}'s
 * own opt-in contract (`src/adapters/jev-evaluation-port.ts`).
 */
export async function createSqliteAuditStore(options: CreateSqliteAuditStoreOptions): Promise<AuditStorePort> {
  const sqliteModule = await loadSqliteModule();
  await mkdir(dirname(options.databaseFile), { recursive: true, mode: DIRECTORY_MODE });

  let db: DatabaseSync;
  try {
    db = new sqliteModule.DatabaseSync(options.databaseFile);
  } catch (error) {
    throw wrapNativeSqliteError(error, options.databaseFile);
  }

  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw wrapNativeSqliteError(error, options.databaseFile);
  }

  return {
    async beginRun(rootDir: string): Promise<string> {
      const runId = randomUUID();
      db.prepare('INSERT INTO runs (id, root_dir, started_at) VALUES (?, ?, ?)').run(runId, rootDir, new Date().toISOString());
      return runId;
    },

    async recordWorkItem(runId: string, outcome: AuditStoreWorkItemOutcome): Promise<void> {
      db.exec('BEGIN');
      try {
        const workItemId = insertWorkItem(db, runId, outcome.identity, outcome.state);
        if (outcome.state === 'completed') {
          insertAttempt(db, workItemId, outcome.evaluation);
          insertJudgment(db, workItemId, outcome.classification);
        } else if (outcome.state === 'failed') {
          insertError(db, workItemId, outcome.errorKind, outcome.errorMessage);
        } else if (outcome.state === 'skipped') {
          insertSkip(db, workItemId, outcome.reason);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async finishRun(runId: string): Promise<void> {
      db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(new Date().toISOString(), runId);
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
