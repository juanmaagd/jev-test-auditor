import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/application/audit.js';
import { createAuditCacheKeyPort } from '../src/adapters/cache-key.js';
import {
  AuditResumeLegacyRootDirError,
  AuditResumeRootDirMismatchError,
  AuditResumeRunNotFoundError,
  AuditResumeUnavailableError,
  type AuditCacheKeyPort,
  type AuditEvaluationPort,
  type AuditEvaluationRequest,
  type AuditPorts,
  type AuditRequest,
  type AuditStorePort,
  type AuditStoreRunState,
  type AuditStoreWorkItemOutcome,
} from '../src/domain/audit.js';
import type { ClassificationResult } from '../src/domain/classification.js';
import type { DiscoveredTestFile, DiscoveryResult } from '../src/domain/discovery.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import type { JevEvaluation } from '../src/domain/jev-gateway.js';
import type { TestCase, TestCaseId, TestModifierKind } from '../src/domain/test-understanding.js';

const configuration: AuditRequest = {
  rootDir: '/repo',
  include: ['**/*.test.ts'],
  exclude: [],
  concurrency: 4,
  evidence: {
    maxFragmentBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes,
    maxBundleBytes: DEFAULT_EVIDENCE_BUDGET.maxBundleBytes,
    deny: [],
  },
  store: { databasePath: undefined },
  schedule: { requestsPerMinute: 1_200, tokensPerSecond: 250_000 },
  reportingOnly: true,
};

function discovered(repositoryRelativePath: string): DiscoveredTestFile {
  return { repositoryRelativePath, framework: 'vitest', frameworkEvidence: [] };
}

function emptyBundle(testCaseId: TestCaseId): EvidenceBundle {
  return buildEvidenceBundle({ testCaseId, budget: DEFAULT_EVIDENCE_BUDGET, fragments: [], denied: [], unresolved: [], omitted: [] });
}

function testCase(id: string, modifierKinds: readonly TestModifierKind[] = [], repositoryRelativePath = 'a.test.ts'): TestCase {
  return {
    id: id as TestCaseId,
    repositoryRelativePath,
    kind: 'test',
    framework: 'vitest',
    name: id,
    structuralAncestry: [{ kind: 'test', name: id, ordinal: 0 }],
    source: `test('${id}', () => {});`,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    modifiers: modifierKinds.map((kind) => ({ kind, span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } })),
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
  };
}

function classificationFor(testCaseId: TestCaseId, status: ClassificationResult['status'] = 'healthy'): ClassificationResult {
  return {
    testCaseId,
    repositoryRelativePath: 'a.test.ts',
    name: String(testCaseId),
    status,
    dimensions: [],
    findings: [],
    policyVersion: 1,
    rubricVersion: 1,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 10, outputTokens: 1 },
  };
}

function stubEvaluationPort(handler: (request: AuditEvaluationRequest) => Promise<ClassificationResult>): AuditEvaluationPort {
  return {
    async evaluate(request) {
      const classification = await handler(request);
      const evaluation: JevEvaluation = {
        requestedModel: classification.model.requested,
        respondedModel: classification.model.responded,
        modelMatchesPin: classification.model.matchesPin,
        answers: {},
        usage: classification.usage,
        attempts: 1,
      };
      return { classification, evaluation };
    },
  };
}

function portsFor(discovery: DiscoveryResult, testCases: readonly TestCase[], evaluation?: AuditEvaluationPort, store?: AuditStorePort, cacheKey?: AuditCacheKeyPort): AuditPorts {
  return {
    discovery: { discover: async () => discovery },
    sourceReader: { read: async () => 'source' },
    extractor: { extract: () => ({ testCases: [...testCases], dynamicMetadata: [], diagnostics: [] }) },
    evidence: { build: async (request) => ({ bundles: request.testCases.map((tc) => emptyBundle(tc.id)), diagnostics: [] }) },
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(store === undefined ? {} : { store }),
    ...(cacheKey === undefined ? {} : { cacheKey }),
  };
}

