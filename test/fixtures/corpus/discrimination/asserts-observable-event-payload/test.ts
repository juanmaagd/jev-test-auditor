import { describe, expect, it } from 'vitest';
import { createAuditPayload } from './event.js';

describe('event', () => {
  it('asserts on observable audit payload content', () => {
    expect(createAuditPayload('alice', 'login')).toEqual({ user: 'alice', action: 'login', version: 1 });
  });
});
