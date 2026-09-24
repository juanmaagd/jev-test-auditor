import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import type {
  AuditEvaluationPort,
  AuditEvaluationRequest,
  AuditEvidenceBuildRequest,
  AuditEvidenceBuildResult,
  AuditExtractorPort,
  AuditPorts,
  AuditPrePhaseEvent,
  AuditProgressEvent,
  AuditProgressPort,
  AuditRequest,
  AuditStorePort,
  AuditStoreWorkItemOutcome,
} from '../src/domain/audit.js';
import type { ClassificationResult } from '../src/domain/classification.js';
import type { DiscoveredTestFile, DiscoveryResult } from '../src/domain/discovery.js';
import type { TestExtractionResult } from '../src/domain/extraction.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import type { JevEvaluation } from '../src/domain/jev-gateway.js';
import type { TestCase, TestCaseId } from '../src/domain/test-understanding.js';

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
  store: {
    databasePath: undefined,
  },
  schedule: {
    requestsPerMinute: 1_200,
    tokensPerSecond: 250_000,
  },
  reportingOnly: true,
};

function discovered(repositoryRelativePath: string): DiscoveredTestFile {
  return { repositoryRelativePath, framework: 'vitest', frameworkEvidence: [] };
}

function baseTestCase(name: string, repositoryRelativePath: string): TestCase {
  return {
    id: `tc:v1:${name}` as TestCaseId,
    repositoryRelativePath,
    kind: 'test',
    framework: 'vitest',
    name,
    structuralAncestry: [{ kind: 'test', name, ordinal: 0 }],
    source: `test('${name}', () => {});`,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    modifiers: [],
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
  };
}

function manyTestCases(name: string, count: number, repositoryRelativePath = `${name}.test.ts`): readonly TestCase[] {
  return Array.from({ length: count }, (_unused, index) => baseTestCase(`${name}-${index + 1}`, repositoryRelativePath));
}

function extractionFor(testCases: readonly TestCase[]): TestExtractionResult {
  return { testCases, dynamicMetadata: [], diagnostics: [] };
}

function emptyBundle(testCaseId: TestCaseId): EvidenceBundle {
  return buildEvidenceBundle({ testCaseId, budget: DEFAULT_EVIDENCE_BUDGET, fragments: [], denied: [], unresolved: [], omitted: [] });
}

async function defaultEvidenceBuild(request: AuditEvidenceBuildRequest): Promise<AuditEvidenceBuildResult> {
  return { bundles: request.testCases.map((testCase) => emptyBundle(testCase.id)), diagnostics: [] };
}

function classificationFor(testCaseId: TestCaseId): ClassificationResult {
  return {
    testCaseId,
    repositoryRelativePath: 'a.test.ts',
    name: String(testCaseId),
    status: 'healthy',
    dimensions: [],
    findings: [],
    policyVersion: 1,
    rubricVersion: 1,
    model: { requested: 'jev-1.13.0', responded: 'jev-1.13.0', matchesPin: true },
    usage: { inputTokens: 10, outputTokens: 0 },
  };
}

function rawEvaluationFor(attempts = 1): JevEvaluation {
  return {
    requestedModel: 'jev-1.13.0',
    respondedModel: 'jev-1.13.0',
    modelMatchesPin: true,
    answers: {},
    usage: { inputTokens: 10, outputTokens: 0 },
    attempts,
  };
}

/** Immediate, deterministic success for every evaluable item — no gating, no concurrency control. */
function immediateEvaluationPort(): AuditEvaluationPort {
  return {
    async evaluate(request: AuditEvaluationRequest) {
      return { evaluation: rawEvaluationFor(), classification: classificationFor(request.testCase.id) };
    },
  };
}

/** An evaluation port that always rejects, for exercising the `failed` checkpoint. */
function failingEvaluationPort(): AuditEvaluationPort {
  return { async evaluate() { throw new Error('boom'); } };
}

