import { describe, expect, it } from 'vitest';
import { computeScore } from './metrics.js';

describe('metrics', () => {
  it('test1', () => {
    const result = computeScore(10);
    expect(result.valid).toBe(true);
  });
});
