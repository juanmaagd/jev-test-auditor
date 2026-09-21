import { describe, expect, it } from 'vitest';
import { Slugger } from './slug.js';

describe('slugger', () => {
  it('pins the private regex pattern property', () => {
    const slugger = new Slugger();
    expect(slugger.separatorPattern.source).toBe('[\\s_-]+');
    expect(slugger.slugify('Hello World')).toBe('hello-world');
  });
});
