/**
 * Deciding *whether an operator's declared effect held* (task P7-2,
 * `odd/tasks/phase-7-benchmarks.md`). Pure, exactly like every other module
 * under `src/domain`: no I/O, no timers, no process spawning (enforced by
 * `test/architecture-boundary.test.ts`). *Producing* an observation — copying
 * files to a scratch directory, spawning a test runner, enforcing a timeout —
 * is `src/adapters/oracle-runner.ts`'s job; this module only ever computes
 * with strings and already-recorded observations it is handed.
 *
 * **Two questions, two kinds of function.** (1) *What should be run?*
 * {@link buildOraclePlan} turns one already-parsed {@link CorpusCase} into an
 * {@link OraclePlan}: a small, ordered list of {@link OracleRun}s, each a
 * complete, self-contained file set plus which file in it is the spec entry.
 * Building a plan never runs anything — it only ever transforms strings
 * already in memory (`CorpusCase.baseTest`/`productionSources`, read by
 * `src/adapters/corpus-store.ts` from the committed corpus) into *new*
 * strings for a *different* run to execute; it can therefore never touch,
 * let alone mutate, the Git-stored corpus, and the "never mutate the corpus"
 * guarantee is structural rather than a discipline this module has to
 * remember. (2) *What did that mean?* {@link decideProof} takes a
 * {@link CorpusCase} and the {@link RunObservation}s an adapter recorded for
 * its plan's runs, and decides `'proven'` or `'unproven'` (with a specific
 * reason) — never a bare boolean, so a caller can always say *why* a case did
 * not count.
 *
 * **Every case gets a baseline run first.** Per the phase Decisions, a
 * fixture case is "a base test that genuinely passes against its production
 * code" — a claim P7-1 stored but never executed. `buildOraclePlan` always
 * puts an unmutated `'baseline'` run first in `OraclePlan.runs`; `decideProof`
 * treats anything other than a `'passed'` baseline as `'baseline-failed'`
 * regardless of what any later run observed, since a case whose own baseline
 * does not pass was never a valid triple to begin with.
 *
 * **Declarative, named, anchor-checked mutations.** Per this phase's own
 * instruction to prefer "a small set of deterministic, declarative mutations
 * ... whose effect is obvious to a reviewer reading the diff" over a general
 * mutation engine: every production mutation and every prescriptive-operator
 * test variant is one named {@link TextTransform} — an exact substring
 * (`anchor`) replaced by fixed text — applied by {@link applyTextTransform},
 * which throws unless the anchor occurs in the source *exactly* once. A
 * transform that cannot find its anchor (a corpus case's file changed under
 * it) fails loudly, at plan-build time, before anything is ever spawned;
 * {@link buildOraclePlan} catches that and reports the case
 * `'unrealizable'` (`mutation-anchor-not-found`) rather than silently
 * producing an unmutated, meaningless plan.
 *
 * **`oracleKind` does not change the mechanical procedure this module runs.**
 * Reading each of the 11 real corpus cases' own `productionEffect` prose
 * (see `odd/tasks/phase-7-benchmarks.md`'s P7-2 report): every
 * `'descriptive'` case, regardless of its declared `oracleKind`
 * (`production-mutation` or `semantics-preserving-refactor`), is proven by
 * exactly one declarative production-side transform plus a single run of the
 * unmodified base test against it. Every `'prescriptive'` case — regardless
 * of whether its `oracleKind` is `production-mutation` or
 * `assertion-mutation` — is proven by the *same* two-run comparison: the
 * unmodified base test against one fixed production mutation (expected to
 * flip to failing), then the operator-derived *variant* test against that
 * *same* mutation (expected to keep passing, showing the operator hides the
 * defect the base test caught). `oracleKind` therefore only ever selects
 * *which* transform is meaningful for a given case's own claim — never a
 * different run shape — in this corpus. `'repeated-randomized-execution'`
 * (exactly one real case, `records-history-shared-state`) is the one
 * genuinely different mechanical shape: see {@link duplicateDescribeBlock}.
 */
import type {
  CorpusCase,
  CorpusExpectedOutcome,
  CorpusOperatorId,
  CorpusOperatorRole,
  CorpusOracleKind,
  CorpusSourceFile,
} from './corpus.js';

/** One committed file's exact bytes, ready to be materialized by an adapter — never written by this module itself. */
export interface OracleProofFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * One thing an adapter must actually run: a complete, self-contained file
 * set (every production file the case declares, plus exactly one test
 * file), which of those files is the spec entry (`testFile`, matched by
 * `path` against one entry of `files`), how many individual test results
 * the adapter should expect to see if this run truly executed as intended
 * (`expectedTestCount` — a mismatch means the run never really happened:
 * a load/parse error, a renamed file, or a mutation that broke the file's
 * syntax), and which of `files` differ from the case's own committed bytes
 * (`mutatedFiles`, empty for `'baseline'`).
 */
export interface OracleRun {
  readonly label: string;
  readonly files: readonly OracleProofFile[];
  readonly testFile: string;
  readonly expectedTestCount: number;
  readonly mutatedFiles: readonly string[];
}

/** One case's full set of runs, in the order an adapter should execute them. */
export interface OraclePlan {
  readonly caseId: string;
  readonly runs: readonly OracleRun[];
}

/**
 * `buildOraclePlan` never throws: a case with no registered recipe, or whose
 * registered transform's anchor no longer matches its committed bytes, is
 * `'unrealizable'` with a specific `reason` — never a silently-empty or
 * silently-unmutated plan.
 */
export type OraclePlanResult =
  | { readonly kind: 'plan'; readonly plan: OraclePlan }
  | { readonly kind: 'unrealizable'; readonly reason: string };

/** One exact-substring, applied-at-most-once declarative text mutation. See {@link applyTextTransform}. */
export interface TextTransform {
  readonly id: string;
  readonly anchor: string;
  readonly replacement: string;
}

