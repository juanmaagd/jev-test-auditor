export const steps = {
  validate(id: string): boolean { return id.length > 0; },
  notify(id: string): void { void id; },
};

export interface CheckoutResult {
  readonly status: 'confirmed' | 'rejected';
}

export function processCheckout(id: string): CheckoutResult {
  steps.validate(id);
  steps.notify(id);
  return { status: 'confirmed' };
}
