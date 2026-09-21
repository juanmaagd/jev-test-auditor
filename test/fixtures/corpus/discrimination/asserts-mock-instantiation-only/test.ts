import { describe, expect, it } from 'vitest';
import { InvoiceService } from './invoice.js';

describe('invoice service', () => {
  it('instantiates invoice service', () => {
    const svc = new InvoiceService();
    expect(svc).toBeDefined();
  });
});
