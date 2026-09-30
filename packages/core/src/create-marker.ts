/**
 * The create marker: the string that makes filing a work item idempotent.
 *
 * No board here offers a native idempotency guarantee, so a retried tick would file a
 * second issue for the same failure. The fix is the same trick the state record uses:
 * write a machine-readable marker into the item's body and look for it BEFORE creating.
 * A reader that finds the marker adopts the existing item instead of creating another.
 *
 * Shape: `<!-- takumi:created=<key> -->` — an HTML comment, invisible in every rendered
 * surface but exact in the raw body, which is what the reader parses.
 */

import { ProviderError } from './provider-error.js';

/**
 * The key grammar. Deliberately narrow: the key travels through a JSON body, an API
 * filter and a human's eyes, so "anything goes" is how unsearchable keys happen.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const MARKER_PATTERN = /<!--\s*takumi:created=([A-Za-z0-9][A-Za-z0-9._:-]{0,119})\s*-->/g;

/**
 * Render the marker for an idempotency key.
 *
 * A malformed key FAILS here rather than producing a marker nothing can find: an item
 * that cannot be found again is a duplicate generator, which is the whole thing this
 * exists to prevent.
 */
export function renderCreateMarker(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new ProviderError(
      'precondition',
      `invalid idempotency key: ${JSON.stringify(key)} (1-120 chars of [A-Za-z0-9._:-], starting with a letter or digit)`,
    );
  }
  return `<!-- takumi:created=${key} -->`;
}

/** Every create marker in a text, in order. */
export function parseCreateMarkers(text: string): string[] {
  return [...text.matchAll(MARKER_PATTERN)].map((match) => match[1] ?? '').filter((key) => key.length > 0);
}

/** Whether a text was created with this key. */
export function hasCreateMarker(text: string, key: string): boolean {
  return parseCreateMarkers(text).includes(key);
}

/**
 * The key a board's view of an item carries, or null.
 *
 * The first marker wins: an item has one creation, and taking the newest would let a
 * quoted body from another tick impersonate a creation.
 */
export function createKeyOf(text: string | undefined): string | null {
  if (text === undefined) return null;
  return parseCreateMarkers(text)[0] ?? null;
}
