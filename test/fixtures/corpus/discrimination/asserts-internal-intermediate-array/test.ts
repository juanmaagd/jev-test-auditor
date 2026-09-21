import { describe, expect, it } from 'vitest';
import { ItemCollector } from './collector.js';

describe('collector', () => {
  it('asserts on internal buffer length directly', () => {
    const collector = new ItemCollector();
    collector.collect('a');
    expect(collector.buffer).toHaveLength(1);
  });
});
