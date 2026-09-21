export const formatter = {
  format(entry: string): string { return `[AUDIT] ${entry}`; },
};
const entries: string[] = [];
export function record(entry: string): void { entries.push(formatter.format(entry)); }
export function history(): readonly string[] { return entries; }
