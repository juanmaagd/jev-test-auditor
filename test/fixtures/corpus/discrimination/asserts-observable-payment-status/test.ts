import { describe, expect, it } from 'vitest';
import { processPayment } from './payment.js';

describe('payment', () => {
  it('verifies observable payment status', () => {
    expect(processPayment(50).status).toBe('PAID');
  });
});
