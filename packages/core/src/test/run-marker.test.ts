import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRunMarker, parseRunMarkers, renderRunMarker } from '../index.js';

// The run marker is the string that ties a board comment, a branch and a pull
// request to one run, so its exact grammar is pinned here rather than inferred
// from whichever adapter happens to write it.

test('renderRunMarker: the exact documented shape, hidden in every markdown surface', () => {
  const marker = renderRunMarker('c0ffee01');
  assert.equal(marker, '<!-- takumi:run=c0ffee01 -->');
  assert.ok(marker.startsWith('<!--') && marker.endsWith('-->'));
});

test('renderRunMarker: refuses an id that is not 8 lowercase hex characters', () => {
  for (const bad of ['', 'C0FFEE01', 'c0ffee0', 'c0ffee011', 'zzzzzzzz', 'abcdefg ']) {
    assert.throws(() => renderRunMarker(bad), /invalid run id/, `must reject ${JSON.stringify(bad)}`);
  }
});

test('parseRunMarkers: finds every marker, in order, inside surrounding prose', () => {
  const body = [
    'Plan ready.',
    '',
    renderRunMarker('aaaaaaaa'),
    'Tests passed: 12/12',
    renderRunMarker('bbbbbbbb'),
  ].join('\n');
  assert.deepEqual(parseRunMarkers(body), ['aaaaaaaa', 'bbbbbbbb']);
  assert.deepEqual(parseRunMarkers('no marker here'), []);
});

test('hasRunMarker: matches one run, not another', () => {
  const body = `progress\n\n${renderRunMarker('aaaaaaaa')}`;
  assert.equal(hasRunMarker(body, 'aaaaaaaa'), true);
  assert.equal(hasRunMarker(body, 'bbbbbbbb'), false);
});

test('parseRunMarkers: a hand-written marker in a public comment parses too — filtering is the reader\'s job', () => {
  // Documented behaviour: this function does not know WHO wrote the text. That is
  // why the board adapters filter by author trust BEFORE parsing.
  const hostile = '<!-- takumi:run=deadbeef -->';
  assert.deepEqual(parseRunMarkers(hostile), ['deadbeef']);
});

test('round trip: render then parse yields the original id', () => {
  for (const id of ['00000000', 'abcdef12', 'ffffffff']) {
    assert.ok(hasRunMarker(renderRunMarker(id), id));
  }
});
