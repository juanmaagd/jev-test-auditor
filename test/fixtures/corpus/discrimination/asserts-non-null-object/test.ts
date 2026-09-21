import { describe, expect, it } from 'vitest';
import { createSessionToken } from './token.js';

describe('token', () => {
  it('creates non-null token object', () => {
    expect(createSessionToken('alice')).not.toBeNull();
  });
});
