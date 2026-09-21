export class EventBus {
  private handlers: Array<() => void> = [];
  subscribe(fn: () => void): void {
    this.handlers.push(fn);
  }
  get listenerCount(): number {
    return this.handlers.length;
  }
  emit(): void {
    for (const h of this.handlers) h();
  }
}
