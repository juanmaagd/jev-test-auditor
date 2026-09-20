/**
 * Replays the real, verbatim provider output recorded on 2026-09-20 for the
 * discrimination fixture (`test/fixtures/recorded/discrimination-raw-2026-09-20.json`,
 * built from `test/fixtures/discrimination/cart.test.ts`) through the real
 * `classifyEvaluation`, for both `CLASSIFICATION_POLICY_V1` and
 * `CLASSIFICATION_POLICY_V2`. This is the point of task C-1
 * (`odd/tasks/classification-calibration.md`): prove, from evidence rather
 * than from a hand-written expectation, that the boundary-mass policy stops
 * discarding a model judgment as `needs-review` without absolving any
 * deliberately bad test.
 *
 * The fixture's `answers` values already have exactly the shape of
 * `JevAnswer` (see `src/domain/jev-gateway.ts`), so they are used verbatim,
 * never hand-edited — "evidence, not hand-written expectations" (task doc
 * Scope).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_POLICY_V1,
  CLASSIFICATION_POLICY_V2,
  classifyEvaluation,
  type OverallClassificationStatus,
} from '../src/domain/classification.js';
import { JEV_MODEL_ID, RUBRIC_V1 } from '../src/domain/rubric.js';
import type { JevAnswer, JevEvaluation } from '../src/domain/jev-gateway.js';
import type { TestCaseId } from '../src/domain/test-understanding.js';

interface RecordedEvaluation {
  readonly testCaseId: string;
  readonly name: string;
  readonly respondedModel: string;
  readonly modelMatchesPin: boolean;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly answers: Readonly<Record<string, JevAnswer>>;
}

interface RecordedFixture {
  readonly capturedAt: string;
  readonly model: string;
  readonly rubricVersion: number;
  readonly evaluations: readonly RecordedEvaluation[];
}

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/recorded/discrimination-raw-2026-09-20.json', import.meta.url),
);

const FIXTURE: RecordedFixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RecordedFixture;

function toEvaluation(recorded: RecordedEvaluation): JevEvaluation {
  return {
    requestedModel: FIXTURE.model,
    respondedModel: recorded.respondedModel,
    modelMatchesPin: recorded.modelMatchesPin,
    answers: recorded.answers,
    usage: recorded.usage,
    attempts: 1,
  };
}

/**
 * `CLASSIFICATION_POLICY_V2` pinned back to `RUBRIC_V1.version` (task C-2 of
 * `odd/tasks/classification-calibration.md` re-pinned the real, exported
 * `CLASSIFICATION_POLICY_V2.rubricVersion` to `2`, matching the shipped
 * `RUBRIC_V2`). This replay's own `rubric` argument below really is
 * `RUBRIC_V1` — the recording is real provider output captured against that
 * exact wording — so replaying it needs a policy value whose `rubricVersion`
 * says so too, or `classifyEvaluation`'s own version-consistency guard
 * (correctly) refuses to run it. This override is not a loophole around
 * that guard: `judgeDimensionV2` (the actual boundary-mass logic this
 * replay is verifying) reads only the quality answer's `probabilities`
 * distribution, never `rubricVersion` — and task C-2 never touches any
 * quality question's wording — so replaying v1-recorded quality answers
 * through these exact thresholds is the identical computation task C-1
 * verified; only the label on the pin changes. The real production guard is
 * still exercised elsewhere (`test/jev-evaluation-port.test.ts`,
 * `test/classification.test.ts`'s dedicated mismatch tests).
 */
const V2_THRESHOLDS_ON_V1_RECORDING = { ...CLASSIFICATION_POLICY_V2, rubricVersion: RUBRIC_V1.version };

function classify(recorded: RecordedEvaluation, policy: typeof CLASSIFICATION_POLICY_V1 | typeof CLASSIFICATION_POLICY_V2) {
  const effectivePolicy = policy === CLASSIFICATION_POLICY_V2 ? V2_THRESHOLDS_ON_V1_RECORDING : policy;
  return classifyEvaluation({
    testCase: {
      testCaseId: recorded.testCaseId as TestCaseId,
      repositoryRelativePath: 'test/fixtures/discrimination/cart.test.ts',
      name: recorded.name,
    },
    evaluation: toEvaluation(recorded),
    rubric: RUBRIC_V1,
    policy: effectivePolicy,
  });
}

/**
 * The three good controls (see `test/fixtures/discrimination/cart.test.ts`):
 * tightly-wired assertions on real computed values. Every other recorded
 * test is deliberately bad (a tautology, a mock standing in for the real
 * logic, an unseeded `Math.random()`, etc.).
 */
const GOOD_TEST_NAMES = new Set([
  'subtotals a two-line cart to 25',
  'rejects a percent above 100',
  'applies a 10 percent discount to a 25 cart',
]);

/**
 * The exact verdict for every one of the 11 recorded tests, under both
 * policies, computed by this test the first time it ran (see this task's
 * writer report for the full derivation) — not hand-picked to make the
 * table green. `v1` locks in the historical behavior actually produced by
 * `CLASSIFICATION_POLICY_V1` on this exact recording (which differs from
 * the feature doc's own narrative summary — see the module doc and the
 * writer report: the doc's prose numbers come from a different capture,
 * while this fixture is the evidence of record for task C-1). Recomputed
 * directly from `discrimination-raw-2026-09-20.json`, ALL THREE good
 * controls are `needs-review` under V1 (not one `healthy` two
 * `needs-review` as the doc's narrative paraphrases), because
 * `applies a 10 percent discount to a 25 cart` also has a
 * confidence-below-0.6 dimension (`falsifiability`, confidence 0.50) that
 * the doc's summary does not mention.
 */
