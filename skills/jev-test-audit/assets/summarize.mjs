#!/usr/bin/env node
/**
 * skills/jev-test-audit/assets/summarize.mjs
 *
 * Zero-dependency, standalone summarizer for a persisted jev-test-auditor `AuditReport`
 * (see `docs/report-schema.json`). Ships inside the packaged agent skill (`package.json`
 * `files`), so it MUST NOT import anything from `src/` — it deliberately re-implements the same
 * aggregation `summarizeReport` (`src/domain/report-overview.ts`) already performs over an
 * `AuditReport`, kept in parity by `test/skill-summarize.test.ts`, which runs both against the
 * same fixture and asserts identical numbers.
 *
 * Why this exists: a real audit report can carry thousands of judged test cases — several MB of
 * JSON. An agent must never load that into its own context. This script reads the report itself
 * (a file, a `--root`-relative default, or stdin) and prints one small, deterministic JSON
 * summary an agent can afford to read directly.
 *
 * Usage:
 *   node summarize.mjs [reportPath|-] [--root <dir>] [--folder <prefix>] [--status <s>[,<s>...]]
 *                       [--dimension <id-or-label>] [--limit <n>] [--worklist] [--help]
 *
 * Input resolution (first match wins):
 *   1. positional "-"     -> read stdin (e.g. `jta report --last --json | node summarize.mjs -`)
 *   2. positional <path>  -> read that file (resolved against the current working directory)
 *   3. neither given      -> read "<root or cwd>/.jta/latest.json"
 *
 * Exit codes: 0 on success (summary printed to stdout as one compact JSON line); 1 on any usage
 * or input error (one clear line on stderr, never a stack trace).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Mirrors `HEATMAP_ROWS_LIMIT`, `src/domain/report-overview.ts`. */
const DEFAULT_TOP_FOLDERS_LIMIT = 12;
/** Mirrors `TOP_FILES_LIMIT`, `src/domain/report-overview.ts`. */
const DEFAULT_TOP_FILES_LIMIT = 10;
const DEFAULT_WORKLIST_LIMIT = 50;
/** Mirrors `HEATMAP_MIN_GROUP_SIZE`, `src/domain/report-overview.ts`. */
const HEATMAP_MIN_GROUP_SIZE = 3;

const KNOWN_STATUSES = new Set(['healthy', 'weak', 'misleading', 'needs-review']);
const LEVEL_KEYS = new Set(['misleading', 'weak', 'acceptable', 'strong']);

const USAGE = 'Usage: node summarize.mjs [reportPath|-] [--root <dir>] [--folder <prefix>] '
  + '[--status <s>[,<s>...]] [--dimension <id-or-label>] [--limit <n>] [--worklist] [--help]';

class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    reportPath: undefined,
    root: undefined,
    folder: undefined,
    status: undefined,
    dimension: undefined,
    limit: undefined,
    worklist: false,
    help: false,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--worklist') {
      options.worklist = true;
      continue;
    }
    if (argument === '--root') {
      options.root = requireValue(argv, index, '--root');
      index += 1;
      continue;
    }
    if (argument === '--folder') {
      options.folder = requireValue(argv, index, '--folder');
      index += 1;
      continue;
    }
    if (argument === '--status') {
      options.status = requireValue(argv, index, '--status');
      index += 1;
      continue;
    }
    if (argument === '--dimension') {
      options.dimension = requireValue(argv, index, '--dimension');
      index += 1;
      continue;
    }
    if (argument === '--limit') {
      const raw = requireValue(argv, index, '--limit');
      index += 1;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`--limit requires a positive integer, got "${raw}"`);
      options.limit = parsed;
      continue;
    }
    if (argument.startsWith('--')) throw new UsageError(`Unknown option: ${argument}`);
    positionals.push(argument);
  }
  if (positionals.length > 1) throw new UsageError(`Only one report path may be given, got: ${positionals.join(', ')}`);
  options.reportPath = positionals[0];
  return options;
}