// --- A hand-controllable fake store, mirroring the real sqlite adapter's `loadRunState`
// contract exactly (Phase 5, task P5-4): the LAST recorded outcome per identity within one run,
// filtered to the four terminal states. `seedRun` lets a test construct "as if interrupted"
// history directly — exactly the P5-3-documented outstanding-set contract this task reads back —
// without needing a literal process kill.

interface CountingStore extends AuditStorePort {
  readonly workItemCalls: { readonly runId: string; readonly outcome: AuditStoreWorkItemOutcome }[];
  readonly lookupCalls: string[];
  readonly finishRunCalls: string[];
  /**
   * `rootDirCanonical` defaults to `true`: every existing test in this file seeds a run as if it
   * were already recorded post-fix (this fake's `canonicalizeRootDir` is a plain identity
   * pass-through, so callers here never see a difference between "raw" and "canonical"). Pass
   * `false` only to construct the one pre-fix-legacy scenario `AuditResumeLegacyRootDirError`
   * covers — see the "rootDir identity" describe block below.
   */
  seedRun(runId: string, rootDir: string, finished: boolean, priorOutcomes: readonly AuditStoreWorkItemOutcome[], rootDirCanonical?: boolean): void;
}

function identityKey(identity: { readonly testCaseId: TestCaseId; readonly repositoryRelativePath: string; readonly name: string }): string {
  return JSON.stringify([identity.testCaseId, identity.repositoryRelativePath, identity.name]);
}

function countingStore(): CountingStore {
  const workItemCalls: { readonly runId: string; readonly outcome: AuditStoreWorkItemOutcome }[] = [];
  const lookupCalls: string[] = [];
  const finishRunCalls: string[] = [];
  const rootDirByRunId = new Map<string, string>();
  const rootDirCanonicalByRunId = new Map<string, boolean>();
  const finishedRunIds = new Set<string>();

  return {
    workItemCalls,
    lookupCalls,
    finishRunCalls,
    seedRun(runId, rootDir, finished, priorOutcomes, rootDirCanonical = true) {
      rootDirByRunId.set(runId, rootDir);
      rootDirCanonicalByRunId.set(runId, rootDirCanonical);
      if (finished) finishedRunIds.add(runId);
      for (const outcome of priorOutcomes) workItemCalls.push({ runId, outcome });
    },
    async beginRun(rootDir: string): Promise<string> {
      const runId = `run-${rootDirByRunId.size + 1}`;
      rootDirByRunId.set(runId, rootDir);
      rootDirCanonicalByRunId.set(runId, true);
      return runId;
    },
    // Identity pass-through (see `CountingStore.seedRun`'s own doc above): this fake never
    // exercises real filesystem canonicalization, only `preflightResume`'s orchestration logic.
    async canonicalizeRootDir(rootDir: string): Promise<string> {
      return rootDir;
    },
    async recordWorkItem(runId, outcome): Promise<void> {
      workItemCalls.push({ runId, outcome });
    },
    async lookup(cacheKey): Promise<{ readonly evaluation: JevEvaluation } | undefined> {
      lookupCalls.push(cacheKey);
      for (let index = workItemCalls.length - 1; index >= 0; index -= 1) {
        const { outcome } = workItemCalls[index]!;
        if (outcome.state === 'completed' && outcome.cacheKey === cacheKey && outcome.evaluation.modelMatchesPin) {
          return { evaluation: outcome.evaluation };
        }
      }
      return undefined;
    },
    async finishRun(runId): Promise<void> {
      finishRunCalls.push(runId);
      finishedRunIds.add(runId);
    },
    async loadRunState(runId): Promise<AuditStoreRunState | undefined> {
      const rootDir = rootDirByRunId.get(runId);
      if (rootDir === undefined) return undefined;
      const lastByIdentity = new Map<string, AuditStoreWorkItemOutcome>();
      for (const call of workItemCalls) {
        if (call.runId !== runId) continue;
        lastByIdentity.set(identityKey(call.outcome.identity), call.outcome);
      }
      const terminalWorkItems = [...lastByIdentity.values()].filter(
        (outcome) => outcome.state === 'completed' || outcome.state === 'cached' || outcome.state === 'failed' || outcome.state === 'skipped',
      );
      return {
        rootDir,
        rootDirCanonical: rootDirCanonicalByRunId.get(runId) ?? true,
        finished: finishedRunIds.has(runId),
        terminalWorkItems,
      };
    },
    async close(): Promise<void> {},
  };
}

