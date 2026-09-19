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

export interface ConfigurationOverrides {
  [key: string]: unknown;
  rootDir?: string;
  include?: readonly string[];
  exclude?: readonly string[];
  concurrency?: number;
  evidence?: EvidenceConfigurationOverrides;
}

export interface ResolvedConfiguration {
  readonly rootDir: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly concurrency: number;
  readonly evidence: ResolvedEvidenceConfiguration;
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
    reportingOnly: true,
  };
}
