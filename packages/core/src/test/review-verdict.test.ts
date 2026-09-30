import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewVerdict } from '../index.js';

// The review verdict is read from a STRUCTURED marker and never from prose.
// These tests pin the two halves of that contract: the marker is recognised
// through the decoration a markdown-minded reviewer adds around the value, and
// every way of NOT stating a verdict fails closed.

test('review verdict: a plain marker is read', () => {
  assert.deepEqual(parseReviewVerdict('review complete\nREVIEW_VERDICT: pass'), { verdict: 'pass' });
  assert.deepEqual(parseReviewVerdict('REVIEW_VERDICT: findings'), { verdict: 'findings' });
  assert.deepEqual(parseReviewVerdict('REVIEW_VERDICT: blocked'), { verdict: 'blocked' });
});

test('review verdict: the key and the separator are forgiving', () => {
  assert.deepEqual(parseReviewVerdict('review_verdict = PASS'), { verdict: 'pass' });
  assert.deepEqual(parseReviewVerdict('  REVIEW_VERDICT =   findings  '), { verdict: 'findings' });
});

test('review verdict: decoration around the value is stripped, the value is not', () => {
  for (const line of [
    'REVIEW_VERDICT: pass.',
    'REVIEW_VERDICT: pass。',
    'REVIEW_VERDICT: **pass**',
    'REVIEW_VERDICT: `pass`',
    'REVIEW_VERDICT: "pass"',
    'REVIEW_VERDICT: pass!',
  ]) {
    assert.deepEqual(parseReviewVerdict(line), { verdict: 'pass' }, `expected pass from: ${line}`);
  }
  // Decoration is not a wildcard: a value that is not a verdict still fails closed.
  const unknown = parseReviewVerdict('REVIEW_VERDICT: **ok**');
  assert.equal(unknown.verdict, undefined);
  assert.match(unknown.error ?? '', /unrecognised REVIEW_VERDICT value/);
});

test('review verdict: a missing marker fails closed, whatever the prose says', () => {
  for (const text of [
    'レビュー結果: 問題なし、合格',
    'No Critical or High issues found.',
    'the marker is REVIEW_VERDICT: pass', // inside a sentence, not on its own line
    '',
  ]) {
    const parsed = parseReviewVerdict(text);
    assert.equal(parsed.verdict, undefined, `no verdict may be inferred from: ${text}`);
    assert.match(parsed.error ?? '', /marker .*missing/);
  }
});

test('review verdict: an unknown value fails closed', () => {
  const parsed = parseReviewVerdict('REVIEW_VERDICT: maybe');
  assert.equal(parsed.verdict, undefined);
  assert.match(parsed.error ?? '', /unrecognised REVIEW_VERDICT value "maybe"/);
});

test('review verdict: two conflicting markers fail closed; a repeated one does not', () => {
  const conflicting = parseReviewVerdict('REVIEW_VERDICT: pass\nREVIEW_VERDICT: findings');
  assert.equal(conflicting.verdict, undefined);
  assert.match(conflicting.error ?? '', /ambiguous REVIEW_VERDICT/);

  assert.deepEqual(parseReviewVerdict('REVIEW_VERDICT: pass\nREVIEW_VERDICT: pass'), { verdict: 'pass' });
});

test('review verdict: a finding written in prose does not pass, and prose cannot block', () => {
  // The old word list matched neither direction; the marker decides.
  assert.deepEqual(parseReviewVerdict('重大な欠陥: SQL injection\nREVIEW_VERDICT: findings'), { verdict: 'findings' });
  assert.deepEqual(parseReviewVerdict('レビュー所見: 脆弱性あり\nREVIEW_VERDICT: pass'), { verdict: 'pass' });
});