describe('--resume error cases (Phase 5, task P5-4)', () => {
  it('rejects with AuditResumeUnavailableError, never a raw TypeError, when resume is requested with no store at all', async () => {
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    await expect(runAudit(configuration, portsFor(discovery, [testCase('tc:v1:a')], evaluation), { resume: 'run-x' }))
      .rejects.toBeInstanceOf(AuditResumeUnavailableError);
  });

  it('rejects with AuditResumeRunNotFoundError, naming the run id, when no run with that id was ever started', async () => {
    const store = countingStore();
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    const failure = runAudit(configuration, portsFor(discovery, [testCase('tc:v1:a')], evaluation, store), { resume: 'never-started' });

    await expect(failure).rejects.toBeInstanceOf(AuditResumeRunNotFoundError);
    await expect(failure).rejects.toThrow('never-started');
  });

  it('rejects with AuditResumeRootDirMismatchError, naming both roots, when the run was recorded against a different rootDir', async () => {
    const store = countingStore();
    store.seedRun('run-other-root', '/some/other/repo', false, []);
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    const failure = runAudit(configuration, portsFor(discovery, [testCase('tc:v1:a')], evaluation, store), { resume: 'run-other-root' });

    await expect(failure).rejects.toBeInstanceOf(AuditResumeRootDirMismatchError);
    await expect(failure).rejects.toThrow('/some/other/repo');
    await expect(failure).rejects.toThrow(configuration.rootDir);
  });
});

