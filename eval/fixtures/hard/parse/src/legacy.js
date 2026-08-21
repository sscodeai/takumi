// BUG: treats numeric string '0' as invalid (explicit check).
export function parseInput(raw) {
  if (raw === '' || raw === null || raw === undefined) return 'invalid';
  const n = Number(raw);
  if (n === 0) return 'invalid'; // BUG: '0' should be valid
  return Number.isNaN(n) ? 'invalid' : n;
}
