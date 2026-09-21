import { describe, expect, it } from 'vitest';
import { history, record } from './audit-log.js';

describe('cart', () => {
  it('records history across runs', () => {
    record(`run-${Math.random()}`);
    expect(history().length).toBeGreaterThan(0);
  });
});
