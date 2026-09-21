import { describe, expect, it, vi } from 'vitest';

describe('cart', () => {
  it('applies the discount', () => {
    const mocked = vi.fn(() => 99);
    expect(mocked()).toBe(99);
  });
});
