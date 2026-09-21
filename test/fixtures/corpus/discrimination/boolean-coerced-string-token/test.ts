import { describe, expect, it } from 'vitest';
import { generateAuthToken } from './auth.js';

describe('auth token', () => {
  it('generates truthy boolean-coerced token', () => {
    expect(Boolean(generateAuthToken('user-1'))).toBe(true);
  });
});
