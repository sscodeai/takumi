import { parse as parseYaml } from 'yaml';
import { parseFeedback } from './requirement-feedback.js';

// The requirement document's DECISIONS and the CHECKS bound to them (ADR-028/ADR-029), parsed in one
// place so the CLI, the brief and the forge cannot drift into three opinions about the same file.
//
// The forge still parses the document line-wise (it runs in shell, outside the implementer's context),
// and the two parsers agree on the shape: that agreement is what the `decides:` refusals test.

/**
 * The relation kinds a forged judge can actually check, and therefore the only ones a requirement
 * document may bind a decision to (ADR-031). The forge implements exactly these in shell; the two lists
 * are kept honest by a test that parses `extensions/judges/metamorphic-forge.sh` and compares, because a
 * document that names a relation the forge does not implement is refused at acceptance time — after the
 * implementation has been paid for.
 */
export const JUDGE_RELATION_VOCABULARY = [
  'row-order-invariance',
  'additivity',
  'duplicate-resolution',
  'malformed-row-accounting',
  'independent-aggregation',
] as const;

/**
 * The MEANING of a decision's answer, per relation kind (ADR-031). Prose is for humans; a judge needs to
 * know which behaviour to test, and inferring that from a sentence is guesswork — the first real intake
 * run wrote "Round half up to one decimal place." where the forge expected "Half-up, no currency
 * printed", which is the same thing and was refused anyway. So a decision that a mode-carrying relation
 * exercises must carry `checkedAs: <mode>`, and the mode is what the judge's expectation is built from.
 */
export const JUDGE_DECISION_MODES: Record<string, readonly string[]> = {
  'duplicate-resolution': ['first-row', 'last-row', 'latest-start-date', 'merge', 'error'],
  'malformed-row-accounting': ['skip-count', 'skip-silent', 'stop-error'],
  'independent-aggregation': ['half-up', 'truncate'],
};

/** The modes a relation kind can test, or undefined when the relation needs no meaning (it is a property). */
export function decisionModesFor(relation: string): readonly string[] | undefined {
  return JUDGE_DECISION_MODES[relation];
}

export interface DeliverableBlock {
  run?: string;
  /** The declared output shape a judge may parse, as written. */
  outputFormat?: unknown;
  bindings: DecisionBinding[];
}

export interface Decision {
  id: string;
  question: string;
  options: string[];
  default?: string;
  chosen?: string;
  blocking: boolean;
  /** The failure this decision came from, when a re-pass proposed it (ADR-030). */
  fromFeedback?: string;
  /** What the chosen answer MEANS to a judge (ADR-031), from `decisionModesFor(relation)`. */
  checkedAs?: string;
}

export interface DecisionBinding {
  /** `REL-003`, `DIFF-001`, … the id the judge reports a check under. */
  checkId: string;
  kind: 'relation' | 'anchor';
  /** `duplicate-resolution`, `independent-aggregation`, … */
  relation: string;
  /** The `AMB-nnn` this check settles; absent when the check exercises no decision. */
  decides?: string;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Every `AMB-nnn` the document records, in document order. */
export function parseRequirements(text: string): Decision[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const list = (parsed as { ambiguities?: unknown }).ambiguities;
  if (!Array.isArray(list)) return [];
  const decisions: Decision[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const id = stringOf(entry['id']);
    if (id === undefined) continue;
    decisions.push({
      id,
      question: stringOf(entry['question']) ?? '',
      options: Array.isArray(entry['options']) ? entry['options'].filter((o): o is string => typeof o === 'string') : [],
      ...(stringOf(entry['default']) === undefined ? {} : { default: stringOf(entry['default']) }),
      ...(stringOf(entry['chosen']) === undefined ? {} : { chosen: stringOf(entry['chosen']) }),
      // Blocking unless the document says otherwise: an unmarked decision is one nobody may skip.
      blocking: entry['blocking'] !== false,
      ...(stringOf(entry['fromFeedback']) === undefined ? {} : { fromFeedback: stringOf(entry['fromFeedback']) }),
      ...(stringOf(entry['checkedAs']) === undefined ? {} : { checkedAs: stringOf(entry['checkedAs']) }),
    });
  }
  return decisions;
}

/** The `decides:` bindings declared by the deliverable's relations and differential anchors. */
export function parseDecisionBindings(text: string): DecisionBinding[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const deliverable = (parsed as { deliverable?: unknown }).deliverable;
  if (deliverable === null || typeof deliverable !== 'object') return [];
  const block = deliverable as { relations?: unknown; differential?: unknown };
  const bindings: DecisionBinding[] = [];
  const collect = (list: unknown, kind: 'relation' | 'anchor'): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const checkId = stringOf(entry['id']);
      const decides = stringOf(entry['decides']);
      const relation = kind === 'relation' ? stringOf(entry['relation']) : stringOf(entry['anchor']);
      if (checkId === undefined || relation === undefined) continue;
      bindings.push({ checkId, kind, relation, ...(decides === undefined ? {} : { decides }) });
    }
  };
  collect(block.relations, 'relation');
  collect(block.differential, 'anchor');
  return bindings;
}

