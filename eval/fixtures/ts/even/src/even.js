// BUG: sums ALL numbers, should sum only EVEN numbers.
export function sumEven(numbers) {
  return numbers.reduce((acc, n) => acc + n, 0);
}
