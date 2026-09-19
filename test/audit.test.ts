import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import type {
  AuditPorts,
  AuditRequest,
} from '../src/domain/audit.js';
import type { DiscoveredTestFile, DiscoveryResult } from '../src/domain/discovery.js';
import type { TestExtractionResult } from '../src/domain/extraction.js';

const configuration: AuditRequest = {
  rootDir: '/repo',
  include: ['**/*.test.ts'],
  exclude: [],
  concurrency: 4,
  reportingOnly: true,
};

function discovered(repositoryRelativePath: string): DiscoveredTestFile {
  return { repositoryRelativePath, framework: 'vitest', frameworkEvidence: [] };
}

function extraction(name: string): TestExtractionResult {
  return { testCases: [{
    id: `tc:v1:${name}`,
    repositoryRelativePath: `${name}.test.ts`,
    kind: 'test',
    framework: 'vitest',
    name,
    structuralAncestry: [{ kind: 'test', name, ordinal: 0 }],
    source: `test('${name}', () => {});`,
    span: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    modifiers: [],
    hooks: [],
    imports: [],
    mocks: [],
    assertions: [],
    parameterization: { mode: 'none', cases: [] },
    diagnostics: [],
  }], dynamicMetadata: [], diagnostics: [] };
}

function portsFor(
  discovery: DiscoveryResult,
  read: (path: string) => Promise<string>,
  extract: (path: string, source: string) => TestExtractionResult,
): AuditPorts {
  return {
    discovery: { discover: async () => discovery },
    sourceReader: { read: async ({ repositoryRelativePath }) => read(repositoryRelativePath) },
    extractor: { extract: ({ repositoryRelativePath, sourceText }) => extract(repositoryRelativePath, sourceText) },
  };
}

describe('audit application', () => {
  it('sorts files and exclusions, reads and extracts each file once, and aggregates results', async () => {
    const reads: string[] = [];
    const extracts: string[] = [];
    const discovery: DiscoveryResult = {
      files: [discovered('z.test.ts'), discovered('a.test.ts')],
      excluded: [
        { repositoryRelativePath: 'z.skip.ts', reason: 'configured-exclude', evidence: [] },
        { repositoryRelativePath: 'a.skip.ts', reason: 'default-exclude', evidence: [] },
      ],
      diagnostics: [],
    };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async (path) => { reads.push(path); return `source:${path}`; },
      (path) => { extracts.push(path); return extraction(path); },
    ));

    expect(reads).toEqual(['a.test.ts', 'z.test.ts']);
    expect(extracts).toEqual(['a.test.ts', 'z.test.ts']);
    expect(result.files.map((file) => file.discovered.repositoryRelativePath)).toEqual(['a.test.ts', 'z.test.ts']);
    expect(result.excluded.map((file) => file.repositoryRelativePath)).toEqual(['a.skip.ts', 'z.skip.ts']);
    expect(result.totals).toEqual({ files: 2, excluded: 2, testCases: 2, dynamicMetadata: 0, diagnostics: 0 });
    expect(result.reportingOnly).toBe(true);
  });

  it('keeps going after deterministic read and extraction failures', async () => {
    const discovery: DiscoveryResult = {
      files: [discovered('extract.test.ts'), discovered('read.test.ts'), discovered('ok.test.ts')],
      excluded: [],
      diagnostics: [],
    };

    const result = await runAudit(configuration, portsFor(
      discovery,
      async (path) => {
        if (path === 'read.test.ts') throw new Error('read boom');
        return path;
      },
      (path) => {
        if (path === 'extract.test.ts') throw new Error('extract boom');
        return extraction(path);
      },
    ));

    expect(result.files.map((file) => file.discovered.repositoryRelativePath)).toEqual([
      'extract.test.ts', 'ok.test.ts', 'read.test.ts',
    ]);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'read.test.ts')?.diagnostics).toEqual([
      { code: 'source-read-failed', message: 'Unable to read read.test.ts: read boom', severity: 'error' },
    ]);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'extract.test.ts')?.diagnostics).toEqual([
      { code: 'extraction-failed', message: 'Unable to extract extract.test.ts: extract boom', severity: 'error' },
    ]);
    expect(result.files.find((file) => file.discovered.repositoryRelativePath === 'ok.test.ts')?.testCases).toHaveLength(1);
    expect(result.totals.diagnostics).toBe(2);
  });

  it('preserves discovery diagnostics and returns an empty reporting-only result on discovery failure', async () => {
    const result = await runAudit(configuration, {
      discovery: { discover: async () => { throw new Error('discovery boom'); } },
      sourceReader: { read: async () => '' },
      extractor: { extract: () => ({ testCases: [], dynamicMetadata: [], diagnostics: [] }) },
    });

    expect(result.files).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'discovery-failed', message: 'Unable to discover test files: discovery boom', severity: 'error' },
    ]);
    expect(result.reportingOnly).toBe(true);
  });

  it('preserves discovery exclusions and root diagnostics on a successful scan', async () => {
    const discovery: DiscoveryResult = {
      files: [],
      excluded: [{ repositoryRelativePath: 'ignored.test.ts', reason: 'e2e-v1', evidence: ['e2e-path-segment'] }],
      diagnostics: [{ code: 'package-json-invalid', message: 'package warning', severity: 'warning' }],
    };

    const result = await runAudit(configuration, portsFor(discovery, async () => '', () => ({
      testCases: [], dynamicMetadata: [], diagnostics: [],
    })));

    expect(result.excluded).toEqual(discovery.excluded);
    expect(result.diagnostics).toEqual(discovery.diagnostics);
    expect(result.totals.diagnostics).toBe(1);
  });
});
