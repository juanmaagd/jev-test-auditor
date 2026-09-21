export function pickItem<T>(items: readonly T[], randomFloat: () => number): T {
  const index = Math.floor(randomFloat() * items.length);
  return items[index]!;
}
