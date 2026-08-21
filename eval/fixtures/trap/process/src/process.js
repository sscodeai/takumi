// BUG: sorts in place (mutates input).
export function processItems(items) {
  return items.sort((a, b) => a - b);
}
