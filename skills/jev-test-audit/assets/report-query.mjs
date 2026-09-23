#!/usr/bin/env node
/**
 * skills/jev-test-audit/assets/report-query.mjs
 *
 * Zero-dependency, standalone query tool over a persisted jev-test-auditor `AuditReport` (see
 * `docs/report-schema.json`). Ships inside the packaged agent skill (`package.json` `files`), so
 * it MUST NOT import anything from `src/`. Supersedes `summarize.mjs` (unreleased, no
 * back-compat): a single "summary" was not enough — an agent needs a script for every question it
 * may ask about a report that can be several MB and must never enter its context, so this is a
 * subcommand tool, one subcommand per question shape.
 *
 * `summary`'s aggregation is deliberately kept in parity with `summarizeReport`
 * (`src/domain/report-overview.ts`) — proven by `test/skill-report-query.test.ts`, which runs
 * both against the same fixture and asserts identical numbers.
 *
 * Usage:
 *   node report-query.mjs <subcommand> [args] [options]
 *
 * Subcommands:
 *   summary  [reportPath|-] [options]                    - headline needs-change/needs-review/status/dimension aggregate
 *   worklist [reportPath|-] [options]                     - needs-change tests (files) + needs-review reasons (needsReview)
 *   file <path> [reportPath|-] [options]                  - every judged test in one file, per-dimension level+status
 *   test <name-substring|testCaseId> [reportPath|-] [opt] - matching tests with full per-dimension detail
 *   folders  [reportPath|-] [options]                     - ranked folder aggregate (reuses summary math)
 *   dimensions [reportPath|-] [options]                   - ranked dimension aggregate, worst-first
 *   batches --by file|folder [--max-tests N] [--include-needs-review] [reportPath|-] [options]
 *                                                          - proposed fix batches
 *   diff <beforeRunId|path> [afterRunId|path] [--root <dir>] [--limit/--offset]
 *                                                          - before/after comparison, default after = latest
 *   runs [--root <dir>] [--limit/--offset]                - list persisted run ids under .jta/reports
 *
 * Common options: --root <dir>, --run <id>, --in <path|->, --folder <prefix>, --status <s[,s...]>,
 * --dimension <id-or-label>, --limit <n>, --offset <n>, --help.
 *
 * Report source (summary/worklist/file/test/folders/dimensions/batches), first match wins:
 *   1. --run <id>              -> "<root>/.jta/reports/<id>.json"
 *   2. --in <path|-> or the trailing positional "-"/path -> that file, or stdin for "-"
 *   3. neither given           -> "<root or cwd>/.jta/latest.json"
 *
 * Every subcommand prints one compact, deterministic JSON line to stdout. Ranked lists are capped
 * with `--limit`/`--offset` and always report `{ items, total, omitted }` — `total` is the full
 * ranked population, `omitted` is how many more remain past what is shown. Exit codes: 0 on
 * success; 1 on any usage or input error (one clear line on stderr, never a stack trace).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Mirrors `HEATMAP_ROWS_LIMIT`, `src/domain/report-overview.ts` — the FIXED folder-merge cutoff, never overridden by `--limit` (see `summarizeTopFolders`'s own doc below). */
const HEATMAP_ROWS_LIMIT = 12;
/** Mirrors `HEATMAP_MIN_GROUP_SIZE`, `src/domain/report-overview.ts`. */
const HEATMAP_MIN_GROUP_SIZE = 3;

const DEFAULT_TOP_FOLDERS_LIMIT = 20;
const DEFAULT_TOP_FILES_LIMIT = 10; // mirrors TOP_FILES_LIMIT, src/domain/report-overview.ts
const DEFAULT_WORKLIST_LIMIT = 50;
const DEFAULT_FILE_TESTS_LIMIT = 200;
const DEFAULT_TEST_MATCHES_LIMIT = 20;
const DEFAULT_FOLDERS_LIMIT = 20;
const DEFAULT_DIMENSIONS_LIMIT = 20;
const DEFAULT_BATCHES_LIMIT = 20;
const DEFAULT_DIFF_LIST_LIMIT = 50;
const DEFAULT_RUNS_LIMIT = 20;

const KNOWN_STATUSES = new Set(['healthy', 'weak', 'misleading', 'needs-review']);
const LEVEL_KEYS = new Set(['misleading', 'weak', 'acceptable', 'strong']);
const STATUS_RANK = { healthy: 0, 'needs-review': 1, weak: 2, misleading: 3 };

