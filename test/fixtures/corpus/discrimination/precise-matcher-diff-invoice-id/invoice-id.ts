export function formatInvoiceId(prefix: string, seq: number): string {
  return `${prefix}-INV-${seq.toString().padStart(4, '0')}`;
}
