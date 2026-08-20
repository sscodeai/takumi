// BUG: regressed to ascending; should be descending.
export function sortDesc(numbers) {
  return [...numbers].sort((a, b) => a - b);
}