const USAGE = [
  'Usage: node report-query.mjs <subcommand> [args] [options]',
  '',
  'Subcommands:',
  '  summary    [reportPath|-]  headline needs-change/needs-review/status/dimension aggregate',
  '  worklist   [reportPath|-]  needs-change tests (files) + needs-review reasons (needsReview)',
  '  file       <path> [reportPath|-]  every judged test in one file, per-dimension level+status',
  '  test       <name-substring|testCaseId> [reportPath|-]  matching tests, full per-dimension detail',
  '  folders    [reportPath|-]  ranked folder aggregate',
  '  dimensions [reportPath|-]  ranked dimension aggregate, worst-first',
  '  batches    --by file|folder [--max-tests N] [--include-needs-review] [reportPath|-]',
  '  diff       <beforeRunId|path> [afterRunId|path]  before/after comparison (default after = latest)',
  '  runs       list persisted run ids under .jta/reports',
  '',
  'Options: --root <dir> --run <id> --in <path|-> --folder <prefix> --status <s[,s...]>',
  '         --dimension <id-or-label> --limit <n> --offset <n> --help',
].join('\n');

class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

const VALUE_FLAG_KEYS = {
  '--root': 'root',
  '--run': 'run',
  '--in': 'in',
  '--limit': 'limit',
  '--offset': 'offset',
  '--folder': 'folder',
  '--status': 'status',
  '--dimension': 'dimension',
  '--by': 'by',
  '--max-tests': 'maxTests',
};

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--include-needs-review') {
      options.includeNeedsReview = true;
      continue;
    }
    const key = VALUE_FLAG_KEYS[argument];
    if (key !== undefined) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${argument} requires a value`);
      options[key] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw new UsageError(`Unknown option: ${argument}`);
    positionals.push(argument);
  }
  return { options, positionals };
}

function parsePositiveIntOption(raw, label) {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`--${label} requires a positive integer, got "${raw}"`);
  return parsed;
}

function parseNonNegativeIntOption(raw, label) {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${label} requires a non-negative integer, got "${raw}"`);
  return parsed;
}

function parseStatusSet(raw) {
  if (raw === undefined) return undefined;
  const values = raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
  const set = new Set(values);
  for (const value of set) {
    if (!KNOWN_STATUSES.has(value)) throw new UsageError(`--status: unknown status "${value}" (expected one of ${[...KNOWN_STATUSES].join(', ')})`);
  }
  return set;
}