function parseStatusSet(raw) {
  if (raw === undefined) return undefined;
  const values = raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
  const set = new Set(values);
  for (const value of set) {
    if (!KNOWN_STATUSES.has(value)) {
      throw new UsageError(`--status: unknown status "${value}" (expected one of ${[...KNOWN_STATUSES].join(', ')})`);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------------------------
// Input reading and validation
// ---------------------------------------------------------------------------------------------

function readReportText(options) {
  if (options.reportPath === '-') {
    try {
      return readFileSync(0, 'utf8');
    } catch (error) {
      throw new UsageError(`Unable to read report from stdin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const path = options.reportPath !== undefined
    ? resolve(process.cwd(), options.reportPath)
    : join(resolve(options.root ?? process.cwd()), '.jta', 'latest.json');
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'no such file' : (error instanceof Error ? error.message : String(error));
    throw new UsageError(`Unable to read report at ${path}: ${reason}. Run "jta audit --evaluate" first, or pass a report path.`);
  }
}

function parseReport(text, sourceLabel) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`Invalid JSON in report (${sourceLabel}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`Report (${sourceLabel}) is not a JSON object.`);
  }
  if (!Array.isArray(parsed.classifications)) {
    throw new UsageError(`Report (${sourceLabel}) is missing "classifications" (not a valid jev-test-auditor AuditReport).`);
  }
  if (parsed.discovery === undefined || parsed.discovery.totals === undefined || typeof parsed.discovery.totals.testCases !== 'number') {
    throw new UsageError(`Report (${sourceLabel}) is missing "discovery.totals.testCases" (not a valid jev-test-auditor AuditReport).`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Aggregation — deliberately mirrors src/domain/report-overview.ts (see this file's own doc)
// ---------------------------------------------------------------------------------------------

function safeShare(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function directorySegments(path) {
  return path.split('/').slice(0, -1);
}

function depthOneFolderKey(path) {
  const dirs = directorySegments(path);
  return dirs.length === 0 ? '.' : dirs[0];
}

function depthTwoFolderKey(path) {
  const dirs = directorySegments(path);
  if (dirs.length === 0) return '.';
  if (dirs.length === 1) return dirs[0];
  return dirs.slice(0, 2).join('/');
}

function matchesDimensionFilter(classification, dimensionFilter) {
  if (dimensionFilter === undefined) return true;
  const needle = dimensionFilter.toLowerCase();
  return (classification.dimensions ?? []).some(
    (dimension) => dimension.dimensionId === dimensionFilter || (dimension.dimensionLabel ?? '').toLowerCase() === needle,
  );
}

function filterClassifications(classifications, { folder, status, dimension }) {
  return classifications.filter((classification) => {
    if (folder !== undefined && !classification.repositoryRelativePath.startsWith(folder)) return false;
    if (status !== undefined && status.size > 0 && !status.has(classification.status)) return false;
    if (!matchesDimensionFilter(classification, dimension)) return false;
    return true;
  });
}

function summarizeStatusCounts(classifications) {
  const counts = { healthy: 0, weak: 0, misleading: 0, 'needs-review': 0 };
  for (const classification of classifications) {
    if (Object.prototype.hasOwnProperty.call(counts, classification.status)) counts[classification.status] += 1;
  }
  return counts;
}

function summarizeNeedsChange(classifications, statusCounts) {
  const denominator = classifications.length;
  const count = statusCounts.misleading + statusCounts.weak + statusCounts['needs-review'];
  return { count, denominator, share: safeShare(count, denominator) };
}

function summarizeDimensions(classifications) {
  const order = [];
  const labels = new Map();
  const buckets = new Map();

  for (const classification of classifications) {
    for (const dimension of classification.dimensions ?? []) {
      let bucket = buckets.get(dimension.dimensionId);
      if (bucket === undefined) {
        bucket = { misleading: 0, weak: 0, acceptable: 0, strong: 0, needsReview: 0, notApplicable: 0 };
        buckets.set(dimension.dimensionId, bucket);
        labels.set(dimension.dimensionId, dimension.dimensionLabel);
        order.push(dimension.dimensionId);
      }
      if (dimension.status === 'not-applicable') bucket.notApplicable += 1;
      else if (dimension.status === 'needs-review') bucket.needsReview += 1;
      else if (dimension.level !== undefined && LEVEL_KEYS.has(dimension.level)) bucket[dimension.level] += 1;
    }
  }

  return order.map((dimensionId) => {
    const bucket = buckets.get(dimensionId);
    const total = bucket.misleading + bucket.weak + bucket.acceptable + bucket.strong + bucket.needsReview + bucket.notApplicable;
    // Summed as two independent shares (never `safeShare(badCount, total)`) to stay bit-for-bit
    // in parity with `deficientShare` (`shares.misleading + shares.weak`) in report-overview.ts.
    const badShare = safeShare(bucket.misleading, total) + safeShare(bucket.weak, total);
    return {
      dimensionId,
      dimensionLabel: labels.get(dimensionId),
      total,
      badCount: bucket.misleading + bucket.weak,
      badShare,
    };
  });
}

function summarizeTopFolders(classifications, limit) {
  const candidateKeys = classifications.map((classification) => depthTwoFolderKey(classification.repositoryRelativePath));
  const candidateSizes = new Map();
  for (const key of candidateKeys) candidateSizes.set(key, (candidateSizes.get(key) ?? 0) + 1);

  const folders = new Map();
  classifications.forEach((classification, index) => {
    const candidate = candidateKeys[index];
    const key = (candidateSizes.get(candidate) ?? 0) >= HEATMAP_MIN_GROUP_SIZE
      ? candidate
      : depthOneFolderKey(classification.repositoryRelativePath);
    let tally = folders.get(key);
    if (tally === undefined) {
      tally = { needsChange: 0, total: 0 };
      folders.set(key, tally);
    }
    tally.total += 1;
    if (classification.status !== 'healthy') tally.needsChange += 1;
  });

  const ranked = [...folders.entries()].sort(
    ([leftKey, left], [rightKey, right]) => right.needsChange - left.needsChange || right.total - left.total || leftKey.localeCompare(rightKey),
  );
  const kept = ranked.slice(0, limit);
  const overflow = ranked.slice(limit);

  const rows = kept.map(([folder, tally]) => ({
    folder,
    needsChangeCount: tally.needsChange,
    judgedTotal: tally.total,
    share: safeShare(tally.needsChange, tally.total),
    isOther: false,
  }));

  if (overflow.length > 0) {
    const merged = { needsChange: 0, total: 0 };
    for (const [, tally] of overflow) {
      merged.needsChange += tally.needsChange;
      merged.total += tally.total;
    }
    rows.push({
      folder: 'Other',
      needsChangeCount: merged.needsChange,
      judgedTotal: merged.total,
      share: safeShare(merged.needsChange, merged.total),
      isOther: true,
    });
  }

  return rows;
}

function summarizeTopFiles(classifications, limit) {
  const byPath = new Map();
  for (const classification of classifications) {
    const tally = byPath.get(classification.repositoryRelativePath) ?? { needsChange: 0, total: 0 };
    tally.total += 1;
    if (classification.status !== 'healthy') tally.needsChange += 1;
    byPath.set(classification.repositoryRelativePath, tally);
  }
  return [...byPath.entries()]
    .map(([path, tally]) => ({
      path,
      needsChangeCount: tally.needsChange,
      judgedTotal: tally.total,
      share: safeShare(tally.needsChange, tally.total),
    }))
    .filter((entry) => entry.needsChangeCount > 0)
    .sort((left, right) => right.needsChangeCount - left.needsChangeCount || right.share - left.share || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function findingsForWorklist(classification) {
  return (classification.findings ?? [])
    .filter((finding) => finding.level === 'misleading' || finding.level === 'weak')
    .map((finding) => ({
      dimensionId: finding.dimensionId,
      dimensionLabel: finding.dimensionLabel,
      level: finding.level,
      reason: finding.reason ?? null,
    }));
}

/**
 * The worklist of non-healthy tests, grouped by file. When `--status` was given explicitly,
 * that filter already decided which statuses are in play (respected as-is, even if it happens to
 * include `healthy`); otherwise it defaults to every non-healthy status, since a worklist exists
 * to drive fixes, not to restate what is already fine.
 */
function summarizeWorklist(classifications, statusFilterGiven, limit) {
  const candidates = statusFilterGiven ? classifications : classifications.filter((classification) => classification.status !== 'healthy');

  const byFile = new Map();
  for (const classification of candidates) {
    const list = byFile.get(classification.repositoryRelativePath) ?? [];
    list.push(classification);
    byFile.set(classification.repositoryRelativePath, list);
  }

  const files = [...byFile.entries()].map(([path, entries]) => ({
    path,
    needsChangeCount: entries.filter((entry) => entry.status !== 'healthy').length,
    tests: entries
      .map((entry) => ({ name: entry.name, status: entry.status, dimensions: findingsForWorklist(entry) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }));

  files.sort((left, right) => right.needsChangeCount - left.needsChangeCount || left.path.localeCompare(right.path));

  const kept = files.slice(0, limit);
  const omittedFiles = Math.max(0, files.length - kept.length);
  return { files: kept.map(({ path, tests }) => ({ path, tests })), omittedFiles };
}

/** Deterministic ordering throughout: every ranked list is worst-first, then by path — see this file's own doc. */
export function summarize(report, options = {}) {
  const statusSet = parseStatusSet(options.status);
  const filters = { folder: options.folder, status: statusSet, dimension: options.dimension };
  const filtered = filterClassifications(report.classifications, filters);

  const statusCounts = summarizeStatusCounts(filtered);
  const summaryResult = {
    runId: report.runId ?? null,
    rootDir: report.rootDir,
    discovered: report.discovery.totals.testCases,
    judged: filtered.length,
    needsChange: summarizeNeedsChange(filtered, statusCounts),
    statusCounts,
    dimensions: summarizeDimensions(filtered),
    topFolders: summarizeTopFolders(filtered, options.limit ?? DEFAULT_TOP_FOLDERS_LIMIT),
    topFiles: summarizeTopFiles(filtered, options.limit ?? DEFAULT_TOP_FILES_LIMIT),
  };

  if (options.worklist) {
    summaryResult.worklist = summarizeWorklist(filtered, statusSet !== undefined && statusSet.size > 0, options.limit ?? DEFAULT_WORKLIST_LIMIT);
  }

  return summaryResult;
}

// ---------------------------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------------------------

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  try {
    const sourceLabel = options.reportPath === '-' ? 'stdin' : (options.reportPath ?? 'default .jta/latest.json');
    const text = readReportText(options);
    const report = parseReport(text, sourceLabel);
    const summaryResult = summarize(report, options);
    process.stdout.write(`${JSON.stringify(summaryResult)}\n`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
