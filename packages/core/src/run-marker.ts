/**
 * The run marker: the one string that ties a board comment, a delivered branch
 * and a pull request back to a single run.
 *
 * It lives in core because three independent places need the SAME spelling: the
 * board adapters write it into progress comments, the delivery adapters write it
 * into a pull request body, and a resuming process greps for it. A per-adapter
 * copy is how those three drift apart and a delivery ends up unexplained.
 *
 * Shape: `<!-- takumi:run=<id> -->` — an HTML comment, so it is invisible in every
 * rendered markdown surface (GitHub, GitLab, Jira-as-text) but exact in the raw
 * body, which is what the reader parses. The id is whatever the caller minted
 * (`<8 hex>` for the pilot, `wf-<8 hex>` for the workflow engine); see RUN_ID_PATTERN
 * for the only constraint that matters, which is that it cannot break the comment.
 */

import { ProviderError } from './provider-error.js';

/**
 * What a run id may look like.
 *
 * It used to be exactly eight lowercase hex characters, which is the shape the pilot's id generator happens
 * to produce. The workflow engine mints its own (`wf-<hex>`), and a live run failed at publish with
 * `invalid run id: "wf-f6a900ef"` — an arbitrary constraint from one caller refusing another caller's
 * legitimate id (docs/bugs-fixed.md #44). The pattern is therefore the constraint the marker ACTUALLY needs:
 * one to sixty-four characters that cannot break the HTML comment (no whitespace, no `-->`) and that survive
 * a round trip through markdown. Writer and reader share it, so there is still exactly one spelling.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const MARKER_PATTERN = /<!--\s*takumi:run=([A-Za-z0-9._-]{1,64})\s*-->/g;

/**
 * Render the marker for a run id.
 *
 * A malformed id FAILS here rather than producing a marker: the reader matches the
 * same pattern, so a marker written from an id the reader cannot see would be
 * invisible to every reader — an unattributable comment is worse than a loud failure. The failure is classified (`precondition`), so a caller can
 * branch on it like any other provider failure instead of catching a bare Error.
 */
export function renderRunMarker(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ProviderError(
      'precondition',
      `invalid run id: ${JSON.stringify(runId)} (expected 8 lowercase hex characters)`,
    );
  }
  return `<!-- takumi:run=${runId} -->`;
}

/** Every run marker in a text, in order. Untrusted text yields its markers too — filtering is the reader's job. */
export function parseRunMarkers(text: string): string[] {
  return [...text.matchAll(MARKER_PATTERN)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** True when the text carries the marker of this exact run. */
export function hasRunMarker(text: string, runId: string): boolean {
  return parseRunMarkers(text).includes(runId);
}
