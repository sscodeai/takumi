import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, calculateTotal } from '../src/order.js';
test('0% discount keeps price', () => assert.equal(applyDiscount(100, 0), 100));
test('10% discount', () => assert.equal(applyDiscount(100, 10), 90));
test('50% discount', () => assert.equal(applyDiscount(200, 50), 100));
test('100% discount = 0', () => assert.equal(applyDiscount(100, 100), 0));
test('calculateTotal sums discounted', () => assert.equal(calculateTotal([{ price: 100, discount: 10 }, { price: 50, discount: 0 }]), 140));
test('calculateTotal with 100% off item', () => assert.equal(calculateTotal([{ price: 100, discount: 100 }, { price: 50, discount: 50 }]), 25));