function countOccurrences(source: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = source.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Applies one named {@link TextTransform} to `source`. Throws a
 * `RangeError` naming the transform's `id` unless `transform.anchor` occurs
 * in `source` *exactly* once — zero occurrences means the transform no
 * longer applies to this file (it drifted, or was never valid for it); more
 * than one means the transform is ambiguous about which occurrence it means,
 * which this module refuses to guess at. Both failure shapes are exactly
 * what makes every mutation here "obvious to a reviewer reading the diff":
 * there is never more than one place the diff could have landed.
 */
export function applyTextTransform(source: string, transform: TextTransform): string {
  const occurrences = countOccurrences(source, transform.anchor);
  if (occurrences !== 1) {
    throw new RangeError(
      `Text transform "${transform.id}" expects its anchor to occur exactly once, found ${occurrences}: ${JSON.stringify(transform.anchor)}`,
    );
  }
  return source.replace(transform.anchor, transform.replacement);
}

/**
 * Production-side declarative mutations (Decisions: "removing an assertion,
 * weakening an expectation, ..." are TEST-side operators; these are the
 * PRODUCTION-side corruptions/refactors the four oracle kinds act on —
 * see the module doc's "`oracleKind` does not change the mechanical
 * procedure" note). Every anchor/replacement pair below is taken verbatim
 * from the corresponding case's own `productionEffect` "(for example ...)"
 * parenthetical in its `case.json` (`test/fixtures/corpus/discrimination/*
 * /case.json`), so a reviewer can check this catalog against the corpus's
 * own prose without needing to run anything.
 */
export const PRODUCTION_TRANSFORMS: Readonly<Record<string, TextTransform>> = {
  'corrupt-discount-sign': {
    id: 'corrupt-discount-sign',
    anchor: 'Math.round(amount * (100 - percent)) / 100',
    replacement: 'Math.round(amount * (100 + percent)) / 100',
  },
  'subtotal-ignores-qty': {
    id: 'subtotal-ignores-qty',
    anchor: 'return items.reduce((total, item) => total + item.price * item.qty, 0);',
    replacement: 'return items.reduce((total, item) => total + item.price, 0);',
  },
  'discount-returns-amount-unchanged': {
    id: 'discount-returns-amount-unchanged',
    anchor: 'return Math.round(amount * (100 - percent)) / 100;',
    replacement: 'return amount;',
  },
  'discount-returns-zero': {
    id: 'discount-returns-zero',
    anchor: 'return Math.round(amount * (100 - percent)) / 100;',
    replacement: 'return 0;',
  },
  'remove-range-guard': {
    id: 'remove-range-guard',
    anchor: "  if (percent < 0 || percent > 100) throw new RangeError('percent must be between 0 and 100');\n",
    replacement: '',
  },
  'checkout-returns-nan': {
    id: 'checkout-returns-nan',
    anchor: 'return applyDiscount(subtotal(items), percent);',
    replacement: 'return NaN;',
  },
  'checkout-returns-one': {
    id: 'checkout-returns-one',
    anchor: 'return applyDiscount(subtotal(items), percent);',
    replacement: 'return 1;',
  },
  'round-via-toFixed': {
    id: 'round-via-toFixed',
    anchor: 'return Math.round(amount * (100 - percent)) / 100;',
    replacement: 'return Number(((amount * (100 - percent)) / 100).toFixed(2));',
  },
  'record-only-first-call': {
    id: 'record-only-first-call',
    anchor: 'export function record(entry: string): void { entries.push(entry); }',
    replacement:
      'let __recordCalls = 0;\n'
      + 'export function record(entry: string): void { __recordCalls += 1; if (__recordCalls === 1) entries.push(entry); }',
  },
  'record-skips-history-append': {
    id: 'record-skips-history-append',
    anchor: 'export function record(entry: string): void { entries.push(formatter.format(entry)); }',
    replacement: 'export function record(entry: string): void { formatter.format(entry); }',
  },
  'session-timeout-multiplied': {
    id: 'session-timeout-multiplied',
    anchor: 'return now - session.createdAt >= timeoutMs;',
    replacement: 'return now - session.createdAt >= timeoutMs * 10;',
  },
  'discount-truncates-cents': {
    id: 'discount-truncates-cents',
    anchor: 'return Math.round(amount * (100 - percent)) / 100;',
    replacement: 'return Math.floor(amount * (100 - percent)) / 100;',
  },
  'subtotal-empty-returns-nan': {
    id: 'subtotal-empty-returns-nan',
    anchor: 'export function subtotal(items: readonly Item[]): number {',
    replacement: 'export function subtotal(items: readonly Item[]): number { if (items.length === 0) return NaN;',
  },
  'tax-calculation-doubled': {
    id: 'tax-calculation-doubled',
    anchor: 'return Math.round(subtotal * rate * 100) / 100;',
    replacement: 'return Math.round(subtotal * rate * 200) / 100;',
  },
  'shipping-tier-inverted': {
    id: 'shipping-tier-inverted',
    anchor: 'if (weightKg <= 5) return 5;',
    replacement: 'if (weightKg > 5) return 5;',
  },
  'counter-increments-first-call-only': {
    id: 'counter-increments-first-call-only',
    anchor: 'let count = 0;\nexport function increment(): void { count += 1; }',
    replacement:
      'let count = 0;\n'
      + 'let __calls = 0;\n'
      + 'export function increment(): void { __calls += 1; if (__calls === 1) count += 1; }',
  },
  'window-max-age-multiplied': {
    id: 'window-max-age-multiplied',
    anchor: 'return Date.now() - timestamp <= maxAgeMs;',
    replacement: 'return Date.now() - timestamp <= maxAgeMs * 10;',
  },
  'pick-item-inverts-index': {
    id: 'pick-item-inverts-index',
    anchor: 'return items[index]!;\n}',
    replacement: 'return items[items.length - 1 - index]!;\n}',
  },
  'cart-service-uses-internal-map': {
    id: 'cart-service-uses-internal-map',
    anchor: '  _cache: Record<string, number> = {};\n  getPrice(sku: string): number {\n    if (this._cache[sku] === undefined) this._cache[sku] = 10;\n    return this._cache[sku]!;\n  }',
    replacement: '  private _store: Record<string, number> = {};\n  getPrice(sku: string): number {\n    if (this._store[sku] === undefined) this._store[sku] = 10;\n    return this._store[sku]!;\n  }',
  },
  'pipeline-inlines-normalize': {
    id: 'pipeline-inlines-normalize',
    anchor: 'process(sku: string): string { return `processed:${this.normalize(sku)}`; }',
    replacement: 'process(sku: string): string { return `processed:${sku.trim().toLowerCase()}`; }',
  },
  'calculate-total-additive': {
    id: 'calculate-total-additive',
    anchor: 'return unitPrice * quantity;',
    replacement: 'return unitPrice + quantity;',
  },
  'checkout-flow-returns-rejected': {
    id: 'checkout-flow-returns-rejected',
    anchor: "return { status: 'confirmed' };",
    replacement: "return { status: 'rejected' };",
  },
  'batch-runner-fails-job': {
    id: 'batch-runner-fails-job',
    anchor: "return { status: 'completed', processed: items.length };",
    replacement: "return { status: 'failed', processed: items.length };",
  },
  'discount-calculation-inverted': {
    id: 'discount-calculation-inverted',
    anchor: 'return price * (1 - rate);',
    replacement: 'return price * (1 + rate);',
  },
  'validator-removes-throw': {
    id: 'validator-removes-throw',
    anchor: "if (qty <= 0) throw new RangeError('quantity must be positive');",
    replacement: 'if (qty <= 0) { /* throw removed */ }',
  },
  'score-calculation-corrupted': {
    id: 'score-calculation-corrupted',
    anchor: 'score: points * 2',
    replacement: 'score: points * 5',
  },
  'report-total-halved': {
    id: 'report-total-halved',
    anchor: 'total: amount * 1.1',
    replacement: 'total: amount * 0.5',
  },
  'tiered-discount-altered': {
    id: 'tiered-discount-altered',
    anchor: 'return price * 0.8;',
    replacement: 'return price * 0.85;',
  },
  'total-fee-subtracted': {
    id: 'total-fee-subtracted',
    anchor: 'return subtotal + fee;',
    replacement: 'return subtotal - fee;',
  },
  'tax-returns-zero': {
    id: 'tax-returns-zero',
    anchor: 'return subtotal * rate;',
    replacement: 'return 0;',
  },
  'format-error-returns-empty': {
    id: 'format-error-returns-empty',
    anchor: 'return `ERR:${code}`;',
    replacement: "return '';",
  },
  'invoice-generate-throws': {
    id: 'invoice-generate-throws',
    anchor: 'return `INV-${id}`;',
    replacement: "throw new Error('generation failed');",
  },
  'remove-strict-discount-guard': {
    id: 'remove-strict-discount-guard',
    anchor: "if (pct < 0) throw new RangeError('negative percentage');",
    replacement: 'if (pct < 0) { /* guard removed */ }',
  },
  'remove-cart-empty-guard': {
    id: 'remove-cart-empty-guard',
    anchor: "if (items.length === 0) throw new Error('cart empty');",
    replacement: 'if (items.length === 0) { /* guard removed */ }',
  },
  'rebate-returns-zero': {
    id: 'rebate-returns-zero',
    anchor: 'return amount * 0.15;',
    replacement: 'return 0;',
  },
  'session-token-returns-empty': {
    id: 'session-token-returns-empty',
    anchor: "return { user, role: 'admin' };",
    replacement: 'return {};',
  },
  'auth-token-returns-error': {
    id: 'auth-token-returns-error',
    anchor: 'return `AUTH_${id}_OK`;',
    replacement: "return 'error';",
  },
  'tiered-tax-rate-corrupted': {
    id: 'tiered-tax-rate-corrupted',
    anchor: 'if (amount > 100) return amount * 0.2;',
    replacement: 'if (amount > 100) return amount * 0.25;',
  },
  'membership-tier-corrupted': {
    id: 'membership-tier-corrupted',
    anchor: 'if (points >= 1000) return 3;',
    replacement: 'if (points >= 1000) return 2;',
  },
  'inventory-always-false': {
    id: 'inventory-always-false',
    anchor: 'return quantity > 0 && quantity <= 100;',
    replacement: 'return false;',
  },
  'fee-returns-zero': {
    id: 'fee-returns-zero',
    anchor: 'return Math.round((amount * 0.029 + 0.3) * 100) / 100;',
    replacement: 'return 0;',
  },
  'permission-always-false': {
    id: 'permission-always-false',
    anchor: "if (role === 'admin') return true;",
    replacement: "if (role === 'admin') return false;",
  },
  'currency-rate-zero': {
    id: 'currency-rate-zero',
    anchor: 'return convertUsdToEur(amountUsd, 0.92);',
    replacement: 'return 0;',
  },
  'volume-discount-corrupted': {
    id: 'volume-discount-corrupted',
    anchor: 'const discount = quantity >= 10 ? 0.2 : 0;',
    replacement: 'const discount = 0;',
  },
  'sorter-inlines-sort': {
    id: 'sorter-inlines-sort',
    anchor: 'return this.quickSort([...nums]);',
    replacement: 'return [...nums].sort((a, b) => a - b);',
  },
  'slugger-replaces-pattern': {
    id: 'slugger-replaces-pattern',
    anchor: 'readonly separatorPattern = /[\\s_-]+/g;',
    replacement: 'readonly separatorPattern = /\\s+/g;',
  },
  'filter-returns-all': {
    id: 'filter-returns-all',
    anchor: 'return users.filter((u) => u.active).map((u) => u.id);',
    replacement: 'return users.map((u) => u.id);',
  },
  'formatter-omits-currency': {
    id: 'formatter-omits-currency',
    anchor: 'return `${currency} ${amount.toFixed(2)}`;',
    replacement: 'return amount.toFixed(2);',
  },
  'validate-always-true': {
    id: 'validate-always-true',
    anchor: "if (!email.includes('@')) return false;",
    replacement: "if (!email.includes('@')) return true;",
  },
  'registry-only-first-call': {
    id: 'registry-only-first-call',
    anchor: 'export function registerService(name: string): number { registered.push(name); return registered.length; }',
    replacement: 'let __regCalls = 0;\nexport function registerService(name: string): number { __regCalls += 1; if (__regCalls === 1) registered.push(name); return registered.length; }',
  },
  'coinflip-corrupted': {
    id: 'coinflip-corrupted',
    anchor: "return Math.random() >= 0.5 ? 'heads' : 'tails';",
    replacement: "return Math.random() >= 0.99 ? 'heads' : 'tails';",
  },
  'clock-threshold-multiplied': {
    id: 'clock-threshold-multiplied',
    anchor: 'return Date.now() - timestamp < thresholdMs;',
    replacement: 'return Date.now() - timestamp < thresholdMs * 100;',
  },
  'token-expiry-inverted': {
    id: 'token-expiry-inverted',
    anchor: 'return now >= token.expiresAt;',
    replacement: 'return now < token.expiresAt;',
  },
  'uuid-offset-altered': {
    id: 'uuid-offset-altered',
    anchor: 'const val = Math.floor(seedRng() * 10000);',
    replacement: 'const val = Math.floor(seedRng() * 5000);',
  },
  'bus-emit-noop': {
    id: 'bus-emit-noop',
    anchor: 'for (const h of this.handlers) h();',
    replacement: '/* emit is no-op */',
  },
  'collector-flush-corrupted': {
    id: 'collector-flush-corrupted',
    anchor: "const joined = this.buffer.join(',');",
    replacement: "const joined = '';",
  },
  'payment-status-corrupted': {
    id: 'payment-status-corrupted',
    anchor: "return { success: true, status: 'PAID' };",
    replacement: "return { success: true, status: 'FAILED' };",
  },
  'batch-total-corrupted': {
    id: 'batch-total-corrupted',
    anchor: 'return { total: sum, count: items.length };',
    replacement: 'return { total: sum * 2, count: items.length };',
  },
  'payload-version-corrupted': {
    id: 'payload-version-corrupted',
    anchor: 'return { user, action, version: 1 };',
    replacement: 'return { user, action, version: 99 };',
  },
  'check-config-inverts-port': {
    id: 'check-config-inverts-port',
    anchor: 'return config.host.length > 0 && config.port > 0;',
    replacement: 'return config.host.length > 0 && config.port < 0;',
  },
  'format-profile-corrupted': {
    id: 'format-profile-corrupted',
    anchor: 'return `${username}:${age}`;',
    replacement: 'return `${username}#${age}`;',
  },
  'state-tax-rate-corrupted': {
    id: 'state-tax-rate-corrupted',
    anchor: "if (state === 'CA') return amount * 0.0825;",
    replacement: "if (state === 'CA') return amount * 0.09;",
  },
  'order-status-corrupted': {
    id: 'order-status-corrupted',
    anchor: "if (delivered) return 'STATUS_DELIVERED';",
    replacement: "if (delivered) return 'STATUS_COMPLETED';",
  },
  'invoice-id-corrupted': {
    id: 'invoice-id-corrupted',
    anchor: 'return `${prefix}-INV-${seq.toString().padStart(4, \'0\')}`;',
    replacement: 'return `${prefix}-${seq}`;',
  },
};

/**
 * Test-side transforms a `'prescriptive'` case's own declared `operator`
 * actually applies to the base test to produce its comparison variant — see
 * the module doc's "the *same* two-run comparison" note. Each is taken
 * verbatim from that case's own `testEffect` prose.
 */
export const TEST_VARIANT_TRANSFORMS: Readonly<Record<string, TextTransform>> = {
  'weaken-assertion-to-truthy': {
    id: 'weaken-assertion-to-truthy',
    anchor: 'expect(subtotal(items)).toBe(25);',
    replacement: 'expect(subtotal(items)).toBeTruthy();',
  },
  'remove-throw-assertion': {
    id: 'remove-throw-assertion',
    anchor: 'expect(() => applyDiscount(100, 101)).toThrow(RangeError);',
    replacement: 'try { applyDiscount(100, 101); } catch { /* assertion removed by the remove-assertion operator */ }',
  },
  'mock-checkout-call': {
    id: 'mock-checkout-call',
    anchor: 'expect(checkout(items, 10)).toBe(22.5);',
    replacement: 'const mockCheckout = (): number => 22.5;\n    expect(mockCheckout()).toBe(22.5);',
  },
  'introduce-real-clock': {
    id: 'introduce-real-clock',
    anchor: 'expect(isSessionExpired(session, 500, start + 600)).toBe(true);',
    replacement: 'expect(isSessionExpired(session, 500, Date.now() + 10_000)).toBe(true);',
  },
  'weaken-discount-rounded-assertion': {
    id: 'weaken-discount-rounded-assertion',
    anchor: 'expect(applyDiscount(100.05, 10)).toBe(90.05);',
    replacement: 'expect(applyDiscount(100.05, 10)).toBeGreaterThan(0);',
  },
  'remove-empty-cart-assertion': {
    id: 'remove-empty-cart-assertion',
    anchor: 'expect(subtotal([])).toBe(0);',
    replacement: 'try { subtotal([]); } catch { /* assertion removed */ }',
  },
  'mock-tax-call': {
    id: 'mock-tax-call',
    anchor: 'expect(totalWithTax(100, 0.05)).toBe(105);',
    replacement: 'const mockTotal = 100 + 5;\n    expect(mockTotal).toBe(105);',
  },
  'mock-shipping-call': {
    id: 'mock-shipping-call',
    anchor: 'expect(calculateShipping(3)).toBe(5);',
    replacement: 'const mockShipping = 5;\n    expect(mockShipping).toBe(5);',
  },
  'substitute-mock-constant': {
    id: 'substitute-mock-constant',
    anchor: "expect(pickItem(['first', 'second'], deterministicZero)).toBe('first');",
    replacement: "const mockConstant = 'second';\n    expect(mockConstant).toBe('second');",
  },
  'weaken-total-expectation': {
    id: 'weaken-total-expectation',
    anchor: 'expect(calculateTotal(10, 2)).toBe(20);',
    replacement: 'expect(calculateTotal(10, 2)).toBeGreaterThan(0);',
  },
  'stub-checkout-outcome': {
    id: 'stub-checkout-outcome',
    anchor: 'expect(checkout(items, 10)).toBe(9);',
    replacement: 'const stubResult = 9;\n    expect(stubResult).toBe(9);',
  },
  'assert-audit-log-instead': {
    id: 'assert-audit-log-instead',
    anchor: 'expect(calculateDiscount(100, 0.2)).toBe(80);',
    replacement: 'calculateDiscount(100, 0.2);\n    expect(100).toBeGreaterThan(0);',
  },
  'catch-and-ignore-validation': {
    id: 'catch-and-ignore-validation',
    anchor: 'expect(() => validateQuantity(-1)).toThrow(RangeError);',
    replacement: 'try { validateQuantity(-1); } catch {}\n    expect(true).toBe(true);',
  },
  'weaken-tiered-discount-assertion': {
    id: 'weaken-tiered-discount-assertion',
    anchor: 'expect(calculateTieredDiscount(200)).toBe(160);',
    replacement: 'expect(calculateTieredDiscount(200)).toBeGreaterThan(100);',
  },
  'weaken-fee-assertion': {
    id: 'weaken-fee-assertion',
    anchor: 'expect(computeTotalWithFee(50, 5)).toBe(55);',
    replacement: 'expect(computeTotalWithFee(50, 5)).toBeGreaterThan(0);',
  },
  'remove-strict-discount-assertion': {
    id: 'remove-strict-discount-assertion',
    anchor: 'expect(() => applyStrictDiscount(100, -10)).toThrow(RangeError);',
    replacement: 'try { applyStrictDiscount(100, -10); } catch {}\n    expect(true).toBe(true);',
  },
  'remove-cart-empty-assertion': {
    id: 'remove-cart-empty-assertion',
    anchor: "expect(() => validateCart([])).toThrow('cart empty');",
    replacement: 'try { validateCart([]); } catch {}\n    expect(true).toBe(true);',
  },
  'weaken-tiered-tax-assertion': {
    id: 'weaken-tiered-tax-assertion',
    anchor: 'expect(computeTieredTax(200)).toBe(40);',
    replacement: 'expect(computeTieredTax(200)).toBeTruthy();',
  },
  'weaken-membership-tier-assertion': {
    id: 'weaken-membership-tier-assertion',
    anchor: 'expect(getMembershipTier(1500)).toBe(3);',
    replacement: "expect(typeof getMembershipTier(1500)).toBe('number');",
  },
  'mock-currency-call': {
    id: 'mock-currency-call',
    anchor: 'expect(totalInEur(100)).toBe(92);',
    replacement: 'const mockEur = 92;\n    expect(mockEur).toBe(92);',
  },
  'mock-volume-call': {
    id: 'mock-volume-call',
    anchor: 'expect(computeVolumeDiscount(10, 50)).toBe(400);',
    replacement: 'const mockVolumeTotal = 400;\n    expect(mockVolumeTotal).toBe(400);',
  },
  'weaken-filter-assertion': {
    id: 'weaken-filter-assertion',
    anchor: "expect(filterActiveUsers(users)).toEqual(['u1', 'u3']);",
    replacement: 'expect(filterActiveUsers(users).length).toBeGreaterThan(0);',
  },
  'weaken-format-assertion': {
    id: 'weaken-format-assertion',
    anchor: "expect(formatPrice(19.5, 'USD')).toBe('USD 19.50');",
    replacement: "expect(formatPrice(19.5, 'USD')).toContain('19.50');",
  },
  'weaken-email-validation-assertion': {
    id: 'weaken-email-validation-assertion',
    anchor: "expect(validateEmail('invalid-email')).toBe(false);",
    replacement: "expect(typeof validateEmail('invalid-email')).toBe('boolean');",
  },
  'introduce-uncontrolled-clock': {
    id: 'introduce-uncontrolled-clock',
    anchor: 'expect(isTokenExpired(token, 1001)).toBe(true);',
    replacement: 'expect(typeof isTokenExpired(token, 1001)).toBe("boolean");',
  },
  'weaken-uuid-assertion': {
    id: 'weaken-uuid-assertion',
    anchor: "expect(generateId('item', deterministicRng)).toBe('item-4200');",
    replacement: "expect(generateId('item', deterministicRng)).toContain('item-');",
  },
  'weaken-payment-status-assertion': {
    id: 'weaken-payment-status-assertion',
    anchor: "expect(processPayment(50).status).toBe('PAID');",
    replacement: 'expect(typeof processPayment(50).status).toBe("string");',
  },
  'weaken-batch-assertion': {
    id: 'weaken-batch-assertion',
    anchor: 'expect(summary.total).toBe(60);',
    replacement: 'expect(summary.total).toBeGreaterThan(0);',
  },
  'weaken-payload-assertion': {
    id: 'weaken-payload-assertion',
    anchor: "expect(createAuditPayload('alice', 'login')).toEqual({ user: 'alice', action: 'login', version: 1 });",
    replacement: "expect(createAuditPayload('alice', 'login')).toHaveProperty('user');",
  },
  'weaken-tax-rate-assertion': {
    id: 'weaken-tax-rate-assertion',
    anchor: "expect(computeStateTax(100, 'CA')).toBe(8.25);",
    replacement: "expect(computeStateTax(100, 'CA')).toBeGreaterThan(0);",
  },
  'weaken-order-status-assertion': {
    id: 'weaken-order-status-assertion',
    anchor: "expect(getOrderStatus(true, true)).toBe('STATUS_DELIVERED');",
    replacement: "expect(typeof getOrderStatus(true, true)).toBe('string');",
  },
  'weaken-invoice-id-assertion': {
    id: 'weaken-invoice-id-assertion',
    anchor: "expect(formatInvoiceId('US', 42)).toBe('US-INV-0042');",
    replacement: "expect(formatInvoiceId('US', 42)).toContain('US-');",
  },
};

interface SingleMutationRecipe {
  readonly kind: 'single-mutation';
  readonly targetFile: string;
  readonly transformId: string;
  readonly variantTransformId?: string;
}

interface RepeatedExecutionRecipe {
  readonly kind: 'repeated-execution';
  readonly targetFile: string;
  readonly transformId: string;
  readonly repeatCount: number;
}

type CaseOracleRecipe = SingleMutationRecipe | RepeatedExecutionRecipe;

/**
 * Case id -> how to realize its declared claim. One entry per real corpus
 * case (`test/fixtures/corpus/discrimination/*`); a case id with no entry
 * here is `'unrealizable'` (`no-mutation-declared`), never silently skipped.
 * A `productionMutation` field on the manifest itself (P7-1's `case.json`)
 * would be the cleaner long-term home for this binding, but retrofitting
 * P7-1's parser and all 11 manifests is out of this task's authorized scope
 * — returned as an open decision, not done here.
 */
const CASE_ORACLE_RECIPES: Readonly<Record<string, CaseOracleRecipe>> = {
  'checkout-applies-percent': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'corrupt-discount-sign', variantTransformId: 'mock-checkout-call' },
  'checkout-tautology': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'corrupt-discount-sign' },
  'computes-subtotal-truthy': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'subtotal-ignores-qty' },
  'discount-returns-number': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'discount-returns-amount-unchanged' },
  'discount-throws-range-error': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'remove-range-guard', variantTransformId: 'remove-throw-assertion' },
  'exposes-checkout-helper': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'checkout-returns-nan' },
  'mocks-discount-logic': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'discount-returns-zero' },
  'records-history-shared-state': { kind: 'repeated-execution', targetFile: 'audit-log.ts', transformId: 'record-only-first-call', repeatCount: 2 },
  'spies-on-math-round': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'round-via-toFixed' },
  'subtotal-exact-value': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'subtotal-ignores-qty', variantTransformId: 'weaken-assertion-to-truthy' },
  'works-boolean-check': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'checkout-returns-one' },
  'asserts-helper-call-count': { kind: 'single-mutation', targetFile: 'audit-log.ts', transformId: 'record-skips-history-append' },
  'generic-boolean-summary': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'corrupt-discount-sign' },
  'session-expiry-controlled-clock': { kind: 'single-mutation', targetFile: 'session.ts', transformId: 'session-timeout-multiplied', variantTransformId: 'introduce-real-clock' },
  'discount-exact-rounded-value': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'discount-truncates-cents', variantTransformId: 'weaken-discount-rounded-assertion' },
  'empty-cart-subtotal-zero': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'subtotal-empty-returns-nan', variantTransformId: 'remove-empty-cart-assertion' },
  'asserts-variable-type-only': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'checkout-returns-nan' },
  'cart-real-tax-calculation': { kind: 'single-mutation', targetFile: 'tax.ts', transformId: 'tax-calculation-doubled', variantTransformId: 'mock-tax-call' },
  'shipping-tiered-rates': { kind: 'single-mutation', targetFile: 'shipping.ts', transformId: 'shipping-tier-inverted', variantTransformId: 'mock-shipping-call' },
  'mocks-entire-subtotal': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'subtotal-ignores-qty' },
  'shared-counter-leak': { kind: 'repeated-execution', targetFile: 'counter.ts', transformId: 'counter-increments-first-call-only', repeatCount: 2 },
  'real-clock-timeout-race': { kind: 'single-mutation', targetFile: 'window.ts', transformId: 'window-max-age-multiplied' },
  'controlled-random-seed': { kind: 'single-mutation', targetFile: 'sampler.ts', transformId: 'pick-item-inverts-index', variantTransformId: 'substitute-mock-constant' },
  'pins-private-field-property': { kind: 'single-mutation', targetFile: 'service.ts', transformId: 'cart-service-uses-internal-map' },
  'pins-internal-transform-pipeline': { kind: 'single-mutation', targetFile: 'pipeline.ts', transformId: 'pipeline-inlines-normalize' },
  'public-api-refactor-safe-subtotal': { kind: 'single-mutation', targetFile: 'pricing.ts', transformId: 'calculate-total-additive', variantTransformId: 'weaken-total-expectation' },
  'public-api-refactor-safe-checkout': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'discount-returns-zero', variantTransformId: 'stub-checkout-outcome' },
  'asserts-internal-call-order': { kind: 'single-mutation', targetFile: 'checkout-flow.ts', transformId: 'checkout-flow-returns-rejected' },
  'asserts-intermediate-state-only': { kind: 'single-mutation', targetFile: 'batch-runner.ts', transformId: 'batch-runner-fails-job' },
  'asserts-observable-discount-result': { kind: 'single-mutation', targetFile: 'discount.ts', transformId: 'discount-calculation-inverted', variantTransformId: 'assert-audit-log-instead' },
  'asserts-observable-thrown-error': { kind: 'single-mutation', targetFile: 'validator.ts', transformId: 'validator-removes-throw', variantTransformId: 'catch-and-ignore-validation' },
  'vague-name-test-fallback': { kind: 'single-mutation', targetFile: 'metrics.ts', transformId: 'score-calculation-corrupted' },
  'bundled-multi-assertion-boolean': { kind: 'single-mutation', targetFile: 'report.ts', transformId: 'report-total-halved' },
  'precise-matcher-diff-discount': { kind: 'single-mutation', targetFile: 'discount.ts', transformId: 'tiered-discount-altered', variantTransformId: 'weaken-tiered-discount-assertion' },
  'precise-matcher-diff-subtotal': { kind: 'single-mutation', targetFile: 'pricing.ts', transformId: 'total-fee-subtracted', variantTransformId: 'weaken-fee-assertion' },
  'never-calls-tested-function': { kind: 'single-mutation', targetFile: 'tax.ts', transformId: 'tax-returns-zero' },
  'tautological-string-length': { kind: 'single-mutation', targetFile: 'error.ts', transformId: 'format-error-returns-empty' },
  'asserts-mock-instantiation-only': { kind: 'single-mutation', targetFile: 'invoice.ts', transformId: 'invoice-generate-throws' },
  'exact-discount-bounds-check': { kind: 'single-mutation', targetFile: 'discount.ts', transformId: 'remove-strict-discount-guard', variantTransformId: 'remove-strict-discount-assertion' },
  'non-empty-cart-validation': { kind: 'single-mutation', targetFile: 'cart.ts', transformId: 'remove-cart-empty-guard', variantTransformId: 'remove-cart-empty-assertion' },
  'checks-definedness-only': { kind: 'single-mutation', targetFile: 'rebate.ts', transformId: 'rebate-returns-zero' },
  'asserts-non-null-object': { kind: 'single-mutation', targetFile: 'token.ts', transformId: 'session-token-returns-empty' },
  'boolean-coerced-string-token': { kind: 'single-mutation', targetFile: 'auth.ts', transformId: 'auth-token-returns-error' },
  'precise-tiered-tax-rate': { kind: 'single-mutation', targetFile: 'tax.ts', transformId: 'tiered-tax-rate-corrupted', variantTransformId: 'weaken-tiered-tax-assertion' },
  'exact-membership-status-code': { kind: 'single-mutation', targetFile: 'membership.ts', transformId: 'membership-tier-corrupted', variantTransformId: 'weaken-membership-tier-assertion' },
  'mocks-inventory-lookup': { kind: 'single-mutation', targetFile: 'inventory.ts', transformId: 'inventory-always-false' },
  'mocks-payment-gateway-math': { kind: 'single-mutation', targetFile: 'fee.ts', transformId: 'fee-returns-zero' },
  'mocks-user-permission-check': { kind: 'single-mutation', targetFile: 'permission.ts', transformId: 'permission-always-false' },
  'real-currency-conversion': { kind: 'single-mutation', targetFile: 'currency.ts', transformId: 'currency-rate-zero', variantTransformId: 'mock-currency-call' },
  'real-volume-discount': { kind: 'single-mutation', targetFile: 'volume.ts', transformId: 'volume-discount-corrupted', variantTransformId: 'mock-volume-call' },
  'spies-on-internal-sort': { kind: 'single-mutation', targetFile: 'sorter.ts', transformId: 'sorter-inlines-sort' },
  'pins-internal-regex-matcher': { kind: 'single-mutation', targetFile: 'slug.ts', transformId: 'slugger-replaces-pattern' },
  'public-api-refactor-safe-filter': { kind: 'single-mutation', targetFile: 'filter.ts', transformId: 'filter-returns-all', variantTransformId: 'weaken-filter-assertion' },
  'public-api-refactor-safe-formatter': { kind: 'single-mutation', targetFile: 'formatter.ts', transformId: 'formatter-omits-currency', variantTransformId: 'weaken-format-assertion' },
  'public-api-refactor-safe-validator': { kind: 'single-mutation', targetFile: 'validate.ts', transformId: 'validate-always-true', variantTransformId: 'weaken-email-validation-assertion' },
  'shared-singleton-registry-leak': { kind: 'repeated-execution', targetFile: 'registry.ts', transformId: 'registry-only-first-call', repeatCount: 2 },
  'unseeded-random-float-threshold': { kind: 'single-mutation', targetFile: 'random.ts', transformId: 'coinflip-corrupted' },
  'wall-clock-timestamp-assertion': { kind: 'single-mutation', targetFile: 'clock.ts', transformId: 'clock-threshold-multiplied' },
  'controlled-clock-token-refresh': { kind: 'single-mutation', targetFile: 'token-expiry.ts', transformId: 'token-expiry-inverted', variantTransformId: 'introduce-uncontrolled-clock' },
  'controlled-seeded-uuid-generator': { kind: 'single-mutation', targetFile: 'uuid.ts', transformId: 'uuid-offset-altered', variantTransformId: 'weaken-uuid-assertion' },
  'asserts-emitter-listener-count': { kind: 'single-mutation', targetFile: 'emitter.ts', transformId: 'bus-emit-noop' },
  'asserts-internal-intermediate-array': { kind: 'single-mutation', targetFile: 'collector.ts', transformId: 'collector-flush-corrupted' },
  'asserts-observable-payment-status': { kind: 'single-mutation', targetFile: 'payment.ts', transformId: 'payment-status-corrupted', variantTransformId: 'weaken-payment-status-assertion' },
  'asserts-observable-batch-summary': { kind: 'single-mutation', targetFile: 'batch.ts', transformId: 'batch-total-corrupted', variantTransformId: 'weaken-batch-assertion' },
  'asserts-observable-event-payload': { kind: 'single-mutation', targetFile: 'event.ts', transformId: 'payload-version-corrupted', variantTransformId: 'weaken-payload-assertion' },
  'uninformative-boolean-flag-validator': { kind: 'single-mutation', targetFile: 'check.ts', transformId: 'check-config-inverts-port' },
  'anonymous-it-assertion-block': { kind: 'single-mutation', targetFile: 'profile.ts', transformId: 'format-profile-corrupted' },
  'precise-matcher-diff-tax-rate': { kind: 'single-mutation', targetFile: 'tax-rate.ts', transformId: 'state-tax-rate-corrupted', variantTransformId: 'weaken-tax-rate-assertion' },
  'precise-matcher-diff-order-status': { kind: 'single-mutation', targetFile: 'order.ts', transformId: 'order-status-corrupted', variantTransformId: 'weaken-order-status-assertion' },
  'precise-matcher-diff-invoice-id': { kind: 'single-mutation', targetFile: 'invoice-id.ts', transformId: 'invoice-id-corrupted', variantTransformId: 'weaken-invoice-id-assertion' },
};

