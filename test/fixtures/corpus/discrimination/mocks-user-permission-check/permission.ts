export function hasPermission(role: string, action: string): boolean {
  if (role === 'admin') return true;
  return role === 'editor' && action === 'edit';
}
