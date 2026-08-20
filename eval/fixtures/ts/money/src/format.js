// BUG: no thousands separators.
export function formatMoney(n) {
  return '$' + n.toFixed(2);
}
