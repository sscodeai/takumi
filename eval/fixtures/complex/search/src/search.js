// BUG: prefix-only, case-sensitive, no price filter.
export function search(products, { query = '', minPrice, maxPrice } = {}) {
  let out = products;
  if (query) {
    out = out.filter((p) => p.name.startsWith(query)); // BUG: prefix + case-sensitive
  }
  if (minPrice !== undefined) out = out.filter((p) => p.price >= minPrice);
  if (maxPrice !== undefined) out = out.filter((p) => p.price <= maxPrice);
  return out; // BUG: not sorted by price
}
