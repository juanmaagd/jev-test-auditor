export function generateAuthToken(id: string): string {
  return `AUTH_${id}_OK`;
}