// --- rootDir identity: a persisted run must identify a repository, not just record whatever
// spelling the caller passed (defect fix, 2026-09-20). See `test/resume-root-dir-identity.test.ts`
// for the real-filesystem, real-adapter end-to-end coverage (false-accept, false-reject, and the
// legacy scenario against a real `node:sqlite` store); these tests cover `preflightResume`'s own
// orchestration logic against a hand-controlled fake, independent of real canonicalization.
describe('--resume rootDir identity (defect fix, 2026-09-20)', () => {
  it('rejects with AuditResumeLegacyRootDirError, naming the recorded root, when the run predates canonical rootDir recording', async () => {
    const store = countingStore();
    // `rootDirCanonical: false` is exactly what a pre-fix run recorded (its raw "." default, or
    // any relative --rootDir, never realpath'd) looks like once read back.
    store.seedRun('run-legacy', '.', false, [], false);
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async () => { throw new Error('must not dispatch'); });

    const failure = runAudit(configuration, portsFor(discovery, [testCase('tc:v1:a')], evaluation, store), { resume: 'run-legacy' });

    await expect(failure).rejects.toBeInstanceOf(AuditResumeLegacyRootDirError);
    await expect(failure).rejects.toThrow('run-legacy');
    await expect(failure).rejects.toThrow('.');
  });

  it('never mistakes a legacy (non-canonical) recorded rootDir for a genuine cross-repository mismatch', async () => {
    // A legacy run must be refused as unresumable outright — never silently reinterpreted as
    // "just some other root" and reported as an ordinary mismatch, which would imply the tool DID
    // manage to compare it (it did not: the raw stored value was never re-resolved at all).
    const store = countingStore();
    store.seedRun('run-legacy-2', '.', false, [], false);
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async () => { throw new Error('must not dispatch'); });

    const failure = runAudit(configuration, portsFor(discovery, [testCase('tc:v1:a')], evaluation, store), { resume: 'run-legacy-2' });

    await expect(failure).rejects.not.toBeInstanceOf(AuditResumeRootDirMismatchError);
    await expect(failure).rejects.toBeInstanceOf(AuditResumeLegacyRootDirError);
  });

  it('compares the resume request\'s rootDir through the store\'s own canonicalization, never the raw request string directly', async () => {
    // Overrides `canonicalizeRootDir` to a non-identity mapping so this test can tell whether
    // `preflightResume` actually calls it, rather than comparing `request.rootDir` verbatim (the
    // exact defect this fix corrects). The recorded root is seeded as the CANONICALIZED form of
    // `configuration.rootDir`, exactly like a real post-fix `beginRun` would have stored it.
    const base = countingStore();
    const canonicalRequestRootDir = `${configuration.rootDir}::canonical`;
    const store: AuditStorePort = {
      ...base,
      async canonicalizeRootDir(rootDir: string): Promise<string> {
        return rootDir === configuration.rootDir ? canonicalRequestRootDir : rootDir;
      },
    };
    base.seedRun('run-canonical-match', canonicalRequestRootDir, false, []);
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

    const result = await runAudit(configuration, portsFor(discovery, [testCase('tc:v1:a')], evaluation, store), { resume: 'run-canonical-match' });

    // No mismatch/legacy error thrown at all — the raw strings ('.'-shaped `configuration.rootDir`
    // vs. the seeded canonical form) would never compare equal on their own; only going through
    // `canonicalizeRootDir` makes them match.
    expect(result.resume?.nothingOutstanding).toBe(false);
  });

  it(
    'canonicalizes rootDir BEFORE calling beginRun for a fresh (non-resume) run, never persisting the raw request string '
    + 'directly, and threads the exact minted id onto AuditResult.runId (Phase 6, task P6-2b)',
    async () => {
      // Proves canonicalization happens at PERSIST time, not only at compare time — the distinction
      // this defect fix depends on (see `AuditStorePort.canonicalizeRootDir`'s own doc for why
      // resolving only at comparison time is the wrong fix).
      const base = countingStore();
      const beginRunCalls: string[] = [];
      const mintedRunIds: string[] = [];
      const store: AuditStorePort = {
        ...base,
        async beginRun(rootDir: string): Promise<string> {
          beginRunCalls.push(rootDir);
          const runId = await base.beginRun(rootDir);
          mintedRunIds.push(runId);
          return runId;
        },
        async canonicalizeRootDir(rootDir: string): Promise<string> {
          return `${rootDir}::canonical`;
        },
      };
      const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
      const evaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));

      const result = await runAudit(configuration, portsFor(discovery, [testCase('tc:v1:a')], evaluation, store));

      expect(beginRunCalls).toEqual([`${configuration.rootDir}::canonical`]);
      expect(mintedRunIds).toHaveLength(1);
      // Captured directly from the store's own `beginRun` return, independently of `result.runId`
      // — provenance, not a coincidence (Phase 6 Warning 2).
      expect(result.runId).toBe(mintedRunIds[0]);
    },
  );
});