/**
 * The `DEC-nnn` ids the forged judge will report, derived the way the forge derives them: one per
 * decision that some check exercises, in document order, whether or not the decision is blocking.
 * A failure reported as `DEC-002` can therefore be traced back to its decision without running a judge.
 */
export function decisionCheckIds(decisions: Decision[], bindings: DecisionBinding[]): Map<string, string> {
  const exercised = new Set(bindings.map((b) => b.decides).filter((d): d is string => d !== undefined));
  const ids = new Map<string, string>();
  let n = 0;
  for (const decision of decisions) {
    if (!exercised.has(decision.id)) continue;
    n += 1;
    ids.set(decision.id, `DEC-${String(n).padStart(3, '0')}`);
  }
  return ids;
}

/** The `deliverable` block as a whole: how the thing is run, and the checks bound to decisions. */
export function parseDeliverableBlock(text: string): DeliverableBlock | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const deliverable = (parsed as { deliverable?: unknown }).deliverable;
  if (deliverable === null || typeof deliverable !== 'object') return undefined;
  const block = deliverable as Record<string, unknown>;
  const run = stringOf(block['run']);
  return {
    ...(run === undefined ? {} : { run }),
    ...(block['output_format'] === undefined ? {} : { outputFormat: block['output_format'] }),
    bindings: parseDecisionBindings(text),
  };
}

/**
 * What must hold for the document to be a coherent answer to its own failures (ADR-030). These are the
 * cite-nothing cases: a decision pointing at a failure the document does not record, or a check
 * claiming to settle a decision that is not there. Both are refused HERE, before a human confirms and
 * long before a run, because a revision that cannot be read back is not a revision — and the forge
 * refuses the same two cases again at acceptance time, from its own line-wise parse.
 */