function limitOffset(options, defaultLimit) {
  return {
    limit: parsePositiveIntOption(options.limit, 'limit') ?? defaultLimit,
    offset: parseNonNegativeIntOption(options.offset, 'offset') ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Input reading, report source resolution, and validation
// ---------------------------------------------------------------------------------------------

function readFileOrThrow(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'no such file' : (error instanceof Error ? error.message : String(error));
    throw new UsageError(`Unable to read report at ${path}: ${reason}. Run "jta audit --evaluate" first, or pass a report path.`);
  }
}

function readStdinOrThrow() {
  try {
    return readFileSync(0, 'utf8');
  } catch (error) {
    throw new UsageError(`Unable to read report from stdin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Report source resolution shared by every subcommand that reads one report — see this file's own doc. */
function resolveReportSource(positionalReportPath, options) {
  if (options.run !== undefined) {
    const path = join(resolve(options.root ?? process.cwd()), '.jta', 'reports', `${options.run}.json`);
    return { text: readFileOrThrow(path), label: options.run };
  }
  const explicit = options.in ?? positionalReportPath;
  if (explicit === '-') return { text: readStdinOrThrow(), label: 'stdin' };
  if (explicit !== undefined) return { text: readFileOrThrow(resolve(process.cwd(), explicit)), label: explicit };
  const defaultPath = join(resolve(options.root ?? process.cwd()), '.jta', 'latest.json');
  return { text: readFileOrThrow(defaultPath), label: 'default .jta/latest.json' };
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

function readAndParseReport(positionalReportPath, options) {
  const source = resolveReportSource(positionalReportPath, options);
  return parseReport(source.text, source.label);
}

// ---------------------------------------------------------------------------------------------
// Shared aggregation — deliberately mirrors src/domain/report-overview.ts (see this file's doc)
// ---------------------------------------------------------------------------------------------

function safeShare(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** `{ items, total, omitted }`: `total` is the full ranked population; `omitted` is how many more remain past what `items` shows (accounting for `offset`). */
function paginate(list, limit, offset) {
  const total = list.length;
  const items = list.slice(offset, offset + limit);
  const omitted = Math.max(0, total - offset - items.length);
  return { items, total, omitted };
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

// `needs-review` is deliberately excluded here — see src/domain/report-overview.ts, "'Needs a
// change' never counts needs-review": the model was uncertain, never a confirmed defect.
function summarizeNeedsChange(classifications, statusCounts) {
  const denominator = classifications.length;
  const count = statusCounts.misleading + statusCounts.weak;
  return { count, denominator, share: safeShare(count, denominator) };
}

/** `needs-review`'s own figure, over the SAME denominator as `summarizeNeedsChange` — never folded into it. Mirrors `summarizeNeedsReview`, src/domain/report-overview.ts. */
function summarizeNeedsReview(classifications, statusCounts) {
  const denominator = classifications.length;
  const count = statusCounts['needs-review'];
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
    // in parity with `deficientShare` in report-overview.ts.
    const badShare = safeShare(bucket.misleading, total) + safeShare(bucket.weak, total);
    return { dimensionId, dimensionLabel: labels.get(dimensionId), total, badCount: bucket.misleading + bucket.weak, badShare };
  });
}

/**
 * The canonical, folded folder ranking — the same "Other"-merge `summarizeFolderHeatmap`
 * (`src/domain/report-overview.ts`) performs, at the SAME fixed thresholds
 * (`HEATMAP_ROWS_LIMIT`/`HEATMAP_MIN_GROUP_SIZE`), never `--limit`: the merge is part of what
 * "top folders" means, not a display cap. `--limit`/`--offset` paginate this already-folded,
 * already-capped (`HEATMAP_ROWS_LIMIT` + 1 "Other" row at most) list afterwards.
 */
function summarizeTopFolders(classifications) {
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
    if (classification.status === 'misleading' || classification.status === 'weak') tally.needsChange += 1;
  });

  const ranked = [...folders.entries()].sort(
    ([leftKey, left], [rightKey, right]) => right.needsChange - left.needsChange || right.total - left.total || leftKey.localeCompare(rightKey),
  );
  const kept = ranked.slice(0, HEATMAP_ROWS_LIMIT);
  const overflow = ranked.slice(HEATMAP_ROWS_LIMIT);

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

/** Every file with at least one non-healthy test, ranked worst-first — deliberately uncapped: `--limit`/`--offset` decide how much of it to show, and `total`/`omitted` stay honest about the real count. `summary`'s default `--limit` (10) reproduces `summarizeReport`'s fixed `TOP_FILES_LIMIT` cap for parity. */
function summarizeTopFiles(classifications) {
  const byPath = new Map();
  for (const classification of classifications) {
    const tally = byPath.get(classification.repositoryRelativePath) ?? { needsChange: 0, total: 0 };
    tally.total += 1;
    if (classification.status === 'misleading' || classification.status === 'weak') tally.needsChange += 1;
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
    .sort((left, right) => right.needsChangeCount - left.needsChangeCount || right.share - left.share || left.path.localeCompare(right.path));
}

// ---------------------------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------------------------

function cmdSummary(positionals, options) {
  const report = readAndParseReport(positionals[0], options);
  const filtered = filterClassifications(report.classifications, {
    folder: options.folder,
    status: parseStatusSet(options.status),
    dimension: options.dimension,
  });
  const statusCounts = summarizeStatusCounts(filtered);
  const foldersLimit = limitOffset(options, DEFAULT_TOP_FOLDERS_LIMIT);
  const filesLimit = limitOffset(options, DEFAULT_TOP_FILES_LIMIT);
  return {
    runId: report.runId ?? null,
    rootDir: report.rootDir,
    discovered: report.discovery.totals.testCases,
    judged: filtered.length,
    needsChange: summarizeNeedsChange(filtered, statusCounts),
    needsReview: summarizeNeedsReview(filtered, statusCounts),
    statusCounts,
    dimensions: summarizeDimensions(filtered),
    topFolders: paginate(summarizeTopFolders(filtered), foldersLimit.limit, foldersLimit.offset),
    topFiles: paginate(summarizeTopFiles(filtered), filesLimit.limit, filesLimit.offset),
  };
}

/**
 * Both groups read `classification.dimensions` directly (never `findings`) — the same source
 * `summary`/`dimensions`/`file`/`test` already read, so there is exactly one place a dimension's
 * level/status/reason comes from. `files`: needs-change tests (status misleading/weak — NEVER
 * needs-review, which is uncertain rather than a confirmed defect) grouped by file, with their
 * judged misleading/weak dimensions (a judged dimension never carries a `reason` — only a
 * needs-review dimension does). `needsReview`: the previously-dead `reason` codes, one entry per
 * needs-review dimension, grouped by file — scanned over every filtered classification, so a
 * misleading/weak test that ALSO carries a needs-review dimension on another dimensionId still
 * appears in both groups.
 */
function cmdWorklist(positionals, options) {
  const report = readAndParseReport(positionals[0], options);
  const filtered = filterClassifications(report.classifications, {
    folder: options.folder,
    status: parseStatusSet(options.status),
    dimension: options.dimension,
  });
  const { limit, offset } = limitOffset(options, DEFAULT_WORKLIST_LIMIT);

  const byFile = new Map();
  for (const classification of filtered) {
    // needs a change = misleading/weak only; needs-review is uncertain, never a confirmed defect,
    // and is already surfaced separately below (`needsReviewByFile`).
    if (classification.status !== 'misleading' && classification.status !== 'weak') continue;
    const list = byFile.get(classification.repositoryRelativePath) ?? [];
    list.push(classification);
    byFile.set(classification.repositoryRelativePath, list);
  }
  const filesFull = [...byFile.entries()].map(([path, entries]) => ({
    path,
    needsChangeCount: entries.length,
    tests: entries
      .map((entry) => ({
        name: entry.name,
        status: entry.status,
        dimensions: (entry.dimensions ?? [])
          .filter((dimension) => dimension.status === 'judged' && (dimension.level === 'misleading' || dimension.level === 'weak'))
          .map((dimension) => ({ dimensionId: dimension.dimensionId, level: dimension.level })),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }));
  filesFull.sort((left, right) => right.needsChangeCount - left.needsChangeCount || left.path.localeCompare(right.path));

  const needsReviewByFile = new Map();
  for (const classification of filtered) {
    for (const dimension of classification.dimensions ?? []) {
      if (dimension.status !== 'needs-review') continue;
      const list = needsReviewByFile.get(classification.repositoryRelativePath) ?? [];
      list.push({ name: classification.name, dimensionId: dimension.dimensionId, reason: dimension.reason ?? null });
      needsReviewByFile.set(classification.repositoryRelativePath, list);
    }
  }
  const needsReviewFull = [...needsReviewByFile.entries()].map(([path, tests]) => ({
    path,
    tests: tests.sort((left, right) => left.name.localeCompare(right.name) || left.dimensionId.localeCompare(right.dimensionId)),
  }));
  needsReviewFull.sort((left, right) => right.tests.length - left.tests.length || left.path.localeCompare(right.path));

  return {
    files: paginate(filesFull, limit, offset),
    needsReview: paginate(needsReviewFull, limit, offset),
  };
}

function cmdFile(positionals, options) {
  const filePath = positionals[0];
  if (filePath === undefined) throw new UsageError('file requires a <path> argument');
  const report = readAndParseReport(positionals[1], options);
  const matches = report.classifications.filter((classification) => classification.repositoryRelativePath === filePath);
  if (matches.length === 0) throw new UsageError(`No judged tests found for file "${filePath}"`);
  const { limit, offset } = limitOffset(options, DEFAULT_FILE_TESTS_LIMIT);
  const items = matches
    .map((classification) => ({
      name: classification.name,
      status: classification.status,
      dimensions: classification.dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        dimensionLabel: dimension.dimensionLabel,
        status: dimension.status,
        level: dimension.level ?? null,
      })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { path: filePath, tests: paginate(items, limit, offset) };
}

function cmdTest(positionals, options) {
  const query = positionals[0];
  if (query === undefined) throw new UsageError('test requires a <name-substring|testCaseId> argument');
  const report = readAndParseReport(positionals[1], options);
  const needle = query.toLowerCase();
  const matches = report.classifications.filter(
    (classification) => classification.testCaseId === query || classification.name.toLowerCase().includes(needle),
  );
  const { limit, offset } = limitOffset(options, DEFAULT_TEST_MATCHES_LIMIT);
  const items = matches
    .map((classification) => ({
      testCaseId: classification.testCaseId,
      repositoryRelativePath: classification.repositoryRelativePath,
      name: classification.name,
      status: classification.status,
      dimensions: classification.dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        dimensionLabel: dimension.dimensionLabel,
        status: dimension.status,
        level: dimension.level ?? null,
        confidence: dimension.confidence ?? null,
        applicabilityProbability: dimension.applicabilityProbability ?? null,
        probabilities: dimension.probabilities ?? null,
      })),
    }))
    .sort((left, right) => left.repositoryRelativePath.localeCompare(right.repositoryRelativePath) || left.name.localeCompare(right.name));
  return { query, matches: paginate(items, limit, offset) };
}

function cmdFolders(positionals, options) {
  const report = readAndParseReport(positionals[0], options);
  const filtered = filterClassifications(report.classifications, {
    folder: options.folder,
    status: parseStatusSet(options.status),
    dimension: options.dimension,
  });
  const { limit, offset } = limitOffset(options, DEFAULT_FOLDERS_LIMIT);
  return { folders: paginate(summarizeTopFolders(filtered), limit, offset) };
}

function cmdDimensions(positionals, options) {
  const report = readAndParseReport(positionals[0], options);
  const filtered = filterClassifications(report.classifications, {
    folder: options.folder,
    status: parseStatusSet(options.status),
    dimension: options.dimension,
  });
  const { limit, offset } = limitOffset(options, DEFAULT_DIMENSIONS_LIMIT);
  const ranked = summarizeDimensions(filtered)
    .slice()
    .sort((left, right) => right.badShare - left.badShare || right.badCount - left.badCount || left.dimensionId.localeCompare(right.dimensionId));
  return { dimensions: paginate(ranked, limit, offset) };
}

function worstDimensionsFor(classifications, topN = 3) {
  return summarizeDimensions(classifications)
    .slice()
    .sort((left, right) => right.badCount - left.badCount || left.dimensionId.localeCompare(right.dimensionId))
    .filter((dimension) => dimension.badCount > 0)
    .slice(0, topN)
    .map((dimension) => ({ dimensionId: dimension.dimensionId, dimensionLabel: dimension.dimensionLabel, badCount: dimension.badCount }));
}

function buildFileBatches(candidates) {
  const byFile = new Map();
  for (const classification of candidates) {
    const list = byFile.get(classification.repositoryRelativePath) ?? [];
    list.push(classification);
    byFile.set(classification.repositoryRelativePath, list);
  }
  const batches = [...byFile.entries()].map(([path, entries]) => ({
    key: path,
    files: [path],
    testCount: entries.length,
    worstDimensions: worstDimensionsFor(entries),
  }));
  batches.sort((left, right) => right.testCount - left.testCount || left.key.localeCompare(right.key));
  return batches;
}

/** Packs files (never splitting one file across batches — "one subagent per file") into folder-scoped batches, greedily chunked to `maxTests` when given. Folder key folding reuses the same depth-two/depth-one rule `summarizeTopFolders` uses, scoped to the candidate files only — never the "Other" row cutoff, since every batch must stay actionable. */
function buildFolderBatches(candidates, maxTests) {
  const byFile = new Map();
  for (const classification of candidates) {
    const list = byFile.get(classification.repositoryRelativePath) ?? [];
    list.push(classification);
    byFile.set(classification.repositoryRelativePath, list);
  }
  const fileEntries = [...byFile.entries()].map(([path, entries]) => ({ path, entries, count: entries.length }));

  const candidateKeys = fileEntries.map((file) => depthTwoFolderKey(file.path));
  // Counts TESTS, not files, per candidate key — matching what `summarizeTopFolders` counts, so
  // the same folder isn't reported as "src/area" there and merely "src" here.
  const candidateSizes = new Map();
  fileEntries.forEach((file, index) => {
    const key = candidateKeys[index];
    candidateSizes.set(key, (candidateSizes.get(key) ?? 0) + file.count);
  });

  const byFolder = new Map();
  fileEntries.forEach((file, index) => {
    const candidate = candidateKeys[index];
    const key = (candidateSizes.get(candidate) ?? 0) >= HEATMAP_MIN_GROUP_SIZE ? candidate : depthOneFolderKey(file.path);
    const list = byFolder.get(key) ?? [];
    list.push(file);
    byFolder.set(key, list);
  });

  const batches = [];
  for (const [folderKey, files] of byFolder.entries()) {
    files.sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
    const chunks = maxTests === undefined ? [files] : greedyChunk(files, maxTests);
    chunks.forEach((chunkFiles, index) => {
      const entries = chunkFiles.flatMap((file) => file.entries);
      const key = chunks.length > 1 ? `${folderKey} (part ${index + 1})` : folderKey;
      batches.push({ key, files: chunkFiles.map((file) => file.path), testCount: entries.length, worstDimensions: worstDimensionsFor(entries) });
    });
  }
  batches.sort((left, right) => right.testCount - left.testCount || left.key.localeCompare(right.key));
  return batches;
}

function greedyChunk(files, maxTests) {
  const chunks = [];
  let current = [];
  let currentCount = 0;
  for (const file of files) {
    if (current.length > 0 && currentCount + file.count > maxTests) {
      chunks.push(current);
      current = [];
      currentCount = 0;
    }
    current.push(file);
    currentCount += file.count;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Default candidates are needs-change only (misleading/weak) — a fix batch proposes tests to FIX,
 * and `needs-review` means the model was uncertain, never a confirmed defect (see SKILL.md's own
 * Hard Rule: "never present it as a defect"). `--include-needs-review` opts uncertain tests back in
 * for a batch that also wants a human to double-check them alongside real fixes.
 */
function cmdBatches(positionals, options) {
  const report = readAndParseReport(positionals[0], options);
  const by = options.by ?? 'file';
  if (by !== 'file' && by !== 'folder') throw new UsageError('--by must be "file" or "folder"');
  const maxTests = options.maxTests !== undefined ? parsePositiveIntOption(options.maxTests, 'max-tests') : undefined;

  let candidates = report.classifications.filter((classification) => classification.status === 'misleading' || classification.status === 'weak');
  if (options.includeNeedsReview) {
    candidates = report.classifications.filter((classification) => classification.status !== 'healthy');
  }

  const { limit, offset } = limitOffset(options, DEFAULT_BATCHES_LIMIT);
  const batches = by === 'file' ? buildFileBatches(candidates) : buildFolderBatches(candidates, maxTests);
  return { by, batches: paginate(batches, limit, offset) };
}

function readDiffSource(token, root) {
  if (token === undefined) {
    const path = join(resolve(root), '.jta', 'latest.json');
    return { text: readFileOrThrow(path), label: 'latest' };
  }
  const literalPath = resolve(process.cwd(), token);
  try {
    return { text: readFileSync(literalPath, 'utf8'), label: token };
  } catch {
    const runPath = join(resolve(root), '.jta', 'reports', `${token}.json`);
    try {
      return { text: readFileSync(runPath, 'utf8'), label: token };
    } catch {
      throw new UsageError(`Unable to read diff source "${token}": not found as a file (${literalPath}) or as a run id (${runPath})`);
    }
  }
}

function cmdDiff(positionals, options) {
  const beforeToken = positionals[0];
  if (beforeToken === undefined) throw new UsageError('diff requires a <beforeRunId|path> argument');
  const afterToken = positionals[1];
  const root = options.root ?? process.cwd();

  const beforeSource = readDiffSource(beforeToken, root);
  const afterSource = readDiffSource(afterToken, root);
  const beforeReport = parseReport(beforeSource.text, beforeSource.label);
  const afterReport = parseReport(afterSource.text, afterSource.label);

  const beforeStatusCounts = summarizeStatusCounts(beforeReport.classifications);
  const afterStatusCounts = summarizeStatusCounts(afterReport.classifications);

  const beforeDims = new Map(summarizeDimensions(beforeReport.classifications).map((dimension) => [dimension.dimensionId, dimension]));
  const afterDims = new Map(summarizeDimensions(afterReport.classifications).map((dimension) => [dimension.dimensionId, dimension]));
  const dimensionIds = new Set([...beforeDims.keys(), ...afterDims.keys()]);
  const dimensions = [...dimensionIds].sort().map((dimensionId) => {
    const before = beforeDims.get(dimensionId);
    const after = afterDims.get(dimensionId);
    return {
      dimensionId,
      dimensionLabel: after?.dimensionLabel ?? before?.dimensionLabel ?? dimensionId,
      before: { badCount: before?.badCount ?? 0, total: before?.total ?? 0 },
      after: { badCount: after?.badCount ?? 0, total: after?.total ?? 0 },
    };
  });

  const beforeById = new Map(beforeReport.classifications.map((classification) => [classification.testCaseId, classification]));
  const afterById = new Map(afterReport.classifications.map((classification) => [classification.testCaseId, classification]));
  const improved = [];
  const regressed = [];
  const unchanged = [];
  let matched = 0;
  for (const [testCaseId, beforeClassification] of beforeById) {
    const afterClassification = afterById.get(testCaseId);
    if (afterClassification === undefined) continue;
    matched += 1;
    const entry = {
      testCaseId,
      repositoryRelativePath: afterClassification.repositoryRelativePath,
      name: afterClassification.name,
      before: beforeClassification.status,
      after: afterClassification.status,
    };
    const beforeRank = STATUS_RANK[beforeClassification.status] ?? 0;
    const afterRank = STATUS_RANK[afterClassification.status] ?? 0;
    if (afterRank < beforeRank) improved.push(entry);
    else if (afterRank > beforeRank) regressed.push(entry);
    else unchanged.push(entry);
  }
  const added = [...afterById.keys()].filter((testCaseId) => !beforeById.has(testCaseId)).length;
  const removed = [...beforeById.keys()].filter((testCaseId) => !afterById.has(testCaseId)).length;

  const sortEntries = (left, right) => left.repositoryRelativePath.localeCompare(right.repositoryRelativePath) || left.name.localeCompare(right.name);
  improved.sort(sortEntries);
  regressed.sort(sortEntries);
  unchanged.sort(sortEntries);

  const { limit, offset } = limitOffset(options, DEFAULT_DIFF_LIST_LIMIT);
  return {
    before: { source: beforeSource.label, runId: beforeReport.runId ?? null },
    after: { source: afterSource.label, runId: afterReport.runId ?? null },
    statusCounts: { before: beforeStatusCounts, after: afterStatusCounts },
    dimensions,
    matched,
    added,
    removed,
    improved: paginate(improved, limit, offset),
    regressed: paginate(regressed, limit, offset),
    unchanged: paginate(unchanged, limit, offset),
  };
}

function cmdRuns(_positionals, options) {
  const root = resolve(options.root ?? process.cwd());
  const reportsDir = join(root, '.jta', 'reports');
  let entries;
  try {
    entries = readdirSync(reportsDir, { withFileTypes: true });
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'no persisted reports directory' : (error instanceof Error ? error.message : String(error));
    throw new UsageError(`Unable to read ${reportsDir}: ${reason}. Run "jta audit --evaluate" first.`);
  }
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  const rows = [];
  let skipped = 0;
  for (const entry of jsonFiles) {
    const filePath = join(reportsDir, entry.name);
    const runId = entry.name.slice(0, -'.json'.length);
    try {
      const stat = statSync(filePath);
      const parsedReport = parseReport(readFileSync(filePath, 'utf8'), filePath);
      const statusCounts = summarizeStatusCounts(parsedReport.classifications);
      const row = { runId, recordedAt: stat.mtime.toISOString(), needsChange: summarizeNeedsChange(parsedReport.classifications, statusCounts) };
      rows.push({ row, mtimeMs: stat.mtimeMs });
    } catch {
      skipped += 1;
    }
  }
  rows.sort((left, right) => right.mtimeMs - left.mtimeMs || left.row.runId.localeCompare(right.row.runId));
  const cleaned = rows.map((entry) => entry.row);
  const { limit, offset } = limitOffset(options, DEFAULT_RUNS_LIMIT);
  return { root, runs: paginate(cleaned, limit, offset), skipped };
}

const SUBCOMMANDS = {
  summary: cmdSummary,
  worklist: cmdWorklist,
  file: cmdFile,
  test: cmdTest,
  folders: cmdFolders,
  dimensions: cmdDimensions,
  batches: cmdBatches,
  diff: cmdDiff,
  runs: cmdRuns,
};

// ---------------------------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------------------------

export function main(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const handler = SUBCOMMANDS[subcommand];
  if (handler === undefined) {
    process.stderr.write(`Error: Unknown subcommand: ${subcommand}\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const { options, positionals } = parseArgs(rest);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const result = handler(positionals, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

// No "is this the entry module" guard: nothing ever imports this file (it ships as a standalone
// CLI asset — see this file's own doc). A symlinked skill directory (the common `~/.claude/skills/`
// dotfiles pattern) can make `process.argv[1]` and `import.meta.url` disagree after path
// resolution, and a guard that silently skips `main()` on that mismatch would exit 0 with no
// output — worse than always running it.
try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
