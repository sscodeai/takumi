// BUG: applyDiscount returns the DISCOUNT AMOUNT, not discounted price.
export function applyDiscount(price, discountPercent) {
  return price * (discountPercent / 100); // wrong: this is the discount amount
}
export function calculateTotal(items) {
  return items.reduce((sum, it) => sum + applyDiscount(it.price, it.discount), 0);
}
