/**
 * Policy-free cache (`odd/tasks/policy-free-cache-and-calibration.md`, task T1):
 * a cache hit re-derives its classification from the stored raw Jev answers
 * under the CURRENT policy, locally, and a policy change never makes a
 * provider request. Exercised end to end through `runAudit`, the real
 * `node:sqlite` store in a temp directory, and the real cache-key port.
 *
 * The seeded store row is keyed with the cache-key formula exactly as it was
 * before this change (re-implemented inline below, with the policy version
 * `2` every existing store was written with), so this also proves existing
 * entries in real stores stay hits instead of being re-billed once.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import { createAuditCacheKeyPort } from '../src/adapters/cache-key.js';
import { sha256 } from '../src/adapters/hash.js';
import { createSqliteAuditStore } from '../src/adapters/sqlite-audit-store.js';
import type { AuditEvaluationPort, AuditPorts, AuditRequest } from '../src/domain/audit.js';
import { CLASSIFICATION_POLICY_V2, classifyEvaluation, type ClassificationPolicyV2 } from '../src/domain/classification.js';
import type { DiscoveryResult } from '../src/domain/discovery.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import type { JevAnswer, JevEvaluation } from '../src/domain/jev-gateway.js';
import { buildJevRequest, canonicalizeJevRequest } from '../src/domain/jev-request.js';
import { RUBRIC_V2 } from '../src/domain/rubric.js';
import { normalizeTestSource, type TestCase, type TestCaseId } from '../src/domain/test-understanding.js';

const SOURCE = "import { expect, test } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n";

const testCase: TestCase = {
  id: 'tc:v1:policy-free' as TestCaseId,
  repositoryRelativePath: 'policy-free.test.ts',
  kind: 'test',
  framework: 'vitest',
  name: 'adds',
  structuralAncestry: [{ kind: 'test', name: 'adds', ordinal: 0 }],
  source: "test('adds', () => { expect(1 + 1).toBe(2); });",
  span: { start: { line: 2, column: 1 }, end: { line: 2, column: 50 } },
  modifiers: [],
  hooks: [],
  imports: [],
  mocks: [],
  assertions: [],
  parameterization: { mode: 'none', cases: [] },
  diagnostics: [],
};

const bundle: EvidenceBundle = buildEvidenceBundle({
  testCaseId: testCase.id,
  budget: DEFAULT_EVIDENCE_BUDGET,
  fragments: [],
  denied: [],
  unresolved: [],
  omitted: [],
});

const configuration: AuditRequest = {
  rootDir: '/repo',
  include: ['**/*.test.ts'],
  exclude: [],
  concurrency: 1,
  evidence: { maxFragmentBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes, maxBundleBytes: DEFAULT_EVIDENCE_BUDGET.maxBundleBytes, deny: [] },
  store: { databasePath: undefined },
  schedule: { requestsPerMinute: 1_200, tokensPerSecond: 250_000 },
  reportingOnly: true,
};

function score(probabilities: readonly [number, number, number, number]): JevAnswer {
  const record = { 0: probabilities[0], 1: probabilities[1], 2: probabilities[2], 3: probabilities[3] };
  const expected = probabilities.reduce((sum, p, level) => sum + p * level, 0);
  const confidence = Math.max(...probabilities);
  const legend = { 0: 'misleading', 1: 'weak', 2: 'acceptable', 3: 'strong' };
  const raw = { type: 'score' as const, score: expected, legend, probabilities: record, confidence };
  return { type: 'score', score: expected, legend, probabilities: record, confidence, raw };
}

/**
 * Every dimension applicable and decisively acceptable, except `assertion-strength`, which carries
 * the real recorded straddling distribution `{0.19, 0.39, 0.38, 0.04}` (deficientMass 0.58, see
 * `CLASSIFICATION_POLICY_V2`'s own doc): `needs-review` at `sideMin` 0.65, `weak` at 0.55.
 */
type Quartet = readonly [number, number, number, number];
const DEFICIENT_BAND: Quartet = [0.19, 0.39, 0.38, 0.04];
/** acceptableMass 0.6: inside `[0.575, 0.65)`, so `needs-review` under V2 and `acceptable` under V3. */
const ACCEPTABLE_BAND: Quartet = [0.05, 0.35, 0.5, 0.1];

function storedEvaluation(assertionStrength: Quartet = DEFICIENT_BAND): JevEvaluation {
  const answers: Record<string, JevAnswer> = {};
  for (const dimension of RUBRIC_V2.dimensions) {
    answers[dimension.applicability.id] = { type: 'noul', probability: 0.95, raw: { type: 'noul', noul: 0.95 } };
    answers[dimension.quality.id] = dimension.id === 'assertion-strength'
      ? score(assertionStrength)
      : score([0, 0.05, 0.45, 0.5]);
  }
  return {
    requestedModel: RUBRIC_V2.model,
    respondedModel: RUBRIC_V2.model,
    modelMatchesPin: true,
    answers,
    usage: { inputTokens: 900, outputTokens: 40 },
    attempts: 1,
  };
}

/** The cache-key formula exactly as shipped before task T1, including the policy version every existing store was written with. */
function legacyCacheKey(): string {
  const request = buildJevRequest({ testCase, bundle, rubric: RUBRIC_V2 });
  return sha256(JSON.stringify({
    request: canonicalizeJevRequest(request),
    fullTestSourceHash: sha256(normalizeTestSource(SOURCE)),
    rubricVersion: 2,
    policyVersion: 2,
  }));
}

