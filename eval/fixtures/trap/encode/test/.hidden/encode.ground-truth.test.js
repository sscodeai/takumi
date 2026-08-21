import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../src/encoder.js';
test('empty string -> empty', () => assert.equal(encode(''), ''));
test('ab -> hex codes', () => assert.equal(encode('ab'), '61-62'));
test('A -> 41', () => assert.equal(encode('A'), '41'));
test('xyz -> 78-79-7a', () => assert.equal(encode('xyz'), '78-79-7a'));
