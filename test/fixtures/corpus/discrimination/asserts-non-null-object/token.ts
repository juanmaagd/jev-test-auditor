export function createSessionToken(user: string): Record<string, string> {
  return { user, role: 'admin' };
}
