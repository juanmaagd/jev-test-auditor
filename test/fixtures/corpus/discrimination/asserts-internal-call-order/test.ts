import { describe, expect, it, vi } from 'vitest';
import { processCheckout, steps } from './checkout-flow.js';

describe('checkout flow', () => {
  it('calls validate before notify', () => {
    const calls: string[] = [];
    vi.spyOn(steps, 'validate').mockImplementation(() => {
      calls.push('validate');
      return true;
    });
    vi.spyOn(steps, 'notify').mockImplementation(() => {
      calls.push('notify');
    });

    processCheckout('order-1');
    expect(calls).toEqual(['validate', 'notify']);
  });
});
