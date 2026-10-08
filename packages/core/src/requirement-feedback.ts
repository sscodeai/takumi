import { parse as parseYaml } from 'yaml';

// The feedback loop (ADR-029): a FAILED acceptance is written back into the requirement document it
// failed, and that write is what closes the loop.
//
// The mechanism is the digest. The document's digest is the token a run binds to (ADR-025) and the
// thing the acceptance checks before it runs. Adding a `feedback:` entry changes the digest, so a run
// that has already failed can never be accepted against the confirmation it was made with — the
// ratchet is structural rather than a convention someone remembers to follow. The human's act of
// closure is their next confirmation (ADR-027), which now has to answer each open entry.
//
// Like every other write into this document, the write is TEXTUAL: the document is hand-written and
// commented, and re-serialising the YAML would delete the comments. Everything here returns text; the
// caller validates it before it lands.

/**
 * How a human closed a failure (ADR-038). An explicit field, not a sentence to be re-parsed: a reader
 * must be able to tell "the implementation was at fault" from "the answer was wrong" from "the CHECK
 * was at fault", because those are three different claims, made by different parties, with different
 * consequences. `addressed` is the legacy undifferentiated closure (ADR-029) for a failure that maps to
 * no decision at all; it is recorded rather than implied so it cannot be mistaken for one of the three.
 */
export type FeedbackClosureKind = 'implementation-changes' | 'answer-wrong' | 'check-at-fault' | 'addressed';

/** The closure kinds a document may record, in the order the confirmation offers them. */
export const FEEDBACK_CLOSURE_KINDS: readonly FeedbackClosureKind[] = [
  'implementation-changes',
  'answer-wrong',
  'check-at-fault',
  'addressed',
];

function closureKindOf(value: unknown): FeedbackClosureKind | undefined {
  return typeof value === 'string' && (FEEDBACK_CLOSURE_KINDS as readonly string[]).includes(value)
    ? (value as FeedbackClosureKind)
    : undefined;
}

export interface FeedbackEntry {
  id: string;
  /** When the machine recorded it. */
  at: string;
  /** The run that failed. */
  run: string;
  /** The digest the failing run was bound to (the confirmation token it was given). */
  requirementDigest: string;
  /** The forged judge that produced the verdict, for the record. */
  judgeDigest: string;
  status: 'open' | 'resolved';
  /** The failing checks, verbatim as the judge reported them. */
  checks: string[];
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedNote?: string;
  /** The decision that answered this failure, when the resolution was "the answer was wrong" (ADR-030). */
  resolvedByDecision?: string;
  /** How the human closed this failure (ADR-038): an explicit field, not a sentence to be re-parsed. */
  resolvedKind?: FeedbackClosureKind;
}

export interface FeedbackAppendInput {
  at: string;
  run: string;
  requirementDigest: string;
  judgeDigest: string;
  checks: string[];
}

export interface FeedbackAppendResult {
  text: string;
  id: string;
  /** True when this run is already recorded: the same run at the same digest is not recorded twice. */
  duplicate: boolean;
}

const FEEDBACK_ID = /^FB-[0-9]+$/;

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Every `feedback:` entry in a requirement document, in document order. */
export function parseFeedback(text: string): FeedbackEntry[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const list = (parsed as { feedback?: unknown }).feedback;
  if (!Array.isArray(list)) return [];
  const entries: FeedbackEntry[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const id = stringOf(entry['id']);
    if (id === undefined || !FEEDBACK_ID.test(id)) continue;
    entries.push({
      id,
      at: stringOf(entry['at']) ?? '',
      run: stringOf(entry['run']) ?? '',
      requirementDigest: stringOf(entry['requirementDigest']) ?? '',
      judgeDigest: stringOf(entry['judgeDigest']) ?? '',
      status: entry['status'] === 'resolved' ? 'resolved' : 'open',
      checks: Array.isArray(entry['checks']) ? entry['checks'].filter((c): c is string => typeof c === 'string') : [],
      ...(stringOf(entry['resolvedAt']) === undefined ? {} : { resolvedAt: stringOf(entry['resolvedAt']) }),
      ...(stringOf(entry['resolvedBy']) === undefined ? {} : { resolvedBy: stringOf(entry['resolvedBy']) }),
      ...(stringOf(entry['resolvedNote']) === undefined ? {} : { resolvedNote: stringOf(entry['resolvedNote']) }),
      ...(stringOf(entry['resolvedByDecision']) === undefined ? {} : { resolvedByDecision: stringOf(entry['resolvedByDecision']) }),
      ...(closureKindOf(entry['resolvedKind']) === undefined ? {} : { resolvedKind: closureKindOf(entry['resolvedKind']) }),
    });
  }
  return entries;
}

/** The entries a human has not dealt with yet. */
export function openFeedback(text: string): FeedbackEntry[] {
  return parseFeedback(text).filter((e) => e.status === 'open');
}

