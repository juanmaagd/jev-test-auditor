import { describe, expect, it, vi } from 'vitest';
import { formatter, record } from './audit-log.js';

describe('audit', () => {
  it('calls formatter during record', () => {
    const spy = vi.spyOn(formatter, 'format');
    record('order-1');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
