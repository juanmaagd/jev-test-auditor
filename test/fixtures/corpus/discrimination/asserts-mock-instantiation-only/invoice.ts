export class InvoiceService {
  generate(id: string): string {
    return `INV-${id}`;
  }
}
