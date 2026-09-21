export function filterActiveUsers(users: readonly { id: string; active: boolean }[]): string[] {
  return users.filter((u) => u.active).map((u) => u.id);
}
