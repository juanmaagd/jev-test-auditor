import { describe, expect, it } from 'vitest';
import { processBatch, progressTracker } from './batch-runner.js';

describe('batch runner', () => {
  it('increments progress tracker for each item', () => {
    processBatch(['a', 'b']);
    expect(progressTracker.count).toBe(2);
  });
});
