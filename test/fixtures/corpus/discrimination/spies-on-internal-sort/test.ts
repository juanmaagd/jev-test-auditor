import { describe, expect, it, vi } from 'vitest';
import { NumberSorter } from './sorter.js';

describe('sorter', () => {
  it('spies on the internal quickSort helper method', () => {
    const sorter = new NumberSorter();
    const spy = vi.spyOn(sorter, 'quickSort');
    const sorted = sorter.sortNumbers([3, 1, 2]);
    expect(sorted).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalled();
  });
});
