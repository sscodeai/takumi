// Data layer — in-memory store.
export const items = new Map(); // id -> { id, name, price, stock }

let nextId = 1;
export function nextItemId() { return nextId++; }

export function reset() { items.clear(); nextId = 1; }
