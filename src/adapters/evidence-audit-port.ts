import type {
  AuditEvidenceBuildRequest,
  AuditEvidenceBuildResult,
  AuditEvidencePort,
  SourceReadRequest,
} from '../domain/audit.js';
import type { EvidenceBundle } from '../domain/evidence.js';
import type { Diagnostic } from '../domain/test-understanding.js';
import { createMemoizingAliasConfigReader, type AliasConfigReader } from './alias-config.js';
import { resolveEvidenceFiles } from './evidence-resolution.js';
import { selectEvidence } from './evidence-selection.js';
import { readSourceFile } from './source-reader.js';

export type SourceReader = (request: SourceReadRequest) => Promise<string>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps a source reader with an in-memory cache keyed by repository-relative
 * path: the *promise* itself is cached, not just its resolved value, so
 * concurrent reads of the same file dedupe onto one underlying read instead
 * of racing to read it twice. A rejected read stays cached too (a retry
 * would hit the same failure again; this keeps the cache simple and the
 * "at most once per run" guarantee exact).
 *
 * Intended to be created once per audit run and shared by every
 * `resolveEvidenceFiles`/`selectEvidence` call in that run (see
 * {@link createAuditEvidencePort}); never reused across runs, since a later
 * run may target a different `rootDir` or see changed file content.
 */
export function createMemoizingSourceReader(readSource: SourceReader = readSourceFile): SourceReader {
  const cache = new Map<string, Promise<string>>();
  return (request: SourceReadRequest): Promise<string> => {
    const cached = cache.get(request.repositoryRelativePath);
    if (cached !== undefined) return cached;
    const pending = readSource(request);
    cache.set(request.repositoryRelativePath, pending);
    return pending;
  };
}

/**
 * Production `AuditEvidencePort`, composed in the CLI/composition root (see
 * `src/cli/index.ts`), not the domain: resolves the file's relative imports
 * once (`resolveEvidenceFiles`) and selects evidence once per test case
 * (`selectEvidence`), threading one shared memoizing reader through both
 * steps so a file already read by resolution (a hop-1 helper) or by an
 * earlier test case's selection (a shared production seam) is never read
 * again within the same run.
 *
 * Import source for resolution: every `TestCase` extracted from one file
 * carries the exact same `imports` array reference (`extractTestCases`
 * computes it once per file and reuses it for every case), so the first
 * test case's `imports` is equivalent to re-scanning the file and is used
 * directly, avoiding a redundant parse.
 *
 * Also threads ONE shared, directory-cached alias mapping reader (task A-2,
 * `odd/tasks/path-alias-resolution.md`) through every `resolveEvidenceFiles`
 * call made by this port instance, lazily created on the first `build()`
 * call against that call's `rootDir` and reused for the rest of the run —
 * so a directory's `tsconfig`/`jsconfig`/`package.json` mapping table is
 * built at most once per audit run, never once per file or per specifier.
 *
 * Isolation, two levels:
 * - Whole-file: if `resolveEvidenceFiles` itself throws (e.g. a helper read
 *   fails), this method's returned promise rejects. `runAudit` catches that,
 *   emits one `evidence-failed` diagnostic naming the file, and reports an
 *   empty `evidence` array for the whole file — matching the existing
 *   source-read/extraction isolation pattern.
 * - Per test case: a single test case's `selectEvidence` call failing does
 *   NOT drop the file's other bundles, and — deliberately — does NOT
 *   produce a placeholder bundle either. Uncertainty is not quality: an
 *   empty-but-structurally-valid bundle would be indistinguishable from "this
 *   test genuinely has no supporting evidence." Instead, the failing test
 *   case contributes no bundle at all and one `evidence-selection-failed`
 *   diagnostic naming its test case id and name (see
 *   {@link AuditEvidenceBuildResult}); every other test case's bundle is
 *   unaffected.
 */
export function createAuditEvidencePort(readSource: SourceReader = readSourceFile): AuditEvidencePort {
  const memoizedRead = createMemoizingSourceReader(readSource);
  let aliasReader: { readonly rootDir: string; readonly reader: AliasConfigReader } | undefined;

  return {
    async build(request: AuditEvidenceBuildRequest): Promise<AuditEvidenceBuildResult> {
      if (request.testCases.length === 0) return { bundles: [], diagnostics: [] };

      if (aliasReader === undefined || aliasReader.rootDir !== request.rootDir) {
        aliasReader = { rootDir: request.rootDir, reader: createMemoizingAliasConfigReader(request.rootDir, memoizedRead) };
      }

      const resolution = await resolveEvidenceFiles({
        rootDir: request.rootDir,
        testFilePath: request.repositoryRelativePath,
        imports: request.testCases[0]?.imports ?? [],
        deny: request.deny,
        readSource: memoizedRead,
        getAliasMappings: aliasReader.reader,
      });

      const bundles: EvidenceBundle[] = [];
      const diagnostics: Diagnostic[] = [];
      for (const testCase of request.testCases) {
        try {
          bundles.push(await selectEvidence({
            rootDir: request.rootDir,
            testCase,
            testFileSource: request.sourceText,
            resolution,
            budget: request.budget,
            readSource: memoizedRead,
          }));
        } catch (error) {
          diagnostics.push({
            code: 'evidence-selection-failed',
            message: `Unable to select evidence for test case ${testCase.id} ("${testCase.name}"): ${messageOf(error)}`,
            severity: 'error',
            span: testCase.span,
          });
        }
      }
      return { bundles, diagnostics };
    },
  };
}
