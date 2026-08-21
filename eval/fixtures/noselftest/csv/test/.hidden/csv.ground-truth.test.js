import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';
test('simple', () => assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]));
test('quoted comma', () => assert.deepEqual(parseCsv('"x,y",z'), [['x,y', 'z']]));
test('escaped quote', () => assert.deepEqual(parseCsv('"a""b",c'), [['a"b', 'c']]));
test('trailing newline', () => assert.deepEqual(parseCsv('a,b\n'), [['a', 'b']]));
test('CRLF', () => assert.deepEqual(parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]));
