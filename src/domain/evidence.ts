import {
  normalizeRepositoryRelativePath,
  normalizeTestSource,
  type SourceSpan,
  type TestCaseId,
} from './test-understanding.js';

/** What repository role a fragment plays in a test case's evidence. */
export type EvidenceFragmentKind = 'test' | 'helper' | 'production-seam' | 'mock-target';

/** Why a fragment was selected as evidence for a test case. */
export type EvidenceSelectionReason =
  | 'test-body'
  | 'imported-binding-referenced'
  | 'mock-target-module'
  | 'hook-in-scope';

export interface EvidenceTruncation {
  readonly truncated: boolean;
  /**
   * Byte length of the untruncated candidate content, measured as UTF-8
   * bytes of newline-normalized (`\n` only) text. Measuring against the
   * normalized form keeps this value stable across CRLF/LF checkouts of the
   * same file.
   */
  readonly originalBytes: number;
  /** Byte length actually retained in `EvidenceFragment.content`, measured the same way as `originalBytes`. */
  readonly includedBytes: number;
}

export interface EvidenceFragment {
  readonly kind: EvidenceFragmentKind;
  readonly repositoryRelativePath: string;
  readonly span: SourceSpan;
  /**
   * The fragment's source text, stored newline-normalized (`\n` only) so
   * that `contentHash` and bundle canonicalization are stable regardless of
   * the originating file's line-ending style.
   */
  readonly content: string;
  readonly contentHash: string;
  readonly selectionReason: EvidenceSelectionReason;
  readonly truncation: EvidenceTruncation;
  readonly symbol?: string;
}

export interface DeniedEvidence {
  readonly repositoryRelativePath: string;
  readonly rule: string;
}

export type UnresolvedEvidenceReason =
  | 'bare-specifier'
  | 'alias-specifier'
  | 'not-found'
  | 'outside-root'
  | 'unsupported-extension'
  | 'dynamic-specifier';

export interface UnresolvedEvidence {
  readonly specifier: string;
  readonly reason: UnresolvedEvidenceReason;
}

export interface EvidenceBudget {
  readonly maxFragmentBytes: number;
  readonly maxBundleBytes: number;
}

export const DEFAULT_EVIDENCE_BUDGET: EvidenceBudget = {
  maxFragmentBytes: 4096,
  maxBundleBytes: 16384,
};

export function validateEvidenceBudget(budget: EvidenceBudget): void {
  if (!Number.isInteger(budget.maxFragmentBytes) || budget.maxFragmentBytes <= 0) {
    throw new RangeError(
      `Evidence budget maxFragmentBytes must be a positive integer: ${budget.maxFragmentBytes}`,
    );
  }
  if (!Number.isInteger(budget.maxBundleBytes) || budget.maxBundleBytes <= 0) {
    throw new RangeError(
      `Evidence budget maxBundleBytes must be a positive integer: ${budget.maxBundleBytes}`,
    );
  }
  if (budget.maxFragmentBytes > budget.maxBundleBytes) {
    throw new RangeError(
      `Evidence budget maxFragmentBytes (${budget.maxFragmentBytes}) must not exceed maxBundleBytes (${budget.maxBundleBytes})`,
    );
  }
}

export interface EvidenceTotals {
  readonly fragments: number;
  readonly includedBytes: number;
  readonly truncatedFragments: number;
}

export interface EvidenceBundle {
  readonly version: 1;
  readonly testCaseId: TestCaseId;
  readonly budget: EvidenceBudget;
  readonly fragments: readonly EvidenceFragment[];
  readonly denied: readonly DeniedEvidence[];
  readonly unresolved: readonly UnresolvedEvidence[];
  readonly totals: EvidenceTotals;
}

export interface EvidenceBundleInput {
  readonly testCaseId: TestCaseId;
  readonly budget: EvidenceBudget;
  readonly fragments: readonly EvidenceFragment[];
  readonly denied: readonly DeniedEvidence[];
  readonly unresolved: readonly UnresolvedEvidence[];
}

