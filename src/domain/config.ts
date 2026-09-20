import { DEFAULT_EVIDENCE_BUDGET, validateEvidenceBudget, type EvidenceBudget } from './evidence.js';

export interface EvidenceConfigurationOverrides {
  readonly maxFragmentBytes?: number;
  readonly maxBundleBytes?: number;
  /** Additive on top of the resolver's own always-applied deny defaults; never replaces them. */
  readonly deny?: readonly string[];
}

export interface ResolvedEvidenceConfiguration extends EvidenceBudget {
  readonly deny: readonly string[];
}

/**
 * Audit store configuration overrides (Phase 5, task P5-1). `databasePath`
 * overrides the adapter's own per-user default resolution
 * (`resolveAuditStorePaths` in `src/adapters/sqlite-audit-store.ts`, which
 * mirrors `resolveAuthStoragePaths`'s convention) — domain code never
 * computes a default path itself (no `node:os`/`node:path` access; the
 * domain layer stays pure), so `undefined` here means "let the adapter
 * decide," never "no database."
 */
export interface StoreConfigurationOverrides {
  readonly databasePath?: string;
}

export interface ResolvedStoreConfiguration {
  readonly databasePath: string | undefined;
}

export interface ConfigurationOverrides {
  [key: string]: unknown;
  rootDir?: string;
  include?: readonly string[];
  exclude?: readonly string[];
  concurrency?: number;
  evidence?: EvidenceConfigurationOverrides;
  store?: StoreConfigurationOverrides;
}

export interface ResolvedConfiguration {
  readonly rootDir: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly concurrency: number;
  readonly evidence: ResolvedEvidenceConfiguration;
  readonly store: ResolvedStoreConfiguration;
  readonly reportingOnly: true;
}

export const DEFAULT_CONFIGURATION: ResolvedConfiguration = {
  rootDir: '.',
  include: ['**/*.{test,spec}.{js,jsx,ts,tsx}'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  concurrency: 4,
  evidence: {
    maxFragmentBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes,
    maxBundleBytes: DEFAULT_EVIDENCE_BUDGET.maxBundleBytes,
    deny: [],
  },
  store: {
    databasePath: undefined,
  },
  reportingOnly: true,
};

export function resolveConfiguration(
  overrides: ConfigurationOverrides = {},
): ResolvedConfiguration {
  const evidence: ResolvedEvidenceConfiguration = {
    maxFragmentBytes: overrides.evidence?.maxFragmentBytes ?? DEFAULT_CONFIGURATION.evidence.maxFragmentBytes,
    maxBundleBytes: overrides.evidence?.maxBundleBytes ?? DEFAULT_CONFIGURATION.evidence.maxBundleBytes,
    deny: [...(overrides.evidence?.deny ?? DEFAULT_CONFIGURATION.evidence.deny)],
  };
  validateEvidenceBudget(evidence);

  return {
    rootDir: overrides.rootDir ?? DEFAULT_CONFIGURATION.rootDir,
    include: [...(overrides.include ?? DEFAULT_CONFIGURATION.include)],
    exclude: [...(overrides.exclude ?? DEFAULT_CONFIGURATION.exclude)],
    concurrency: overrides.concurrency ?? DEFAULT_CONFIGURATION.concurrency,
    evidence,
    store: {
      databasePath: overrides.store?.databasePath ?? DEFAULT_CONFIGURATION.store.databasePath,
    },
    reportingOnly: true,
  };
}
