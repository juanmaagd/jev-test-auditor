export const logger = {
  warn(msg: string): void { void msg; },
};

export function validateQuantity(qty: number): void {
  logger.warn(`validating:${qty}`);
  if (qty <= 0) throw new RangeError('quantity must be positive');
}
