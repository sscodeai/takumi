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
  return record;
}

/**
 * The newest record in a set of candidate texts, or `null` when none carries a
 * block. Untrusted text must already be filtered out by the caller (see
 * `BoardCapabilities.trustedAuthorFilter`): this function cannot tell who wrote
 * what, it only parses.
 */
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
