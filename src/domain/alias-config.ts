/**
 * Static alias-configuration mapping tables (Phase "path alias resolution",
 * task A-1, `odd/tasks/path-alias-resolution.md`). Pure data shapes only —
 * no filesystem access, no `typescript` compiler API, nothing executable.
 * The adapter that builds these values lives in
 * `src/adapters/alias-config.ts`.
 */

/**
 * Which static mechanism produced a mapping entry. Also the precedence
 * order applied by a consumer that must pick one mechanism for a specifier
 * (see the feature doc's "Decisions" section): `imports` (a `#`-prefixed
 * Node subpath import is unambiguous) beats tsconfig/jsconfig `paths`,
 * which beats a workspace package name, which beats a bare `baseUrl`
 * catch-all. This module does not itself apply that precedence — it only
 * orders {@link AliasMappings.entries} so a caller can rely on the order.
 */
export type AliasMappingSource = 'imports' | 'paths' | 'workspace' | 'baseUrl';

/**
 * One resolvable pattern. `pattern` contains at most one `*` (a Node/TS
 * subpath wildcard); `targets` are repository-relative path patterns with
 * the same `*` left in place (never expanded — expansion against a
 * specific specifier is a consumer concern, e.g. task A-2), listed in
 * declaration order so multiple `paths` targets keep their fallback order.
 * `declaredIn` is the repository-relative path of the config file that
 * actually declared this entry (after `extends` resolution), for
 * provenance in reports and debugging.
 */
export interface AliasMappingEntry {
  readonly source: AliasMappingSource;
  readonly pattern: string;
  readonly targets: readonly string[];
  readonly declaredIn: string;
}

/**
 * Why a candidate mapping, `extends` target, or config file was refused.
 * Every refusal is recorded, never silently dropped and never thrown.
 */
export type AliasConfigRefusalReason =
  | 'extends-outside-root'
  | 'extends-node-modules'
  | 'extends-cycle'
  | 'extends-missing'
  | 'config-malformed'
  | 'config-unreadable'
  | 'target-outside-root'
  | 'imports-external-target'
  | 'imports-unsupported-conditions';

export interface AliasConfigRefusal {
  readonly reason: AliasConfigRefusalReason;
  /** Repository-relative path of the config file where the refusal was detected. */
  readonly declaredIn: string;
  /** The raw text that triggered the refusal (an `extends` string, an `imports` key, or a mapped target), for debugging. Never a filesystem path outside the root. */
  readonly detail: string;
}

/**
 * The deterministic mapping table for one file, per
 * `resolveAliasConfig`/`createAliasConfigReader` in
 * `src/adapters/alias-config.ts`. `entries` is already in precedence order
 * (`imports`, then `paths`, then `workspace`, then `baseUrl`); within a
 * source, entries preserve their declared order. `configFiles` lists every
 * repository-relative config file path that was actually opened while
 * building this table (nearest tsconfig/jsconfig chain, nearest
 * package.json, and the root package.json when workspaces were read),
 * whether or not it contributed an entry — a malformed config is still
 * "read", it just contributes no entry (see `refusals`).
 */
export interface AliasMappings {
  readonly entries: readonly AliasMappingEntry[];
  readonly configFiles: readonly string[];
  readonly refusals: readonly AliasConfigRefusal[];
}
