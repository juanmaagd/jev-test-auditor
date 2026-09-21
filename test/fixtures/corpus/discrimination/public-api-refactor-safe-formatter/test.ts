import { describe, expect, it } from 'vitest';
import { formatPrice } from './formatter.js';

describe('formatter', () => {
  it('formats prices according to public currency formatting', () => {
    expect(formatPrice(19.5, 'USD')).toBe('USD 19.50');
  });
});
