import { normalizeTestSource } from '../domain/test-understanding.js';
import { canonicalizeEvidenceBundle, type EvidenceBundle } from '../domain/evidence.js';
import { sha256 } from './hash.js';

/** SHA-256 of the newline-normalized content, for `EvidenceFragment.contentHash`. */
export function hashEvidenceContent(content: string): string {
  return sha256(normalizeTestSource(content));
}

/** SHA-256 of the bundle's canonical serialization. Stable for equal bundles, for Phase 5 caching. */
export function hashEvidenceBundle(bundle: EvidenceBundle): string {
  return sha256(canonicalizeEvidenceBundle(bundle));
}
