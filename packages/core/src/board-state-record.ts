/**
 * The versioned, machine-readable run state record shared by every board
 * adapter.
 *
 * Why this exists: a delivery must be resumable from the board alone, but the
 * board is also a place where humans (and, on a public repository, strangers)
 * write text. So the resumable facts are stored as a SINGLE hidden, versioned
 * block that only takumi writes and only takumi reads — the human-readable text
 * next to it is display only. A wording change can therefore never change
 * control flow, and a comment from an untrusted author can never steer a run.
 *
 * Adapters choose where the block physically lives (a hidden HTML comment on
 * GitHub/GitLab, an issue property on Jira, a rich-text property on Notion);
 * this module owns the grammar and the version field, so all of them stay
 * interchangeable.
 */

export const BOARD_STATE_MARKER_VERSION = 1;

/**
 * The resumable facts of one delivery, as stored on the board.
 *
 * Deliberately tiny: it carries only what a resumed run must know, and it is
 * versioned (`schema`) so a future shape can be added without breaking the
 * records already sitting on someone's board.
 */
export interface BoardStateRecord {
  schema: 1;
  runId: string;
  item: string;
  baseBranch?: string;
  deliveryRef?: string;
  /**
   * The branch this run delivered on.
   *
   * Recorded so a LATER tick can resume an unfinished delivery — same branch, same pull
   * request — instead of starting over: without it, the only recovery was a human resetting the
   * item, which re-runs the agent and pushes a second branch for work that was already
   * reviewed. Optional because records written before this field exist, and a record without it
   * simply cannot be resumed (never guessed).
   */
  branch?: string;
  /**
   * The inputs the clean review on record actually covered (ADR-018). Absent means "unknown
   * provenance": a delivery that exists but cannot show what was reviewed may NOT merge.
   */
  reviewed?: {
    digest: string;
    head: string;
    base: string;
    policy: string;
    ruleset: string;
    reviewer: string;
    /** ISO-8601, for humans reading the board. Not part of the digest. */
    at: string;
  };
  /**
   * A human's approval, bound to the digest it approved. `by` is null when the board gave no
   * identity: a label says somebody approved, not who — and an unknown actor is not written as a
   * known one.
   */
  approval?: {
    by: string | null;
    at: string;
    digest: string;
    ref: string;
    note?: string;
  };
  reviewRound: number;
  updatedAt: string;
  note?: string;
}


/** Marker prefix, kept stable: `<!-- takumi:boardstate:v1 {...} -->`. */
export const BOARD_STATE_MARKER_PREFIX = 'takumi:boardstate:';

/**
 * Non-greedy to the first `-->`, so a truncated or mangled payload still
 * matches the marker and fails as CORRUPTED instead of silently falling back to
 * whatever text happens to be beside it.
 */
const BOARD_STATE_BLOCK_RE = /<!--\s*takumi:boardstate:v1\s+(.*?)-->/s;

/** Raised when a state block is present but cannot be trusted as a record. */
export class BoardStateRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardStateRecordError';
  }
}

/** Render the hidden block for a record. Round-trips through {@link parseBoardStateRecord}. */
export function renderBoardStateRecord(record: BoardStateRecord): string {
  if (record.schema !== BOARD_STATE_MARKER_VERSION) {
    throw new BoardStateRecordError(
      `cannot render schema ${record.schema}: this takumi only speaks schema ${BOARD_STATE_MARKER_VERSION}`,
    );
  }
  return `<!-- ${BOARD_STATE_MARKER_PREFIX}v1 ${JSON.stringify(record)} -->`;
}

/**
 * Parse the first state block in `text`, or return `null` when the text carries
 * none. A block that is present but malformed/incomplete throws
 * {@link BoardStateRecordError} — never a silent `null`, which would make a
 * corrupted run look like a brand-new one.
 */
