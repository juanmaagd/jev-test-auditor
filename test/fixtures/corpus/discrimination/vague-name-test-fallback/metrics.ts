export interface ScoreResult {
  readonly valid: boolean;
  readonly score: number;
}

export function computeScore(points: number): ScoreResult {
  return { valid: points > 0, score: points * 2 };
}
