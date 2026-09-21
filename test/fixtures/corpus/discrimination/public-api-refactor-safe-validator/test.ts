import { describe, expect, it } from 'vitest';
import { validateEmail } from './validate.js';

describe('validator', () => {
  it('validates email format through public contract', () => {
    expect(validateEmail('test@example.com')).toBe(true);
    expect(validateEmail('invalid-email')).toBe(false);
  });
});