export function parseBoardStateRecord(text: string): BoardStateRecord | null {
  const match = BOARD_STATE_BLOCK_RE.exec(text);
  if (!match) return null;
  const payload = match[1]?.trim() ?? '';
  if (payload.length === 0) {
    throw new BoardStateRecordError('state block marker present but empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (e) {
    throw new BoardStateRecordError(
      `state block payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BoardStateRecordError('state block payload is not a JSON object');
  }
  return validateBoardStateRecord(parsed as Record<string, unknown>);
}

/** Structural validation of a decoded record — fail fast on any missing/invalid field. */
export function validateBoardStateRecord(value: Record<string, unknown>): BoardStateRecord {
  const { schema, runId, item, reviewRound } = value;
  if (schema !== BOARD_STATE_MARKER_VERSION) {
    throw new BoardStateRecordError(
      `unsupported schema ${String(schema)}: expected ${BOARD_STATE_MARKER_VERSION}`,
    );
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new BoardStateRecordError('state record is missing runId');
  }
  if (typeof item !== 'string' || item.length === 0) {
    throw new BoardStateRecordError('state record is missing item');
  }
  if (typeof reviewRound !== 'number' || !Number.isInteger(reviewRound) || reviewRound < 0) {
    throw new BoardStateRecordError(`state record has an invalid reviewRound: ${String(reviewRound)}`);
  }
  const record: BoardStateRecord = {
    schema: BOARD_STATE_MARKER_VERSION,
    runId,
    item,
    reviewRound,
    updatedAt: typeof value['updatedAt'] === 'string' ? (value['updatedAt'] as string) : new Date(0).toISOString(),
  };
  if (typeof value['baseBranch'] === 'string') record.baseBranch = value['baseBranch'];
  if (typeof value['deliveryRef'] === 'string') record.deliveryRef = value['deliveryRef'];
  if (typeof value['branch'] === 'string') record.branch = value['branch'];
  if (typeof value['note'] === 'string') record.note = value['note'];
  // A `reviewed` block that cannot be read is NOT "no review on record" — it is a record we cannot
  // trust, and the difference decides whether a delivery may merge. So it throws, like any other
  // present-but-corrupt block, instead of being quietly dropped.
  if (value['reviewed'] !== undefined) record.reviewed = parseReviewed(value['reviewed']);
  if (value['approval'] !== undefined) record.approval = parseApproval(value['approval']);
  return record;
}

/**
 * The newest record in a set of candidate texts, or `null` when none carries a
 * block. Untrusted text must already be filtered out by the caller (see
 * `BoardCapabilities.trustedAuthorFilter`): this function cannot tell who wrote
 * what, it only parses.
 */
/**
 * A `reviewed` block, or a `BoardStateRecordError`: a block we cannot read is not the same as no
 * block, and the difference decides whether a delivery may merge.
 */
function parseReviewed(value: unknown): NonNullable<BoardStateRecord['reviewed']> {
  const block = asRecord(value, 'reviewed');
  const digest = block['digest'];
  const head = block['head'];
  if (typeof digest !== 'string' || typeof head !== 'string') {
    throw new BoardStateRecordError('the reviewed block is missing its digest or head');
  }
  return {
    digest,
    head,
    base: typeof block['base'] === 'string' ? block['base'] : '',
    policy: typeof block['policy'] === 'string' ? block['policy'] : '',
    ruleset: typeof block['ruleset'] === 'string' ? block['ruleset'] : '',
    reviewer: typeof block['reviewer'] === 'string' ? block['reviewer'] : '',
    at: typeof block['at'] === 'string' ? block['at'] : '',
  };
}

function parseApproval(value: unknown): NonNullable<BoardStateRecord['approval']> {
  const block = asRecord(value, 'approval');
  const digest = block['digest'];
  if (typeof digest !== 'string') throw new BoardStateRecordError('the approval block is missing its digest');
  return {
    // null is a real value here: the label said somebody approved, not who.
    by: typeof block['by'] === 'string' ? block['by'] : null,
    at: typeof block['at'] === 'string' ? block['at'] : '',
    digest,
    ref: typeof block['ref'] === 'string' ? block['ref'] : '',
    ...(typeof block['note'] === 'string' ? { note: block['note'] } : {}),
  };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoardStateRecordError(`the ${what} block is not an object`);
  }
  return value as Record<string, unknown>;
}

export function newestBoardStateRecord(texts: readonly string[]): BoardStateRecord | null {
  let newest: BoardStateRecord | null = null;
  for (const text of texts) {
    const record = parseBoardStateRecord(text);
    if (record === null) continue;
    if (newest === null || Date.parse(record.updatedAt) >= Date.parse(newest.updatedAt)) {
      newest = record;
    }
  }
  return newest;
}
