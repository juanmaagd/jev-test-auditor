import { describe, expect, it } from 'vitest';
import { getMembershipTier } from './membership.js';

describe('membership tier', () => {
  it('returns exact tier 3 for high points', () => {
    expect(getMembershipTier(1500)).toBe(3);
  });
});