function portsFor(discovery: DiscoveryResult, testCases: readonly TestCase[], evaluation: AuditEvaluationPort, extra: Partial<AuditPorts> = {}): AuditPorts {
  return {
    discovery: { discover: async () => discovery },
    sourceReader: { read: async () => 'source' },
    extractor: { extract: () => extractionFor(testCases) },
    evidence: { build: defaultEvidenceBuild },
    evaluation,
    ...extra,
  };
}

/** A promise this test settles by hand, so a scenario controls the exact order dispatches complete in — never a race against real timer delays. Mirrors `test/audit.test.ts`'s own `deferredGate` helper. */
function deferredGate(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => { resolveFn = resolve; });
  return { promise, resolve: resolveFn };
}

/** Drains the microtask queue — see `test/audit.test.ts`'s own `flush` for why this, not a real timer wait, reliably observes a gated dispatch chain's current progress. */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

/** A minimal in-memory `AuditProgressPort` recording every call in order, for asserting exact sequences. */
function fakeProgress(): { readonly port: AuditProgressPort; readonly beginCalls: number[]; readonly events: AuditProgressEvent[] } {
  const beginCalls: number[] = [];
  const events: AuditProgressEvent[] = [];
  return {
    beginCalls,
    events,
    port: {
      begin(total: number): void { beginCalls.push(total); },
      report(event: AuditProgressEvent): void { events.push(event); },
    },
  };
}

interface FakeStoreCall {
  readonly runId: string;
  readonly outcome: AuditStoreWorkItemOutcome;
}

function identityKeyFor(identity: { readonly testCaseId: TestCaseId; readonly repositoryRelativePath: string; readonly name: string }): string {
  return JSON.stringify([identity.testCaseId, identity.repositoryRelativePath, identity.name]);
}

/** A minimal in-memory `AuditStorePort`, mirroring `test/audit.test.ts`'s own `fakeStore` (trimmed to what this file needs: recording calls and supporting `--resume`). */
function fakeStore(): AuditStorePort & { readonly workItemCalls: FakeStoreCall[]; readonly finishRunCalls: string[] } {
  const workItemCalls: FakeStoreCall[] = [];
  const finishRunCalls: string[] = [];
  const rootDirByRunId = new Map<string, string>();
  let nextRunId = 0;
  return {
    workItemCalls,
    finishRunCalls,
    async beginRun(rootDir: string): Promise<string> {
      nextRunId += 1;
      const runId = `run-${nextRunId}`;
      rootDirByRunId.set(runId, rootDir);
      return runId;
    },
    async recordWorkItem(runId: string, outcome: AuditStoreWorkItemOutcome): Promise<void> {
      workItemCalls.push({ runId, outcome });
    },
    // Mirrors `test/audit.test.ts`'s own `fakeStore().lookup`: the most recent `completed` outcome
    // recorded under `cacheKey` — enough for this file's own cache-hit test to warm the cache on a
    // first run and actually hit on a second one, never a stub that unconditionally misses.
    async lookup(cacheKey: string) {
      for (let index = workItemCalls.length - 1; index >= 0; index -= 1) {
        const { outcome } = workItemCalls[index]!;
        if (outcome.state === 'completed' && outcome.cacheKey === cacheKey) return { evaluation: outcome.evaluation };
      }
      return undefined;
    },
    async finishRun(runId: string): Promise<void> { finishRunCalls.push(runId); },
    async loadRunState(runId: string) {
      const rootDir = rootDirByRunId.get(runId);
      if (rootDir === undefined) return undefined;
      const lastByIdentity = new Map<string, AuditStoreWorkItemOutcome>();
      for (const call of workItemCalls) {
        if (call.runId !== runId) continue;
        lastByIdentity.set(identityKeyFor(call.outcome.identity), call.outcome);
      }
      const terminalWorkItems = [...lastByIdentity.values()].filter(
        (outcome) => outcome.state === 'completed' || outcome.state === 'cached' || outcome.state === 'failed' || outcome.state === 'skipped',
      );
      return { rootDir, rootDirCanonical: true, finished: finishRunCalls.includes(runId), terminalWorkItems };
    },
    async canonicalizeRootDir(rootDir: string): Promise<string> { return rootDir; },
    async close(): Promise<void> { /* no-op */ },
  };
}

