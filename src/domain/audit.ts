import type {
  ClassificationResult,
  OverallClassificationStatus,
} from './classification.js';
import type {
  ConfigurationOverrides,
  ResolvedConfiguration,
} from './config.js';
import type {
  DiscoveredTestFile,
  DiscoveryRequest,
  DiscoveryResult,
  ExcludedTestFile,
} from './discovery.js';
import type { DryRunSkippedReason, DryRunSkippedTotals } from './estimate.js';
import type {
  TestExtractionRequest,
  TestExtractionResult,
} from './extraction.js';
import type {
  Diagnostic,
  DynamicMetadata,
  TestCase,
  TestCaseId,
  TestFramework,
} from './test-understanding.js';
import type { EvidenceBudget, EvidenceBundle } from './evidence.js';
import type { JevEvaluation } from './jev-gateway.js';

export interface SourceReadRequest {
  readonly rootDir: string;
  readonly repositoryRelativePath: string;
}

export interface AuditDiscoveryPort {
  discover(request: DiscoveryRequest): Promise<DiscoveryResult>;
}

export interface AuditSourceReaderPort {
  read(request: SourceReadRequest): Promise<string>;
}

export interface AuditExtractorPort {
  extract(request: TestExtractionRequest): TestExtractionResult;
}

/**
 * `odd/tasks/jest-ambient-globals.md`: a fallback framework hint, consulted
 * only for a file whose discovery-level attribution is `'unknown'` — e.g.
 * ambient-global Jest specs (`describe`/`it`/`expect` with no
 * `@jest/globals` import, NestJS's standard setup) whose file imports
 * `frameworkForModule` (`src/adapters/test-extraction.ts`) can never
 * attribute anything from. `resolve` reads the project's OWN configuration
 * (the nearest `package.json`'s `jest` key, its `"test"` script, or a
 * `jest.config.*` file's presence — see
 * `src/adapters/jest-project-config.ts`) rather than the file's contents,
 * so it takes only the repository-relative path, not source text.
 */
export interface AuditJestFrameworkHintPort {
  resolve(repositoryRelativePath: string): Promise<Exclude<TestFramework, 'unknown'> | undefined>;
}

export interface AuditEvidenceBuildRequest {
  readonly rootDir: string;
  readonly repositoryRelativePath: string;
  /** Full source text of the file, already read once by {@link AuditSourceReaderPort}; the evidence port never re-reads the test file itself. */
  readonly sourceText: string;
  readonly testCases: readonly TestCase[];
  readonly budget: EvidenceBudget;
  /** Additive deny patterns, layered on top of the resolver's own always-applied defaults. */
  readonly deny: readonly string[];
}

export interface AuditEvidenceBuildResult {
  /**
   * One bundle per SUCCESSFULLY selected test case, in `request.testCases`
   * relative order; callers match a bundle to its test case by
   * `bundle.testCaseId`, not by array position, since a failed selection
   * contributes no entry here at all.
   */
  readonly bundles: readonly EvidenceBundle[];
  /**
   * One `evidence-selection-failed` diagnostic per test case whose
   * selection failed, naming that test case's id and name. Uncertainty is
   * not quality: a failed selection is never represented as an empty (or
   * otherwise placeholder) bundle indistinguishable from "this test
   * genuinely has no supporting evidence" — it is reported here instead,
   * and simply produces no bundle.
   */
  readonly diagnostics: readonly Diagnostic[];
}

export interface AuditEvidencePort {
  /**
   * Builds evidence for `request.testCases`. Never called for a file with
   * zero test cases. See {@link AuditEvidenceBuildResult} for how success
   * and per-test-case failure are represented.
   */
  build(request: AuditEvidenceBuildRequest): Promise<AuditEvidenceBuildResult>;
}

/** One evaluable test case and its evidence, ready to be judged (Phase 4, task P4-4). */
export interface AuditEvaluationRequest {
  readonly testCase: TestCase;
  readonly bundle: EvidenceBundle;
}

/**
 * The result of one evaluation call (Phase 5, task P5-1): the raw, normalized
 * {@link JevEvaluation} the gateway returned, alongside the already-derived
 * {@link ClassificationResult}. Kept together — rather than only the
 * classification, as Phase 4 shipped — so a caller (`runAudit`) can persist
 * both the raw answers and the normalized judgment (Phase 5 Scope: "Persist
 * ... attempts, raw answers, normalized judgments") without a second Jev
 * call; `ClassificationResult`'s own doc in `src/domain/classification.ts`
 * notes exactly this: "raw answers ... remain available to the caller, so a
 * future policy version can recompute this result without another Jev call."
 */
export interface AuditEvaluationOutcome {
  readonly evaluation: JevEvaluation;
  readonly classification: ClassificationResult;
}

/**
 * The Jev evaluation port (Phase 4, task P4-4; widened by Phase 5, task
 * P5-1 to also return the raw {@link JevEvaluation} — see
 * {@link AuditEvaluationOutcome}): builds the request, calls the gateway,
 * and classifies the result for exactly one evaluable test case. Production
 * is `src/adapters/jev-evaluation-port.ts`, composing `buildJevRequest`, a
 * `JevGatewayPort`, and `classifyEvaluation` over the shipped
 * `RUBRIC_V2`/`CLASSIFICATION_POLICY_V3`.
 *
 * **This port is the entire opt-in gate.** `runAudit` (see {@link AuditPorts.evaluation})
 * evaluates every evaluable test case if and only if this port is present on
 * `AuditPorts`; when it is `undefined`, evaluation is skipped entirely —
 * `runAudit` never constructs a gateway, reads an API key, or reaches the
 * network on its own. The CLI composition root is responsible for
 * constructing this port lazily, only when `--evaluate` was actually
 * requested (`createJevHttpGateway` validates the API key eagerly, so
 * constructing it unconditionally would turn every offline run into a
 * configuration error).
 *
 * A rejected promise from `evaluate` is a single test case's failure, never
 * the whole run's: `runAudit` isolates it into one `evaluation-failed`
 * diagnostic naming the test case id and the error's typed kind (never the
 * API key or the request body) and simply records no classification for
 * that test case — uncertainty is not quality, so a failure is never
 * represented as a fabricated verdict.
 */
