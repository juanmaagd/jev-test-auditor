import { describe, expect, it } from 'vitest';
import { isWithinWindow } from './window.js';

describe('window', () => {
  it('accepts immediate timestamp using real clock', () => {
    const now = Date.now();
    expect(isWithinWindow(now, 1000)).toBe(true);
  });
});
