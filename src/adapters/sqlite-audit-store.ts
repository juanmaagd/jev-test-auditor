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
import type { DryRunCacheNotConsultedReason, DryRunSkippedReason } from '../domain/estimate.js';
import type { JevEvaluation } from '../domain/jev-gateway.js';
import type { TestCaseId } from '../domain/test-understanding.js';
import {
  isSqliteExperimentalWarning,
  loadSqliteModule,
  migrateSqliteStore,
  readSchemaVersion as readSqliteStoreSchemaVersion,
  withSqliteExperimentalWarningSuppressed,
  wrapNativeSqliteError as wrapNativeSqliteStoreError,
  type SchemaErrorFactories,
  type SqliteStoreSchema,
} from './sqlite-store-common.js';

// Re-exported unchanged (Phase 7, task P7-3 extraction to `sqlite-store-common.ts`): every existing
// import of these two names from THIS module (this file's own doc, and `test/sqlite-audit-store.test.ts`)
// keeps working — see `sqlite-store-common.ts`'s own module doc for why the underlying
// implementation must stay genuinely singular across every store, never copy-pasted per store.
export { isSqliteExperimentalWarning, withSqliteExperimentalWarningSuppressed };

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

// --- Schema / versioned migrations ------------------------------------------------------
//
// The suppression window and migration ENGINE (schema_meta bookkeeping, transactional
// migration application, native-error wrapping) now live in `./sqlite-store-common.js`
// (Phase 7, task P7-3 extraction) — see that module's own doc for why. This section keeps
// only what is genuinely THIS store's own: its meta table name, its schema version, its
// migrations, and its named error types.

const SCHEMA_VERSION = 3;

/**
 * The schema version this build's persistence layer targets (Phase 6, task P6-2) — exported
 * purely for reporting: the canonical JSON report's `versions.storeSchema` field names it
 * regardless of whether a store actually opened for this run (it is a compile-time constant, not
 * a fact read from an open connection), so a reader can tell which migration generation produced
 * — or would produce, for an ordinary audit with no `--evaluate` — the persisted rows this build
 * writes. Never mutated at runtime; kept as a re-export of {@link SCHEMA_VERSION} rather than a
 * second constant so the two can never drift.
 */
