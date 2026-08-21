import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/search.js';

const PRODUCTS = [
  { name: 'Apple', price: 300 },
  { name: 'apple pie', price: 150 },
  { name: 'Banana', price: 100 },
  { name: 'APPLE juice', price: 200 },
];

test('substring match', () => {
  const res = search(PRODUCTS, { query: 'ppl' });
  assert.equal(res.length, 3); // Apple, apple pie, APPLE juice
});
test('case-insensitive', () => {
  const res = search(PRODUCTS, { query: 'apple' });
  assert.equal(res.length, 3);
});
test('price range filter', () => {
  const res = search(PRODUCTS, { query: 'apple', minPrice: 150, maxPrice: 200 });
  assert.equal(res.length, 2);
});
test('results sorted by price ascending', () => {
  const res = search(PRODUCTS, { query: 'apple' });
  const prices = res.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});
test('empty query returns all sorted by price', () => {
  const res = search(PRODUCTS);
  assert.equal(res.length, 4);
  const prices = res.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});
