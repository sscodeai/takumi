// Pricing — applyBulkDiscount exists but tier logic may be wrong.
export function applyBulkDiscount(unitPrice, quantity) {
  if (quantity >= 10) return unitPrice * 0.8;
  if (quantity >= 5) return unitPrice * 0.9;
  return unitPrice;
}
