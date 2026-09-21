export function isRecent(timestamp: number, thresholdMs: number = 5000): boolean {
  return Date.now() - timestamp < thresholdMs;
}
