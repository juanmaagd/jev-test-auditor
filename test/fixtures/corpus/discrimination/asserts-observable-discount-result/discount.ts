export const audit = {
  log(msg: string): void { void msg; },
};

export function calculateDiscount(price: number, rate: number): number {
  audit.log(`discount:${rate}`);
  return price * (1 - rate);
}
