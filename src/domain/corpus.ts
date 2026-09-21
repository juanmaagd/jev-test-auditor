/**
 * The Phase 7 deterministic-benchmark fixture corpus (task P7-1,
 * `odd/tasks/phase-7-benchmarks.md`). Pure parsing only — no Node imports, no
 * adapter imports, no I/O, no timers, exactly like every other module under
 * `src/domain` (see `test/architecture-boundary.test.ts`). Reading a case's
 * bytes off disk is adapter work (`src/adapters/corpus-store.ts`); this
 * module only ever sees strings it has already been handed.
 *
 * **What a corpus case is.** Per `docs/technical-design.md`'s "Deterministic
 * evaluation" and this phase's Decisions: a triple of a base test that
 * genuinely passes against its production code, one declared operator, and
 * the oracle that will later prove the operator's claimed effect. This task
 * (P7-1) stores that triple and parses it; it never applies a mutation and
 * never runs anything — P7-2 does both.
 *
 * **Two mutation targets, not one.** `docs/technical-design.md:332` names six
 * operators (`CORPUS_OPERATOR_IDS`) and four oracle kinds
 * (`CORPUS_ORACLE_KINDS`) as separate lists for a reason: every operator here
 * mutates the *test* (remove an assertion, weaken an expectation, ...). Three
 * of the four oracle kinds prove their effect by acting on *production*
 * (mutate the function under test, refactor it while preserving behavior, run
 * repeatedly/randomized); the fourth, `assertion-mutation`, acts on the base
 * test's own assertion instead and compares outcomes — still a distinct claim
 * from what the operator changes about the test, since it is about whether
 * that assertion change alters what a fixed production mutation can be
 * distinguished from. A case therefore declares two independent
 * expected-effect claims, not one: `testEffect` (what the operator changes
 * about the base test) and `productionEffect` (the falsifiable pass/fail
 * claim the named `oracleKind` is meant to prove, whichever side it acts on).
 * Collapsing these into a single field would force P7-2 to either guess which
 * side a free-text claim was about, or widen the format later and orphan
 * every case already written — both rejected up front instead of discovered
 * mid-P7-2.
 *
 * **Why `oracleKind` is declared now even though no oracle runs yet.** A
 * case that names its oracle kind but has not yet been run reads, correctly,
 * as "proof pending"; a case with no named oracle at all would be a
 * different and strictly worse state — "nobody has even decided how this
 * would be proven" — so `oracleKind` is required, exactly like `operator`.
 *
 * **The unproven/proven distinction is structural, not a convention.** Every
 * `CorpusCase` this module produces carries `proofStatus: 'unverified'`, a
 * literal this parser assigns itself — it is never read from the manifest,
 * so a hand-edited `case.json` cannot forge a proof by writing the word
 * "proven" into a JSON file (this is also why `proofStatus` is one of the
 * rejected unknown keys below: it has no legitimate reason to appear in a
 * declaration). P7-3's benchmark database is the only place a real proof
 * outcome can live; nothing here, or downstream of it, can mistake a
 * declared claim for a demonstrated one. `docs/PRD.md`'s "Rules are
 * hypotheses" applies equally to a corpus case's own claims about itself.
 */

/** The six test-mutating operators from `docs/technical-design.md:332`, in the order they appear there. */
export const CORPUS_OPERATOR_IDS = [
  'remove-assertion',
  'weaken-expectation',
  'add-shared-state',
  'mock-owned-logic',
  'pin-implementation-detail',
  'introduce-uncontrolled-time',
] as const;

export type CorpusOperatorId = (typeof CORPUS_OPERATOR_IDS)[number];

const CORPUS_OPERATOR_ID_SET: ReadonlySet<string> = new Set(CORPUS_OPERATOR_IDS);

/** The four production-mutating oracle kinds from `docs/technical-design.md:332`, in the order they appear there. */
export const CORPUS_ORACLE_KINDS = [
  'production-mutation',
  'assertion-mutation',
  'semantics-preserving-refactor',
  'repeated-randomized-execution',
] as const;

export type CorpusOracleKind = (typeof CORPUS_ORACLE_KINDS)[number];

const CORPUS_ORACLE_KIND_SET: ReadonlySet<string> = new Set(CORPUS_ORACLE_KINDS);

