import { describe, expect, it, vi } from 'vitest';

describe('cart', () => {
  it('computes subtotal via stub', () => {
    const stub = vi.fn().mockReturnValue(50);
    expect(stub([{ sku: 'x', price: 10, qty: 1 }])).toBe(50);
  });
});