/**
 * Duplicates a test file's `describe(...)` block (and everything after it)
 * `times` times, keeping the file's own `import`s exactly once. This is the
 * mechanical shape `'repeated-randomized-execution'` needs, and it needs
 * only for `records-history-shared-state`: "running this exact test body
 * twice in a row within the same process, sharing one loaded module" (that
 * case's own `productionEffect`) means two `it(...)`s inside one file, so
 * the module they both import is loaded exactly once by the adapter's
 * spawned test runner. Throws if the source has no `describe(` to
 * duplicate — a plan for a case whose base test does not use `describe`
 * would be meaningless here, and `buildOraclePlan` turns that into an
 * `'unrealizable'` case rather than a silently unduplicated run.
 */
export function duplicateDescribeBlock(source: string, times: number): string {
  const marker = 'describe(';
  const index = source.indexOf(marker);
  if (index === -1) throw new RangeError('Expected a "describe(" block to duplicate, found none');
  const head = source.slice(0, index);
  const block = source.slice(index);
  return head + block.repeat(times);
}

function baselineRun(corpusCase: CorpusCase): OracleRun {
  return {
    label: 'baseline',
    files: [...corpusCase.productionSources, corpusCase.baseTest],
    testFile: corpusCase.baseTest.path,
    expectedTestCount: 1,
    mutatedFiles: [],
  };
}

