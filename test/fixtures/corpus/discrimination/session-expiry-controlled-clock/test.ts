import { describe, expect, it } from 'vitest';
import { createSession, isSessionExpired } from './session.js';

describe('session', () => {
  it('expires session after timeout with controlled clock', () => {
    const start = 1_000;
    const session = createSession(start);
    expect(isSessionExpired(session, 500, start + 600)).toBe(true);
  });
});
