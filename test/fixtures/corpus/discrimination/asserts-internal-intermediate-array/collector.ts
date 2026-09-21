export class ItemCollector {
  readonly buffer: string[] = [];
  collect(item: string): void {
    this.buffer.push(item);
  }
  flush(): string {
    const joined = this.buffer.join(',');
    this.buffer.length = 0;
    return joined;
  }
}
