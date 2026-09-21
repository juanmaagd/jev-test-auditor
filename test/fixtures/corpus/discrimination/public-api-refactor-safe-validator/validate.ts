export function validateEmail(email: string): boolean {
  if (!email.includes('@')) return false;
  const parts = email.split('@');
  return parts.length === 2 && (parts[1]?.includes('.') ?? false);
}
