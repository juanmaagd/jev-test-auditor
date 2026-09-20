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
import { mkdir, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  AuditStoreCorruptError,
  AuditStoreSchemaVersionError,
  type AuditStoreCachedJudgment,
  type AuditStorePort,
  type AuditStoreRunState,
  type AuditStoreWorkItemIdentity,
  type AuditStoreWorkItemOutcome,
  type WorkItemState,
} from '../domain/audit.js';
import type { ClassificationResult } from '../domain/classification.js';
import type { DryRunSkippedReason } from '../domain/estimate.js';
import type { JevEvaluation } from '../domain/jev-gateway.js';
import type { TestCaseId } from '../domain/test-understanding.js';

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

const SCHEMA_VERSION = 2;

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
  // Phase 5, task P5-2: content-addressed caching. `cache_key` is nullable — a `completed` work
  // item recorded by a caller that never wires `AuditCacheKeyPort` (or a pre-P5-2 row already on
  // disk before this migration ran) simply carries no key, and `lookup` (below) can never match a
  // stored NULL against a real key string, so it is correctly unfindable rather than requiring an
  // extra runtime check to exclude it.
  (db) => {
    db.exec('ALTER TABLE work_items ADD COLUMN cache_key TEXT;');
    db.exec('CREATE INDEX idx_work_items_cache_key ON work_items (cache_key);');
  },
];

/**
 * The cache-hit lookup query (Phase 5, task P5-2's rule — see
 * `AuditStorePort.lookup`'s own doc in `src/domain/audit.ts`), shared
 * verbatim between the live store's own `lookup` below and the read-only
 * `--dry-run` reader (`openSqliteAuditStoreForLookup`, Phase 5, task P5-5):
 * one module-level constant, not two hand-copied query strings, so the two
 * can never silently drift apart and disagree on what counts as a hit.
 */
const LOOKUP_CACHED_JUDGMENT_SQL = `
  SELECT j.classification AS classification
  FROM work_items w
  JOIN attempts a ON a.work_item_id = w.id
  JOIN judgments j ON j.work_item_id = w.id
  WHERE w.state = 'completed' AND w.cache_key = ? AND a.model_matches_pin = 1
  ORDER BY w.id DESC
  LIMIT 1
`;

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