describe('--resume nothing outstanding (Phase 5, task P5-4)', () => {
  it('an already-finished run reports nothing to do WITHOUT running discovery at all, and dispatches nothing', async () => {
    const store = countingStore();
    store.seedRun('run-done', configuration.rootDir, true, [
      { state: 'completed', identity: { testCaseId: 'tc:v1:done' as TestCaseId, repositoryRelativePath: 'a.test.ts', name: 'tc:v1:done' }, cacheKey: 'ck', evaluation: {
        requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true, answers: {}, usage: { inputTokens: 1, outputTokens: 1 }, attempts: 1,
      }, classification: classificationFor('tc:v1:done' as TestCaseId) },
    ]);
    let discoveryCalls = 0;
    const evaluation = stubEvaluationPort(async () => { throw new Error('must not dispatch'); });

    const result = await runAudit(configuration, {
      discovery: { discover: async () => { discoveryCalls += 1; return { files: [], excluded: [], diagnostics: [] }; } },
      sourceReader: { read: async () => 'source' },
      extractor: { extract: () => ({ testCases: [], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async () => ({ bundles: [], diagnostics: [] }) },
      evaluation,
      store,
    }, { resume: 'run-done' });

    expect(discoveryCalls).toBe(0);
    expect(result.resume).toEqual({ runId: 'run-done', outstanding: 0, reused: 0, nothingOutstanding: true });
    // Phase 6, task P6-2b: this already-finished early return continues the SAME identity it was
    // asked to resume — never absent, never a freshly minted one.
    expect(result.runId).toBe('run-done');
    expect(result.evaluation).toBeUndefined();
  });
});

describe('--resume completes only outstanding items (Phase 5, task P5-4)', () => {
  it(
    'reuses every already-terminal item (completed, cached, failed, skipped) without dispatching or re-looking-up any of them, '
    + 'dispatches only the outstanding ones, and produces the same totals an uninterrupted run over the same fixture would',
    async () => {
      const alreadyOk = testCase('tc:v1:already-ok');
      const alreadyCached = testCase('tc:v1:already-cached');
      const alreadyFailed = testCase('tc:v1:already-failed');
      const alreadySkipped = testCase('tc:v1:already-skipped', ['skip']);
      const outstandingA = testCase('tc:v1:outstanding-a');
      const outstandingB = testCase('tc:v1:outstanding-b');
      const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };

      const store = countingStore();
      store.seedRun('run-partial', configuration.rootDir, false, [
        { state: 'pending', identity: { testCaseId: alreadyOk.id, repositoryRelativePath: 'a.test.ts', name: alreadyOk.name } },
        {
          state: 'completed',
          identity: { testCaseId: alreadyOk.id, repositoryRelativePath: 'a.test.ts', name: alreadyOk.name },
          cacheKey: 'ck-already-ok',
          evaluation: { requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true, answers: {}, usage: { inputTokens: 111, outputTokens: 22 }, attempts: 1 },
          classification: classificationFor(alreadyOk.id, 'healthy'),
        },
        {
          state: 'cached',
          identity: { testCaseId: alreadyCached.id, repositoryRelativePath: 'a.test.ts', name: alreadyCached.name },
          cacheKey: 'ck-already-cached',
          classification: classificationFor(alreadyCached.id, 'weak'),
        },
        {
          state: 'failed',
          identity: { testCaseId: alreadyFailed.id, repositoryRelativePath: 'a.test.ts', name: alreadyFailed.name },
          errorKind: 'rate-limit',
          errorMessage: 'Jev rate limit exceeded (429) after 4 attempt(s).',
        },
        {
          state: 'skipped',
          identity: { testCaseId: alreadySkipped.id, repositoryRelativePath: 'a.test.ts', name: alreadySkipped.name },
          reason: 'skip',
        },
        // outstandingA and outstandingB never reached a terminal state before the (simulated)
        // interruption — outstandingA got as far as `running`, outstandingB has no row at all.
        { state: 'running', identity: { testCaseId: outstandingA.id, repositoryRelativePath: 'a.test.ts', name: outstandingA.name } },
      ]);

      const workItemCallsBeforeResume = store.workItemCalls.length;
      const dispatched: TestCaseId[] = [];
      const evaluation = stubEvaluationPort(async (request) => {
        dispatched.push(request.testCase.id);
        return classificationFor(request.testCase.id, 'misleading');
      });

      const result = await runAudit(
        { ...configuration, concurrency: 1 },
        portsFor(discovery, [alreadyOk, alreadyCached, alreadyFailed, alreadySkipped, outstandingA, outstandingB], evaluation, store),
        { resume: 'run-partial' },
      );

      // Only the two genuinely outstanding items ever reach the evaluation port.
      expect(dispatched.sort()).toEqual([outstandingA.id, outstandingB.id].sort());

      // Reused totals combine with freshly dispatched ones exactly like a single uninterrupted
      // run would report them: evaluated counts BOTH a fresh success (outstandingA/B) and a reused
      // `completed` (alreadyOk); cached counts the reused `cached` item; failed counts the reused
      // `failed` item; skipped counts the (freshly re-classified, deterministic) skip.
      expect(result.evaluation?.totals).toMatchObject({
        evaluated: 3,
        cached: 1,
        failed: 1,
        skipped: { total: 1, byReason: { skip: 1, todo: 0, 'evidence-unavailable': 0 } },
      });
      // `resume.reused` counts only EVALUABLE items reused from a prior terminal state (3: ok,
      // cached, failed) — the skipped item is not "reused," it is simply not re-recorded, since
      // skip/evaluable status is always freshly recomputed from the current source either way.
      expect(result.resume).toEqual({ runId: 'run-partial', outstanding: 2, reused: 3, nothingOutstanding: false });
      // Phase 6, task P6-2b: a resumed run's top-level runId always agrees with resume.runId — it
      // continues the identity it was asked to resume, never mints a new one.
      expect(result.runId).toBe('run-partial');

      // The reused failed item's diagnostic is reconstructed with the SAME kind/message it was
      // originally recorded with — never a fresh, different-looking one.
      const diagnostic = result.diagnostics.find((entry) => entry.message.includes(alreadyFailed.id));
      expect(diagnostic?.message).toContain('rate-limit');
      expect(diagnostic?.message).toContain('Jev rate limit exceeded (429) after 4 attempt(s).');

      // Reused items are never re-looked-up, re-recorded as skipped, or re-recorded as pending —
      // only the two outstanding items get a fresh `pending` checkpoint appended THIS resume
      // (everything before `workItemCallsBeforeResume` is the seeded pre-interruption history).
      const callsDuringResume = store.workItemCalls.slice(workItemCallsBeforeResume);
      const pendingCalls = callsDuringResume.filter((call) => call.outcome.state === 'pending');
      expect(pendingCalls.map((call) => call.outcome.identity.testCaseId).sort()).toEqual([outstandingA.id, outstandingB.id].sort());
      const skippedCalls = store.workItemCalls.filter((call) => call.runId === 'run-partial' && call.outcome.state === 'skipped');
      expect(skippedCalls).toHaveLength(1); // the ORIGINAL seeded one only — never re-recorded
      const newSkippedCalls = callsDuringResume.filter((call) => call.outcome.state === 'skipped');
      expect(newSkippedCalls).toEqual([]); // and specifically: no NEW skipped checkpoint this resume
    },
  );

  it(
    'source-drift safety net: a test case recorded `skipped` before the interruption but currently evaluable (e.g. the `skip` '
    + 'modifier was removed since) is treated as OUTSTANDING and genuinely dispatched — never silently reused as a bogus failure',
    async () => {
      const driftedCase = testCase('tc:v1:drift-now-evaluable'); // no skip modifier NOW
      const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
      const store = countingStore();
      store.seedRun('run-drift', configuration.rootDir, false, [
        { state: 'skipped', identity: { testCaseId: driftedCase.id, repositoryRelativePath: 'a.test.ts', name: driftedCase.name }, reason: 'skip' },
      ]);
      const dispatched: TestCaseId[] = [];
      const evaluation = stubEvaluationPort(async (request) => { dispatched.push(request.testCase.id); return classificationFor(request.testCase.id); });

      const result = await runAudit({ ...configuration, concurrency: 1 }, portsFor(discovery, [driftedCase], evaluation, store), { resume: 'run-drift' });

      expect(dispatched).toEqual([driftedCase.id]);
      expect(result.evaluation?.totals).toMatchObject({ evaluated: 1, failed: 0, skipped: { total: 0 } });
      expect(result.resume).toEqual({ runId: 'run-drift', outstanding: 1, reused: 0, nothingOutstanding: false });
      expect(result.runId).toBe('run-drift');
    },
  );

  it('resuming a run whose items are ALL terminal (crash between the last item and finishRun — finished stays false) reports nothing outstanding and dispatches nothing, without redispatching the already-terminal ones', async () => {
    const only = testCase('tc:v1:all-terminal');
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const store = countingStore();
    store.seedRun('run-all-terminal', configuration.rootDir, false, [
      {
        state: 'completed',
        identity: { testCaseId: only.id, repositoryRelativePath: 'a.test.ts', name: only.name },
        cacheKey: 'ck-all-terminal',
        evaluation: { requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true, answers: {}, usage: { inputTokens: 1, outputTokens: 1 }, attempts: 1 },
        classification: classificationFor(only.id),
      },
    ]);
    const evaluation = stubEvaluationPort(async () => { throw new Error('must not dispatch — already terminal'); });

    const result = await runAudit({ ...configuration, concurrency: 1 }, portsFor(discovery, [only], evaluation, store), { resume: 'run-all-terminal' });

    expect(result.resume).toEqual({ runId: 'run-all-terminal', outstanding: 0, reused: 1, nothingOutstanding: true });
    expect(result.runId).toBe('run-all-terminal');
    expect(result.evaluation?.totals).toMatchObject({ evaluated: 1, cached: 0, failed: 0 });
  });
});

describe('--resume combined with --fresh (Phase 5, task P5-4)', () => {
  it(
    '--fresh only affects OUTSTANDING items\' cache lookup — never touches an already-terminal reused item, and never re-looks-up it either way',
    async () => {
      const alreadyCompleted = testCase('tc:v1:fresh-already-completed');
      const outstandingWarm = testCase('tc:v1:fresh-outstanding-warm');
      const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
      const cacheKeyPort = createAuditCacheKeyPort();
      const store = countingStore();
      store.seedRun('run-fresh', configuration.rootDir, false, [
        {
          state: 'completed',
          identity: { testCaseId: alreadyCompleted.id, repositoryRelativePath: 'a.test.ts', name: alreadyCompleted.name },
          cacheKey: 'ck-already-completed-unrelated',
          evaluation: { requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true, answers: {}, usage: { inputTokens: 1, outputTokens: 1 }, attempts: 1 },
          classification: classificationFor(alreadyCompleted.id),
        },
      ]);
      // Warm the cache for `outstandingWarm` under a SEPARATE run, so resuming without --fresh can
      // serve it from that warm entry.
      const warmingEvaluation = stubEvaluationPort(async (request) => classificationFor(request.testCase.id));
      await runAudit(configuration, portsFor({ files: [discovered('a.test.ts')], excluded: [], diagnostics: [] }, [outstandingWarm], warmingEvaluation, store, cacheKeyPort));

      const dispatched: TestCaseId[] = [];
      const evaluation = stubEvaluationPort(async (request) => { dispatched.push(request.testCase.id); return classificationFor(request.testCase.id); });

      const withoutFresh = await runAudit(
        { ...configuration, concurrency: 1 },
        portsFor(discovery, [alreadyCompleted, outstandingWarm], evaluation, store, cacheKeyPort),
        { resume: 'run-fresh' },
      );
      // The outstanding item is served from the warm cache (no dispatch); the reused terminal item
      // contributes no lookup call at all.
      expect(dispatched).toEqual([]);
      expect(withoutFresh.evaluation?.totals).toMatchObject({ evaluated: 1, cached: 1 });

      // A second, independent seeded run: same shape, but resumed WITH --fresh this time.
      const store2 = countingStore();
      store2.seedRun('run-fresh-2', configuration.rootDir, false, [
        {
          state: 'completed',
          identity: { testCaseId: alreadyCompleted.id, repositoryRelativePath: 'a.test.ts', name: alreadyCompleted.name },
          cacheKey: 'ck-already-completed-unrelated-2',
          evaluation: { requestedModel: 'jev-1.13.0', respondedModel: 'jev-1.13.0', modelMatchesPin: true, answers: {}, usage: { inputTokens: 1, outputTokens: 1 }, attempts: 1 },
          classification: classificationFor(alreadyCompleted.id),
        },
      ]);
      await runAudit(configuration, portsFor({ files: [discovered('a.test.ts')], excluded: [], diagnostics: [] }, [outstandingWarm], warmingEvaluation, store2, cacheKeyPort));
      const dispatched2: TestCaseId[] = [];
      const evaluation2 = stubEvaluationPort(async (request) => { dispatched2.push(request.testCase.id); return classificationFor(request.testCase.id); });

      const withFresh = await runAudit(
        { ...configuration, concurrency: 1 },
        portsFor(discovery, [alreadyCompleted, outstandingWarm], evaluation2, store2, cacheKeyPort),
        { resume: 'run-fresh-2', fresh: true },
      );
      // --fresh bypasses the warm cache for the OUTSTANDING item — one real dispatch — while the
      // already-terminal item is still simply reused, not re-dispatched.
      expect(dispatched2).toEqual([outstandingWarm.id]);
      expect(withFresh.evaluation?.totals).toMatchObject({ evaluated: 2, cached: 0 });
    },
  );
});
