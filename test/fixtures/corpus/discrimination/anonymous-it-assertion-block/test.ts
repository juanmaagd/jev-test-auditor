import { describe, expect, it } from 'vitest';
import { formatProfile } from './profile.js';

describe('profile', () => {
  it('test 1', () => {
    expect(formatProfile('admin', 30)).toBeTruthy();
  });
});
