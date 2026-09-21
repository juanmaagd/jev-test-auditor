import { describe, expect, it } from 'vitest';
import { getOrderStatus } from './order.js';

describe('order', () => {
  it('reports exact delivered order status for diagnostics', () => {
    expect(getOrderStatus(true, true)).toBe('STATUS_DELIVERED');
  });
});