/**
 * Every `CorpusCase` P7-1 can produce is `'unverified'` — the single literal
 * this module ever assigns. P7-2 introduces the proven counterpart once an
 * oracle can actually run; widening this into a real union is deliberately
 * left to that task rather than guessed at here.
 */
export type CorpusCaseProofStatus = 'unverified';

/** One file's exact bytes, addressable on its own — never folded into another file's contents. */
export interface CorpusSourceFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * The validated shape of one case's `case.json`, before its declared files
 * have been read off disk. `testFile`/`productionFiles` are still bare
 * relative paths here; {@link buildCorpusCase} turns them into real
 * {@link CorpusSourceFile} content once the adapter has read them.
 */
export interface CorpusCaseManifest {
  readonly id: string;
  readonly operator: CorpusOperatorId;
  readonly oracleKind: CorpusOracleKind;
  readonly testEffect: string;
  readonly productionEffect: string;
  readonly testFile: string;
  readonly productionFiles: readonly string[];
}

/** One fully assembled, still-unproven corpus case: the manifest plus the exact bytes it names. */
export interface CorpusCase {
  readonly id: string;
  readonly operator: CorpusOperatorId;
  readonly oracleKind: CorpusOracleKind;
  readonly testEffect: string;
  readonly productionEffect: string;
  readonly baseTest: CorpusSourceFile;
  readonly productionSources: readonly CorpusSourceFile[];
  readonly proofStatus: CorpusCaseProofStatus;
}

/**
 * The only fields a `case.json` may declare. `proofStatus` is deliberately
 * absent — see the module doc — so a manifest that tries to declare it fails
 * the unknown-field check below exactly like a typo would.
 */
const MANIFEST_KEYS = [
  'id',
  'operators',
  'oracleKind',
  'testEffect',
  'productionEffect',
  'testFile',
  'productionFiles',
] as const;

const MANIFEST_KEY_SET: ReadonlySet<string> = new Set(MANIFEST_KEYS);

