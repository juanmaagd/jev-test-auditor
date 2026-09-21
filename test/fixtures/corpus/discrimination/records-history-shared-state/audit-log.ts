const entries: string[] = [];
export function record(entry: string): void { entries.push(entry); }
export function history(): readonly string[] { return entries; }
