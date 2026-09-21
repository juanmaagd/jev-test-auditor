export function getOrderStatus(shipped: boolean, delivered: boolean): string {
  if (delivered) return 'STATUS_DELIVERED';
  if (shipped) return 'STATUS_SHIPPED';
  return 'STATUS_PENDING';
}
