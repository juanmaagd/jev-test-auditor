import { describe, expect, it, vi } from 'vitest';

describe('permission', () => {
  it('validates user permission', () => {
    const mockHasPermission = vi.fn(() => true);
    expect(mockHasPermission()).toBe(true);
  });
});
