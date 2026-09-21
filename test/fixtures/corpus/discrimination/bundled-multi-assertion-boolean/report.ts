export interface ReportSummary {
  readonly id: string;
  readonly total: number;
  readonly active: boolean;
}

export function buildSummary(id: string, amount: number): ReportSummary {
  return { id, total: amount * 1.1, active: amount > 0 };
}
