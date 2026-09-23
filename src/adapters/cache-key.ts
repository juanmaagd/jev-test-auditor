/**
 * The complete content-addressed cache key (Phase 5, task P5-2): identifies
 * exactly the request a real evaluation attempt would make, so an
 * unchanged test is never paid for twice and any input that would change
 * Jev's judgment invalidates it cleanly.
 *
 * Built on `canonicalizeJevRequest` (`src/domain/jev-request.ts`), which
 * already deterministically serializes `{ state, model, questions }` — see
 * that function's own doc. Reading its coverage precisely (Phase 5,
 * `odd/tasks/phase-5-persistence.md` task P5-2):
 *
 * - **Already covered by `canonicalizeJevRequest`, no separate hash input
 *   needed here**: the pinned model id (`request.model`, ultimately
 *   `rubric.model` — e.g. `jev-1.13.0`), every rubric question's wording
 *   (`request.questions`, built from `rubric.dimensions`), and the
 *   evidence bundle's *selected* fragments/denied/unresolved/omitted
 *   entries (`request.state.fragments` etc., built from the
 *   `EvidenceBundle` passed to `buildJevRequest`). A change to any of
 *   these already changes `canonicalizeJevRequest`'s output byte-for-byte,
 *   so hashing them again here would be redundant, not merely harmless —
 *   see `test/cache-key.test.ts`'s "already covered" tests, which prove
 *   this rather than assert it.
 * - **NOT covered, and added explicitly here**:
 *   - the normalized full test-file source hash: `state.fragments` carries
 *     only what evidence selection actually chose (the test body span, any
 *     in-scope hooks, referenced helpers/production seams) — never the
 *     whole file. An edit anywhere else in the file (an unrelated test, a
 *     comment, a helper not currently pulled in as evidence) would
 *     otherwise go completely undetected.
 *   - the rubric's own numeric `version`: never embedded in `state`,
 *     `model`, or `questions` anywhere. Today a rubric bump also rewrites
 *     question wording (so `canonicalizeJevRequest`'s output already
 *     differs on its own — see the "pre-v2 rubric" test), but the Phase 5
 *     decision is to key on the version explicitly, so a hypothetical
 *     future bump whose wording happens to stay byte-identical still
 *     invalidates cleanly.
 *
 * **Deliberately NOT covered: the classification policy.** The policy never
 * reaches Jev — it runs entirely locally, after the fact, over the stored raw
 * answers — so a cache hit re-derives its classification under the CURRENT
 * policy ({@link AuditCacheKeyPort.classifyCached}) instead of reusing the
 * stored verdict, and a policy change never costs a provider request
 * (`odd/tasks/policy-free-cache-and-calibration.md`, task T1). The payload
 * still carries a `policyVersion` field, frozen at
 * {@link LEGACY_POLICY_VERSION_SLOT}: every audit store written before T1
 * hashed that exact value, and keeping the payload byte-identical is what
 * keeps those entries hits instead of re-billing a whole suite once.
 *
 * `hashEvidenceBundle` (`src/adapters/evidence-hash.ts`) is deliberately
 * NOT used here, even though it exists for exactly this phase: its
 * `canonicalizeEvidenceBundle` serialization additionally includes each
 * fragment's `span`, `contentHash`, and byte counts, which would
 * over-invalidate the key on a pure line-shift with unchanged fragment
 * content. `state.fragments` (already inside `canonicalizeJevRequest`,
 * via `JevStateFragment`) deliberately excludes exactly those fields
 * (see `src/domain/jev-request.ts`'s own doc on `JevStateFragment`) —
 * carrying only what Jev actually saw, which is what should invalidate
 * the judgment.
 */
import { normalizeTestSource } from '../domain/test-understanding.js';
import { CLASSIFICATION_POLICY_V2, classifyEvaluation, type ClassificationPolicy, type ClassificationResult } from '../domain/classification.js';
import type { JevEvaluation } from '../domain/jev-gateway.js';
import { buildJevRequest, canonicalizeJevRequest, type JevRequest } from '../domain/jev-request.js';
import { RUBRIC_V2, type Rubric } from '../domain/rubric.js';
import type { AuditCacheKeyPort, AuditEvaluationRequest } from '../domain/audit.js';

/**
 * The `policyVersion` value hashed into every cache key, frozen forever at
 * the classification policy version every pre-T1 audit store was written
 * with. It is not a policy pin and must never change: changing it would turn
 * every existing entry into a miss and re-bill the whole suite. See this
 * module's doc.
 */
export const LEGACY_POLICY_VERSION_SLOT = 2;
import { sha256 } from './hash.js';

export interface CacheKeyInput {
  readonly request: JevRequest;
  /** The whole file's raw, un-normalized source text — normalized (and hashed) inside {@link computeCacheKey}, never by the caller. */
  readonly fullTestSource: string;
  readonly rubricVersion: number;
}

/**
 * Computes the cache key: `sha256` over a JSON payload combining
 * `canonicalizeJevRequest(input.request)`, the normalized full test-source
 * hash, `input.rubricVersion`, and the frozen {@link LEGACY_POLICY_VERSION_SLOT}
 * — see this module's own doc for exactly which ingredients the canonical
 * request serialization already covers on its own, and why the policy slot
 * is a constant. Deterministic
 * and independent of `rootDir`: nothing here ever sees an absolute path
 * (`canonicalizeJevRequest`'s paths are already repository-relative, per
 * Phase 3 provenance).
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const payload = JSON.stringify({
    request: canonicalizeJevRequest(input.request),
    fullTestSourceHash: sha256(normalizeTestSource(input.fullTestSource)),
    rubricVersion: input.rubricVersion,
    policyVersion: LEGACY_POLICY_VERSION_SLOT,
  });
  return sha256(payload);
}

/**
 * Creates the production {@link AuditCacheKeyPort}, pinned to `rubric` and
 * `policy` (defaulting to the shipped `RUBRIC_V2`/`CLASSIFICATION_POLICY_V2`
 * — the exact pair `src/adapters/jev-evaluation-port.ts` wires for real
 * evaluation). `rubric` shapes the key, so a key always describes the same
 * request an actual evaluation attempt would make; `policy` never touches the
 * key and only classifies a hit's stored raw answers. No I/O, no state: safe
 * to construct freely.
 */
export function createAuditCacheKeyPort(
  rubric: Rubric = RUBRIC_V2,
  policy: ClassificationPolicy = CLASSIFICATION_POLICY_V2,
): AuditCacheKeyPort {
  return {
    computeKey(request: AuditEvaluationRequest, fullTestSource: string): string {
      const jevRequest = buildJevRequest({ testCase: request.testCase, bundle: request.bundle, rubric });
      return computeCacheKey({ request: jevRequest, fullTestSource, rubricVersion: rubric.version });
    },
    classifyCached(request: AuditEvaluationRequest, evaluation: JevEvaluation): ClassificationResult {
      return classifyEvaluation({
        testCase: {
          testCaseId: request.testCase.id,
          repositoryRelativePath: request.testCase.repositoryRelativePath,
          name: request.testCase.name,
        },
        evaluation,
        rubric,
        policy,
      });
    },
  };
}
