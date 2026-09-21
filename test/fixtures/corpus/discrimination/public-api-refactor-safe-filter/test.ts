import { describe, expect, it } from 'vitest';
import { filterActiveUsers } from './filter.js';

describe('filter', () => {
  it('filters active user ids through the public interface', () => {
    const users = [{ id: 'u1', active: true }, { id: 'u2', active: false }, { id: 'u3', active: true }];
    expect(filterActiveUsers(users)).toEqual(['u1', 'u3']);
  });
});