export const AUDIT_STORE_SCHEMA_VERSION = SCHEMA_VERSION;

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
  // Phase 6, task P6-1: per-request latency. Both new columns are nullable — deliberately, and
  // for the identical reason `work_items.cache_key` above is nullable: a completed work item
  // recorded before this migration ran (a v2 `attempts` row) never captured latency at all, and
  // this migration must never fabricate a value (a made-up `0`, or an empty `[]`) standing in for
  // "genuinely measured, and it was zero." `latency_ms` is the whole-call wall-clock total
  // (`JevEvaluation.latencyMs`, including every internal retry and the backoff wait between
  // attempts); `attempt_latencies_ms` is that same evaluation's per-attempt breakdown
  // (`JevEvaluation.attemptLatenciesMs`), stored as a JSON array of milliseconds — the same
  // "store a JSON-serialized array/object in a TEXT column" convention `raw_answers` already uses
  // on this exact table, rather than a normalized child table for what is always read back as one
  // unit alongside its owning attempt.
  (db) => {
    db.exec('ALTER TABLE attempts ADD COLUMN latency_ms INTEGER;');
    db.exec('ALTER TABLE attempts ADD COLUMN attempt_latencies_ms TEXT;');
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

/**
 * This store's own schema identity (Phase 7, task P7-3 extraction): a fixed
 * `'schema_meta'` meta table name (unchanged from Phase 5 — every table name
 * already on disk stays exactly as it was, so no existing audit store file
 * needs a migration of its own to keep working under this refactor), this
 * store's {@link SCHEMA_VERSION}, and its {@link MIGRATIONS}. See
 * `sqlite-store-common.ts`'s `SqliteStoreSchema` doc for why the meta table
 * name is a per-store identity rather than a shared constant.
 */
const AUDIT_SQLITE_SCHEMA: SqliteStoreSchema = {
  metaTableName: 'schema_meta',
  schemaVersion: SCHEMA_VERSION,
  migrations: MIGRATIONS,
};

const AUDIT_SQLITE_ERRORS: SchemaErrorFactories<AuditStoreCorruptError | AuditStoreSchemaVersionError> = {
  corrupt: (detail) => new AuditStoreCorruptError(detail),
  tooNew: (foundVersion, supportedVersion) => new AuditStoreSchemaVersionError(foundVersion, supportedVersion),
};

function readSchemaVersion(db: DatabaseSync): number {
  return readSqliteStoreSchemaVersion(db, AUDIT_SQLITE_SCHEMA, AUDIT_SQLITE_ERRORS);
}

/**
 * Applies every pending migration transactionally and records the new
 * schema version, delegating the engine itself to
 * `sqlite-store-common.ts`'s `migrateSqliteStore` — see that function's own
 * doc; behavior is unchanged from Phase 5's original `migrate`.
 */
function migrate(db: DatabaseSync): void {
  migrateSqliteStore(db, AUDIT_SQLITE_SCHEMA, AUDIT_SQLITE_ERRORS);
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
      (work_item_id, requested_model, responded_model, model_matches_pin, attempts, raw_answers, input_tokens, output_tokens, latency_ms, attempt_latencies_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workItemId,
    evaluation.requestedModel,
    evaluation.respondedModel,
    evaluation.modelMatchesPin ? 1 : 0,
    evaluation.attempts,
    JSON.stringify(evaluation.answers),
    evaluation.usage.inputTokens,
    evaluation.usage.outputTokens,
    // Phase 6, task P6-1: both nullable (see MIGRATIONS[2]'s own doc) — `undefined` on the
    // in-memory `JevEvaluation` (never produced by the live gateway, only possible for a
    // hand-built fixture or a value reconstructed from a pre-P6-1 row) stores as a real SQL NULL,
    // never a fabricated 0 or '[]'.
    evaluation.latencyMs ?? null,
    evaluation.attemptLatenciesMs === undefined ? null : JSON.stringify(evaluation.attemptLatenciesMs),
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
  /** Phase 6, task P6-1: NULL for a row recorded before this migration (see MIGRATIONS[2]'s own doc) — never a fabricated 0. */
  readonly latency_ms: number | null;
  readonly attempt_latencies_ms: string | null;
}

function loadAttempt(db: DatabaseSync, workItemId: number): JevEvaluation | undefined {
  const row = db.prepare(`
    SELECT requested_model, responded_model, model_matches_pin, attempts, raw_answers, input_tokens, output_tokens, latency_ms, attempt_latencies_ms
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
    // Omitted entirely (never `latencyMs: undefined` as an explicit key) for a legacy row that
    // never captured this data — see `JevEvaluation.latencyMs`'s own doc (`src/domain/jev-gateway.ts`)
    // for why the field is optional at all.
    ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
    ...(row.attempt_latencies_ms === null ? {} : { attemptLatenciesMs: JSON.parse(row.attempt_latencies_ms) as readonly number[] }),
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
 * Wraps a raw native `node:sqlite` failure into {@link AuditStoreCorruptError},
 * delegating to `sqlite-store-common.ts`'s `wrapNativeSqliteError` — see that
 * function's own doc; behavior is unchanged from Phase 5's original.
 */
function wrapNativeSqliteError(error: unknown, databaseFile: string): AuditStoreCorruptError | AuditStoreSchemaVersionError {
  return wrapNativeSqliteStoreError(error, databaseFile, isAuditStoreError, (detail) => new AuditStoreCorruptError(detail));
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
 * `openSqliteAuditStoreForLookup`'s own result: a discriminated union rather
 * than a plain `| undefined`, so the one place that already knows *why* a
 * lookup is unavailable (this function) is also the one place that reports
 * it — no second, independent decision elsewhere that could silently drift
 * from this one. `available: false`'s `reason` is a
 * {@link DryRunCacheNotConsultedReason} (`src/domain/estimate.ts`) — the
 * exact same type `DryRunEstimate.cacheNotConsultedReason` carries, so the
 * CLI only ever passes this value through, never re-derives or re-maps it.
 */
export type AuditStoreLookupResult =
  | { readonly available: true; readonly lookup: AuditStoreReadOnlyLookup }
  | { readonly available: false; readonly reason: DryRunCacheNotConsultedReason };

/**
 * Opens the audit store strictly for a `--dry-run` cache-hit preview (Phase
 * 5, task P5-5) — the store's own scope constraint carried through from
 * `--evaluate` applies just as strictly here: a dry run "may read an
 * existing store, but must never create one, never migrate one, and never
 * write anything" (`odd/tasks/phase-5-persistence.md`, task P5-5). Verified
 * empirically against this Node's real `node:sqlite` (see this task's own
 * evidence in the feature document, not assumed from documentation):
 *
 * - `stat`s `options.databaseFile` first, and returns
 *   `{ available: false, reason: 'no-store' }` immediately when it does not
 *   exist — the one case the task names explicitly ("no store exists yet").
 *   This never even loads `node:sqlite`
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
 *   `{ available: false, reason: 'schema-outdated' }` ("not consulted"),
 *   matching that outcome exactly, rather than failing. A native open
 *   failure once the file is known to exist (not a SQLite database, a
 *   directory, unreadable permissions, ...) is wrapped the same way a
 *   writable open of the same file would fail for `--evaluate`, for the
 *   same reason.
 *
 * The two `available: false` `reason`s are exactly the two
 * {@link DryRunCacheNotConsultedReason} values (`src/domain/estimate.ts`) —
 * the CLI passes this result's `reason` straight through to
 * `estimateDryRun`'s own matching parameter with no re-derivation, so this
 * one function is the single source of truth for "why wasn't the cache
 * consulted" and the two can never drift apart.
 */
export async function openSqliteAuditStoreForLookup(
  options: CreateSqliteAuditStoreOptions,
): Promise<AuditStoreLookupResult> {
  try {
    await stat(options.databaseFile);
  } catch {
    return { available: false, reason: 'no-store' };
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
      return { available: false, reason: 'schema-outdated' };
    }
  } catch (error) {
    db.close();
    throw isAuditStoreError(error) ? error : wrapNativeSqliteError(error, options.databaseFile);
  }

  return {
    available: true,
    lookup: {
      async lookup(cacheKey: string): Promise<AuditStoreCachedJudgment | undefined> {
        const row = db.prepare(LOOKUP_CACHED_JUDGMENT_SQL).get(cacheKey) as { readonly classification: string } | undefined;
        if (row === undefined) return undefined;
        return { classification: JSON.parse(row.classification) as AuditStoreCachedJudgment['classification'] };
      },

      async close(): Promise<void> {
        db.close();
      },
    },
  };
}
