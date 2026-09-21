export function createAuditPayload(user: string, action: string): { user: string; action: string; version: number } {
  return { user, action, version: 1 };
}