function fail(message: string): never {
  throw new RangeError(message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A path is safe when it stays inside the case directory it was declared
 * from: no absolute path, no drive letter, no `..` segment. This is
 * validation of the *string*, not I/O, so it belongs here rather than in the
 * adapter that later joins it to a real directory and reads it.
 */
function isSafeRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return false;
  return normalized.split('/').every((segment) => segment !== '..');
}

function parseManifestJson(manifestJson: string): unknown {
  try {
    return JSON.parse(manifestJson);
  } catch (error) {
    return fail(`Corpus case manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asManifestRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('Corpus case manifest must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

function requireId(record: Record<string, unknown>): string {
  if (!isNonEmptyString(record.id)) fail('Corpus case manifest must declare a non-empty "id"');
  return record.id;
}

function requireOperator(record: Record<string, unknown>, id: string): CorpusOperatorId {
  const operators = record.operators;
  if (!Array.isArray(operators)) {
    fail(`Corpus case "${id}" must declare "operators" as an array of operator ids`);
  }
  if (operators.length !== 1) {
    fail(`Corpus case "${id}" must declare exactly one operator: got ${operators.length} (${JSON.stringify(operators)})`);
  }
  const [candidate] = operators as unknown[];
  if (typeof candidate !== 'string' || !CORPUS_OPERATOR_ID_SET.has(candidate)) {
    fail(`Corpus case "${id}" declares an unknown operator: ${JSON.stringify(candidate)}`);
  }
  return candidate as CorpusOperatorId;
}

function requireOracleKind(record: Record<string, unknown>, id: string): CorpusOracleKind {
  const oracleKind = record.oracleKind;
  if (typeof oracleKind !== 'string' || !CORPUS_ORACLE_KIND_SET.has(oracleKind)) {
    fail(`Corpus case "${id}" must declare a known "oracleKind": got ${JSON.stringify(oracleKind)}`);
  }
  return oracleKind as CorpusOracleKind;
}

function requireNonEmptyStringField(record: Record<string, unknown>, field: string, id: string): string {
  const value = record[field];
  if (!isNonEmptyString(value)) fail(`Corpus case "${id}" must declare a non-empty "${field}"`);
  return value;
}

function requireSafeRelativePathField(record: Record<string, unknown>, field: string, id: string): string {
  const value = record[field];
  if (!isSafeRelativePath(value)) {
    fail(`Corpus case "${id}" must declare "${field}" as a relative path inside its case directory: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireProductionFiles(record: Record<string, unknown>, id: string): readonly string[] {
  const productionFiles = record.productionFiles;
  if (!Array.isArray(productionFiles) || productionFiles.length === 0) {
    fail(`Corpus case "${id}" must declare at least one "productionFiles" entry`);
  }
  return productionFiles.map((entry, index) => {
    if (!isSafeRelativePath(entry)) {
      fail(`Corpus case "${id}" has an invalid "productionFiles" entry at index ${index}: ${JSON.stringify(entry)}`);
    }
    return entry;
  });
}

/**
 * Parses and validates one `case.json`'s bytes. Deterministic and pure:
 * `JSON.parse` is a global, not an import, so this stays free of any
 * non-relative dependency (see `test/architecture-boundary.test.ts`) while
 * still doing zero I/O itself — the adapter reads the bytes, this function
 * only ever sees the resulting string.
 *
 * Rejects, each with a specific `RangeError`: invalid JSON; a non-object
 * top level; any field name outside {@link MANIFEST_KEYS}; a missing or
 * empty `id`; an `operators` array whose length is not exactly one, or
 * whose one entry is not a known {@link CorpusOperatorId}; an unknown or
 * missing `oracleKind`; a missing or empty `testEffect`/`productionEffect`;
 * a `testFile` that is missing, empty, or escapes its case directory; and a
 * `productionFiles` array that is empty or contains an invalid entry.
 */
export function parseCorpusCaseManifest(manifestJson: string): CorpusCaseManifest {
  const raw = parseManifestJson(manifestJson);
  const record = asManifestRecord(raw);

  const unknownKeys = Object.keys(record).filter((key) => !MANIFEST_KEY_SET.has(key));
  if (unknownKeys.length > 0) {
    fail(`Corpus case manifest declares unknown field(s): ${unknownKeys.join(', ')}`);
  }

  const id = requireId(record);
  const operator = requireOperator(record, id);
  const oracleKind = requireOracleKind(record, id);
  const testEffect = requireNonEmptyStringField(record, 'testEffect', id);
  const productionEffect = requireNonEmptyStringField(record, 'productionEffect', id);
  const testFile = requireSafeRelativePathField(record, 'testFile', id);
  const productionFiles = requireProductionFiles(record, id);

  return { id, operator, oracleKind, testEffect, productionEffect, testFile, productionFiles };
}

/**
 * Combines an already-validated {@link CorpusCaseManifest} with the actual
 * file bytes the adapter read for it into one immutable {@link CorpusCase},
 * assigning the single {@link CorpusCaseProofStatus} literal this module
 * ever produces. Pure data assembly plus one consistency check: the paths
 * the adapter says it read must be exactly the paths the manifest declared,
 * in the same order — a mismatch here means the adapter and the manifest
 * disagree about what this case even is, which must fail loudly rather than
 * silently pair a case with the wrong file.
 */
export function buildCorpusCase(
  manifest: CorpusCaseManifest,
  baseTest: CorpusSourceFile,
  productionSources: readonly CorpusSourceFile[],
): CorpusCase {
  if (baseTest.path !== manifest.testFile) {
    fail(`Corpus case "${manifest.id}" declares testFile "${manifest.testFile}" but received "${baseTest.path}"`);
  }

  const productionPaths = productionSources.map((source) => source.path);
  const pathsMatch = productionPaths.length === manifest.productionFiles.length
    && manifest.productionFiles.every((path, index) => productionPaths[index] === path);
  if (!pathsMatch) {
    fail(
      `Corpus case "${manifest.id}" declares productionFiles [${manifest.productionFiles.join(', ')}] `
      + `but received [${productionPaths.join(', ')}]`,
    );
  }

  return {
    id: manifest.id,
    operator: manifest.operator,
    oracleKind: manifest.oracleKind,
    testEffect: manifest.testEffect,
    productionEffect: manifest.productionEffect,
    baseTest,
    productionSources,
    proofStatus: 'unverified',
  };
}