function withMutatedProductionFile(
  corpusCase: CorpusCase,
  targetFile: string,
  mutatedContents: string,
): readonly OracleProofFile[] {
  return corpusCase.productionSources.map((file) => (file.path === targetFile ? { path: file.path, contents: mutatedContents } : file));
}

function findProductionSource(corpusCase: CorpusCase, path: string): CorpusSourceFile {
  const file = corpusCase.productionSources.find((entry) => entry.path === path);
  if (file === undefined) {
    throw new RangeError(`Case "${corpusCase.id}" has no production file "${path}" to mutate`);
  }
  return file;
}

function buildSingleMutationPlan(corpusCase: CorpusCase, recipe: SingleMutationRecipe): OraclePlan {
  const target = findProductionSource(corpusCase, recipe.targetFile);
  const transform = PRODUCTION_TRANSFORMS[recipe.transformId];
  if (transform === undefined) throw new RangeError(`Unknown production transform id "${recipe.transformId}"`);
  const mutatedContents = applyTextTransform(target.contents, transform);
  const mutatedProductionFiles = withMutatedProductionFile(corpusCase, recipe.targetFile, mutatedContents);

  const runs: OracleRun[] = [
    baselineRun(corpusCase),
    {
      label: 'base-under-mutation',
      files: [...mutatedProductionFiles, corpusCase.baseTest],
      testFile: corpusCase.baseTest.path,
      expectedTestCount: 1,
      mutatedFiles: [recipe.targetFile],
    },
  ];

  if (corpusCase.operatorRole === 'prescriptive') {
    if (recipe.variantTransformId === undefined) {
      throw new RangeError(`Case "${corpusCase.id}" is prescriptive but declares no variant transform`);
    }
    const variantTransform = TEST_VARIANT_TRANSFORMS[recipe.variantTransformId];
    if (variantTransform === undefined) throw new RangeError(`Unknown test-variant transform id "${recipe.variantTransformId}"`);
    const variantTestContents = applyTextTransform(corpusCase.baseTest.contents, variantTransform);
    runs.push({
      label: 'variant-under-mutation',
      files: [...mutatedProductionFiles, { path: corpusCase.baseTest.path, contents: variantTestContents }],
      testFile: corpusCase.baseTest.path,
      expectedTestCount: 1,
      mutatedFiles: [recipe.targetFile, corpusCase.baseTest.path],
    });
  }

  return { caseId: corpusCase.id, runs };
}

