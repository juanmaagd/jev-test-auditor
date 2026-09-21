/**
 * I/O for the Phase 7 fixture corpus (task P7-1). Reads bytes off disk and
 * hands them to `src/domain/corpus.ts`, which does every shape decision;
 * this file makes none of its own beyond "which bytes to read, in which
 * order" — exactly the domain/adapter split `odd/tasks/phase-7-benchmarks.md`
 * requires ("Parsing is deterministic and pure ... reading corpus files from
 * disk is adapter work").
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildCorpusCase,
  parseCorpusCaseManifest,
  type CorpusCase,
  type CorpusSourceFile,
} from '../domain/corpus.js';

const MANIFEST_FILE_NAME = 'case.json';

async function readCorpusSourceFile(caseDir: string, relativePath: string): Promise<CorpusSourceFile> {
  const contents = await readFile(join(caseDir, relativePath), 'utf8');
  return { path: relativePath, contents };
}

/**
 * Reads one case directory's `case.json` plus every file it names, and
 * assembles them into a {@link CorpusCase}. All shape validation —
 * including path-containment checks on `testFile`/`productionFiles` — is the
 * domain parser's job; this function only reads what the manifest, once
 * validated, says to read.
 */
export async function loadCorpusCase(caseDir: string): Promise<CorpusCase> {
  const manifestJson = await readFile(join(caseDir, MANIFEST_FILE_NAME), 'utf8');
  const manifest = parseCorpusCaseManifest(manifestJson);

  const baseTest = await readCorpusSourceFile(caseDir, manifest.testFile);
  const productionSources = await Promise.all(
    manifest.productionFiles.map((path) => readCorpusSourceFile(caseDir, path)),
  );

  return buildCorpusCase(manifest, baseTest, productionSources);
}

/**
 * Reads every immediate case directory under `rootDir`, in a fixed,
 * alphabetically sorted order. `readdir`'s own order is not specified by
 * Node and is not guaranteed identical across platforms; a Git-reviewed
 * corpus must parse into the same case list everywhere it is cloned, so this
 * function never depends on `readdir`'s incidental order.
 *
 * Rejects a case whose manifest `id` does not match its own directory name.
 * This is deliberately stricter than only rejecting duplicate ids: because
 * directory names are already unique on the filesystem, requiring
 * `id === basename(caseDir)` makes every id unique *and* catches the actual
 * failure mode this guards against — a case directory copy-pasted to author
 * a new case, whose `case.json` was never updated to match its new name —
 * at the one case that is actually wrong, rather than only when a second,
 * differently-named case happens to collide with it later.
 */
export async function loadCorpusFromDirectory(rootDir: string): Promise<readonly CorpusCase[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const caseDirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const cases: CorpusCase[] = [];
  for (const dirName of caseDirNames) {
    const corpusCase = await loadCorpusCase(join(rootDir, dirName));
    if (corpusCase.id !== dirName) {
      throw new RangeError(
        `Corpus case directory "${dirName}" declares a different id in its manifest: "${corpusCase.id}"`,
      );
    }
    cases.push(corpusCase);
  }
  return cases;
}
