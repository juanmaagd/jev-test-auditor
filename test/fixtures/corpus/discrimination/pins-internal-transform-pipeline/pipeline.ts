export class OrderPipeline {
  normalize(sku: string): string { return sku.trim().toLowerCase(); }
  process(sku: string): string { return `processed:${this.normalize(sku)}`; }
}