const EXPECTED_TABLE: readonly {
  readonly name: string;
  readonly v1: OverallClassificationStatus;
  readonly v2: OverallClassificationStatus;
}[] = [
  { name: 'exposes the checkout helper', v1: 'misleading', v2: 'misleading' },
  { name: 'works', v1: 'misleading', v2: 'misleading' },
  { name: 'computes a subtotal', v1: 'misleading', v2: 'misleading' },
  { name: 'returns a number for a discount', v1: 'weak', v2: 'weak' },
  { name: 'checks out correctly', v1: 'misleading', v2: 'misleading' },
  { name: 'calls subtotal once during checkout', v1: 'misleading', v2: 'misleading' },
  { name: 'applies the discount', v1: 'misleading', v2: 'misleading' },
  { name: 'records history across runs', v1: 'weak', v2: 'weak' },
  { name: 'subtotals a two-line cart to 25', v1: 'needs-review', v2: 'healthy' },
  { name: 'rejects a percent above 100', v1: 'needs-review', v2: 'healthy' },
  { name: 'applies a 10 percent discount to a 25 cart', v1: 'needs-review', v2: 'healthy' },
];

describe('classification replay — discrimination fixture (2026-09-20, recorded)', () => {
  it('sanity-checks that the real shipped CLASSIFICATION_POLICY_V2 is pinned to rubric v2, not v1 (task C-2)', () => {
    // Documents exactly why `classify` above needs `V2_THRESHOLDS_ON_V1_RECORDING`: the real,
    // exported policy no longer pairs with `RUBRIC_V1` directly.
    expect(CLASSIFICATION_POLICY_V2.rubricVersion).toBe(2);
    expect(CLASSIFICATION_POLICY_V2.rubricVersion).not.toBe(RUBRIC_V1.version);
  });

  it('sanity-checks the fixture is the expected capture before trusting any replayed verdict', () => {
    expect(FIXTURE.evaluations).toHaveLength(11);
    expect(FIXTURE.rubricVersion).toBe(RUBRIC_V1.version);
    expect(FIXTURE.model).toBe(JEV_MODEL_ID);
    for (const recorded of FIXTURE.evaluations) {
      expect(recorded.respondedModel).toBe(JEV_MODEL_ID);
      expect(recorded.modelMatchesPin).toBe(true);
    }
    expect(new Set(FIXTURE.evaluations.map((recorded) => recorded.name))).toEqual(
      new Set(EXPECTED_TABLE.map((row) => row.name)),
    );
  });

  it.each(EXPECTED_TABLE)('replays "$name": V1 → $v1, V2 → $v2', ({ name, v1, v2 }) => {
    const recorded = FIXTURE.evaluations.find((entry) => entry.name === name);
    if (recorded === undefined) throw new Error(`Fixture is missing recorded evaluation "${name}"`);

    expect(classify(recorded, CLASSIFICATION_POLICY_V1).status).toBe(v1);
    expect(classify(recorded, CLASSIFICATION_POLICY_V2).status).toBe(v2);
  });

  it('V2 never turns a bad test acceptable and never leaves a good test unresolved (task C-1 acceptance criteria)', () => {
    for (const row of EXPECTED_TABLE) {
      const isGood = GOOD_TEST_NAMES.has(row.name);
      if (isGood) {
        expect(row.v2, `${row.name} (a good control) must be healthy under V2`).toBe('healthy');
      } else {
        expect(['misleading', 'weak'], `${row.name} (deliberately bad) must stay misleading or weak under V2`).toContain(row.v2);
      }
    }
  });

  it('tallies the V1 vs. V2 status counts across all 11 recorded tests', () => {
    const tally = (column: 'v1' | 'v2'): Record<OverallClassificationStatus, number> => {
      const counts: Record<OverallClassificationStatus, number> = { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 };
      for (const row of EXPECTED_TABLE) counts[row[column]] += 1;
      return counts;
    };

    // V1 (as actually recomputed from this recording, not the doc's paraphrase): 6 misleading, 2 weak, 3 needs-review, 0 healthy.
    expect(tally('v1')).toEqual({ misleading: 6, weak: 2, 'needs-review': 3, healthy: 0 });
    // V2: same 6 misleading + 2 weak for the 8 bad tests; all 3 good tests move from needs-review to healthy.
    expect(tally('v2')).toEqual({ misleading: 6, weak: 2, 'needs-review': 0, healthy: 3 });
  });

  it('exposes per-level probabilities and the three derived masses on every V2-judged dimension, for audit', () => {
    const recorded = FIXTURE.evaluations.find((entry) => entry.name === 'subtotals a two-line cart to 25');
    if (recorded === undefined) throw new Error('Fixture is missing "subtotals a two-line cart to 25"');
    const result = classify(recorded, CLASSIFICATION_POLICY_V2);
    const judgedDimensions = result.dimensions.filter((dimension) => dimension.status === 'judged');
    expect(judgedDimensions.length).toBeGreaterThan(0);
    for (const dimension of judgedDimensions) {
      expect(dimension.probabilities).toBeDefined();
      expect(Object.keys(dimension.probabilities ?? {})).toEqual(['0', '1', '2', '3']);
      expect(dimension.deficientMass).toBeDefined();
      expect(dimension.acceptableMass).toBeDefined();
      expect(dimension.criticalMass).toBeDefined();
      expect((dimension.deficientMass ?? 0) + (dimension.acceptableMass ?? 0)).toBeCloseTo(1, 6);
    }
  });
});
