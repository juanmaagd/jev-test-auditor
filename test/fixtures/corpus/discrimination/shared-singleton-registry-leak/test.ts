import { describe, expect, it } from 'vitest';
import { registerService } from './registry.js';

describe('registry', () => {
  it('registers a new service', () => {
    const count = registerService('auth');
    expect(count).toBeGreaterThan(0);
  });
});
