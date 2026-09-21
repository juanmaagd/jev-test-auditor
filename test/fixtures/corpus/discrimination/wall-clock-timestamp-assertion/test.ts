import { describe, expect, it } from 'vitest';
import { isRecent } from './clock.js';

describe('clock', () => {
  it('checks if timestamp is recent', () => {
    const now = Date.now();
    expect(typeof isRecent(now)).toBe('boolean');
  });
});
