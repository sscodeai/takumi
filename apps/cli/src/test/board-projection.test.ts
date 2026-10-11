import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertKnownBoardOptions,
  createBoardFromSection,
  createBoardProvider,
} from '../board-projection-command.js';

/**
 * The `board:` section of `takumi.yaml` (ADR-044) — the DELIVERY board a run projects its row onto.
 *
 * These tests drive the REAL CLI builder, not a paraphrase of it. What they pin is the same shape
 * `delivery-command.ts` is pinned to: a section names a provider, every option it passes must be one
 * the adapter actually READS (a key the factory drops and a typo in a key are the same silent defect),
 * a credential is never accepted from configuration, and a section that cannot build anything is
 * refused up front rather than after the run has spent its work.
 *
 * It is NOT the task board: `board:` here names the write-only delivery row (a run with no board
 * projects nowhere, which is not an error). The task board is the `pilot:` section's business.
 */

test('the board: section needs a provider, and an unknown provider is refused by name', async () => {
  await assert.rejects(
    () => createBoardFromSection({ provider: '   ' }),
    /needs a `provider`/,
    'a section with no provider cannot name a board',
  );
  await assert.rejects(
    () => createBoardProvider({ providerId: 'trello', providerOptions: {} }),
    /unknown board provider: trello \(notion\)/,
    'an unknown provider is refused, and the message lists the ones that exist',
  );
});

test('a board option nobody would read is refused, and the message names the ones the adapter reads', () => {
  assert.throws(
    () => assertKnownBoardOptions({ providerId: 'notion', providerOptions: { labellProperty: 'Labels' } }),
    /unknown option "labellProperty" — this adapter reads databaseId, apiBase, titleProperty, stateProperty, columnProperty, labelsProperty/,
    'a near-miss key is refused and the real keys are named, so the typo is visible',
  );
});

test('a credential and a code-only option are refused from configuration, with the reason', () => {
  assert.throws(
    () => assertKnownBoardOptions({ providerId: 'notion', providerOptions: { token: 'ntn_x' } }),
    /comes from the ENVIRONMENT, never from configuration/,
    'a secret in a config file is one commit away from being a secret in a repository',
  );
  assert.throws(
    () => assertKnownBoardOptions({ providerId: 'notion', providerOptions: { request: 'x' } }),
    /set in code \(an injected transport\), not from configuration/,
    'an injected transport only means something in code',
  );
});

test('a notion board: section needs databaseId — the section is refused before a run starts', async () => {
  await assert.rejects(
    () => createBoardFromSection({ provider: 'notion', options: {} }),
    /needs databaseId/,
  );
});

test('the board: section builds the notion delivery board from its documented options', async () => {
  const board = await createBoardFromSection({
    provider: 'notion',
    options: { databaseId: '3dec1a02-53fb-8129-965c-d7cbe18d38b6', labelsProperty: 'Labels' },
  });
  assert.equal(board.metadata().id, 'notion', 'the section selects the notion delivery board');
  assert.equal(typeof board.project, 'function', 'the port is write-only: project() and nothing else is required');
});
