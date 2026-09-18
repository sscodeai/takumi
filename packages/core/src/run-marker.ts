/**
 * The run marker: the one string that ties a board comment, a delivered branch
 * and a pull request back to a single run.
 *
 * It lives in core because three independent places need the SAME spelling: the
 * board adapters write it into progress comments, the delivery adapters write it
 * into a pull request body, and a resuming process greps for it. A per-adapter
 * copy is how those three drift apart and a delivery ends up unexplained.
 *
 * Shape: `<!-- takumi:run=<8 hex> -->` — an HTML comment, so it is invisible in
 * every rendered markdown surface (GitHub, GitLab, Jira-as-text) but exact in the
 * raw body, which is what the reader parses.
 */

const RUN_ID_PATTERN = /^[0-9a-f]{8}$/;

const MARKER_PATTERN = /<!--\s*takumi:run=([0-9a-f]{8})\s*-->/g;

/** Render the marker for a run id. Fails fast on a malformed id. */
export function renderRunMarker(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid run id: ${JSON.stringify(runId)} (expected 8 lowercase hex characters)`);
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
