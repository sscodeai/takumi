import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRunMarker, parseRunMarkers, ProviderError, renderRunMarker } from '../index.js';

// The run marker is the string that ties a board comment, a branch and a pull
// request to one run, so its exact grammar is pinned here rather than inferred
// from whichever adapter happens to write it.

test('renderRunMarker: the exact documented shape, hidden in every markdown surface', () => {
  const marker = renderRunMarker('c0ffee01');
  assert.equal(marker, '<!-- takumi:run=c0ffee01 -->');
  assert.ok(marker.startsWith('<!--') && marker.endsWith('-->'));
});

test('renderRunMarker: an engine run id is a run id too (it used to be refused)', () => {
  // The workflow engine mints `wf-<hex>`; the marker used to demand exactly eight lowercase hex characters,
  // so a live run failed at publish with `invalid run id: "wf-f6a900ef"` (docs/bugs-fixed.md #44). The id
  // shape is now the constraint the marker actually needs, and it round-trips.
  const marker = renderRunMarker('wf-f6a900ef');
  assert.equal(marker, '<!-- takumi:run=wf-f6a900ef -->');
  assert.deepEqual(parseRunMarkers(`body\n${marker}\nmore`), ['wf-f6a900ef']);
  assert.ok(hasRunMarker(marker, 'wf-f6a900ef'));
  // A dot, an underscore and a dash are all fine; the pilot's shape stays valid.
  assert.equal(renderRunMarker('c0ffee01'), '<!-- takumi:run=c0ffee01 -->');
  assert.equal(renderRunMarker('run_1.2'), '<!-- takumi:run=run_1.2 -->');
});

test('renderRunMarker: refuses an id that would break the marker or the comment', () => {
  for (const bad of ['', 'has space', 'new\nline', 'closes-->it', 'a'.repeat(65), 'tab\there']) {
    // Classified on purpose: a marker rendered from a non-canonical id would be
    // invisible to every reader, so this fails in the shared error taxonomy
    // instead of producing an unattributable comment.
    let thrown: unknown;
    try {
      renderRunMarker(bad);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof ProviderError, `must reject ${JSON.stringify(bad)} with a ProviderError`);
    assert.equal((thrown as ProviderError).kind, 'precondition');
    assert.match((thrown as Error).message, /invalid run id/);
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
