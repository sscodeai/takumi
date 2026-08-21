// BUGGY: off-by-one on month boundaries (adds 1 day).
export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
}
