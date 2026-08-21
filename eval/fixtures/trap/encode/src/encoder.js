// BUG: returns wrong format.
export function encode(input) {
  return input.split('').map((c) => c.charCodeAt(0).toString()).join('-');
}
