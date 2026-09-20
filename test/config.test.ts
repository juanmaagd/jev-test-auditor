import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIGURATION, resolveConfiguration } from '../src/domain/config.js';
import { DEFAULT_EVIDENCE_BUDGET } from '../src/domain/evidence.js';

describe('resolved configuration', () => {
  it('uses deterministic zero-config defaults', () => {
    expect(resolveConfiguration()).toEqual({
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
    });
  });

  it('overrides only the requested settings', () => {
    const resolved = resolveConfiguration({ concurrency: 2, rootDir: 'fixtures' });

    expect(resolved).toEqual({
      ...DEFAULT_CONFIGURATION,
      concurrency: 2,
      rootDir: 'fixtures',
    });
  });

  it('clones default include and exclude arrays for each resolution', () => {
    const resolved = resolveConfiguration();

    expect(resolved.include).toEqual(DEFAULT_CONFIGURATION.include);
    expect(resolved.exclude).toEqual(DEFAULT_CONFIGURATION.exclude);
    expect(resolved.include).not.toBe(DEFAULT_CONFIGURATION.include);
    expect(resolved.exclude).not.toBe(DEFAULT_CONFIGURATION.exclude);
  });

  it('clones caller-provided include and exclude arrays', () => {
    const include = ['custom/**/*.test.ts'];
    const exclude = ['custom/vendor/**'];
    const resolved = resolveConfiguration({ include, exclude });

    expect(resolved.include).toEqual(include);
    expect(resolved.exclude).toEqual(exclude);
    expect(resolved.include).not.toBe(include);
    expect(resolved.exclude).not.toBe(exclude);
  });


  it('keeps reporting-only enabled when unknown runtime input asks to disable it', () => {
    const resolved = resolveConfiguration({ reportingOnly: false });

    expect(resolved.reportingOnly).toBe(true);
  });
});

// --- Audit store configuration (Phase 5, task P5-1) ------------------------

describe('store configuration', () => {
  it('defaults databasePath to undefined, deferring the default location to the adapter', () => {
    const resolved = resolveConfiguration();

    expect(resolved.store).toEqual({ databasePath: undefined });
  });

  it('carries an explicit databasePath override through untouched', () => {
    const resolved = resolveConfiguration({ store: { databasePath: '/custom/audit-store.sqlite3' } });

    expect(resolved.store).toEqual({ databasePath: '/custom/audit-store.sqlite3' });
  });
});

describe('evidence configuration', () => {
  it('defaults to the default evidence budget and an empty additive deny list', () => {
    const resolved = resolveConfiguration();

    expect(resolved.evidence).toEqual({
      maxFragmentBytes: DEFAULT_EVIDENCE_BUDGET.maxFragmentBytes,
      maxBundleBytes: DEFAULT_EVIDENCE_BUDGET.maxBundleBytes,
      deny: [],
    });
  });

  it('overrides only the requested evidence settings', () => {
    const resolved = resolveConfiguration({ evidence: { maxFragmentBytes: 1024 } });

    expect(resolved.evidence).toEqual({
      maxFragmentBytes: 1024,
      maxBundleBytes: DEFAULT_EVIDENCE_BUDGET.maxBundleBytes,
      deny: [],
    });
  });

  it('treats configured deny patterns as additive (defaults still apply downstream, this only carries the extras)', () => {
    const resolved = resolveConfiguration({ evidence: { deny: ['**/fixtures/**'] } });

    expect(resolved.evidence.deny).toEqual(['**/fixtures/**']);
  });

  it('clones the caller-provided deny array', () => {
    const deny = ['**/fixtures/**'];
    const resolved = resolveConfiguration({ evidence: { deny } });

    expect(resolved.evidence.deny).toEqual(deny);
    expect(resolved.evidence.deny).not.toBe(deny);
  });

  it('validates the resolved evidence budget and throws for a non-positive maxFragmentBytes', () => {
    expect(() => resolveConfiguration({ evidence: { maxFragmentBytes: 0 } })).toThrow(RangeError);
  });

  it('validates the resolved evidence budget and throws when maxFragmentBytes exceeds maxBundleBytes', () => {
    expect(() => resolveConfiguration({ evidence: { maxFragmentBytes: 999_999 } })).toThrow(RangeError);
  });
});
