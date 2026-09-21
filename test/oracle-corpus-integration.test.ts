import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpusFromDirectory } from '../src/adapters/corpus-store.js';
import { createOracleRunnerPort, type OracleObservationPort } from '../src/adapters/oracle-runner.js';
import { proveCase, proveCorpus } from '../src/application/benchmark.js';
import type { CorpusCase } from '../src/domain/corpus.js';

const CORPUS_ROOT = 'test/fixtures/corpus/discrimination';

const REAL_CASE_IDS = [
  'checkout-applies-percent', 'checkout-tautology', 'computes-subtotal-truthy', 'discount-returns-number',
  'discount-throws-range-error', 'exposes-checkout-helper', 'mocks-discount-logic', 'records-history-shared-state',
  'spies-on-math-round', 'subtotal-exact-value', 'works-boolean-check',
] as const;

async function sha256OfDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const contents = await readFile(full);
        hash.update(relative(root, full));
        hash.update('\0');
        hash.update(contents);
        hash.update('\0');
      }
    }
  }
  await walk(root);
  return hash.digest('hex');
}

/** Own-prefix count only — see `test/oracle-runner.test.ts`'s `ownScratchDirCount` for why a shared global prefix would race concurrently-running test files. */
async function ownScratchDirCount(port: OracleObservationPort): Promise<number> {
  const entries = await readdir(dirname(port.scratchPrefix));
  const prefix = basename(port.scratchPrefix);
  return entries.filter((name) => name.startsWith(prefix)).length;
}

describe('proveCorpus against the real, committed discrimination corpus', () => {
  it(
    'proves every real case exactly as its own declared expectedOutcome predicts, reports a deliberately-unprovable case as unproven, and leaves the corpus and the filesystem exactly as it found them',
    async () => {
      const beforeHash = await sha256OfDirectory(CORPUS_ROOT);

      const cases = await loadCorpusFromDirectory(CORPUS_ROOT);
      expect(cases.map((corpusCase) => corpusCase.id).sort()).toEqual([...REAL_CASE_IDS].sort());

      const port = createOracleRunnerPort();
      const proofs = await proveCorpus(cases, { observe: port, timeoutMs: 20_000 });
      const proofById = new Map(proofs.map((proof) => [proof.caseId, proof]));

      for (const id of REAL_CASE_IDS) {
        const proof = proofById.get(id);
        expect(proof?.status, `case "${id}" should be proven`).toEqual({ kind: 'proven' });
      }

      // The acceptance criterion this whole phase exists for: a case whose mutation does NOT
      // produce its declared effect must come back unproven, never silently proven. Constructed by
      // taking a real, genuinely-descriptive, genuinely-passing case (computes-subtotal-truthy,
      // whose production mutation genuinely leaves the test passing, proven above) and flipping
      // only its declared prediction — the id is kept identical so the same real oracle recipe
      // still applies; the runner must catch that the (correctly) observed outcome contradicts the
      // (deliberately wrong) declared expectation.
      const realSource = cases.find((corpusCase) => corpusCase.id === 'computes-subtotal-truthy');
      if (realSource === undefined) throw new Error('Fixture corpus is missing computes-subtotal-truthy');
      const deliberatelyWrongCase: CorpusCase = { ...realSource, expectedOutcome: 'expected-to-fail' };
      const wrongProof = await proveCase(deliberatelyWrongCase, { observe: port, timeoutMs: 20_000 });

      expect(wrongProof.status.kind, 'the deliberately mispredicted case must never be reported proven').toBe('unproven');
      expect(wrongProof.status.kind === 'unproven' && wrongProof.status.reason).toMatch(/prediction-not-held/);
      // And it is NOT proven merely by inventing a weaker check that always passes: the underlying
      // production-mutation observation genuinely kept passing, exactly like the real (correctly
      // predicted) case it was cloned from.
      const mutationRun = wrongProof.runs.find((run) => run.label === 'base-under-mutation');
      expect(mutationRun?.observation).toEqual({ kind: 'passed' });

      const afterHash = await sha256OfDirectory(CORPUS_ROOT);
      expect(afterHash, 'the Git-stored corpus must be byte-identical after a full proof run').toBe(beforeHash);

      expect(await ownScratchDirCount(port), 'every scratch directory must have been cleaned up').toBe(0);
    },
    120_000,
  );
});
