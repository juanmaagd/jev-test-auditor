export interface ConfigurationOverrides {
  [key: string]: unknown;
  rootDir?: string;
  include?: readonly string[];
  exclude?: readonly string[];
  concurrency?: number;
}

export interface ResolvedConfiguration {
  readonly rootDir: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly concurrency: number;
  readonly reportingOnly: true;
}

export const DEFAULT_CONFIGURATION: ResolvedConfiguration = {
  rootDir: '.',
  include: ['**/*.{test,spec}.{js,jsx,ts,tsx}'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  concurrency: 4,
  reportingOnly: true,
};

export function resolveConfiguration(
  overrides: ConfigurationOverrides = {},
): ResolvedConfiguration {
  return {
    rootDir: overrides.rootDir ?? DEFAULT_CONFIGURATION.rootDir,
    include: [...(overrides.include ?? DEFAULT_CONFIGURATION.include)],
    exclude: [...(overrides.exclude ?? DEFAULT_CONFIGURATION.exclude)],
    concurrency: overrides.concurrency ?? DEFAULT_CONFIGURATION.concurrency,
    reportingOnly: true,
  };
}