describe('policy-free cache hits (task T1)', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function seededStore(assertionStrength: Quartet = DEFICIENT_BAND): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'jta-policy-free-'));
    const databaseFile = join(directory, 'audit.db');
    const store = await createSqliteAuditStore({ databaseFile });
    const runId = await store.beginRun('/repo');
    const evaluation = storedEvaluation(assertionStrength);
    await store.recordWorkItem(runId, {
      state: 'completed',
      identity: { testCaseId: testCase.id, repositoryRelativePath: testCase.repositoryRelativePath, name: testCase.name },
      cacheKey: legacyCacheKey(),
      evaluation,
      classification: classifyEvaluation({
        testCase: { testCaseId: testCase.id, repositoryRelativePath: testCase.repositoryRelativePath, name: testCase.name },
        evaluation,
        rubric: RUBRIC_V2,
        policy: CLASSIFICATION_POLICY_V2,
      }),
    });
    await store.finishRun(runId);
    await store.close();
    return databaseFile;
  }

  async function auditWithPolicy(databaseFile: string, policy: ClassificationPolicyV2) {
    let evaluateCalls = 0;
    const evaluation: AuditEvaluationPort = {
      async evaluate() {
        evaluateCalls += 1;
        throw new Error('a policy change must never reach the provider');
      },
    };
    const discovery: DiscoveryResult = { files: [{ repositoryRelativePath: testCase.repositoryRelativePath, framework: 'vitest', frameworkEvidence: [] }], excluded: [], diagnostics: [] };
    const store = await createSqliteAuditStore({ databaseFile });
    const ports: AuditPorts = {
      discovery: { discover: async () => discovery },
      sourceReader: { read: async () => SOURCE },
      extractor: { extract: () => ({ testCases: [testCase], dynamicMetadata: [], diagnostics: [] }) },
      evidence: { build: async () => ({ bundles: [bundle], diagnostics: [] }) },
      evaluation,
      store,
      cacheKey: createAuditCacheKeyPort(RUBRIC_V2, policy),
    };
    try {
      const result = await runAudit(configuration, ports);
      return { result, evaluateCalls };
    } finally {
      await store.close();
    }
  }

  it('an entry written under the pre-change key formula stays a hit under policy v2, re-derived locally', async () => {
    const databaseFile = await seededStore();

    const { result, evaluateCalls } = await auditWithPolicy(databaseFile, CLASSIFICATION_POLICY_V2);

    expect(evaluateCalls).toBe(0);
    expect(result.evaluation?.totals.cached).toBe(1);
    expect(result.evaluation?.classifications[0]?.status).toBe('needs-review');
  });

  async function auditWithDefaultPort(databaseFile: string) {
    let evaluateCalls = 0;
    const store = await createSqliteAuditStore({ databaseFile });
    const discovery: DiscoveryResult = { files: [{ repositoryRelativePath: testCase.repositoryRelativePath, framework: 'vitest', frameworkEvidence: [] }], excluded: [], diagnostics: [] };
    try {
      const result = await runAudit(configuration, {
        discovery: { discover: async () => discovery },
        sourceReader: { read: async () => SOURCE },
        extractor: { extract: () => ({ testCases: [testCase], dynamicMetadata: [], diagnostics: [] }) },
        evidence: { build: async () => ({ bundles: [bundle], diagnostics: [] }) },
        evaluation: { async evaluate() { evaluateCalls += 1; throw new Error('no provider request expected'); } },
        store,
        cacheKey: createAuditCacheKeyPort(),
      });
      return { result, evaluateCalls };
    } finally {
      await store.close();
    }
  }

  it('the default cache-key port re-classifies a pre-change entry under the shipped policy v3 with no provider request: an in-band acceptable mass is now decided', async () => {
    const databaseFile = await seededStore(ACCEPTABLE_BAND);

    const { result, evaluateCalls } = await auditWithDefaultPort(databaseFile);

    expect(evaluateCalls).toBe(0);
    expect(result.evaluation?.classifications[0]?.policyVersion).toBe(3);
    expect(result.evaluation?.classifications[0]?.status).toBe('healthy');
  });

  it('the shipped policy v3 keeps an in-band deficient mass (0.58) as needs-review — only the acceptable side moved', async () => {
    const databaseFile = await seededStore(DEFICIENT_BAND);

    const { result, evaluateCalls } = await auditWithDefaultPort(databaseFile);

    expect(evaluateCalls).toBe(0);
    expect(result.evaluation?.classifications[0]?.policyVersion).toBe(3);
    expect(result.evaluation?.classifications[0]?.status).toBe('needs-review');
  });

  it('changing the policy keeps the hit, makes no provider request, and classifies under the new policy', async () => {
    const databaseFile = await seededStore();
    const recalibrated: ClassificationPolicyV2 = { ...CLASSIFICATION_POLICY_V2, version: 3, sideMin: 0.55 };

    const { result, evaluateCalls } = await auditWithPolicy(databaseFile, recalibrated);

    expect(evaluateCalls).toBe(0);
    expect(result.evaluation?.totals.cached).toBe(1);
    const classification = result.evaluation?.classifications[0];
    expect(classification?.policyVersion).toBe(3);
    expect(classification?.status).toBe('weak');
    expect(classification?.usage).toEqual({ inputTokens: 900, outputTokens: 40 });
  });
});
