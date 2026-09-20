import { DEFAULT_EVIDENCE_BUDGET, validateEvidenceBudget, type EvidenceBudget } from './evidence.js';
import { JEV_VERIFIED_RATE_LIMITS } from './jev-pricing.js';

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

/**
 * Adaptive-scheduling request/token budget overrides (Phase 5, task P5-3).
 * Like {@link StoreConfigurationOverrides.databasePath}, nothing in the CLI
 * argument parser reaches these — they exist for a library consumer
 * calling `resolveConfiguration()` directly, so a non-default provider
 * plan (or a deliberately tighter self-imposed budget) never requires a
 * source change. See `RequestTokenBudgetConfig` (`src/application/scheduler.ts`)
 * for how the resolved values are actually used.
 */
export interface ScheduleConfigurationOverrides {
  readonly requestsPerMinute?: number;
  readonly tokensPerSecond?: number;
}

export interface ResolvedScheduleConfiguration {
  readonly requestsPerMinute: number;
  readonly tokensPerSecond: number;
}

export interface ConfigurationOverrides {
  [key: string]: unknown;
  rootDir?: string;
  include?: readonly string[];
  exclude?: readonly string[];
  concurrency?: number;
  evidence?: EvidenceConfigurationOverrides;
  store?: StoreConfigurationOverrides;
  schedule?: ScheduleConfigurationOverrides;
}

export interface ResolvedConfiguration {
  readonly rootDir: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly concurrency: number;
  readonly evidence: ResolvedEvidenceConfiguration;
  readonly store: ResolvedStoreConfiguration;
  readonly schedule: ResolvedScheduleConfiguration;
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
  // Verified provider facts, not guesses (`JEV_VERIFIED_RATE_LIMITS`, `src/domain/jev-pricing.ts`,
  // 2026-09-20, docs.typesafe.ai/models) — the same numbers Phase 4 recorded but never enforced.
  schedule: {
    requestsPerMinute: JEV_VERIFIED_RATE_LIMITS.requestsPerMinute,
    tokensPerSecond: JEV_VERIFIED_RATE_LIMITS.tokensPerSecond,
  },
  reportingOnly: true,
};

/** Validates the resolved schedule budget: both figures must be positive finite numbers, mirroring `validateEvidenceBudget`'s own fail-fast shape (`src/domain/evidence.ts`). A non-positive or non-finite value is a misconfiguration caught here, before it ever reaches `createRequestTokenBudgetGate` (which would otherwise treat it as "unlimited" — a silent behavior change this validation prevents at the configuration boundary). */
export function validateScheduleConfiguration(schedule: ResolvedScheduleConfiguration): void {
  if (!Number.isFinite(schedule.requestsPerMinute) || schedule.requestsPerMinute <= 0) {
    throw new RangeError(`Schedule configuration requestsPerMinute must be a positive finite number: ${schedule.requestsPerMinute}`);
  }
  if (!Number.isFinite(schedule.tokensPerSecond) || schedule.tokensPerSecond <= 0) {
    throw new RangeError(`Schedule configuration tokensPerSecond must be a positive finite number: ${schedule.tokensPerSecond}`);
  }
}

export function resolveConfiguration(
  overrides: ConfigurationOverrides = {},
): ResolvedConfiguration {
  const evidence: ResolvedEvidenceConfiguration = {
    maxFragmentBytes: overrides.evidence?.maxFragmentBytes ?? DEFAULT_CONFIGURATION.evidence.maxFragmentBytes,
    maxBundleBytes: overrides.evidence?.maxBundleBytes ?? DEFAULT_CONFIGURATION.evidence.maxBundleBytes,
    deny: [...(overrides.evidence?.deny ?? DEFAULT_CONFIGURATION.evidence.deny)],
  };
  validateEvidenceBudget(evidence);

  const schedule: ResolvedScheduleConfiguration = {
    requestsPerMinute: overrides.schedule?.requestsPerMinute ?? DEFAULT_CONFIGURATION.schedule.requestsPerMinute,
    tokensPerSecond: overrides.schedule?.tokensPerSecond ?? DEFAULT_CONFIGURATION.schedule.tokensPerSecond,
  };
  validateScheduleConfiguration(schedule);

  return {
    rootDir: overrides.rootDir ?? DEFAULT_CONFIGURATION.rootDir,
    include: [...(overrides.include ?? DEFAULT_CONFIGURATION.include)],
    exclude: [...(overrides.exclude ?? DEFAULT_CONFIGURATION.exclude)],
    concurrency: overrides.concurrency ?? DEFAULT_CONFIGURATION.concurrency,
    evidence,
    store: {
      databasePath: overrides.store?.databasePath ?? DEFAULT_CONFIGURATION.store.databasePath,
    },
    schedule,
    reportingOnly: true,
  };
}