describe('progress reporting (Phase 6, task P6-3)', () => {
  it('reports begin(total) before pending, then running, then the terminal transition for a single evaluable item', async () => {
    const testCase = baseTestCase('solo', 'solo.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('solo.test.ts')], excluded: [], diagnostics: [] };
    const progress = fakeProgress();

    await runAudit({ ...configuration, concurrency: 1 }, portsFor(discovery, [testCase], immediateEvaluationPort(), { progress: progress.port }));

    expect(progress.beginCalls).toEqual([1]);
    expect(progress.events.map((event) => `${event.state}:${event.identity.testCaseId}`)).toEqual([
      `pending:${testCase.id}`,
      `running:${testCase.id}`,
      `completed:${testCase.id}`,
    ]);
    expect(progress.events.every((event) => event.concurrencyLimit === 1)).toBe(true);
  });

  it('reports a pending checkpoint for every item up front, before any running/terminal event — concurrency 1 makes the order deterministic', async () => {
    const first = baseTestCase('checkpoint-a', 'checkpoint.test.ts');
    const second = baseTestCase('checkpoint-b', 'checkpoint.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('checkpoint.test.ts')], excluded: [], diagnostics: [] };
    const progress = fakeProgress();

    await runAudit({ ...configuration, concurrency: 1 }, portsFor(discovery, [first, second], immediateEvaluationPort(), { progress: progress.port }));

    expect(progress.beginCalls).toEqual([2]);
    expect(progress.events.map((event) => `${event.state}:${event.identity.testCaseId}`)).toEqual([
      `pending:${first.id}`,
      `pending:${second.id}`,
      `running:${first.id}`,
      `completed:${first.id}`,
      `running:${second.id}`,
      `completed:${second.id}`,
    ]);
  });

  it('reports a failed dispatch as a failed transition, distinct from completed', async () => {
    const testCase = baseTestCase('boom', 'boom.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('boom.test.ts')], excluded: [], diagnostics: [] };
    const progress = fakeProgress();

    await runAudit({ ...configuration, concurrency: 1 }, portsFor(discovery, [testCase], failingEvaluationPort(), { progress: progress.port }));

    expect(progress.events.map((event) => event.state)).toEqual(['pending', 'running', 'failed']);
  });

  it('distinguishes a cache hit (cached) from a fresh dispatch (completed) — same checkpoint order either way', async () => {
    const testCase = baseTestCase('cache-me', 'cache-me.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('cache-me.test.ts')], excluded: [], diagnostics: [] };
    const store = fakeStore();
    const cacheKeyPort = { computeKey: () => 'fixed-key', classifyCached: (request: AuditEvaluationRequest) => classificationFor(request.testCase.id) };
    const progress = fakeProgress();
    const basePorts = portsFor(discovery, [testCase], immediateEvaluationPort(), { store, cacheKey: cacheKeyPort });

    await runAudit(configuration, basePorts); // warms the cache (no progress port on the warm-up run)
    await runAudit(configuration, { ...basePorts, progress: progress.port }); // served from cache, progress port attached

    expect(progress.events.map((event) => event.state)).toEqual(['pending', 'running', 'cached']);
  });

  it('reports every transition even when no store is wired at all — progress never depends on persistence', async () => {
    const testCase = baseTestCase('storeless', 'storeless.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('storeless.test.ts')], excluded: [], diagnostics: [] };
    const progress = fakeProgress();

    const result = await runAudit({ ...configuration, concurrency: 1 }, portsFor(discovery, [testCase], immediateEvaluationPort(), { progress: progress.port }));

    expect(result.runId).toBeUndefined(); // no store present at all
    expect(progress.events.map((event) => event.state)).toEqual(['pending', 'running', 'completed']);
  });

  it('reports a skipped test case as one terminal skipped transition, counted in begin\'s total', async () => {
    const skippable = { ...baseTestCase('skip-me', 'skip.test.ts'), modifiers: [{ kind: 'skip' as const, span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }] };
    const discovery: DiscoveryResult = { files: [discovered('skip.test.ts')], excluded: [], diagnostics: [] };
    const progress = fakeProgress();

    await runAudit(configuration, portsFor(discovery, [skippable], immediateEvaluationPort(), { progress: progress.port }));

    expect(progress.beginCalls).toEqual([1]);
    expect(progress.events).toEqual([{ state: 'skipped', identity: { testCaseId: skippable.id, repositoryRelativePath: 'skip.test.ts', name: skippable.name }, concurrencyLimit: 4 }]);
  });

  it('reports transitions in real settlement order under concurrency, never merely submission order', async () => {
    const first = baseTestCase('race-a', 'race.test.ts');
    const second = baseTestCase('race-b', 'race.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('race.test.ts')], excluded: [], diagnostics: [] };
    const gates = { [first.id]: deferredGate(), [second.id]: deferredGate() };
    const evaluation: AuditEvaluationPort = {
      async evaluate(request) {
        await gates[request.testCase.id as string]!.promise;
        return { evaluation: rawEvaluationFor(), classification: classificationFor(request.testCase.id) };
      },
    };
    const progress = fakeProgress();

    const auditPromise = runAudit({ ...configuration, concurrency: 2 }, portsFor(discovery, [first, second], evaluation, { progress: progress.port }));
    await flush();

    // Both items are already dispatched (pending, then running, both fired) — now settle SECOND
    // before FIRST, the opposite of submission order.
    gates[second.id]!.resolve();
    await flush();
    gates[first.id]!.resolve();
    await auditPromise;

    const terminalOrder = progress.events.filter((event) => event.state === 'completed').map((event) => event.identity.testCaseId);
    expect(terminalOrder).toEqual([second.id, first.id]);
  });

  it('shows the pre-reduction concurrency limit on a throttled item\'s own terminal event; the reduced limit is visible starting only with the next dispatched item\'s running event', async () => {
    const cases = manyTestCases('limit', 4);
    const gates = new Map(cases.map((testCase) => [testCase.id, deferredGate()]));
    const attemptsFor = (testCaseId: TestCaseId): number => (testCaseId === cases[0]!.id ? 4 : 1);
    const evaluation: AuditEvaluationPort = {
      async evaluate(request) {
        await gates.get(request.testCase.id)!.promise;
        return { evaluation: rawEvaluationFor(attemptsFor(request.testCase.id)), classification: classificationFor(request.testCase.id) };
      },
    };
    const discovery: DiscoveryResult = { files: [discovered('limit.test.ts')], excluded: [], diagnostics: [] };
    const progress = fakeProgress();

    const auditPromise = runAudit({ ...configuration, concurrency: 2 }, portsFor(discovery, cases, evaluation, { progress: progress.port }));
    await flush();

    gates.get(cases[0]!.id)!.resolve(); // the throttled dispatch (attempts: 4) settles first
    await flush();
    const item0Completed = progress.events.find((event) => event.state === 'completed' && event.identity.testCaseId === cases[0]!.id);
    expect(item0Completed?.concurrencyLimit).toBe(2); // NOT yet reduced: the scheduler applies the throttle signal after this event was already reported

    gates.get(cases[1]!.id)!.resolve(); // only once item 1 also settles does item 2 get dispatched (ceiling reduced to 1)
    await flush();
    const item2Running = progress.events.find((event) => event.state === 'running' && event.identity.testCaseId === cases[2]!.id);
    expect(item2Running?.concurrencyLimit).toBe(1); // reduced before item 2 was even dispatched

    gates.get(cases[2]!.id)!.resolve();
    await flush();
    gates.get(cases[3]!.id)!.resolve();
    await auditPromise;
  });

  it('excludes an already-terminal, reused item from begin\'s total on a resumed run — never items.length unconditionally', async () => {
    const first = baseTestCase('resume-a', 'resume.test.ts');
    const second = baseTestCase('resume-b', 'resume.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('resume.test.ts')], excluded: [], diagnostics: [] };
    const store = fakeStore();

    // Interrupted run: `first` completes; `second` hangs forever (never settles) — simulating a
    // crash before it could reach a terminal state. Never awaited: this promise is deliberately
    // abandoned, exactly like `test/cli.test.ts`'s own real `--resume` fixtures do.
    const hangingGate = deferredGate();
    const interruptedEvaluation: AuditEvaluationPort = {
      async evaluate(request) {
        if (request.testCase.id === second.id) await hangingGate.promise;
        return { evaluation: rawEvaluationFor(), classification: classificationFor(request.testCase.id) };
      },
    };
    void runAudit(configuration, portsFor(discovery, [first, second], interruptedEvaluation, { store }));
    await flush();
    await flush();

    const capturedRunId = store.workItemCalls[0]?.runId;
    expect(capturedRunId).toBeDefined();
    expect(store.finishRunCalls).toEqual([]); // genuinely unfinished — proves the "crash" landed before completion

    // Resumed run: only `second` is outstanding; `first` is reused as-is from the store.
    const progress = fakeProgress();
    const result = await runAudit(configuration, portsFor(discovery, [first, second], immediateEvaluationPort(), { store, progress: progress.port }), { resume: capturedRunId! });

    expect(progress.beginCalls).toEqual([1]); // NOT items.length (2) — `first` is reused, never redispatched
    expect(progress.events.map((event) => `${event.state}:${event.identity.testCaseId}`)).toEqual([
      `pending:${second.id}`,
      `running:${second.id}`,
      `completed:${second.id}`,
    ]);
    expect(result.resume?.outstanding).toBe(1);
    expect(result.resume?.reused).toBe(1);
  });

  it('records the store write for a terminal transition before reporting that same transition to progress', async () => {
    const testCase = baseTestCase('order-check', 'order.test.ts');
    const discovery: DiscoveryResult = { files: [discovered('order.test.ts')], excluded: [], diagnostics: [] };
    const order: string[] = [];
    const store = fakeStore();
    const orderedStore: AuditStorePort = {
      ...store,
      async recordWorkItem(runId, outcome) {
        await store.recordWorkItem(runId, outcome);
        if (outcome.state === 'completed') order.push('store:completed');
      },
    };
    const progress: AuditProgressPort = {
      begin() { /* no-op */ },
      report(event) { if (event.state === 'completed') order.push('progress:completed'); },
    };

    await runAudit(configuration, portsFor(discovery, [testCase], immediateEvaluationPort(), { store: orderedStore, progress }));

    expect(order).toEqual(['store:completed', 'progress:completed']);
  });
});

describe('pre-dispatch phase progress (T3, odd/tasks/audit-run-responsiveness.md)', () => {
  function manyDiscoveredFiles(count: number): DiscoveredTestFile[] {
    return Array.from({ length: count }, (_unused, index) => discovered(`file-${index + 1}.test.ts`));
  }

  /** One test case per file, its id derived from the file's own path — distinct per file so a per-file extractor never accidentally returns a shared object. */
  function extractorForOneTestCasePerFile(): AuditExtractorPort {
    return {
      extract: (request) => extractionFor([baseTestCase(`tc-${request.repositoryRelativePath}`, request.repositoryRelativePath)]),
    };
  }

  function portsWithPhaseTracking(discovery: DiscoveryResult, extra: Partial<AuditPorts> = {}): { readonly ports: AuditPorts; readonly phaseCalls: AuditPrePhaseEvent[] } {
    const phaseCalls: AuditPrePhaseEvent[] = [];
    const ports: AuditPorts = {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: extractorForOneTestCasePerFile(),
      evidence: { build: defaultEvidenceBuild },
      evaluation: immediateEvaluationPort(),
      progress: { begin() { /* no-op */ }, report() { /* no-op */ }, phase(event) { phaseCalls.push(event); } },
      ...extra,
    };
    return { ports, phaseCalls };
  }

  it('reports a discovering phase before any extracting phase, with no counts yet — the first thing a caller sees, before discovery itself even resolves', async () => {
    const discovery: DiscoveryResult = { files: [discovered('a.test.ts')], excluded: [], diagnostics: [] };
    const { ports, phaseCalls } = portsWithPhaseTracking(discovery);

    await runAudit(configuration, ports);

    expect(phaseCalls[0]).toEqual({ phase: 'discovering' });
  });

  it('reports one extracting phase per file for a small suite (throttle floor of 1), with cumulative done/total/testCases', async () => {
    const discovery: DiscoveryResult = { files: manyDiscoveredFiles(3), excluded: [], diagnostics: [] };
    const { ports, phaseCalls } = portsWithPhaseTracking(discovery);

    await runAudit(configuration, ports);

    const extracting = phaseCalls.filter((event) => event.phase === 'extracting');
    expect(extracting).toEqual([
      { phase: 'extracting', done: 1, total: 3, testCases: 1 },
      { phase: 'extracting', done: 2, total: 3, testCases: 2 },
      { phase: 'extracting', done: 3, total: 3, testCases: 3 },
    ]);
  });

  it('throttles extracting phase events for a larger suite instead of one per file — bounded output regardless of suite size, always ending on the exact final total', async () => {
    const fileCount = 100;
    const discovery: DiscoveryResult = { files: manyDiscoveredFiles(fileCount), excluded: [], diagnostics: [] };
    const { ports, phaseCalls } = portsWithPhaseTracking(discovery);

    await runAudit(configuration, ports);

    const extracting = phaseCalls.filter((event) => event.phase === 'extracting');
    expect(extracting.length).toBeLessThan(fileCount);
    expect(extracting[extracting.length - 1]).toEqual({ phase: 'extracting', done: fileCount, total: fileCount, testCases: fileCount });
  });

  it('reports a checking-cache phase exactly once, right before begin, only when content-addressed caching is actually enabled for this run', async () => {
    const discovery: DiscoveryResult = { files: [discovered('cache-check.test.ts')], excluded: [], diagnostics: [] };
    const store = fakeStore();
    const cacheKeyPort = { computeKey: () => 'fixed-key-for-phase-test', classifyCached: (request: AuditEvaluationRequest) => classificationFor(request.testCase.id) };
    const { ports, phaseCalls } = portsWithPhaseTracking(discovery, { store, cacheKey: cacheKeyPort });

    await runAudit(configuration, ports);

    expect(phaseCalls.filter((event) => event.phase === 'checking-cache')).toEqual([{ phase: 'checking-cache' }]);
  });

  it('never reports checking-cache when no store/cache-key port is wired — nothing would actually be checked', async () => {
    const discovery: DiscoveryResult = { files: [discovered('no-cache.test.ts')], excluded: [], diagnostics: [] };
    const { ports, phaseCalls } = portsWithPhaseTracking(discovery);

    await runAudit(configuration, ports);

    expect(phaseCalls.some((event) => event.phase === 'checking-cache')).toBe(false);
  });

  it('never calls phase() at all when no progress port is wired — the optional hook is genuinely optional', async () => {
    const discovery: DiscoveryResult = { files: manyDiscoveredFiles(3), excluded: [], diagnostics: [] };

    // No `progress` in the ports at all — must not throw, exactly like every other opt-in port.
    await expect(runAudit(configuration, {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => 'source' },
      extractor: extractorForOneTestCasePerFile(),
      evidence: { build: defaultEvidenceBuild },
      evaluation: immediateEvaluationPort(),
    })).resolves.toBeDefined();
  });
});
