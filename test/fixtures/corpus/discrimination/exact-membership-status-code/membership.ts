export function getMembershipTier(points: number): number {
  if (points >= 1000) return 3;
  return 1;
}
