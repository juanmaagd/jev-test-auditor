import { describe, expect, it } from 'vitest';
import { isTokenExpired } from './token-expiry.js';

describe('token expiry', () => {
  it('checks token expiry with controlled time', () => {
    const token = { expiresAt: 1000 };
    expect(isTokenExpired(token, 1001)).toBe(true);
  });
});
