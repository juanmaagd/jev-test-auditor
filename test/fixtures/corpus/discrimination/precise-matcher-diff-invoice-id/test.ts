import { describe, expect, it } from 'vitest';
import { formatInvoiceId } from './invoice-id.js';

describe('invoice id', () => {
  it('formats invoice identifier with exact prefix and padded sequence', () => {
    expect(formatInvoiceId('US', 42)).toBe('US-INV-0042');
  });
});
