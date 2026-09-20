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
 *   - the classification policy's own numeric `version`: never sent to Jev
 *     at all — the policy runs entirely locally, after the fact, against
 *     the already-returned raw answers, so nothing about it could ever
 *     appear in a `JevRequest`.
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
import { CLASSIFICATION_POLICY_V2 } from '../domain/classification.js';
import { buildJevRequest, canonicalizeJevRequest, type JevRequest } from '../domain/jev-request.js';
import { RUBRIC_V2, type Rubric } from '../domain/rubric.js';
import type { AuditCacheKeyPort, AuditEvaluationRequest } from '../domain/audit.js';
import { sha256 } from './hash.js';

export interface CacheKeyInput {
  readonly request: JevRequest;
  /** The whole file's raw, un-normalized source text — normalized (and hashed) inside {@link computeCacheKey}, never by the caller. */
  readonly fullTestSource: string;
  readonly rubricVersion: number;
  readonly policyVersion: number;
}

/**
 * Computes the cache key: `sha256` over a JSON payload combining
 * `canonicalizeJevRequest(input.request)`, the normalized full test-source
 * hash, `input.rubricVersion`, and `input.policyVersion` — see this
 * module's own doc for exactly which of those four ingredients the
 * canonical request serialization already covers on its own. Deterministic
 * and independent of `rootDir`: nothing here ever sees an absolute path
 * (`canonicalizeJevRequest`'s paths are already repository-relative, per
 * Phase 3 provenance).
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const payload = JSON.stringify({
    request: canonicalizeJevRequest(input.request),
    fullTestSourceHash: sha256(normalizeTestSource(input.fullTestSource)),
    rubricVersion: input.rubricVersion,
    policyVersion: input.policyVersion,
  });
  return sha256(payload);
}

/**
 * Creates the production {@link AuditCacheKeyPort}, pinned to `rubric` and
 * `policyVersion` (defaulting to the shipped `RUBRIC_V2`/
 * `CLASSIFICATION_POLICY_V2.version` — the exact pair
 * `src/adapters/jev-evaluation-port.ts` wires for real evaluation, so a
 * cache key always describes the same request an actual evaluation attempt
 * would make). No I/O, no state: safe to construct freely.
 */
export function createAuditCacheKeyPort(
  rubric: Rubric = RUBRIC_V2,
  policyVersion: number = CLASSIFICATION_POLICY_V2.version,
): AuditCacheKeyPort {
  return {
    computeKey(request: AuditEvaluationRequest, fullTestSource: string): string {
      const jevRequest = buildJevRequest({ testCase: request.testCase, bundle: request.bundle, rubric });
      return computeCacheKey({ request: jevRequest, fullTestSource, rubricVersion: rubric.version, policyVersion });
    },
  };
}
