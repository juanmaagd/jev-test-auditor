/**
 * Shared `node:sqlite` scaffolding for every local store this repository
 * persists (the audit store, `src/adapters/sqlite-audit-store.ts`, task P5-1;
 * and the benchmark store, `src/adapters/sqlite-benchmark-store.ts`, task
 * P7-3): the one-time `node:sqlite` `ExperimentalWarning` suppression, and
 * the versioned-migration engine (`schema_meta`-style bookkeeping,
 * transactional migration application, and native-error wrapping).
 *
 * Extracted here (P7-3) rather than copy-pasted into a second store module,
 * for two independent reasons:
 *
 * - The migration engine is genuinely generic — ~150 lines of already-tested
 *   Phase 5/6 behavior (idempotent re-open, foreign-database detection,
 *   schema-version-too-new refusal, native-error wrapping) that a second
 *   hand-copied implementation could only either duplicate exactly (dead
 *   weight) or silently drift from (a real risk: the two stores would then
 *   disagree about what "foreign database" or "schema too new" detection
 *   even means, for no reason).
 * - The warning suppression genuinely MUST be singular. Its overlap-safe
 *   depth-counter design (`withSqliteExperimentalWarningSuppressed`'s own
 *   doc below) depends on there being exactly one `suppressionDepth`/
 *   `trueOriginalEmitWarning` pair in the whole process. Two independent
 *   copies of this module-level state (one per store module) would each
 *   patch and restore `process.emitWarning` without knowing about the
 *   other's active window — reintroducing exactly the cross-call race this
 *   design exists to prevent, only now across STORES instead of across
 *   overlapping calls to the same store.
 *
 * Each store still owns everything that makes it what it is: its own meta
 * table name (see {@link SqliteStoreSchema.metaTableName}'s own doc for why
 * this one field is load-bearing), its own schema version and migrations,
 * and its own named error types (`AuditStoreCorruptError`/
 * `AuditStoreSchemaVersionError` vs. `BenchmarkStoreCorruptError`/
 * `BenchmarkStoreSchemaVersionError`). Nothing here decides what "corrupt"
 * or "too new" MEANS for a given store — only how a schema is read,
 * migrated, and how a native failure is caught before it can ever escape a
 * caller as a raw `ERR_SQLITE_ERROR`.
 */
import type { DatabaseSync } from 'node:sqlite';

// --- ExperimentalWarning suppression (Phase 5 Scope: "Suppress that one warning narrowly") ---

const SQLITE_EXPERIMENTAL_WARNING_TYPE = 'ExperimentalWarning';
const SQLITE_EXPERIMENTAL_WARNING_TEXT = 'SQLite is an experimental feature';

/**
 * `true` only for the exact `node:sqlite` experimental-feature warning shape
 * Node emits. See `src/adapters/sqlite-audit-store.ts`'s original doc (Phase
 * 5, task P5-1) for the full rationale; unchanged by this extraction.
 */
export function isSqliteExperimentalWarning(warning: unknown, warningType: unknown): boolean {
  return (
    warningType === SQLITE_EXPERIMENTAL_WARNING_TYPE
    && typeof warning === 'string'
    && warning.includes(SQLITE_EXPERIMENTAL_WARNING_TEXT)
  );
}

// Module-level suppression state (P5-1 verifier finding E, unchanged by this extraction): a naive
// save/restore of `process.emitWarning` per call breaks under two overlapping (not merely nested)
// calls. Instead, exactly one shared patch is installed by the first entrant and removed by the
// last, tracked by a depth counter — see the module doc above for why this state must stay
// singular across every store that imports this module, never duplicated per store.
let suppressionDepth = 0;
let trueOriginalEmitWarning: typeof process.emitWarning | undefined;

/**
 * Runs `loader` with `process.emitWarning` temporarily wrapped so that
 * exactly the `node:sqlite` experimental-feature warning never reaches
 * Node's default handler, while every other warning — including a
 * *different* `ExperimentalWarning` — is forwarded untouched. Safe under
 * overlapping concurrent calls, including calls made on behalf of different
 * stores: see the module doc above and `test/sqlite-audit-store.test.ts`'s
 * own overlap test (unchanged by this extraction — it imports this function
 * through `sqlite-audit-store.js`'s re-export).
 */
