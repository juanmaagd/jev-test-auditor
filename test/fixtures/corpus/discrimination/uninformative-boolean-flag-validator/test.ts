import { describe, expect, it } from 'vitest';
import { checkConfig } from './check.js';

describe('config', () => {
  it('works', () => {
    const ok = checkConfig({ host: 'localhost', port: 8080 });
    expect(typeof ok).toBe('boolean');
  });
});
