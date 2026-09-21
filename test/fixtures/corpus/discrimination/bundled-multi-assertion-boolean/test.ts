import { describe, expect, it } from 'vitest';
import { buildSummary } from './report.js';

describe('report', () => {
  it('bundles checks into boolean', () => {
    const r = buildSummary('rep-1', 100);
    const isValid = r.id === 'rep-1' && r.total > 0 && r.active;
    expect(isValid).toBe(true);
  });
});