function insertWorkItem(
  db: DatabaseSync,
  runId: string,
  identity: AuditStoreWorkItemIdentity,
  state: WorkItemState,
  cacheKey: string | undefined,
): number {
  const result = db.prepare(
    'INSERT INTO work_items (run_id, test_case_id, repository_relative_path, name, state, recorded_at, cache_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(runId, identity.testCaseId, identity.repositoryRelativePath, identity.name, state, new Date().toISOString(), cacheKey ?? null);
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

// --- Row readers (Phase 5, task P5-4: `AuditStorePort.loadRunState`, for `--resume <runId>`) --

interface StoredAttemptRow {
  readonly requested_model: string;
  readonly responded_model: string;
  readonly model_matches_pin: number;
  readonly attempts: number;
  readonly raw_answers: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

function loadAttempt(db: DatabaseSync, workItemId: number): JevEvaluation | undefined {
  const row = db.prepare(`
    SELECT requested_model, responded_model, model_matches_pin, attempts, raw_answers, input_tokens, output_tokens
    FROM attempts WHERE work_item_id = ?
  `).get(workItemId) as StoredAttemptRow | undefined;
  if (row === undefined) return undefined;
  return {
    requestedModel: row.requested_model,
    respondedModel: row.responded_model,
    modelMatchesPin: row.model_matches_pin === 1,
    answers: JSON.parse(row.raw_answers) as JevEvaluation['answers'],
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
    attempts: row.attempts,
  };
}

function loadJudgment(db: DatabaseSync, workItemId: number): ClassificationResult | undefined {
  const row = db.prepare('SELECT classification FROM judgments WHERE work_item_id = ?').get(workItemId) as
    | { readonly classification: string }
    | undefined;
  if (row === undefined) return undefined;
  return JSON.parse(row.classification) as ClassificationResult;
}

function loadError(db: DatabaseSync, workItemId: number): { readonly kind: string; readonly message: string } | undefined {
  return db.prepare('SELECT kind, message FROM errors WHERE work_item_id = ?').get(workItemId) as
    | { readonly kind: string; readonly message: string }
    | undefined;
}

function loadSkip(db: DatabaseSync, workItemId: number): { readonly reason: string } | undefined {
  return db.prepare('SELECT reason FROM skips WHERE work_item_id = ?').get(workItemId) as
    | { readonly reason: string }
    | undefined;
}

interface LastRowPerIdentity {
  readonly id: number;
  readonly test_case_id: string;
  readonly repository_relative_path: string;
  readonly name: string;
  readonly state: string;
  readonly cache_key: string | null;
}

/**
 * The LAST recorded `work_items` row (highest `id`, insertion order) per
 * `(test_case_id, repository_relative_path, name)` identity for `runId` —
 * regardless of that row's state. Grouping is by `MAX(id)`, deliberately
 * never `MIN(id)`: the whole point of a `pending` → `running` → terminal
 * trail (Phase 5, task P5-3) is that the LATEST row is the current truth,
 * and every earlier row is superseded history the caller
 * (`loadRunState` below) must never mistake for it — see
 * `test/sqlite-audit-store.test.ts`'s own MIN(id)-vs-MAX(id) test for
 * exactly the corruption a swap here would cause.
 */
function lastRowPerIdentity(db: DatabaseSync, runId: string): readonly LastRowPerIdentity[] {
  return db.prepare(`
    SELECT w.id AS id, w.test_case_id AS test_case_id, w.repository_relative_path AS repository_relative_path,
           w.name AS name, w.state AS state, w.cache_key AS cache_key
    FROM work_items w
    INNER JOIN (
      SELECT test_case_id, repository_relative_path, name, MAX(id) AS max_id
      FROM work_items
      WHERE run_id = ?
      GROUP BY test_case_id, repository_relative_path, name -- MUTATION
    ) last ON last.max_id = w.id
    WHERE w.run_id = ?
  `).all(runId, runId) as unknown as readonly LastRowPerIdentity[];
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
    // Phase 5, task P5-3: every evaluable work item now writes up to three separate append-only
    // transactions (`pending`, `running`, then its terminal outcome) instead of P5-1/P5-2's one,
    // so a run's total transaction count roughly triples. SQLite's default rollback-journal mode
    // does a full `fsync` on every `COMMIT`, which is the dominant cost for many small sequential
    // single-row transactions like these. WAL mode amortizes that cost across the whole run
    // instead of paying it per row, without weakening the durability this adapter actually needs:
    // every committed row is still crash-safe against an application crash (a full disk-power-loss
    // window during an uncheckpointed WAL is an acceptable tradeoff for a local audit-tool cache,
    // not a production database). Transaction semantics (`BEGIN`/`COMMIT`/`ROLLBACK` in `migrate`
    // and `recordWorkItem`) are unaffected — WAL only changes how a commit is physically durable,
    // never the SQL-level guarantees. Set once per connection, before migrations run, and inside
    // the same try/catch as `migrate` below: a garbage file or a read-only file fails right here
    // (setting WAL mode itself needs to write), and must still surface as the same named
    // `AuditStoreCorruptError`, never a raw native error.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
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

    // Defect fix (2026-09-20): resolve against the current working directory, then follow
    // symlinks (matching `discoverTestFiles`/`readSourceFile`'s own convention for the audited
    // root) — never throws, falling back to the plain resolved form when `realpath` cannot
    // resolve the path (it does not exist, or is not yet reachable), so a `--resume` preflight
    // still compares cleanly instead of crashing on a raw filesystem error.
    async canonicalizeRootDir(rootDir: string): Promise<string> {
      const resolved = resolve(rootDir);
      try {
        return await realpath(resolved);
      } catch {
        return resolved;
      }
    },

    async recordWorkItem(runId: string, outcome: AuditStoreWorkItemOutcome): Promise<void> {
      db.exec('BEGIN');
      try {
        const cacheKey = outcome.state === 'completed' || outcome.state === 'cached' ? outcome.cacheKey : undefined;
        const workItemId = insertWorkItem(db, runId, outcome.identity, outcome.state, cacheKey);
        if (outcome.state === 'completed') {
          insertAttempt(db, workItemId, outcome.evaluation);
          insertJudgment(db, workItemId, outcome.classification);
        } else if (outcome.state === 'cached') {
          // A cache hit made no provider request: no `attempts` row (there was no attempt), only
          // the reused judgment, recorded as its own append-only fact (Phase 5, task P5-2).
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

    async lookup(cacheKey: string): Promise<AuditStoreCachedJudgment | undefined> {
      const row = db.prepare(LOOKUP_CACHED_JUDGMENT_SQL).get(cacheKey) as { readonly classification: string } | undefined;
      if (row === undefined) return undefined;
      return { classification: JSON.parse(row.classification) as AuditStoreCachedJudgment['classification'] };
    },

    async finishRun(runId: string): Promise<void> {
      db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(new Date().toISOString(), runId);
    },

    async loadRunState(runId: string): Promise<AuditStoreRunState | undefined> {
      const runRow = db.prepare('SELECT root_dir, finished_at FROM runs WHERE id = ?').get(runId) as
        | { readonly root_dir: string; readonly finished_at: string | null }
        | undefined;
      if (runRow === undefined) return undefined;

      const terminalWorkItems: AuditStoreWorkItemOutcome[] = [];
      for (const row of lastRowPerIdentity(db, runId)) {
        const identity: AuditStoreWorkItemIdentity = {
          testCaseId: row.test_case_id as TestCaseId,
          repositoryRelativePath: row.repository_relative_path,
          name: row.name,
        };
        if (row.state === 'completed') {
          const evaluation = loadAttempt(db, row.id);
          const classification = loadJudgment(db, row.id);
          if (evaluation !== undefined && classification !== undefined) {
            terminalWorkItems.push({ state: 'completed', identity, ...(row.cache_key === null ? {} : { cacheKey: row.cache_key }), evaluation, classification });
          }
        } else if (row.state === 'cached') {
          const classification = loadJudgment(db, row.id);
          if (classification !== undefined && row.cache_key !== null) {
            terminalWorkItems.push({ state: 'cached', identity, cacheKey: row.cache_key, classification });
          }
        } else if (row.state === 'failed') {
          const error = loadError(db, row.id);
          if (error !== undefined) terminalWorkItems.push({ state: 'failed', identity, errorKind: error.kind, errorMessage: error.message });
        } else if (row.state === 'skipped') {
          const skip = loadSkip(db, row.id);
          if (skip !== undefined) terminalWorkItems.push({ state: 'skipped', identity, reason: skip.reason as DryRunSkippedReason });
        }
        // 'pending'/'running' (and an 'uncertain' row, never produced today — see
        // `WorkItemState`'s own doc) are intentionally not included: see `AuditStoreRunState`'s own
        // doc for why this port never decides what is "outstanding."
      }

      return {
        rootDir: runRow.root_dir,
        // Defect fix (2026-09-20): a necessary, not sufficient, test for "already canonical" —
        // see `AuditStoreRunState.rootDirCanonical`'s own doc (`src/domain/audit.ts`) for the one
        // known residual gap (a pre-fix absolute rootDir that still traversed a symlinked
        // ancestor `beginRun` never resolved).
        rootDirCanonical: isAbsolute(runRow.root_dir),
        finished: runRow.finished_at !== null,
        terminalWorkItems,
      };
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}

/**
 * The narrow, strictly read-only surface `openSqliteAuditStoreForLookup`
 * (below) returns: exactly the one operation `audit --dry-run` needs
 * (Phase 5, task P5-5), and nothing that could write. Deliberately not the
 * full {@link AuditStorePort} — a dry run has no run to begin, no work item
 * to record, and must never be handed a shape whose other methods even
 * *look* callable for those.
 */
export interface AuditStoreReadOnlyLookup {
  lookup(cacheKey: string): Promise<AuditStoreCachedJudgment | undefined>;
  /** Releases the underlying read-only database handle. Safe to call once. */
  close(): Promise<void>;
}

/**
 * Opens the audit store strictly for a `--dry-run` cache-hit preview (Phase
 * 5, task P5-5) — the store's own scope constraint carried through from
 * `--evaluate` applies just as strictly here: a dry run "may read an
 * existing store, but must never create one, never migrate one, and never
 * write anything" (`odd/tasks/phase-5-persistence.md`, task P5-5). Verified
 * empirically against this Node's real `node:sqlite` (see this task's own
 * evidence in the feature document, not assumed from documentation):
 *
 * - `stat`s `options.databaseFile` first, and returns `undefined`
 *   immediately when it does not exist — the one case the task names
 *   explicitly ("no store exists yet"). This never even loads `node:sqlite`
 *   (no `ExperimentalWarning`, no native open attempt against a path that
 *   is not there), unlike `createSqliteAuditStore`, which always opens
 *   (and, if needed, creates) the file.
 * - When the file exists, opens it through a `file:` URI (built with
 *   `pathToFileURL`, never raw string concatenation — a `#`/`?`/`%` in the
 *   resolved path, e.g. inside `XDG_CONFIG_HOME`, would otherwise corrupt a
 *   hand-built URI) carrying `immutable=1`, plus `{ readOnly: true }` as a
 *   second, independent guard. `immutable=1` is the load-bearing piece,
 *   empirically confirmed both ways: `readOnly: true` alone still makes
 *   SQLite create `-shm`/`-wal` sidecar files for a WAL-mode database on the
 *   very first `SELECT` (it needs the wal-index to read a consistent
 *   snapshot), while `immutable=1` alone (no `readOnly` option at all)
 *   already refuses a write attempt outright ("attempt to write a readonly
 *   database") and creates no sidecar — `immutable=1` tells SQLite the file
 *   will not change and to skip that locking/indexing machinery entirely.
 *   `readOnly: true` is kept anyway as defense-in-depth at the `node:sqlite`
 *   binding level, not because it is independently necessary. Verified to
 *   create no sidecar file and leave the main file byte-identical (hash
 *   and size), both against a cleanly closed store and one still holding an
 *   uncheckpointed `-wal` file from another live connection.
 * - **Known, documented limitation of `immutable=1`**: it also means a row
 *   sitting only in an uncheckpointed `-wal` sidecar (the store did not
 *   close cleanly since that write — see P5-3's own WAL evidence) is
 *   invisible to this read-only reader; it reads only the main database
 *   file's own last-checkpointed content. This can only ever make a dry
 *   run UNDER-report cache hits (report a test case as billable that a
 *   subsequent real `--evaluate` — which opens the store normally and does
 *   see the WAL — would actually find cached), never the reverse. The
 *   required "billable count matches what a subsequent real run issues"
 *   guarantee holds for the ordinary case this task verifies: sequential
 *   CLI invocations, each of which closes its store cleanly (`runCli`'s own
 *   `finally`), so by the time a later `--dry-run`/`--evaluate` opens the
 *   file, everything is already checkpointed into it.
 * - **Schema compatibility**, decided by "what would a subsequent real
 *   `--evaluate` against this exact file do?" (never a separate policy):
 *   a version newer than this build supports, or a store `readSchemaVersion`
 *   already rejects as corrupt/foreign (a malformed `schema_meta` row, or
 *   user tables with no `schema_meta` at all) — `--evaluate` would refuse
 *   these too (`AuditStoreSchemaVersionError`/`AuditStoreCorruptError`), so
 *   this function throws the identical named error rather than silently
 *   reporting a happy "N billable" preview a real run could never actually
 *   produce; the CLI's existing `--evaluate` catch already handles both
 *   (readable message, exit 1, no stack trace) and is reused unchanged for
 *   `--dry-run`. A version OLDER than this build's `SCHEMA_VERSION` (no
 *   `cache_key` column can exist yet) can never contain a hit, and a
 *   subsequent real `--evaluate` would simply migrate it forward first and
 *   then dispatch every evaluable test case — so this degrades to
 *   `undefined` ("not consulted"), matching that outcome exactly, rather
 *   than failing. A native open failure once the file is known to exist
 *   (not a SQLite database, a directory, unreadable permissions, ...) is
 *   wrapped the same way a writable open of the same file would fail for
 *   `--evaluate`, for the same reason.
 */
export async function openSqliteAuditStoreForLookup(
  options: CreateSqliteAuditStoreOptions,
): Promise<AuditStoreReadOnlyLookup | undefined> {
  try {
    await stat(options.databaseFile);
  } catch {
    return undefined;
  }

  const sqliteModule = await loadSqliteModule();
  const immutableUrl = new URL(pathToFileURL(options.databaseFile).href);
  immutableUrl.searchParams.set('immutable', '1');

  let db: DatabaseSync;
  try {
    db = new sqliteModule.DatabaseSync(immutableUrl.href, { readOnly: true });
  } catch (error) {
    throw wrapNativeSqliteError(error, options.databaseFile);
  }

  try {
    const version = readSchemaVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new AuditStoreSchemaVersionError(version, SCHEMA_VERSION);
    }
    if (version < SCHEMA_VERSION) {
      db.close();
      return undefined;
    }
  } catch (error) {
    db.close();
    throw isAuditStoreError(error) ? error : wrapNativeSqliteError(error, options.databaseFile);
  }

  return {
    async lookup(cacheKey: string): Promise<AuditStoreCachedJudgment | undefined> {
      const row = db.prepare(LOOKUP_CACHED_JUDGMENT_SQL).get(cacheKey) as { readonly classification: string } | undefined;
      if (row === undefined) return undefined;
      return { classification: JSON.parse(row.classification) as AuditStoreCachedJudgment['classification'] };
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
