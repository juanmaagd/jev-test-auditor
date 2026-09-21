import { describe, expect, it } from 'vitest';
import { CartService } from './service.js';

describe('service', () => {
  it('populates internal _cache record on getPrice', () => {
    const svc = new CartService();
    svc.getPrice('item-1');
    expect(svc._cache['item-1']).toBe(10);
  });
});