export function validateRequirementDocument(text: string): string[] {
  const decisions = parseRequirements(text);
  const bindings = parseDecisionBindings(text);
  const feedback = parseFeedback(text);
  const issues: string[] = [];

  // The intake's contract, machine-checked. It is enforced here (before a human is asked to confirm, and
  // in --dry-run) because a document that breaks it is one the loop cannot use: an unbounded "open
  // question" cannot be answered by typing a number, a value outside its own options cannot be written
  // back, and an id that does not line up cannot be traced.
  const sequence = (ids: string[], prefix: string): void => {
    ids.forEach((id, index) => {
      const expected = `${prefix}-${String(index + 1).padStart(3, '0')}`;
      if (id !== expected) {
        issues.push(`the ${prefix} ids are not sequential: entry ${index + 1} is ${id} where ${expected} was expected, and the loop traces decisions and requirements by that numbering`);
      }
    });
  };
  sequence(decisions.map((d) => d.id), 'AMB');
  for (const decision of decisions) {
    if (decision.options.length < 2 || decision.options.length > 4) {
      issues.push(`${decision.id} has ${decision.options.length} option(s): a decision a human answers by number needs 2 to 4 bounded options`);
    }
    for (const key of ['default', 'chosen'] as const) {
      const value = decision[key];
      if (value !== undefined && !decision.options.includes(value)) {
        issues.push(`${decision.id} has ${key} = "${value}", which is not one of its own options: a value the document does not offer is a value nobody chose`);
      }
    }
    if (decision.fromFeedback !== undefined && !/^FB-[0-9]+$/.test(decision.fromFeedback)) {
      issues.push(`${decision.id} cites "${decision.fromFeedback}" as the failure it came from, which is not an FB-nnn id`);
    }
  }
  // ADR-031: the document now has to carry the contract a judge is forged from, and the two ways it can
  // be un-judgeable are worth catching BEFORE a human confirms (and long before an implementation is
  // paid for): an invocation nobody can run, a relation the forge does not implement, and a blocking
  // decision that no declared check exercises (the forge refuses that one too, at acceptance time).
  const block = parseDeliverableBlock(text);
  if (block !== undefined) {
    if (block.run === undefined || block.run.trim().length === 0) {
      issues.push('the deliverable block declares no run: a judge with no way to invoke the thing cannot check anything');
    }
    const implemented = JUDGE_RELATION_VOCABULARY.join(', ');
    for (const binding of block.bindings) {
      if (!(JUDGE_RELATION_VOCABULARY as readonly string[]).includes(binding.relation)) {
        issues.push(`${binding.checkId} declares the relation "${binding.relation}", which no judge can check (implemented: ${implemented}): the document would be refused at acceptance time, after the implementation`);
      }
    }
    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    for (const binding of block.bindings) {
      const modes = decisionModesFor(binding.relation);
      if (modes === undefined || binding.decides === undefined) continue;
      const decision = decisionById.get(binding.decides);
      if (decision === undefined) continue; // reported by the dangling-binding rule above
      if (decision.checkedAs === undefined) {
        issues.push(
          `${binding.checkId} settles ${decision.id} with "${binding.relation}", so ${decision.id} must say what its answer MEANS to a judge: add checkedAs: <${modes.join(' | ')}> (prose alone is not checkable)`,
        );
      } else if (!modes.includes(decision.checkedAs)) {
        issues.push(`${decision.id} says checkedAs: "${decision.checkedAs}", which no judge can act on for ${binding.relation} (implemented: ${modes.join(', ')})`);
      }
    }
    const exercised = new Set(block.bindings.map((b) => b.decides).filter((d): d is string => d !== undefined));
    for (const decision of decisions) {
      if (!decision.blocking || exercised.has(decision.id)) continue;
      issues.push(`${decision.id} is blocking and no declared check exercises it (add decides: ${decision.id} to the check that settles it): a blocking decision nothing checks does not bind the implementation`);
    }
  }

  // Read the requirements out of the parsed document rather than by counting indentation: the intake's
  // contract is about what the file SAYS, not about how it happens to be laid out.
  let requirements: { id: string; criteria: number }[] = [];
  try {
    const parsed = parseYaml(text) as { requirements?: unknown } | null;
    const list = parsed !== null && typeof parsed === 'object' ? (parsed as { requirements?: unknown }).requirements : undefined;
    if (Array.isArray(list)) {
      requirements = list
        .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
        .map((r) => ({
          id: stringOf(r['id']) ?? '',
          criteria: Array.isArray(r['acceptance_criteria'])
            ? r['acceptance_criteria'].filter((c) => typeof c === 'string' && c.trim().length > 0).length
            : 0,
        }));
    }
  } catch {
    // A document that does not parse is already an issue elsewhere; nothing to add here.
  }
  sequence(
    requirements.map((r) => r.id).filter((id) => id.length > 0),
    'REQ',
  );
  for (const requirement of requirements) {
    if (requirement.criteria === 0) {
      issues.push(`${requirement.id} has no acceptance criterion: a requirement nobody can check is a wish`);
    }
  }
  const decisionIds = new Set(decisions.map((d) => d.id));
  const feedbackIds = new Set(feedback.map((e) => e.id));
  for (const decision of decisions) {
    if (decision.fromFeedback === undefined) continue;
    if (!feedbackIds.has(decision.fromFeedback)) {
      issues.push(
        `${decision.id} cites ${decision.fromFeedback}, which this document does not record as an acceptance failure: a decision that came from nothing is a decision nobody asked for`,
      );
    }
  }
  for (const binding of bindings) {
    if (binding.decides === undefined) continue;
    if (!decisionIds.has(binding.decides)) {
      issues.push(`${binding.checkId} (${binding.relation}) exercises ${binding.decides}, which is not a decision in this document`);
    }
  }
  return issues;
}

/** The check id a judge line starts with: `REL-003`, `DIFF-001`, `DEC-002`, `DOC-001`, … */
export function checkIdOf(check: string): string {
  return /^([A-Z]+-[0-9]+)/.exec(check.trim())?.[1] ?? '';
}
