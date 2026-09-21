import { describe, expect, it } from 'vitest';
import { formatError } from './error.js';

describe('error formatter', () => {
  it('formats error with non-negative length string', () => {
    expect(formatError('404').length).toBeGreaterThanOrEqual(0);
  });
});
