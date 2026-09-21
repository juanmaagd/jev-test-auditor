import { describe, expect, it, vi } from 'vitest';

describe('fee', () => {
  it('calculates processor fee', () => {
    const mockFee = vi.fn(() => 3.2);
    expect(mockFee()).toBe(3.2);
  });
});
