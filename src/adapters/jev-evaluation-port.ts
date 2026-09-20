/**
 * The production `AuditEvaluationPort` (Phase 4, task P4-4): composes the
 * pure domain pieces from earlier Phase 4 tasks — `buildJevRequest` (P4-1),
 * a `JevGatewayPort` (P4-2), and `classifyEvaluation` (P4-3) — into the one
 * seam `runAudit` calls per evaluable test case. Deliberately thin: this
 * file owns no policy of its own, only wiring the shipped `RUBRIC_V2` and
 * `CLASSIFICATION_POLICY_V2` together and letting every error (a malformed
 * bundle/test-case pair from `buildJevRequest`, or any typed `JevGatewayError`
 * from the gateway) propagate untouched — `runAudit` is what turns a
 * rejection into an isolated `evaluation-failed` diagnostic (see
 * `src/application/audit.ts`), never this adapter.
 *
 * Wired to `CLASSIFICATION_POLICY_V2` (`odd/tasks/classification-calibration.md`
 * task C-1): the shipped `--evaluate` path uses the boundary-mass gate
 * instead of `CLASSIFICATION_POLICY_V1`'s retired confidence gate. A policy
 * this adapter never constructs is not a delivered fix — the report's
 * `policyVersion` and per-dimension `probabilities`/mass fields only reach a
 * real `--evaluate --json` run through this one seam.
 *
 * Wired to `RUBRIC_V2` (task C-2 of the same feature doc, which repairs the
 * `determinism-isolation`/`falsifiability` applicability questions and bumps
 * `CLASSIFICATION_POLICY_V2.rubricVersion` to match): a rubric this adapter
 * never constructs is not a delivered fix either, and `classifyEvaluation`
 * fails closed (`RangeError`) on any rubric/policy version mismatch, so this
 * import and `CLASSIFICATION_POLICY_V2`'s pin must move together.
 */
import type { AuditEvaluationPort, AuditEvaluationRequest } from '../domain/audit.js';
import { classifyEvaluation, CLASSIFICATION_POLICY_V2, type ClassificationResult } from '../domain/classification.js';
import type { JevGatewayPort } from '../domain/jev-gateway.js';
import { buildJevRequest } from '../domain/jev-request.js';
import { RUBRIC_V2 } from '../domain/rubric.js';

/**
 * Creates the production {@link AuditEvaluationPort} backed by `gateway`.
 * `gateway` is injected (never constructed here) so the CLI composition
 * root controls exactly when a real `JevGatewayPort` — and the eager API
 * key validation `createJevHttpGateway` performs — comes into existence
 * (see `AuditEvaluationPort`'s own doc in `src/domain/audit.ts` for the
 * full opt-in contract this depends on).
 */
export function createJevEvaluationPort(gateway: JevGatewayPort): AuditEvaluationPort {
  return {
    async evaluate(request: AuditEvaluationRequest): Promise<ClassificationResult> {
      const jevRequest = buildJevRequest({ testCase: request.testCase, bundle: request.bundle, rubric: RUBRIC_V2 });
      const evaluation = await gateway.evaluate(jevRequest);
      return classifyEvaluation({
        testCase: {
          testCaseId: request.testCase.id,
          repositoryRelativePath: request.testCase.repositoryRelativePath,
          name: request.testCase.name,
        },
        evaluation,
        rubric: RUBRIC_V2,
        policy: CLASSIFICATION_POLICY_V2,
      });
    },
  };
}
