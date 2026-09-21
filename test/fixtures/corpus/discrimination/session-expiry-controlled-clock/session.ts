export interface Session { readonly createdAt: number; }

export function createSession(now: number): Session {
  return { createdAt: now };
}

export function isSessionExpired(session: Session, timeoutMs: number, now: number): boolean {
  return now - session.createdAt >= timeoutMs;
}
