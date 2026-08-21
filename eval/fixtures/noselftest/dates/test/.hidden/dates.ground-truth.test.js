import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween } from '../src/dates.js';
test('same day = 0', () => assert.equal(daysBetween('2024-01-01', '2024-01-01'), 0));
test('next day = 1', () => assert.equal(daysBetween('2024-01-01', '2024-01-02'), 1));
test('month boundary', () => assert.equal(daysBetween('2024-01-31', '2024-02-01'), 1));
test('leap year Feb', () => assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2));
test('non-leap Feb', () => assert.equal(daysBetween('2023-02-28', '2023-03-01'), 1));
test('negative (b before a)', () => assert.equal(daysBetween('2024-01-02', '2024-01-01'), -1));
