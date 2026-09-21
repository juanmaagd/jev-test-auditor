import { describe, expect, it } from 'vitest';
import { getCount, increment } from './counter.js';

describe('counter', () => {
  it('increments counter across executions', () => {
    increment();
    expect(getCount()).toBeGreaterThan(0);
  });
});