/** The text of one feedback entry, as it is written into the document. */
export function renderFeedbackEntry(entry: FeedbackEntry): string {
  // Verbatim, escaped rather than rewritten: a check that is quoted differently from what the judge
  // said is a check a reader cannot search for.
  const quoted = (value: string): string =>
    `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+$/, '')}"`;
  return [
    `  - id: ${entry.id}`,
    `    at: ${quoted(entry.at)}`,
    `    run: ${quoted(entry.run)}`,
    `    requirementDigest: ${quoted(entry.requirementDigest)}`,
    `    judgeDigest: ${quoted(entry.judgeDigest)}`,
    `    status: ${entry.status}`,
    ...(entry.status === 'resolved'
      ? [
          `    resolvedAt: ${quoted(entry.resolvedAt ?? '')}`,
          `    resolvedBy: ${quoted(entry.resolvedBy ?? '')}`,
          `    resolvedNote: ${quoted(entry.resolvedNote ?? '')}`,
          ...(entry.resolvedKind === undefined ? [] : [`    resolvedKind: ${quoted(entry.resolvedKind)}`]),
          ...(entry.resolvedByDecision === undefined ? [] : [`    resolvedByDecision: ${quoted(entry.resolvedByDecision)}`]),
        ]
      : []),
    '    checks:',
    ...(entry.checks.length === 0 ? ['      []'] : entry.checks.map((check) => `      - ${quoted(check)}`)),
  ].join('\n');
}

function nextFeedbackId(entries: FeedbackEntry[]): string {
  let max = 0;
  for (const entry of entries) {
    const n = Number.parseInt(entry.id.slice('FB-'.length), 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `FB-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Append a failure to the document's `feedback:` block (creating it if the document has none).
 *
 * Idempotent per (run, requirement digest): the engine can call this once per run, and a retry of the
 * same run at the same confirmed digest does not add a second entry. The caller validates the result
 * before writing it — an append that would corrupt the document must never land.
 */
export function appendFeedback(text: string, input: FeedbackAppendInput): FeedbackAppendResult {
  const entries = parseFeedback(text);
  const duplicate = entries.find(
    (e) => e.status === 'open' && e.run === input.run && e.requirementDigest === input.requirementDigest,
  );
  if (duplicate !== undefined) return { text, id: duplicate.id, duplicate: true };

  const id = nextFeedbackId(entries);
  const block = renderFeedbackEntry({ ...input, id, status: 'open' });
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^feedback:\s*$/.test(line));
  if (start === -1) {
    return { text: `${text.replace(/\s*$/, '')}\n\nfeedback:\n${block}\n`, id, duplicate: false };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return { text: [...lines.slice(0, end), ...block.split('\n'), ...lines.slice(end)].join('\n'), id, duplicate: false };
}

export interface FeedbackResolveResult {
  text: string;
  entry?: FeedbackEntry;
  error?: string;
}

export interface FeedbackResolveOptions {
  /** The decision that answered the failure, when the closure was "the answer was wrong" (ADR-030). */
  byDecision?: string;
  /** How the failure was closed (ADR-038). Omitted on the legacy scriptable path, which records no kind. */
  kind?: FeedbackClosureKind;
}

/**
 * Mark an entry resolved. The note is required: a resolution without a sentence about what addresses
 * the failure is an unrecorded resolution, which is the thing this loop exists to prevent.
 *
 * The closure kind (ADR-038) is recorded as an explicit field so a later reader can tell which claim the
 * human made — and the note is where that claim's BASIS is stated, which is why it is still refused when
 * empty whatever the kind.
 */
export function resolveFeedback(
  text: string,
  id: string,
  by: string,
  note: string,
  at: string,
  options: FeedbackResolveOptions = {},
): FeedbackResolveResult {
  const entries = parseFeedback(text);
  const entry = entries.find((e) => e.id === id);
  if (entry === undefined) return { text, error: `this document records no feedback entry ${id}` };
  if (entry.status === 'resolved') {
    return { text, error: `${id} is already resolved (${entry.resolvedBy ?? 'someone'} at ${entry.resolvedAt ?? 'an unrecorded time'})` };
  }
  if (note.trim().length === 0) {
    return { text, error: `resolving ${id} needs a note about what addresses it: an empty resolution records nothing` };
  }

  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(line));
  if (start === -1) return { text, error: `this document records no feedback entry ${id}` };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*-\s*id:/.test(line) || (/^\S/.test(line) && line.trim() !== '')) {
      end = i;
      break;
    }
  }
  const quoted = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*status:/.test(line)) {
      const indent = /^\s*/.exec(line)?.[0] ?? '    ';
      lines[i] = `${indent}status: resolved`;
      lines.splice(
        i + 1,
        0,
        `${indent}resolvedAt: ${quoted(at)}`,
        `${indent}resolvedBy: ${quoted(by)}`,
        `${indent}resolvedNote: ${quoted(note)}`,
        ...(options.kind === undefined ? [] : [`${indent}resolvedKind: ${quoted(options.kind)}`]),
        ...(options.byDecision === undefined ? [] : [`${indent}resolvedByDecision: ${quoted(options.byDecision)}`]),
      );
      return {
        text: lines.join('\n'),
        entry: {
          ...entry,
          status: 'resolved',
          resolvedAt: at,
          resolvedBy: by,
          resolvedNote: note,
          ...(options.kind === undefined ? {} : { resolvedKind: options.kind }),
          ...(options.byDecision === undefined ? {} : { resolvedByDecision: options.byDecision }),
        },
      };
    }
  }
  return { text, error: `${id} has no status line to resolve` };
}
