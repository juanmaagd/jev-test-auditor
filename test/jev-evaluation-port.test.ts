import { describe, expect, it } from 'vitest';
import { createJevEvaluationPort } from '../src/adapters/jev-evaluation-port.js';
import { CLASSIFICATION_POLICY_V2, classifyEvaluation } from '../src/domain/classification.js';
import type { AuditEvaluationRequest } from '../src/domain/audit.js';
import { buildEvidenceBundle, DEFAULT_EVIDENCE_BUDGET, type EvidenceBundle } from '../src/domain/evidence.js';
import type { JevAnswer, JevEvaluation, JevGatewayPort } from '../src/domain/jev-gateway.js';
import type { JevRequest } from '../src/domain/jev-request.js';
import { JEV_MODEL_ID, RUBRIC_V2 } from '../src/domain/rubric.js';
import type { TestCase, TestCaseId } from '../src/domain/test-understanding.js';

const zeroSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };

function testCase(id: string): TestCase {
  return {
    id: id as TestCaseId,
    repositoryRelativePath: 'a.test.ts',
    kind: 'test',
    framework: 'vitest',
    name: 'adds numbers',
    structuralAncestry: [{ kind: 'test', name: 'adds numbers', ordinal: 0 }],
    source: "test('adds numbers', () => {});",
    span: zeroSpan,
    modifiers: [],
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
  };
}

function bundleFor(testCaseId: string): EvidenceBundle {
  return buildEvidenceBundle({
    testCaseId: testCaseId as TestCaseId,
    budget: DEFAULT_EVIDENCE_BUDGET,
    fragments: [],
    denied: [],
    unresolved: [],
    omitted: [],
  });
}

/** Fixed, deterministic answers for every RUBRIC_V2 question: every `.applicable` noul is low (0.1, below `applicabilityMin` 0.5, shared by V1 and V2), so every dimension is `not-applicable` and the `.quality` score is never read regardless of policy version. */
function fixedAnswersGateway(recordedRequests: JevRequest[]): JevGatewayPort {
  return {
    async evaluate(request: JevRequest): Promise<JevEvaluation> {
      recordedRequests.push(request);
      const answers: Record<string, JevAnswer> = {};
      for (const questionId of Object.keys(request.questions)) {
        answers[questionId] = questionId.endsWith('.applicable')
          ? { type: 'noul', probability: 0.1, raw: { type: 'noul', noul: 0.1 } }
          : {
            type: 'score',
            score: 0,
            legend: { '0': 'Misleading', '1': 'Weak', '2': 'Acceptable', '3': 'Strong' },
            probabilities: { '0': 0.25, '1': 0.25, '2': 0.25, '3': 0.25 },
            confidence: 0.9,
            raw: {
              type: 'score',
              score: 0,
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
        usage: { inputTokens: 123, outputTokens: 0 },
        attempts: 1,
      };
    },
  };
}

describe('createJevEvaluationPort', () => {
  it('builds the request from RUBRIC_V2, calls the gateway, and classifies the result with CLASSIFICATION_POLICY_V2 — matching classifyEvaluation applied by hand to the same gateway response', async () => {
    const recordedRequests: JevRequest[] = [];
    const gateway = fixedAnswersGateway(recordedRequests);
    const port = createJevEvaluationPort(gateway);
    const request: AuditEvaluationRequest = { testCase: testCase('tc:v1:abc'), bundle: bundleFor('tc:v1:abc') };

    const result = await port.evaluate(request);

    expect(recordedRequests).toHaveLength(1);
    expect(recordedRequests[0]?.model).toBe(JEV_MODEL_ID);
    expect(Object.keys(recordedRequests[0]?.questions ?? {})).toHaveLength(14);

    const expectedEvaluation = await gateway.evaluate(recordedRequests[0] as JevRequest);
    const expected = classifyEvaluation({
      testCase: { testCaseId: request.testCase.id, repositoryRelativePath: request.testCase.repositoryRelativePath, name: request.testCase.name },
      evaluation: expectedEvaluation,
      rubric: RUBRIC_V2,
      policy: CLASSIFICATION_POLICY_V2,
    });
    // Phase 5, task P5-1: `evaluate` now returns both the raw `JevEvaluation` (so a future policy
    // version can recompute the judgment without another Jev call) and the derived classification.
    expect(result.evaluation).toEqual(expectedEvaluation);
    expect(result.classification).toEqual(expected);
    expect(result.classification.status).toBe('needs-review');
    expect(result.classification.dimensions).toHaveLength(7);
    expect(result.classification.dimensions.every((dimension) => dimension.status === 'not-applicable')).toBe(true);
    // Asserts the shipped path's policy version directly (not only via the toEqual above), so a
    // regression that reverts src/adapters/jev-evaluation-port.ts to CLASSIFICATION_POLICY_V1
    // fails here even if some future change made the two policies coincidentally agree elsewhere.
    expect(result.classification.policyVersion).toBe(CLASSIFICATION_POLICY_V2.version);
    // Asserts the shipped path's rubric version directly (task C-2): a regression that reverts
    // src/adapters/jev-evaluation-port.ts to RUBRIC_V1 while CLASSIFICATION_POLICY_V2.rubricVersion
    // stays pinned to 2 would throw RangeError from classifyEvaluation's own version guard before
    // this assertion is even reached, which is itself the guard this test exists to exercise.
    expect(result.classification.rubricVersion).toBe(RUBRIC_V2.version);
  });

  it('propagates a gateway rejection untouched (no wrapping, no swallowing) so the application layer sees the original typed error', async () => {
    const boom = new Error('gateway boom');
    const port = createJevEvaluationPort({ evaluate: async () => { throw boom; } });

    await expect(port.evaluate({ testCase: testCase('tc:v1:abc'), bundle: bundleFor('tc:v1:abc') })).rejects.toBe(boom);
  });

  it('throws RangeError before calling the gateway when the bundle test case id does not match the test case (buildJevState\'s own guard)', async () => {
    let called = false;
    const port = createJevEvaluationPort({ evaluate: async () => { called = true; throw new Error('must not be called'); } });

    await expect(port.evaluate({ testCase: testCase('tc:v1:abc'), bundle: bundleFor('tc:v1:mismatched') })).rejects.toThrow(RangeError);
    expect(called).toBe(false);
  });
});
