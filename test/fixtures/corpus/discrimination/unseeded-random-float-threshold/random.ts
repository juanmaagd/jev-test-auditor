export function coinFlip(): string {
  return Math.random() >= 0.5 ? 'heads' : 'tails';
}
