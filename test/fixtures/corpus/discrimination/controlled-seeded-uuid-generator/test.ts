import { describe, expect, it } from 'vitest';
import { generateId } from './uuid.js';

describe('uuid', () => {
  it('generates deterministic id using injected rng', () => {
    const deterministicRng = () => 0.42;
    expect(generateId('item', deterministicRng)).toBe('item-4200');
  });
});
