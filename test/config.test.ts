import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIGURATION, resolveConfiguration } from '../src/domain/config.js';

describe('resolved configuration', () => {
  it('uses deterministic zero-config defaults', () => {
    expect(resolveConfiguration()).toEqual({
      rootDir: '.',
      include: ['**/*.{test,spec}.{js,jsx,ts,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      concurrency: 4,
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