/** UTF-8 byte length of a string, via the global `TextEncoder` (no Node imports; domain stays pure). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeFragmentPath(fragment: EvidenceFragment): EvidenceFragment {
  const repositoryRelativePath = normalizeRepositoryRelativePath(fragment.repositoryRelativePath);
  return repositoryRelativePath === fragment.repositoryRelativePath
    ? fragment
    : { ...fragment, repositoryRelativePath };
}

function normalizeDeniedPath(denied: DeniedEvidence): DeniedEvidence {
  const repositoryRelativePath = normalizeRepositoryRelativePath(denied.repositoryRelativePath);
  return repositoryRelativePath === denied.repositoryRelativePath
    ? denied
    : { ...denied, repositoryRelativePath };
}

/**
 * Builds a deterministic {@link EvidenceBundle}: normalizes and validates
 * fragment/denied repository-relative paths, enforces the per-fragment and
 * per-bundle byte budgets against the already-computed
 * {@link EvidenceTruncation} byte counts, and computes totals.
 *
 * This does not select fragments, resolve imports, or fit content under
 * budget by truncating it — those are import resolution and fragment
 * selection concerns. Callers must supply fragments whose truncation byte
 * counts already respect the budget; this function only validates and
 * reports, it never truncates on the caller's behalf.
 */
export function buildEvidenceBundle(input: EvidenceBundleInput): EvidenceBundle {
  validateEvidenceBudget(input.budget);

  const fragments = input.fragments.map(normalizeFragmentPath);
  const denied = input.denied.map(normalizeDeniedPath);

  let includedBytes = 0;
  let truncatedFragments = 0;
  for (const fragment of fragments) {
    const { truncation } = fragment;
    if (
      !Number.isInteger(truncation.originalBytes) || truncation.originalBytes < 0
      || !Number.isInteger(truncation.includedBytes) || truncation.includedBytes < 0
    ) {
      throw new RangeError(
        `Evidence fragment truncation byte counts must be non-negative integers: ${fragment.repositoryRelativePath}`,
      );
    }
    const normalizedContentBytes = utf8ByteLength(normalizeTestSource(fragment.content));
    if (truncation.includedBytes !== normalizedContentBytes) {
      throw new RangeError(
        `Evidence fragment includedBytes (${truncation.includedBytes}) must equal the UTF-8 byte length `
        + `of its newline-normalized content (${normalizedContentBytes}): ${fragment.repositoryRelativePath}`,
      );
    }
    if (truncation.includedBytes > truncation.originalBytes) {
      throw new RangeError(
        `Evidence fragment includedBytes must not exceed originalBytes: ${fragment.repositoryRelativePath}`,
      );
    }
    if (truncation.truncated !== (truncation.includedBytes < truncation.originalBytes)) {
      throw new RangeError(
        `Evidence fragment truncated flag is inconsistent with its byte counts: ${fragment.repositoryRelativePath}`,
      );
    }
    if (truncation.includedBytes > input.budget.maxFragmentBytes) {
      throw new RangeError(
        `Evidence fragment exceeds the per-fragment budget: ${fragment.repositoryRelativePath}`,
      );
    }
    includedBytes += truncation.includedBytes;
    if (truncation.truncated) truncatedFragments += 1;
  }

  if (includedBytes > input.budget.maxBundleBytes) {
    throw new RangeError(
      `Evidence bundle exceeds the bundle budget: ${includedBytes} > ${input.budget.maxBundleBytes}`,
    );
  }

  return {
    version: 1,
    testCaseId: input.testCaseId,
    budget: input.budget,
    fragments,
    denied,
    unresolved: input.unresolved,
    totals: {
      fragments: fragments.length,
      includedBytes,
      truncatedFragments,
    },
  };
}

const FRAGMENT_KIND_ORDER: Readonly<Record<EvidenceFragmentKind, number>> = {
  test: 0,
  helper: 1,
  'production-seam': 2,
  'mock-target': 3,
};

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

interface CanonicalEvidenceFragment {
  readonly kind: EvidenceFragmentKind;
  readonly repositoryRelativePath: string;
  readonly span: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
  readonly symbol: string | null;
  readonly contentHash: string;
  readonly content: string;
  readonly selectionReason: EvidenceSelectionReason;
  readonly truncation: {
    readonly truncated: boolean;
    readonly originalBytes: number;
    readonly includedBytes: number;
  };
}

interface CanonicalDeniedEvidence {
  readonly repositoryRelativePath: string;
  readonly rule: string;
}

