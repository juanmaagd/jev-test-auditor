export function runBatch(items: readonly number[]): { total: number; count: number } {
  const sum = items.reduce((acc, x) => acc + x, 0);
  return { total: sum, count: items.length };
}
