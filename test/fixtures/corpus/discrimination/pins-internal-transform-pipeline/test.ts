import { describe, expect, it, vi } from 'vitest';
import { OrderPipeline } from './pipeline.js';

describe('pipeline', () => {
  it('invokes internal normalize method during process', () => {
    const pipeline = new OrderPipeline();
    const spy = vi.spyOn(pipeline, 'normalize');
    pipeline.process(' ABC ');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