export interface AuditEvaluationPort {
  evaluate(request: AuditEvaluationRequest): Promise<AuditEvaluationOutcome>;
}

/**
 * The content-addressed cache key port (Phase 5, task P5-2). Computes the
 * deterministic key that identifies "evaluating this exact test case
 * against this exact evidence, full source, and rubric" — see
 * `src/adapters/cache-key.ts`'s own doc for precisely which of
 * `request`/`fullTestSource` the composed key covers and how. Optional on
 * {@link AuditPorts}, exactly like {@link AuditEvaluationPort} and
 * {@link AuditStorePort}: caching only matters when both this port and a
 * `store` are present, and the CLI composition root always constructs them
 * together (see `src/cli/index.ts`'s `createProductionPorts`) — never one
 * without the other in production. No I/O, no state; safe to call any
 * number of times.
 */
export interface AuditCacheKeyPort {
  computeKey(request: AuditEvaluationRequest, fullTestSource: string): string;
  /**
   * Classifies a cache hit's stored raw answers under the CURRENT
   * classification policy (`odd/tasks/policy-free-cache-and-calibration.md`,
   * task T1): the policy is deliberately not part of the key, so a policy
   * change re-derives every hit locally and never causes a provider request.
   * Pure and local; `request` supplies the identity the result reports.
   */
  classifyCached(request: AuditEvaluationRequest, evaluation: JevEvaluation): ClassificationResult;
}

/**
 * The seven work-item states persistence recognizes (Phase 5, task P5-1;
 * `odd/tasks/phase-5-persistence.md` Decisions: "Work-item states are the
 * design's seven"). Only `completed` and a valid `cached` judgment
 * participate in quality classification. Task P5-1 itself only ever
 * produced `completed`, `failed`, and `skipped` records; task P5-2 adds
 * `cached`, produced exactly once — on a cache hit (see
 * {@link AuditStorePort.lookup}) — and never anywhere else. Task P5-3 adds
 * `pending` (recorded up front for every evaluable work item, before the
 * scheduler dispatches anything) and `running` (recorded the moment the
 * scheduler picks that item up) — the two non-terminal checkpoints a later
 * phase's `--resume <runId>` reads back to compute the outstanding set; see
 * {@link AuditStoreWorkItemOutcome}'s own doc.
 * `uncertain` is admitted by the type (and the adapter's schema `CHECK`
 * constraint) for forward compatibility only: nothing in this codebase
 * produces it as of task P5-2, and no semantics are defined for it here —
 * a later phase that wants to produce it must define what it means before
 * doing so. All seven are admitted from the start so a later phase never
 * needs a backward-incompatible migration just to widen the set.
 */
