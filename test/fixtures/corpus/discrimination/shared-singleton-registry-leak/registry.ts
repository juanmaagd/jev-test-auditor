const registered: string[] = [];
export function registerService(name: string): number { registered.push(name); return registered.length; }