interface CanonicalUnresolvedEvidence {
  readonly specifier: string;
  readonly reason: UnresolvedEvidenceReason;
}

/**
 * Produces the canonical (normalized path, normalized content) form of a
 * fragment. Must run before any order-dependent step (sorting) so that
 * entries that differ only in path spelling or line-ending style compare
 * and serialize identically.
 */
function canonicalFragment(fragment: EvidenceFragment): CanonicalEvidenceFragment {
  return {
    kind: fragment.kind,
    repositoryRelativePath: normalizeRepositoryRelativePath(fragment.repositoryRelativePath),
    span: {
      start: { line: fragment.span.start.line, column: fragment.span.start.column },
      end: { line: fragment.span.end.line, column: fragment.span.end.column },
    },
    symbol: fragment.symbol ?? null,
    contentHash: fragment.contentHash,
    content: normalizeTestSource(fragment.content),
    selectionReason: fragment.selectionReason,
    truncation: {
      truncated: fragment.truncation.truncated,
      originalBytes: fragment.truncation.originalBytes,
      includedBytes: fragment.truncation.includedBytes,
    },
  };
}

/** Produces the canonical (normalized path) form of a denied entry. Must run before sorting; see {@link canonicalFragment}. */
function canonicalDenied(denied: DeniedEvidence): CanonicalDeniedEvidence {
  return {
    repositoryRelativePath: normalizeRepositoryRelativePath(denied.repositoryRelativePath),
    rule: denied.rule,
  };
}

function canonicalUnresolved(unresolved: UnresolvedEvidence): CanonicalUnresolvedEvidence {
  return {
    specifier: unresolved.specifier,
    reason: unresolved.reason,
  };
}

function compareCanonicalFragments(left: CanonicalEvidenceFragment, right: CanonicalEvidenceFragment): number {
  return (
    compareNumbers(FRAGMENT_KIND_ORDER[left.kind], FRAGMENT_KIND_ORDER[right.kind])
    || compareStrings(left.repositoryRelativePath, right.repositoryRelativePath)
    || compareNumbers(left.span.start.line, right.span.start.line)
    || compareNumbers(left.span.start.column, right.span.start.column)
    || compareStrings(left.symbol ?? '', right.symbol ?? '')
    || compareStrings(left.contentHash, right.contentHash)
  );
}

function compareCanonicalDenied(left: CanonicalDeniedEvidence, right: CanonicalDeniedEvidence): number {
  return (
    compareStrings(left.repositoryRelativePath, right.repositoryRelativePath)
    || compareStrings(left.rule, right.rule)
  );
}

function compareUnresolved(left: UnresolvedEvidence, right: UnresolvedEvidence): number {
  return (
    compareStrings(left.specifier, right.specifier)
    || compareStrings(left.reason, right.reason)
  );
}

/**
 * Serializes an {@link EvidenceBundle} to a stable JSON string: fixed key
 * order, fragments/denied/unresolved entries sorted deterministically
 * regardless of input order, repository-relative paths normalized, and
 * fragment content newline-normalized. Equal bundles always produce
 * byte-identical output, which is what Phase 5 hashes.
 *
 * Normalization always runs before sorting (`.map` before `.sort`): sorting
 * on raw, un-normalized fields would let two logically-equal entries that
 * differ only in path spelling (e.g. `./a.ts` vs `a.ts`) or line-ending
 * style land in different relative positions, producing different output
 * for equal bundles.
 */
export function canonicalizeEvidenceBundle(bundle: EvidenceBundle): string {
  const fragments = bundle.fragments.map(canonicalFragment).sort(compareCanonicalFragments);
  const denied = bundle.denied.map(canonicalDenied).sort(compareCanonicalDenied);
  const unresolved = [...bundle.unresolved].sort(compareUnresolved).map(canonicalUnresolved);

  return JSON.stringify({
    version: bundle.version,
    testCaseId: bundle.testCaseId,
    budget: {
      maxFragmentBytes: bundle.budget.maxFragmentBytes,
      maxBundleBytes: bundle.budget.maxBundleBytes,
    },
    totals: {
      fragments: bundle.totals.fragments,
      includedBytes: bundle.totals.includedBytes,
      truncatedFragments: bundle.totals.truncatedFragments,
    },
    fragments,
    denied,
    unresolved,
  });
}