function buildRepeatedExecutionPlan(corpusCase: CorpusCase, recipe: RepeatedExecutionRecipe): OraclePlan {
  const target = findProductionSource(corpusCase, recipe.targetFile);
  const transform = PRODUCTION_TRANSFORMS[recipe.transformId];
  if (transform === undefined) throw new RangeError(`Unknown production transform id "${recipe.transformId}"`);
  const mutatedContents = applyTextTransform(target.contents, transform);
  const mutatedProductionFiles = withMutatedProductionFile(corpusCase, recipe.targetFile, mutatedContents);
  const duplicatedTestContents = duplicateDescribeBlock(corpusCase.baseTest.contents, recipe.repeatCount);

  return {
    caseId: corpusCase.id,
    runs: [
      baselineRun(corpusCase),
      {
        label: 'base-under-mutation',
        files: [...mutatedProductionFiles, { path: corpusCase.baseTest.path, contents: duplicatedTestContents }],
        testFile: corpusCase.baseTest.path,
        expectedTestCount: recipe.repeatCount,
        mutatedFiles: [recipe.targetFile],
      },
    ],
  };
}

/**
 * Turns one already-parsed {@link CorpusCase} into an {@link OraclePlan} an
 * adapter can execute, or reports it `'unrealizable'`. Never throws: a
 * missing recipe, an unknown transform id, or a transform whose anchor no
 * longer matches this case's committed bytes are all caught here and turned
 * into a specific `reason` string, so a caller never has to wrap this in its
 * own `try`/`catch` to get a safe result.
 */
