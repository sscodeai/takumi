import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { interactiveApprove } from '../commands.js';

/**
 * Build a fake stdin: an object-mode-ish Readable that buffers lines and
 * flags isTTY=true so interactiveApprove takes the interactive path.
 */
function fakeTtyInput(lines: string[], endAfter = true): NodeJS.ReadableStream & { isTTY?: boolean } {
  const readable = new Readable({
    read() {},
  });
  (readable as { isTTY?: boolean }).isTTY = true;
  // Push lines with a small delay so readline settles each one.
  let i = 0;
  const timer = setInterval(() => {
    if (i < lines.length) {
      readable.push(lines[i++] + '\n');
    } else {
      clearInterval(timer);
      if (endAfter) readable.push(null);
    }
  }, 5);
  return readable;
}

test('interactiveApprove: "a" approves', async () => {
  const input = fakeTtyInput(['a']);
  const ok = await interactiveApprove('gate', 'approve me?', input);
  assert.equal(ok, true);
});

test('interactiveApprove: "r" rejects', async () => {
  const input = fakeTtyInput(['r']);
  const ok = await interactiveApprove('gate', 'approve me?', input);
  assert.equal(ok, false);
});

test('interactiveApprove: "v" view then "a" approves', async () => {
  const input = fakeTtyInput(['v', 'a']);
  const ok = await interactiveApprove('gate', 'view then approve', input);
  assert.equal(ok, true);
});

test('interactiveApprove: non-TTY stdin auto-approves', async () => {
  // Default (process.stdin in CI/test is not a TTY) → auto-approve.
  const ok = await interactiveApprove('gate', 'auto', process.stdin);
  assert.equal(ok, true);
});