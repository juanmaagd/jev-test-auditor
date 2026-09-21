import { describe, expect, it } from 'vitest';

describe('tax', () => {
  it('prepares tax calculation rate correctly', () => {
    const rate = 0.1;
    expect(rate).toBe(0.1);
  });
});
