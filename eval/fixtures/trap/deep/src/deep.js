// BUG: reference comparison only.
export function deepEquals(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a === b; // BUG: reference comparison
  }
  return a === b;
}
