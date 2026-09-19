import {
  type ConfigurationOverrides,
  type ResolvedConfiguration,
  resolveConfiguration as resolveDomainConfiguration,
} from '../domain/config.js';

export function getResolvedConfiguration(
  overrides: ConfigurationOverrides = {},
): ResolvedConfiguration {
  return resolveDomainConfiguration(overrides);
}
