export function generateId(prefix: string, seedRng: () => number): string {
  const val = Math.floor(seedRng() * 10000);
  return `${prefix}-${val}`;
}