export async function withSqliteExperimentalWarningSuppressed<T>(loader: () => Promise<T>): Promise<T> {
  if (suppressionDepth === 0) {
    // Deliberately NOT `.bind()`ed — see the original doc this was extracted from for why.
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

/** Loads `node:sqlite` through the suppression window above — the one place either store ever imports the module itself. */
export async function loadSqliteModule(): Promise<typeof import('node:sqlite')> {
  return withSqliteExperimentalWarningSuppressed(() => import('node:sqlite'));
}

// --- Schema / versioned migrations --------------------------------------------------------

export type SqliteMigration = (db: DatabaseSync) => void;

/**
 * One store's schema identity. `metaTableName` is deliberately part of this
 * (never a shared constant like `'schema_meta'` hardcoded in this module):
 * two stores sharing one meta table name would mean opening the WRONG store
 * file under the RIGHT adapter reads a table that happens to exist there
 * too, and either silently succeeds against a foreign schema or reports a
 * confusing "newer than this build supports" instead of the true "this is
 * not a benchmark store" — see `test/sqlite-benchmark-store.test.ts`'s own
 * "refuses a real audit store file" test, which exists specifically to prove
 * a distinct meta table name is what makes that refusal legible rather than
 * misleading.
 */
export interface SqliteStoreSchema {
  readonly metaTableName: string;
  readonly schemaVersion: number;
  readonly migrations: readonly SqliteMigration[];
}

/** Error factories a store supplies so this module never has to know a store's own named error classes. */
export interface SchemaErrorFactories<TError extends Error> {
  readonly corrupt: (detail: string) => TError;
  readonly tooNew: (foundVersion: number, supportedVersion: number) => TError;
}

export function schemaMetaTableExists(db: DatabaseSync, metaTableName: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(metaTableName) !== undefined;
}

/**
 * Every user table name already present in `db`, excluding SQLite's own
 * internal `sqlite_%` tables. Used only to distinguish a genuinely empty
 * database (nothing here yet — safe to migrate) from a foreign one that
 * already holds someone else's tables but never went through this store's
 * own migrations (P5-1 verifier finding B; unchanged by this extraction).
 */
export function listUserTableNames(db: DatabaseSync): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all()
    .map((row) => (row as { readonly name: string }).name);
}

/**
 * Reads a store's recorded schema version: `0` for a genuinely empty
 * database. Throws `errors.corrupt(...)` when `schema.metaTableName` is
 * absent but the database already contains OTHER user tables (a foreign
 * database must never be silently adopted), or when the meta table exists
 * but its one expected row is missing or malformed. See
 * `src/adapters/sqlite-audit-store.ts`'s original `readSchemaVersion` doc
 * (Phase 5, task P5-1) for the full rationale; unchanged by this extraction
 * beyond taking `schema`/`errors` as parameters instead of closing over a
 * fixed table name and a fixed pair of error classes.
 */
export function readSchemaVersion<TError extends Error>(
  db: DatabaseSync,
  schema: Pick<SqliteStoreSchema, 'metaTableName'>,
  errors: Pick<SchemaErrorFactories<TError>, 'corrupt'>,
): number {
  if (!schemaMetaTableExists(db, schema.metaTableName)) {
    const foreignTables = listUserTableNames(db);
    if (foreignTables.length > 0) {
      throw errors.corrupt(
        `the database already contains table(s) ${foreignTables.join(', ')} but no ${schema.metaTableName} table — `
        + 'refusing to adopt what looks like a foreign database as a fresh store',
      );
    }
    return 0;
  }

  const row = db.prepare(`SELECT schema_version FROM ${schema.metaTableName} WHERE id = 1`).get() as
    | { readonly schema_version: unknown }
    | undefined;
  if (row === undefined) {
    throw errors.corrupt(`the ${schema.metaTableName} table exists but has no row with id = 1`);
  }
  const { schema_version: version } = row;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw errors.corrupt(`${schema.metaTableName}.schema_version is not a non-negative integer: ${JSON.stringify(version)}`);
  }
  return version;
}

export function writeSchemaVersion(db: DatabaseSync, metaTableName: string, version: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${metaTableName} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL
    ) STRICT;
  `);
  db.prepare(
    `INSERT INTO ${metaTableName} (id, schema_version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version`,
  ).run(version);
}

/**
 * Applies every pending migration transactionally and records the new
 * schema version. Throws `errors.tooNew(...)` when the store's recorded
 * version is already newer than `schema.schemaVersion` this build supports
 * — never migrated backwards, never silently recreated. A no-op (no
 * transaction opened at all) when the store is already at the current
 * version — idempotent re-open. Identical control flow to
 * `src/adapters/sqlite-audit-store.ts`'s original `migrate` (Phase 5, task
 * P5-1); unchanged by this extraction beyond taking `schema`/`errors` as
 * parameters.
 */
export function migrateSqliteStore<TError extends Error>(
  db: DatabaseSync,
  schema: SqliteStoreSchema,
  errors: SchemaErrorFactories<TError>,
): void {
  const currentVersion = readSchemaVersion(db, schema, errors);
  if (currentVersion > schema.schemaVersion) {
    throw errors.tooNew(currentVersion, schema.schemaVersion);
  }
  if (currentVersion === schema.schemaVersion) return;

  db.exec('BEGIN');
  try {
    for (let version = currentVersion; version < schema.schemaVersion; version += 1) {
      const migration = schema.migrations[version];
      if (migration === undefined) throw new Error(`unreachable: missing migration for schema version ${version + 1}`);
      migration(db);
    }
    writeSchemaVersion(db, schema.metaTableName, schema.schemaVersion);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Wraps a raw failure from the native `node:sqlite` driver — `ERR_SQLITE_ERROR`
 * for a file that is not a SQLite database at all, a directory where the
 * file should be, a read-only file, or a foreign database whose table names
 * collide with ours — into the store's own named corrupt error, so none of
 * those ever escape a caller as a raw native error (P5-1 verifier finding
 * B). An error already thrown by the store's own domain checks (per
 * `isOwnError`) is rethrown unchanged, never double-wrapped.
 */
export function wrapNativeSqliteError<TError extends Error>(
  error: unknown,
  databaseFile: string,
  isOwnError: (error: unknown) => error is TError,
  onCorrupt: (detail: string) => TError,
): TError {
  if (isOwnError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return onCorrupt(`the native sqlite driver rejected "${databaseFile}": ${detail}`);
}
