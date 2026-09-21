import { describe, expect, it } from 'vitest';
import { pickItem } from './sampler.js';

describe('sampler', () => {
  it('picks first item deterministically with controlled seed', () => {
    const deterministicZero = (): number => 0;
    expect(pickItem(['first', 'second'], deterministicZero)).toBe('first');
  });
});
