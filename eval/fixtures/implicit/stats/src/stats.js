// BUG: empty array gives Infinity/-Infinity; avg not rounded.
export function summarize(numbers) {
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    count: numbers.length,
  };
}