export const WORK_ITEM_STATES = ['pending', 'running', 'completed', 'cached', 'uncertain', 'skipped', 'failed'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** Identifies the work item a persisted record belongs to, independent of run or state. */
export interface AuditStoreWorkItemIdentity {
  readonly testCaseId: TestCaseId;
  readonly repositoryRelativePath: string;
  readonly name: string;
}

/**
 * One work-item outcome to persist. Four are terminal — carried over from
 * Phase 5, task P5-1/P5-2: a `completed` outcome carries both the raw
 * {@link JevEvaluation} and the already-derived {@link ClassificationResult}
 * (see {@link AuditEvaluationOutcome}'s own doc for why both are kept); a
 * `failed` outcome carries the same typed error kind and message `runAudit`
 * already reports in an `evaluation-failed` diagnostic
 * (`src/application/audit.ts`); a `skipped` outcome carries the same
 * {@link DryRunSkippedReason} `classifyTestCase` (`src/domain/estimate.ts`)
 * already produces; a `cached` outcome carries the exact `cacheKey` that
 * hit and the reused {@link ClassificationResult} — never a fresh
 * {@link JevEvaluation}, since no provider request was made.
 *
 * `pending` and `running` (Phase 5, task P5-3) are the two non-terminal
 * checkpoints: `pending` is recorded for every evaluable work item up
 * front, before the scheduler dispatches anything at all, and `running` is
 * recorded the moment the scheduler actually picks that item up — both
 * carry only {@link AuditStoreWorkItemIdentity}, nothing else, since
 * neither represents a fact about how the item resolved. Together with the
 * terminal states, they make the run's *intended* work durable, not only
 * its *finished* work: a process killed mid-run leaves every item it never
 * reached with only a `pending` row (never started) or a `running` row
 * (in flight when the process died), which a later phase (P5-4,
 * `--resume <runId>`) reads back to compute the outstanding set — every
 * work item under a run id whose most recently recorded state is `pending`
 * or `running` rather than one of the four terminal states. Appending a
 * `pending`/`running` row is exactly like every other write here: it never
 * updates or deletes an earlier row for the same work item, so the
 * complete `pending` → `running` → terminal trail (or a shorter one, for
 * whichever point a crash landed on) is always the full, honest history —
 * never rewritten to look as if the crash never happened.
 *
 * `uncertain` is not constructed anywhere in this codebase — see
 * {@link WorkItemState}'s own doc. `completed`'s own `cacheKey` is
 * optional, not because a real evaluation lacks one, but so a caller that
 * never wires {@link AuditCacheKeyPort} (or a pre-P5-2 test fixture) still
 * compiles and persists exactly as before — see {@link AuditStorePort.lookup}'s
 * own doc for why an absent key simply means "can never be found again,"
 * never a silent behavior change.
 */
export type AuditStoreWorkItemOutcome =
  | {
    readonly state: 'pending';
    readonly identity: AuditStoreWorkItemIdentity;
  }
  | {
    readonly state: 'running';
    readonly identity: AuditStoreWorkItemIdentity;
  }
  | {
    readonly state: 'completed';
    readonly identity: AuditStoreWorkItemIdentity;
    readonly cacheKey?: string;
    readonly evaluation: JevEvaluation;
    readonly classification: ClassificationResult;
  }
  | {
    readonly state: 'cached';
    readonly identity: AuditStoreWorkItemIdentity;
    readonly cacheKey: string;
    readonly classification: ClassificationResult;
  }
  | {
    readonly state: 'failed';
    readonly identity: AuditStoreWorkItemIdentity;
    readonly errorKind: string;
    readonly errorMessage: string;
  }
  | {
    readonly state: 'skipped';
    readonly identity: AuditStoreWorkItemIdentity;
    readonly reason: DryRunSkippedReason;
  };

/**
 * One cache hit returned by {@link AuditStorePort.lookup}: the original
 * provider response's raw {@link JevEvaluation}, exactly as stored — never
 * the classification recorded alongside it, which may have been derived
 * under an older policy. The caller re-classifies it under the current policy
 * ({@link AuditCacheKeyPort.classifyCached}); a cache hit itself makes no
 * provider request.
 */
export interface AuditStoreCachedJudgment {
  readonly evaluation: JevEvaluation;
}

/**
 * The audit persistence port (Phase 5, task P5-1): append-only storage for
 * one audit run's work-item outcomes, behind a port so the domain and
 * application layers never import the `node:sqlite` adapter
 * (`src/adapters/sqlite-audit-store.ts`) directly. Optional on
 * {@link AuditPorts}, constructed lazily by the CLI exactly like
 * {@link AuditEvaluationPort} — see `AuditPorts.store`'s own doc for the
 * full opt-in contract: an offline audit without `--evaluate` must never
 * construct this port, read a database file, or create one.
 *
 * `beginRun`/`finishRun` bracket exactly one audit run; `recordWorkItem` is
 * called once per work item reaching a terminal state, and (Phase 5, task
 * P5-3) once more each time that same work item passes through a
 * non-terminal checkpoint (`pending`, then `running`) on its way there —
 * see {@link AuditStoreWorkItemOutcome}'s own doc for why. Every method is
 * append-only: no method here updates or deletes a previously written run,
 * work item, attempt, judgment, or error record. (`finishRun` sets the run's
 * own `finished_at` marker exactly once — completing that run's own record,
 * never rewriting a fact already recorded about a work item.)
 */
export interface AuditStorePort {
  /** Starts a new run record for `rootDir` and returns its generated run id. */
  beginRun(rootDir: string): Promise<string>;
  /**
   * Canonicalizes `rootDir` into the absolute, symlink-resolved identity
   * this port uses to recognize "the same repository" (defect fix, Phase 5,
   * 2026-09-20): resolves `rootDir` against the current working directory
   * when it is relative, then follows symlinks — the identical convention
   * `discoverTestFiles`/`readSourceFile` already apply to the audited root
   * (`src/adapters/repository-discovery.ts`, `src/adapters/source-reader.ts`),
   * needed here for the same reason: a repository is routinely reached
   * through a symlinked ancestor (this project's own dev machine confirmed
   * macOS's `/var` is one), so two different-looking paths to the same
   * directory must canonicalize identically.
   *
   * The application layer canonicalizes with this method BEFORE calling
   * {@link beginRun} (never inside it — `beginRun`'s own contract is
   * unchanged: it stores exactly the string it is given), and again before
   * comparing a `--resume` request's `rootDir` against a previously
   * recorded {@link AuditStoreRunState.rootDir} — always canonicalizing at
   * the moment a value is persisted or freshly supplied, never by
   * re-interpreting an already-stored value later (see
   * {@link AuditStoreRunState.rootDirCanonical}'s own doc for why that
   * distinction matters).
   *
   * Never throws: a `rootDir` that cannot be realpath'd (does not exist, or
   * is not yet reachable) falls back to its plain resolved form, so a
   * `--resume` preflight against a mistyped or since-deleted root still
   * compares (and fails with a named, visible mismatch) rather than
   * crashing this check with a raw filesystem error before discovery ever
   * gets a chance to report the same problem its own, already-established
   * way.
   *
   * Filesystem I/O — reachable only through this port so neither the
   * domain nor the application layer ever touches the filesystem directly.
   */
  canonicalizeRootDir(rootDir: string): Promise<string>;
  /** Persists one work-item outcome for `runId` — terminal or one of the two non-terminal checkpoints (`pending`, `running`; Phase 5, task P5-3) — atomically (all-or-nothing): a failure here leaves no partial record. */
  recordWorkItem(runId: string, outcome: AuditStoreWorkItemOutcome): Promise<void>;
  /**
   * Looks up the cached judgment for `cacheKey` (Phase 5, task P5-2).
   *
   * **Lookup rule, when one key has several results** (append-only plus
   * `--fresh` means a single key can accumulate more than one `completed`
   * judgment over time): returns the most recent `completed` work item
   * recorded under this exact key whose attempt's `model.matchesPin` was
   * `true` — "most recent" meaning highest `work_items.id` (insertion
   * order), never `recorded_at`, which is a millisecond-resolution ISO
   * string that can collide under a fast run. A model mismatch is not a
   * trustworthy judgment to serve silently as a cache hit, so a
   * pin-mismatched row is skipped in favor of an older pin-matched one;
   * with no pin-matched row at all, this is a miss (`undefined`).
   *
   * A `cached` work item's own judgment is never itself eligible as a
   * source for a later lookup — only `completed` rows are — so every hit
   * traces back to exactly one real provider response, never a cache hit
   * of a cache hit.
   *
   * A `completed` row recorded with no `cacheKey` (see
   * {@link AuditStoreWorkItemOutcome}'s own doc on why that field is
   * optional there) can never be a hit: the underlying comparison never
   * matches a stored `NULL`, by construction, not by an extra filter this
   * method has to remember to apply.
   *
   * Returns `undefined` on a miss.
   */
  lookup(cacheKey: string): Promise<AuditStoreCachedJudgment | undefined>;
  /** Marks `runId` finished. */
  finishRun(runId: string): Promise<void>;
  /**
   * Loads the durable state of a previously started run (Phase 5, task
   * P5-4, `--resume <runId>`): `undefined` when no run with `runId` exists
   * at all — a distinct, visible error at the caller (see
   * `AuditResumeRunNotFoundError`), never confused with "a run that exists
   * but has nothing outstanding." See {@link AuditStoreRunState}'s own doc
   * for exactly what `terminalWorkItems` does (and does not) include.
   */
  loadRunState(runId: string): Promise<AuditStoreRunState | undefined>;
  /** Releases the underlying database handle. Safe to call once, after every other call for this store has settled. */
  close(): Promise<void>;
}

/**
 * The durable state of one previously started run (Phase 5, task P5-4),
 * read back for `--resume <runId>`.
 *
 * `terminalWorkItems` holds exactly one {@link AuditStoreWorkItemOutcome}
 * per work-item identity that has at least one recorded row under this
 * run: the identity's LAST recorded row (highest `work_items.id`,
 * insertion order — never `recorded_at`, for the same collision reason
 * `AuditStorePort.lookup`'s own doc gives), and only when that last row's
 * state is one of the four terminal states (`completed`, `cached`,
 * `failed`, `skipped`). An identity whose last row is `pending`/`running`,
 * or that has no row at all under this run, is never included here — it is
 * exactly the run's *outstanding* set, and this port deliberately does not
 * compute that set itself: the caller (`runAudit`, `src/application/audit.ts`)
 * is the one that already knows which identities are currently evaluable
 * (or skippable) at all, so "outstanding" is "currently relevant and NOT
 * in this list," decided there, not duplicated here.
 */
export interface AuditStoreRunState {
  /** The root directory this run was originally started against (`AuditStorePort.beginRun`'s own argument) — compared by the caller against the root being audited now, so a run recorded for one repository is never silently resumed against another. */
  readonly rootDir: string;
  /**
   * Whether `rootDir` above is already in the canonical (absolute) form
   * {@link AuditStorePort.canonicalizeRootDir} produces (defect fix, Phase
   * 5, 2026-09-20) — `true` for every run started after this fix shipped,
   * since the application layer now always canonicalizes before calling
   * `beginRun`. `false` marks a run recorded before this fix (most
   * commonly the "." default, or any relative `--rootDir`): re-resolving
   * that raw string now would resolve it against THIS process's current
   * working directory, not the one the original run actually audited — an
   * entirely different, silently wrong answer — so `preflightResume`
   * refuses to compare it at all and reports `AuditResumeLegacyRootDirError`
   * instead of guessing.
   *
   * This is a necessary, not sufficient, test for "genuinely canonical": a
   * pre-fix run whose `--rootDir` happened to already be an absolute path
   * reads as canonical here even though `beginRun` never realpath'd it —
   * that residual case falls through to an ordinary (still honest, still
   * visible) `AuditResumeRootDirMismatchError` rather than the legacy one
   * whenever it no longer matches the freshly canonicalized request, never
   * a silent accept.
   */
  readonly rootDirCanonical: boolean;
  /** Whether `finishRun` was ever called for this run. `true` implies (but is not the only way to reach) "nothing is outstanding" — every terminal work item a finished run could have is already reflected in `terminalWorkItems`; see this interface's own doc for why an unfinished run can independently have zero outstanding items too (a crash between the last item's terminal write and `finishRun` itself). */
  readonly finished: boolean;
  readonly terminalWorkItems: readonly AuditStoreWorkItemOutcome[];
}

export type AuditStoreErrorCode = 'schema-version' | 'corrupt';

abstract class AuditStoreErrorBase extends Error {
  abstract readonly code: AuditStoreErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The store's recorded schema version is newer than this build supports.
 * Never silently recreated and never migrated backwards (Phase 5 Scope: "A
 * corrupt or schema-incompatible store fails visibly with a named error").
 */
export class AuditStoreSchemaVersionError extends AuditStoreErrorBase {
  readonly code = 'schema-version' as const;
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(foundVersion: number, supportedVersion: number) {
    super(
      `Audit store schema version ${foundVersion} is newer than this build supports (up to version `
      + `${supportedVersion}). Refusing to migrate backwards or silently recreate the database; use a `
      + 'build that supports this schema version, or point the store at a fresh database file.',
    );
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}

/**
 * The database at the configured path cannot be treated as this adapter's
 * own audit store — never guessed at, never silently recreated or adopted.
 * Distinct from {@link AuditStoreSchemaVersionError}'s known-but-too-new
 * schema version, this covers every other way a store fails to open safely
 * (Phase 5, task P5-1 verifier finding B):
 *
 * - the store's own schema metadata exists but is missing, malformed, or
 *   otherwise not a recognized version record;
 * - the database already contains user tables but no `schema_meta` table —
 *   a foreign database belonging to another application, never silently
 *   adopted as a fresh audit store (a genuinely empty database, with no
 *   user tables at all, still migrates normally);
 * - the underlying native `node:sqlite` driver rejected the file outright
 *   (not a SQLite database, a directory where the file should be, a
 *   read-only file, or a foreign database whose table names collide with
 *   ours) — wrapped here so no raw `ERR_SQLITE_ERROR` ever escapes to a
 *   caller.
 */
export class AuditStoreCorruptError extends AuditStoreErrorBase {
  readonly code = 'corrupt' as const;

  constructor(detail: string) {
    super(`Audit store is corrupt, foreign, or otherwise unusable: ${detail}`);
  }
}

export type AuditStoreError = AuditStoreSchemaVersionError | AuditStoreCorruptError;

export type AuditResumeErrorCode = 'run-not-found' | 'root-dir-mismatch' | 'legacy-root-dir' | 'store-unavailable';

abstract class AuditResumeErrorBase extends Error {
  abstract readonly code: AuditResumeErrorCode;
  readonly runId: string;

  protected constructor(runId: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.runId = runId;
  }
}

/**
 * `--resume <runId>` (Phase 5, task P5-4) named `runId`, but no run with
 * that id exists in the audit store at all (`AuditStorePort.loadRunState`
 * returned `undefined`) — never silently started as a new run instead, and
 * never confused with {@link AuditResumeRootDirMismatchError} or "a run
 * that exists but is already finished" (not an error at all — see
 * `runAudit`'s own doc).
 */
export class AuditResumeRunNotFoundError extends AuditResumeErrorBase {
  readonly code = 'run-not-found' as const;

  constructor(runId: string) {
    super(runId, `--resume ${runId}: no run with this id exists in the audit store.`);
  }
}

/**
 * `--resume <runId>` named a run that exists, but was originally started
 * (`AuditStorePort.beginRun`) against a different root directory than the
 * one being audited now — never silently resumed against the wrong
 * repository's recorded work items.
 */
export class AuditResumeRootDirMismatchError extends AuditResumeErrorBase {
  readonly code = 'root-dir-mismatch' as const;
  readonly recordedRootDir: string;
  readonly requestedRootDir: string;

  constructor(runId: string, recordedRootDir: string, requestedRootDir: string) {
    super(
      runId,
      `--resume ${runId}: this run was recorded against root "${recordedRootDir}", not "${requestedRootDir}" being audited now.`,
    );
    this.recordedRootDir = recordedRootDir;
    this.requestedRootDir = requestedRootDir;
  }
}

/**
 * `--resume <runId>` named a run recorded before this fix started
 * persisting a canonical (absolute, symlink-resolved) `rootDir` (defect
 * fix, Phase 5, 2026-09-20) — see {@link AuditStoreRunState.rootDirCanonical}'s
 * own doc for exactly what marks a run this way (most commonly the "."
 * default, or any relative `--rootDir`, recorded before this fix). Its
 * stored `rootDir` is not safely re-interpretable now: resolving it
 * against THIS process's current working directory would silently compare
 * against the wrong repository rather than the one the original run
 * actually audited, so this run cannot be resumed at all — never confused
 * with {@link AuditResumeRootDirMismatchError}'s genuine cross-repository
 * mismatch between two runs that are both already canonical.
 */
export class AuditResumeLegacyRootDirError extends AuditResumeErrorBase {
  readonly code = 'legacy-root-dir' as const;
  readonly recordedRootDir: string;

  constructor(runId: string, recordedRootDir: string) {
    super(
      runId,
      `--resume ${runId}: this run predates canonical root-directory recording (its recorded root `
      + `"${recordedRootDir}" is not an absolute path) and cannot be safely resumed; re-run the audit `
      + 'without --resume to start fresh.',
    );
    this.recordedRootDir = recordedRootDir;
  }
}

/**
 * `--resume <runId>` was requested but no {@link AuditStorePort} is
 * available to resume from at all — defensive: the CLI itself never
 * reaches `runAudit` in this shape (`--resume` requires `--evaluate`, and
 * a successful `--evaluate` always constructs a store), but a direct
 * library caller could still pass `RunAuditOptions.resume` without a
 * store, and this is reported the same named way rather than throwing a
 * raw `TypeError` from an unguarded `ports.store!`.
 */
export class AuditResumeUnavailableError extends AuditResumeErrorBase {
  readonly code = 'store-unavailable' as const;

  constructor(runId: string) {
    super(runId, `--resume ${runId}: no audit store is available to resume from (requires --evaluate with a working audit store).`);
  }
}

export type AuditResumeError = AuditResumeRunNotFoundError | AuditResumeRootDirMismatchError | AuditResumeLegacyRootDirError | AuditResumeUnavailableError;

/**
 * `--cache-only` (`RunAuditOptions.cacheOnly`, `odd/tasks/cache-only-evaluation.md`) was requested
 * but no working content-addressed cache is available to serve it from — {@link AuditPorts.store}
 * or {@link AuditPorts.cacheKey} is missing, so there is nowhere to look an evaluable test case's
 * key up in at all. Refused visibly, exactly like {@link AuditResumeUnavailableError}, rather than
 * silently reporting every evaluable test case as "not in cache" — a result that would be
 * indistinguishable from an honestly cold cache and could mislead a reader into thinking nothing
 * was ever judged. Production CLI wiring (`--evaluate --cache-only`) always constructs a store and
 * a cache-key port together whenever `--evaluate` is used — see `runCli` — so this is reachable
 * only through a direct library caller that omits one or both.
 */
export class AuditCacheOnlyUnavailableError extends Error {
  readonly code = 'cache-only-unavailable' as const;

  constructor() {
    super(
      '--cache-only requires a working audit store and a content-addressed cache-key port '
      + '(pass --evaluate with caching enabled; --cache-only has nothing to serve without one).',
    );
    this.name = new.target.name;
  }
}

/**
 * `--resume <runId>`'s own summary of one audit run (Phase 5, task P5-4),
 * present on {@link AuditResult} only when `RunAuditOptions.resume` was
 * used. `outstanding` is how many currently evaluable work items were NOT
 * already terminal under this run id (the ones this call actually
 * dispatched, or would have — `0` for the `nothingOutstanding` case);
 * `reused` is how many were already terminal and were reused as-is,
 * without a new provider request. `nothingOutstanding` is `true` in
 * exactly two cases, both reported identically to the caller: the run was
 * already finished (`AuditStoreRunState.finished`), diagnosed before any
 * discovery ran at all; or discovery ran and found zero outstanding items
 * anyway (a crash between the last item's terminal write and `finishRun`
 * itself — see {@link AuditStoreRunState.finished}'s own doc). Neither is
 * an error: see `runAudit`'s own doc.
 */
export interface AuditResumeSummary {
  readonly runId: string;
  readonly outstanding: number;
  readonly reused: number;
  readonly nothingOutstanding: boolean;
}

/**
 * Terminal-progress checkpoint states (Phase 6, task P6-3): the same six states
 * `AuditStoreWorkItemOutcome`/`recordWorkItem` ever actually produces — `uncertain` is excluded
 * here too, for the identical reason {@link WorkItemState}'s own doc gives (nothing in this
 * codebase constructs it, and no semantics are defined for it). Derived from {@link WorkItemState}
 * with `Exclude`, rather than a second hand-written literal union, so a future phase that ever
 * does wire up `uncertain` is forced to decide what a progress reporter does with it instead of
 * silently falling outside this type's coverage.
 *
 * `'not-cached'` (`odd/tasks/cache-only-evaluation.md`) is added on top of that `Exclude`, not
 * folded into it: it is a real terminal transition a `--cache-only` run reports to
 * {@link AuditProgressPort.report}, but it is deliberately NOT one of {@link WORK_ITEM_STATES} —
 * see {@link AuditStoreWorkItemOutcome}'s own doc — since a cache-only miss is never persisted to
 * the store at all (progress describes what this run is doing, not what gets persisted; see
 * {@link AuditProgressPort}'s own doc).
 */
export type AuditProgressState = Exclude<WorkItemState, 'uncertain'> | 'not-cached';

/**
 * One per-item checkpoint transition, reported to {@link AuditProgressPort.report} at exactly the
 * same call sites `AuditStorePort.recordWorkItem` is called from `runEvaluation`
 * (`src/application/audit.ts`) — see that port's own doc for why the two are wired independently
 * rather than one depending on the other. `concurrencyLimit` is the adaptive scheduler's own
 * `AdaptiveConcurrencyController.limit` (`src/domain/scheduler.ts`) read at the exact moment this
 * transition is reported — P5-3 makes it change mid-run (halving on an observed throttle,
 * restoring by one step after a clean-dispatch streak), so a reporter that surfaces it can explain
 * a run visibly slowing down without a second call. Because `controller.report(signal)` is only
 * applied by `runAdaptiveSchedule` (`src/application/scheduler.ts`) AFTER a worker's own promise
 * settles, a throttled dispatch's own terminal event still carries the PRE-reduction limit; the
 * reduction is visible starting with the next item's own `running` event, never retroactively on
 * an event already reported.
 */
export interface AuditProgressEvent {
  readonly state: AuditProgressState;
  readonly identity: AuditStoreWorkItemIdentity;
  readonly concurrencyLimit: number;
}

/**
 * The terminal-progress reporting port (Phase 6, task P6-3): notified of every per-item checkpoint
 * transition `runEvaluation` reaches, in real completion order under concurrency — never sorted,
 * batched, or deferred to the end of the run. Optional on {@link AuditPorts}, exactly like
 * `evaluation`/`store`/`cacheKey`, but deliberately independent of `store`: progress describes
 * what THIS RUN is doing, not what gets persisted, so a run with no store wired still reports
 * every transition exactly as if one were present, and a store failing to open or simply never
 * being requested never silences progress. The domain stays free of I/O — this is a port
 * (interface) declared here exactly like every other `AuditPorts` member; the adapter that
 * actually writes anywhere (`src/adapters/terminal-progress-reporter.ts`) lives outside the
 * domain and application layers, and the CLI composition root (`src/cli/index.ts`) is the only
 * place that constructs one for real.
 */
export interface AuditProgressPort {
  /**
   * Called exactly once per run, before any {@link report} call, naming how many work items will
   * reach a terminal state THIS run — newly recorded skips plus currently outstanding items; an
   * already-terminal item reused on `--resume <runId>` is never redispatched and never reported
   * again, so it is deliberately excluded from this count (never `items.length` unconditionally).
   * A reporter needs no separate call to learn its own denominator for "N of TOTAL done."
   */
  begin(total: number): void;
  /** Called once per checkpoint transition — see {@link AuditProgressEvent}'s own doc. */
  report(event: AuditProgressEvent): void;
  /**
   * Opt-in (T3, `odd/tasks/audit-run-responsiveness.md`): pre-dispatch phase milestones, called
   * zero or more times BEFORE {@link begin} — discovery, extraction/evidence selection, and (only
   * when caching is enabled) the transition into cache-aware dispatch. Optional so every existing
   * `AuditProgressPort` implementation (a test double with only `begin`/`report`) keeps satisfying
   * this interface unchanged. See {@link AuditPrePhaseEvent}'s own doc for exactly what fires when,
   * and `runAudit`/`runEvaluation` (`src/application/audit.ts`) for the throttling rule that keeps
   * this from flooding a large suite's output.
   */
  phase?(event: AuditPrePhaseEvent): void;
}

/**
 * Pre-dispatch phase labels (T3, `odd/tasks/audit-run-responsiveness.md`): what `runAudit` is
 * doing before `AuditProgressPort.begin` ever fires, so a long run shows SOMETHING from its first
 * second instead of 15–20s of silence on a large suite. `'discovering'` fires once, before
 * `AuditDiscoveryPort.discover` is even called (nothing is known yet — no `done`/`total`).
 * `'extracting'` fires per-file, throttled, while `runAudit` reads/extracts/selects evidence for
 * each discovered file — `done`/`total` are FILES processed so far / total files, `testCases` is
 * the cumulative test-case count extracted so far; extraction and evidence selection are reported
 * as one combined phase (not two alternating ones) since they happen back-to-back for the same
 * file in the same loop iteration — see `runAudit`'s own comment for why splitting them would only
 * flicker a TTY line and double a non-TTY log for no benefit. `'checking-cache'` fires at most
 * once, immediately before `begin`, only when content-addressed caching is actually enabled for
 * this run (a store, a run id, and a cache-key port are all present) — otherwise nothing would be
 * checked, and this phase never fires.
 */
export type AuditPrePhase = 'discovering' | 'extracting' | 'checking-cache';

export interface AuditPrePhaseEvent {
  readonly phase: AuditPrePhase;
  /** Files processed so far — only ever present for `'extracting'`. */
  readonly done?: number;
  /** Total files to process — only ever present for `'extracting'`, once discovery has completed. */
  readonly total?: number;
  /** Cumulative test cases extracted so far — only ever present for `'extracting'`. */
  readonly testCases?: number;
}

export interface AuditPorts {
  readonly discovery: AuditDiscoveryPort;
  readonly sourceReader: AuditSourceReaderPort;
  readonly extractor: AuditExtractorPort;
  readonly evidence: AuditEvidencePort;
  /** Opt-in (Phase 4, task P4-4): see {@link AuditEvaluationPort}'s own doc for the full opt-in contract. */
  readonly evaluation?: AuditEvaluationPort;
  /** Opt-in (Phase 5, task P5-1): see {@link AuditStorePort}'s own doc for the full opt-in contract. */
  readonly store?: AuditStorePort;
  /** Opt-in (Phase 5, task P5-2): see {@link AuditCacheKeyPort}'s own doc for the full opt-in contract. */
  readonly cacheKey?: AuditCacheKeyPort;
  /** Opt-in (Phase 6, task P6-3): see {@link AuditProgressPort}'s own doc for the full opt-in contract — deliberately independent of `store`. */
  readonly progress?: AuditProgressPort;
  /** Opt-in (`odd/tasks/jest-ambient-globals.md`): see {@link AuditJestFrameworkHintPort}'s own doc for the full opt-in contract. Absent in a caller with no reason to read project config (most test doubles); `runAudit` behaves exactly as before when this is `undefined`. */
  readonly jestFrameworkHint?: AuditJestFrameworkHintPort;
}

export type AuditRequest = ResolvedConfiguration;

export interface AuditFileResult {
  readonly discovered: DiscoveredTestFile;
  readonly testCases: readonly TestCase[];
  readonly dynamicMetadata: readonly DynamicMetadata[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * One bundle per successfully selected test case (matched by
   * `bundle.testCaseId`, not position — see {@link AuditEvidenceBuildResult}).
   * Empty when there are no test cases, every test case's selection failed
   * (see `evidence-selection-failed` diagnostics), or the whole file's
   * evidence build failed (see the `evidence-failed` diagnostic).
   */
  readonly evidence: readonly EvidenceBundle[];
}

export interface AuditDiagnostic extends Diagnostic {
  readonly repositoryRelativePath?: string;
}

export interface AuditTotals {
  readonly files: number;
  readonly excluded: number;
  readonly testCases: number;
  readonly dynamicMetadata: number;
  readonly diagnostics: number;
  /**
   * Count of files carrying an `unsupported-framework` diagnostic (B-1,
   * `odd/tasks/bun-test-support.md`): a discovered, included test file
   * whose framework could not be attributed and that produced zero test
   * cases. Reported explicitly so a reader sees this without reading every
   * diagnostic record — the same silence the diagnostic itself exists to
   * prevent must not reappear one level up in the totals.
   */
  readonly unsupportedFrameworkFiles: number;
  readonly evidenceBundles: number;
  readonly evidenceFragments: number;
  readonly evidenceTruncatedFragments: number;
  readonly evidenceOmitted: number;
  readonly evidenceDenied: number;
  readonly evidenceUnresolved: number;
}

/**
 * Evaluation totals (Phase 4, task P4-4; `cached` added by Phase 5, task
 * P5-2). `evaluated`, `cached`, `failed`, and `skipped` always sum to the
 * total number of test cases `classifyTestCase` (see
 * `src/domain/estimate.ts`) considered across the whole run: `skipped` is
 * never evaluated at all (a static `skip`/`todo` modifier or no built
 * evidence bundle); `failed` was attempted but its gateway call or
 * classification threw; `evaluated` made a fresh provider request that
 * succeeded; `cached` made no provider request at all, reusing a judgment
 * already recorded under that content-addressed key (see
 * `AuditStorePort.lookup`). Both `evaluated` and `cached` test cases have a
 * {@link ClassificationResult} in `classifications` and participate
 * identically in `statusCounts`/`respondedModel`/`modelMismatches` below
 * (Phase 5 Decisions: "Only `completed` and valid `cached` judgments
 * participate in quality classification") — only `usage` treats them
 * differently: a cache hit's `classification.usage` reflects the ORIGINAL
 * evaluation's cost, not a fresh spend, so it is deliberately excluded from
 * `usage` here to keep that field meaning "what this run actually billed."
 * `modelMismatches` counts every evaluated-or-cached test case whose
 * `model.matchesPin` is `false` — the verified provider contract requires
 * this to be reported, never hidden (Phase 4 Scope), and a single "first
 * success" `respondedModel` alone would silently hide a mismatch on a
 * later call.
 *
 * **`--cache-only` (`odd/tasks/cache-only-evaluation.md`)** widens this invariant rather than
 * breaking it: under `RunAuditOptions.cacheOnly`, `evaluated` and `failed` are always `0` (nothing
 * is ever dispatched, so nothing can succeed or fail as a fresh provider call), and `notCached`
 * takes the place a dispatch-and-fail outcome would otherwise have occupied — `evaluated + cached +
 * (notCached ?? 0) + failed + skipped.total` always equals the run's total considered test cases.
 */
export interface AuditEvaluationTotals {
  readonly evaluated: number;
  /** Test cases served from the content-addressed cache this run, at zero provider cost (Phase 5, task P5-2). Always `0` when caching is not wired (see {@link AuditPorts.cacheKey}). */
  readonly cached: number;
  /**
   * Evaluable test cases considered under `--cache-only` whose content-addressed key was NOT found
   * in the store — never dispatched, never counted as `failed` (`odd/tasks/cache-only-evaluation.md`:
   * "cache misses are not counted as failed and appear under the new not-in-cache count"). Present
   * (even as `0`) only when this run actually used `--cache-only`; genuinely absent — never a
   * fabricated `0` — for an ordinary run, matching this project's established convention for
   * "genuinely absent" fields (e.g. {@link TestCaseLatency.attemptLatenciesMs}). Always additive:
   * `docs/report-schema.json`/`REPORT_JSON_SCHEMA` never required it, so an older persisted report
   * (predating this field) still validates.
   */
  readonly notCached?: number;
  readonly failed: number;
  readonly skipped: DryRunSkippedTotals;
  /** Tokens actually spent by THIS run's fresh provider requests only — never includes a cache hit's reused `classification.usage` (see this interface's own doc). */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly statusCounts: Readonly<Record<OverallClassificationStatus, number>>;
  /** The `model.responded` of the first successful-or-cached evaluation, in submission order; `undefined` when none succeeded. Not a claim that every evaluation responded with the same model — see `modelMismatches`. */
  readonly respondedModel: string | undefined;
  readonly modelMismatches: number;
}

/**
 * The full evaluation outcome for one audit run (Phase 4, task P4-4).
 * `classifications` holds one entry per successfully evaluated test case,
 * in the same deterministic file-then-test-case order as `AuditResult.files`
 * regardless of which gateway call actually completed first (see
 * `runAdaptiveSchedule` in `src/application/scheduler.ts`, Phase 5, task
 * P5-3 — replacing Phase 4's fixed-size `runBoundedPool`) — never sorted or
 * reordered afterward, and never containing an entry for a failed or
 * skipped test case.
 */
/**
 * Per-evaluable-test-case cache provenance (Phase 6, task P6-2): distinguishes a judgment served
 * from the content-addressed cache (`cached`) from one obtained by a fresh provider request this
 * run (`fresh`) from an evaluable test case that was dispatched but never produced a judgment at
 * all (`not-evaluated` — its evaluation call threw; see the `failed` `EvaluationOutcome` in
 * `src/application/audit.ts`'s `runEvaluation`). Never populated for a SKIPPED test case (`skip`/
 * `todo`/`evidence-unavailable`): those never reach `collectEvaluableItems`'s evaluable set at
 * all, so caching is not a meaningful question for them — see `AuditEvaluationTotals.skipped` for
 * that count instead. Run-level `AuditEvaluationTotals.cached` is the aggregate this map's
 * `'cached'` entries sum to; this map is what makes that count attributable to a specific test
 * case, which the run-level count alone cannot do.
 */
/**
 * `'not-cached'` (`odd/tasks/cache-only-evaluation.md`) is a fourth, distinct provenance: an
 * evaluable test case considered under `--cache-only` (`RunAuditOptions.cacheOnly`,
 * `src/application/audit.ts`) whose content-addressed key was never found in the store — never
 * dispatched (cache-only makes no provider request, ever) and never counted as `'not-evaluated'`,
 * which specifically means "dispatched and failed." See `AuditEvaluationTotals.notCached` for the
 * run-level aggregate this value sums to.
 */
export type TestCaseCacheStatus = 'cached' | 'fresh' | 'not-evaluated' | 'not-cached';

/**
 * One test case's measured latency for a FRESH dispatch this run (Phase 6, task P6-2) — never
 * populated for a cache hit (no provider request was made to measure) or a failed dispatch (no
 * evaluation ever completed to measure). Mirrors `JevEvaluation.latencyMs`/`attemptLatenciesMs`
 * (`src/domain/jev-gateway.ts`) exactly; `attemptLatenciesMs` is optional for the identical reason
 * that field is optional there (a resumed/reused `completed` item reconstructed from a pre-P6-1
 * store row never captured it — see `AuditStoreWorkItemOutcome`'s own doc).
 */
export interface TestCaseLatency {
  readonly latencyMs: number;
  readonly attemptLatenciesMs?: readonly number[];
}

export interface AuditEvaluationResult {
  readonly classifications: readonly ClassificationResult[];
  readonly totals: AuditEvaluationTotals;
  /**
   * One entry per evaluable test case this run considered (dispatched fresh, served from cache,
   * or attempted and failed) — see {@link TestCaseCacheStatus}'s own doc. Always present (an empty
   * map when evaluation ran but nothing was evaluable, e.g. every test case was skipped) so a
   * report builder never has to guess whether the absence of an entry means "not evaluable" or
   * "this run predates P6-2" — it always means the former.
   */
  readonly cacheStatusByTestCaseId: ReadonlyMap<TestCaseId, TestCaseCacheStatus>;
  /** One entry per test case whose judgment came from a genuinely fresh, successfully measured provider call this run — see {@link TestCaseLatency}'s own doc. */
  readonly latencyByTestCaseId: ReadonlyMap<TestCaseId, TestCaseLatency>;
}

export interface AuditResult {
  readonly rootDir: string;
  /**
   * This run's persisted identity (Phase 6, task P6-2b) — present whenever there is a durable run
   * to identify: a fresh, non-resumed `--evaluate` run with a store present (the exact id
   * {@link AuditStorePort.beginRun} minted, the same id every `recordWorkItem` call for this run
   * uses) or a resumed run, where it equals `resume.runId` below (a resumed run continues an
   * existing identity, it never mints a new one — `runAudit` never assigns the two independently).
   * `undefined` exactly when there is no persisted run to name: an offline audit (no
   * `--evaluate`), an `--evaluate` run with no store wired at all, or a run whose evaluation never
   * started at all (e.g. discovery failed before `ports.evaluation` was ever reached) — never a
   * fabricated placeholder id for any of those, matching this codebase's established convention
   * for "genuinely absent" (see e.g. {@link TestCaseLatency.attemptLatenciesMs}'s own doc). This is
   * what lets a canonical report (`src/domain/report.ts`'s `buildAuditReport`) be traced back to
   * the store it was persisted under, and correlated with a later `--resume`, without a separate
   * `reports` lookup table — the gap the Phase 5 implementation plan left open, closed by this
   * field rather than by that table (see the Phase 6 feature document's own decision record).
   */
  readonly runId?: string;
  readonly files: readonly AuditFileResult[];
  readonly excluded: readonly ExcludedTestFile[];
  readonly diagnostics: readonly AuditDiagnostic[];
  readonly totals: AuditTotals;
  readonly reportingOnly: true;
  /** `undefined` unless `--evaluate` was requested (i.e. `AuditPorts.evaluation` was present) — see {@link AuditEvaluationPort}'s doc for the full opt-in contract. */
  readonly evaluation?: AuditEvaluationResult;
  /** `undefined` unless `RunAuditOptions.resume` was used (Phase 5, task P5-4) — see {@link AuditResumeSummary}'s own doc. */
  readonly resume?: AuditResumeSummary;
  /**
   * Every discovered file's full, raw, un-normalized source text, keyed by
   * `repositoryRelativePath` (Phase 5, task P5-5) — `undefined` unless
   * `RunAuditOptions.retainSourceText` was explicitly `true`. This is the
   * one ingredient a cache-aware `audit --dry-run` preview needs
   * (`AuditCacheKeyPort.computeKey`'s `fullTestSource` argument) that
   * `AuditFileResult` itself deliberately never carries — see `runAudit`'s
   * own comment on why full source stays out of the ordinary result shape
   * by default (memory, and never leaking into a JSON report). Never
   * populated for an ordinary audit or `--evaluate` run unless that option
   * is explicitly passed; existing callers see no change.
   */
  readonly sourceTextByPath?: ReadonlyMap<string, string>;
}

export type AuditConfigurationOverrides = ConfigurationOverrides;

/**
 * The honest, all-zero {@link AuditEvaluationTotals} for a `--evaluate` invocation that has no
 * real evaluation outcome to report — never a placeholder object literal hand-duplicated at each
 * call site (the CLI's own `evaluateTextReport` and the canonical report builder,
 * `src/domain/report.ts`'s `buildAuditReport`, both fall back to this exact constant, so the two
 * can never silently drift on what "zero" looks like).
 */
export const EMPTY_AUDIT_EVALUATION_TOTALS: AuditEvaluationTotals = {
  evaluated: 0,
  cached: 0,
  failed: 0,
  skipped: { total: 0, byReason: { skip: 0, todo: 0, 'evidence-unavailable': 0 } },
  usage: { inputTokens: 0, outputTokens: 0 },
  statusCounts: { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 },
  respondedModel: undefined,
  modelMismatches: 0,
};
