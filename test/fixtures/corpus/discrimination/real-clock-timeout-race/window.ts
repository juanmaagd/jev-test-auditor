export function isWithinWindow(timestamp: number, maxAgeMs: number): boolean {
  return Date.now() - timestamp <= maxAgeMs;
}
