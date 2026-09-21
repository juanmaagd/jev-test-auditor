import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBenchmarkSamplePort } from '../src/adapters/benchmark-sample-port.js';
import { createSqliteAuditStore, resolveAuditStorePaths } from '../src/adapters/sqlite-audit-store.js';
import { loadCorpusCase } from '../src/adapters/corpus-store.js';
import type { JevAnswer, JevEvaluation, JevGatewayPort } from '../src/domain/jev-gateway.js';
import type { JevRequest } from '../src/domain/jev-request.js';
import { afterEach, describe, expect, it } from 'vitest';

const CORPUS_DIR = 'test/fixtures/corpus/discrimination';
const REAL_CASE_ID = 'checkout-applies-percent';

/**
 * Answers every question the real rubric generates, deterministically, from
 * a caller-supplied `status`: `'healthy'` returns every applicability noul
 * low (nothing applicable, so every dimension is `not-applicable` and the
 * overall status is `needs-review`... — no: for a genuinely predictable,
 * distinguishable status this stub instead makes exactly one dimension
 * `misleading`-worthy when `unhealthy` is requested, and every dimension
 * inapplicable (a real `healthy`-producing shape would need every dimension
 * `judged`+`strong`, which is unnecessary for this suite's purposes — see
 * each test's own assertions for exactly what is checked).
 */
function stubGateway(recordedRequests: JevRequest[], scoreForNonApplicability: 0 | 3 = 0): JevGatewayPort {
  return {
    async evaluate(request: JevRequest): Promise<JevEvaluation> {
      recordedRequests.push(request);
      const answers: Record<string, JevAnswer> = {};
      for (const questionId of Object.keys(request.questions)) {
        answers[questionId] = questionId.endsWith('.applicable')
          ? { type: 'noul', probability: 0.1, raw: { type: 'noul', noul: 0.1 } }
          : {
            type: 'score',
            score: scoreForNonApplicability,
            legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
            probabilities: { '0': 0.25, '1': 0.25, '2': 0.25, '3': 0.25 },
            confidence: 0.9,
            raw: {
              type: 'score',
              score: scoreForNonApplicability,
              legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
              probabilities: { '0': 0.25, '1': 0.25, '2': 0.25, '3': 0.25 },
              confidence: 0.9,
            },
          };
      }
      return {
        requestedModel: request.model,
        respondedModel: request.model,
        modelMatchesPin: true,
        answers,
        usage: { inputTokens: 42, outputTokens: 7 },
        attempts: 1,
      };
    },
  };
}

const restoreEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string): void {
  if (!restoreEnv.has(key)) restoreEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of restoreEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restoreEnv.clear();
});

describe('createBenchmarkSamplePort', () => {
  it('samples a real corpus case: discovers its test.ts, resolves evidence from its real production file, and returns exactly one classification', async () => {
    const recordedRequests: JevRequest[] = [];
    const port = createBenchmarkSamplePort(CORPUS_DIR, stubGateway(recordedRequests));
    const corpusCase = await loadCorpusCase(`${CORPUS_DIR}/${REAL_CASE_ID}`);

    const result = await port.sample(corpusCase);

    expect(result.kind).toBe('sampled');
    if (result.kind !== 'sampled') throw new Error(`expected sampled, got failed: ${JSON.stringify(result)}`);
    expect(recordedRequests).toHaveLength(1);
    expect(result.classification.name).toBe('applies a 10 percent discount to a 25 cart');
    expect(result.classification.repositoryRelativePath).toBe('test.ts');
    expect(result.classification.dimensions.length).toBeGreaterThan(0);
  });

  it('bypasses any cache by construction: two samples of the identical case both reach the gateway, never served from a stored judgment', async () => {
    const recordedRequests: JevRequest[] = [];
    // Alternates the score so the two responses are genuinely distinguishable — a test that
    // returned the same classification both times either way could not tell "dispatched twice"
    // apart from "served the first response back out of a cache."
    let call = 0;
    const gateway: JevGatewayPort = {
      async evaluate(request: JevRequest): Promise<JevEvaluation> {
        call += 1;
        recordedRequests.push(request);
        // Call 1: every dimension decisively misleading (deficientMass=1 >= sideMin 0.65,
        // criticalMass=1 >= criticalMin 0.5) -> overall 'misleading'.
        // Call 2: every dimension decisively strong (acceptableMass=1 >= sideMin 0.65,
        // levelForScore(3, [1,2,3]) = 'strong') -> overall 'healthy'. Genuinely distinguishable
        // probability mass, not just a different discrete `score` field.
        const score = call === 1 ? 0 : 3;
        const probabilities = call === 1 ? { '0': 1, '1': 0, '2': 0, '3': 0 } : { '0': 0, '1': 0, '2': 0, '3': 1 };
        const answers: Record<string, JevAnswer> = {};
        for (const questionId of Object.keys(request.questions)) {
          answers[questionId] = questionId.endsWith('.applicable')
            ? { type: 'noul', probability: 0.9, raw: { type: 'noul', noul: 0.9 } }
            : {
              type: 'score',
              score,
              legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
              probabilities,
              confidence: 0.95,
              raw: {
                type: 'score',
                score,
                legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
                probabilities,
                confidence: 0.95,
              },
            };
        }
        return {
          requestedModel: request.model,
          respondedModel: request.model,
          modelMatchesPin: true,
          answers,
          usage: { inputTokens: 1, outputTokens: 1 },
          attempts: 1,
        };
      },
    };
    const port = createBenchmarkSamplePort(CORPUS_DIR, gateway);
    const corpusCase = await loadCorpusCase(`${CORPUS_DIR}/${REAL_CASE_ID}`);

    const first = await port.sample(corpusCase);
    const second = await port.sample(corpusCase);

    expect(call).toBe(2);
    if (first.kind !== 'sampled' || second.kind !== 'sampled') throw new Error('expected both samples to succeed');
    expect(first.classification.status).toBe('misleading');
    expect(second.classification.status).toBe('healthy');
  });

  it('never opens, reads, or writes the user\'s real audit store — a store created before sampling is byte-identical after', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'jev-benchmark-sample-audit-untouched-'));
    setEnv('XDG_CONFIG_HOME', tempRoot);

    try {
      const auditPaths = resolveAuditStorePaths();
      const auditStore = await createSqliteAuditStore({ databaseFile: auditPaths.databaseFile });
      await auditStore.beginRun('/some/repo');
      await auditStore.close();
      const before = await readFile(auditPaths.databaseFile);

      const port = createBenchmarkSamplePort(CORPUS_DIR, stubGateway([]));
      const corpusCase = await loadCorpusCase(`${CORPUS_DIR}/${REAL_CASE_ID}`);
      await port.sample(corpusCase);

      const after = await readFile(auditPaths.databaseFile);
      expect(after.equals(before)).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports a sample failure (never throws, never fabricates a classification) when the gateway itself rejects', async () => {
    const boom = new Error('provider unavailable');
    const port = createBenchmarkSamplePort(CORPUS_DIR, { evaluate: async () => { throw boom; } });
    const corpusCase = await loadCorpusCase(`${CORPUS_DIR}/${REAL_CASE_ID}`);

    const result = await port.sample(corpusCase);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected a failure result');
    expect(result.errorMessage).toContain('provider unavailable');
  });
});