export function buildOraclePlan(corpusCase: CorpusCase): OraclePlanResult {
  const recipe = CASE_ORACLE_RECIPES[corpusCase.id];
  if (recipe === undefined) {
    return { kind: 'unrealizable', reason: `no-mutation-declared: no oracle recipe is registered for case "${corpusCase.id}"` };
  }
  try {
    const plan = recipe.kind === 'repeated-execution'
      ? buildRepeatedExecutionPlan(corpusCase, recipe)
      : buildSingleMutationPlan(corpusCase, recipe);
    return { kind: 'plan', plan };
  } catch (error) {
    return { kind: 'unrealizable', reason: `mutation-anchor-not-found: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** What one {@link OracleRun} was actually observed to do, recorded by the adapter that ran it. */
export type Observation =
  | { readonly kind: 'passed' }
  | { readonly kind: 'failed'; readonly detail?: string }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'runner-error'; readonly detail: string };

/** One run's recorded observation, plus the content hash of the exact bytes that produced it (Decisions: "a benchmark that re-derives its own ground truth ... can drift silently"). */
export interface RunObservation {
  readonly label: string;
  readonly observation: Observation;
  readonly contentHash: string;
}

export type CaseProofStatus =
  | { readonly kind: 'proven' }
  | { readonly kind: 'unproven'; readonly reason: string };

function findObservation(observations: readonly RunObservation[], label: string): RunObservation | undefined {
  return observations.find((entry) => entry.label === label);
}

function outcomeOf(observation: Observation): CorpusExpectedOutcome | undefined {
  if (observation.kind === 'passed') return 'expected-to-keep-passing';
  if (observation.kind === 'failed') return 'expected-to-fail';
  return undefined;
}

function nonTerminalReason(label: string, observation: Observation): string | undefined {
  if (observation.kind === 'timed-out') return `${label} timed-out`;
  if (observation.kind === 'runner-error') return `${label} runner-error: ${observation.detail}`;
  return undefined;
}

/**
 * Decides whether a case's declared claim held, from the {@link RunObservation}s
 * an adapter recorded for the {@link OraclePlan} {@link buildOraclePlan} built
 * for it. Never a bare boolean — every non-`'proven'` result carries a
 * specific machine-matchable `reason`:
 *
 * - `'baseline-failed'`: the case's own "genuinely passes against its
 *   production code" precondition (Decisions) did not hold.
 * - `'<label> timed-out'` / `'<label> runner-error: ...'`: a run never
 *   reached a real pass/fail outcome at all.
 * - `'incoherent-declaration'`: a `'prescriptive'` case declared
 *   `'expected-to-keep-passing'` — incoherent, because the entire point of a
 *   prescriptive good control is that its unmodified base test *catches* the
 *   fixed production mutation (fails), which only a declared
 *   `'expected-to-fail'` can express. Decided before even looking at the
 *   mutation/variant observations, since no execution result could make this
 *   declaration coherent.
 * - `'prediction-not-held'`: the base-under-mutation run's own pass/fail did
 *   not match the case's declared `expectedOutcome`.
 * - `'operator-did-not-hide-defect'`: (`'prescriptive'` only) the base test
 *   correctly caught the mutation, but the operator-derived variant *also*
 *   failed under it — the operator did not, in fact, hide the defect.
 */
export function decideProof(corpusCase: CorpusCase, observations: readonly RunObservation[]): CaseProofStatus {
  const baseline = findObservation(observations, 'baseline');
  if (baseline === undefined || baseline.observation.kind !== 'passed') {
    return { kind: 'unproven', reason: 'baseline-failed: the case\'s base test did not pass against its own unmutated production code' };
  }

  if (corpusCase.operatorRole === 'prescriptive' && corpusCase.expectedOutcome !== 'expected-to-fail') {
    return {
      kind: 'unproven',
      reason: 'incoherent-declaration: a prescriptive case must declare expected-to-fail (the base test is expected to catch the fixed mutation the variant is expected to hide)',
    };
  }

  const baseUnderMutation = findObservation(observations, 'base-under-mutation');
  if (baseUnderMutation === undefined) {
    return { kind: 'unproven', reason: 'base-under-mutation: no observation was recorded for this run' };
  }
  const baseNonTerminal = nonTerminalReason('base-under-mutation', baseUnderMutation.observation);
  if (baseNonTerminal !== undefined) return { kind: 'unproven', reason: baseNonTerminal };

  const baseOutcome = outcomeOf(baseUnderMutation.observation);
  if (baseOutcome !== corpusCase.expectedOutcome) {
    return { kind: 'unproven', reason: `prediction-not-held: declared "${corpusCase.expectedOutcome}" but observed "${baseOutcome}"` };
  }

  if (corpusCase.operatorRole === 'descriptive') {
    return { kind: 'proven' };
  }

  const variant = findObservation(observations, 'variant-under-mutation');
  if (variant === undefined) {
    return { kind: 'unproven', reason: 'variant-under-mutation: no observation was recorded for this run' };
  }
  const variantNonTerminal = nonTerminalReason('variant-under-mutation', variant.observation);
  if (variantNonTerminal !== undefined) return { kind: 'unproven', reason: variantNonTerminal };

  if (variant.observation.kind !== 'passed') {
    return { kind: 'unproven', reason: 'operator-did-not-hide-defect: the operator-derived variant did not keep passing under the same mutation the base test caught' };
  }

  return { kind: 'proven' };
}

export type { CorpusOperatorId, CorpusOperatorRole, CorpusOracleKind };
