import { describe, expect, it } from 'vitest';
import { runBatch } from './batch.js';

describe('batch', () => {
  it('asserts on observable batch computation result', () => {
    const summary = runBatch([10, 20, 30]);
    expect(summary.total).toBe(60);
  });
});
