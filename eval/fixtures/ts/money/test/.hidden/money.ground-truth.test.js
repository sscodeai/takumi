import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';
test('ground truth: 1234.5 -> $1,234.50', () => assert.equal(formatMoney(1234.5), '$1,234.50'));
test('ground truth: 999 -> $999.00', () => assert.equal(formatMoney(999), '$999.00'));
test('ground truth: 1234567 -> $1,234,567.00', () => assert.equal(formatMoney(1234567), '$1,234,567.00'));
test('ground truth: 0 -> $0.00', () => assert.equal(formatMoney(0), '$0.00'));
