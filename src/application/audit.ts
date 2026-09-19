import type {
  AuditPorts,
  AuditRequest,
  AuditResult,
  AuditDiagnostic,
  AuditFileResult,
} from '../domain/audit.js';
import type { Diagnostic } from '../domain/test-understanding.js';
import type { EvidenceBundle } from '../domain/evidence.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function comparePath(left: { readonly repositoryRelativePath: string }, right: { readonly repositoryRelativePath: string }): number {
  return left.repositoryRelativePath < right.repositoryRelativePath ? -1
    : left.repositoryRelativePath > right.repositoryRelativePath ? 1 : 0;
}

function withPath(diagnostic: Diagnostic, repositoryRelativePath: string): AuditDiagnostic {
  return { ...diagnostic, repositoryRelativePath };
}

export async function runAudit(
  request: AuditRequest,
  ports: AuditPorts,
): Promise<AuditResult> {
  let discovery;
  try {
    discovery = await ports.discovery.discover({
      rootDir: request.rootDir,
      include: request.include,
      exclude: request.exclude,
    });
  } catch (error) {
    const diagnostics: readonly AuditDiagnostic[] = [{
      code: 'discovery-failed',
      message: `Unable to discover test files: ${messageOf(error)}`,
      severity: 'error',
    }];
    return {
      rootDir: request.rootDir,
      files: [],
      excluded: [],
      diagnostics,
      totals: {
        files: 0,
        excluded: 0,
        testCases: 0,
        dynamicMetadata: 0,
        diagnostics: diagnostics.length,
        evidenceBundles: 0,
        evidenceFragments: 0,
        evidenceTruncatedFragments: 0,
        evidenceOmitted: 0,
        evidenceDenied: 0,
        evidenceUnresolved: 0,
      },
      reportingOnly: true,
    };
  }

  const files = [...discovery.files].sort(comparePath);
  const excluded = [...discovery.excluded].sort((left, right) => {
    const pathOrder = comparePath(left, right);
    return pathOrder !== 0 ? pathOrder : left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
  });
  const diagnostics: AuditDiagnostic[] = [...discovery.diagnostics];
  const results: AuditFileResult[] = [];

  for (const discovered of files) {
    let sourceText: string;
    try {
      sourceText = await ports.sourceReader.read({
        rootDir: request.rootDir,
        repositoryRelativePath: discovered.repositoryRelativePath,
      });
    } catch (error) {
      const diagnostic = withPath({
        code: 'source-read-failed',
        message: `Unable to read ${discovered.repositoryRelativePath}: ${messageOf(error)}`,
        severity: 'error',
      }, discovered.repositoryRelativePath);
      diagnostics.push(diagnostic);
      results.push({
        discovered,
        testCases: [],
        dynamicMetadata: [],
        diagnostics: [{ code: diagnostic.code, message: diagnostic.message, severity: diagnostic.severity }],
        evidence: [],
      });
      continue;
    }

    try {
      const extraction = ports.extractor.extract({
        repositoryRelativePath: discovered.repositoryRelativePath,
        sourceText,
        frameworkHint: discovered.framework,
      });
      const fileDiagnostics: Diagnostic[] = [...extraction.diagnostics];
      diagnostics.push(...extraction.diagnostics.map((diagnostic) => withPath(diagnostic, discovered.repositoryRelativePath)));

      let evidence: readonly EvidenceBundle[] = [];
      if (extraction.testCases.length > 0) {
        try {
          const evidenceResult = await ports.evidence.build({
            rootDir: request.rootDir,
            repositoryRelativePath: discovered.repositoryRelativePath,
            sourceText,
            testCases: extraction.testCases,
            budget: { maxFragmentBytes: request.evidence.maxFragmentBytes, maxBundleBytes: request.evidence.maxBundleBytes },
            deny: request.evidence.deny,
          });
          evidence = evidenceResult.bundles;
          fileDiagnostics.push(...evidenceResult.diagnostics);
          diagnostics.push(...evidenceResult.diagnostics.map((diagnostic) => withPath(diagnostic, discovered.repositoryRelativePath)));
        } catch (error) {
          const diagnostic = withPath({
            code: 'evidence-failed',
            message: `Unable to build evidence for ${discovered.repositoryRelativePath}: ${messageOf(error)}`,
            severity: 'error',
          }, discovered.repositoryRelativePath);
          diagnostics.push(diagnostic);
          fileDiagnostics.push({ code: diagnostic.code, message: diagnostic.message, severity: diagnostic.severity });
          evidence = [];
        }
      }

      results.push({
        discovered,
        testCases: extraction.testCases,
        dynamicMetadata: extraction.dynamicMetadata,
        diagnostics: fileDiagnostics,
        evidence,
      });
    } catch (error) {
      const diagnostic = withPath({
        code: 'extraction-failed',
        message: `Unable to extract ${discovered.repositoryRelativePath}: ${messageOf(error)}`,
        severity: 'error',
      }, discovered.repositoryRelativePath);
      diagnostics.push(diagnostic);
      results.push({
        discovered,
        testCases: [],
        dynamicMetadata: [],
        diagnostics: [{ code: diagnostic.code, message: diagnostic.message, severity: diagnostic.severity }],
        evidence: [],
      });
    }
  }

  const evidenceBundles = results.flatMap((file) => file.evidence);
  const totals = {
    files: results.length,
    excluded: excluded.length,
    testCases: results.reduce((total, file) => total + file.testCases.length, 0),
    dynamicMetadata: results.reduce((total, file) => total + file.dynamicMetadata.length, 0),
    diagnostics: diagnostics.length,
    evidenceBundles: evidenceBundles.length,
    evidenceFragments: evidenceBundles.reduce((total, bundle) => total + bundle.totals.fragments, 0),
    evidenceTruncatedFragments: evidenceBundles.reduce((total, bundle) => total + bundle.totals.truncatedFragments, 0),
    evidenceOmitted: evidenceBundles.reduce((total, bundle) => total + bundle.omitted.length, 0),
    evidenceDenied: evidenceBundles.reduce((total, bundle) => total + bundle.denied.length, 0),
    evidenceUnresolved: evidenceBundles.reduce((total, bundle) => total + bundle.unresolved.length, 0),
  };
  return { rootDir: request.rootDir, files: results, excluded, diagnostics, totals, reportingOnly: true };
}
