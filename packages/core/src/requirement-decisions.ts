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
  'derived-ratio',
  'browser-scenario',
  'mutation-detection',
] as const;

/**
 * The relation kinds whose expectations are RECOMPUTED FROM THE DECLARED RECORDS (ADR-033): a document
 * that declares one of them must declare its world, because the judge builds its fixtures AND its
 * expectations in it. The other two need no world at all — a scenario (ADR-035) runs a command the
 * document names and reads the report that command writes, and mutation-detection (ADR-039) runs the
 * document's mutation tool.
 *
 * Demanding a world from a document whose checks need none refused documents this chain can implement, at
 * the FRONT DOOR, before the forge ever saw them: measured 2026-10-13 (round 10), three runs of a
 * shortest-path requirement were refused with "the deliverable block declares no input_format" and the
 * later rounds of the same defect (#83, #84) had already been fixed inside the forge. The forge keeps the
 * same list in its own WORLD_NEEDED case, and judge-vocabulary.test.ts compares the two, because a drift
 * here is a document that passes one door and is refused at the other.
 */
export const JUDGE_RELATIONS_THAT_NEED_THE_WORLD = [
  'row-order-invariance',
  'additivity',
  'duplicate-resolution',
  'malformed-row-accounting',
  'independent-aggregation',
  // `derived-ratio` recomputes numerator/denominator FROM THE RECORDS, so the judge must know what a row
  // looks like and how the quotient is rounded — exactly the two things the world supplies (ledger #99).
  'derived-ratio',
] as const;

/** The report formats a `browser-scenario` may name as its evidence, beyond the command's exit code. */
export const JUDGE_SCENARIO_REPORTS = ['ctrf', 'junit', 'tap'] as const;

/**
 * The mutation report formats a judge implements (ADR-039). `survivors-json` is the design's first choice
 * and deliberately boring: a tool-agnostic report every mutation tool can be wrapped into, which lets the
 * relation be proven end to end before any specific tool's schema is wired in. The tool-specific readers
 * (stryker, mutmut, cargo-mutants) come after, and a format the judge does not implement is refused, not
 * guessed — a report the judge cannot read is never a pass.
 */
export const JUDGE_MUTATION_FORMATS = ['survivors-json'] as const;

/**
 * The smallest honest bound on ONE invocation of the deliverable (ADR-046). A run gets at least a
 * second, or the bound is a refusal nobody sees. The forge carries the same floor on its own
 * `RUN_MIN_TIMEOUT_MS` line; the two are kept honest by a test that parses the shell.
 */
export const MIN_RUN_TIMEOUT_MS = 1000;

/**
 * The bound applied to one invocation of the deliverable when the document declares none (ADR-046).
 *
 * WHY A BOUND EXISTS AT ALL, AND WHY IT IS A DEFAULT RATHER THAN AN OPTION. `deliverable.run` is
 * invoked once per fixture, and a SERVICE-shaped run is a start-and-serve command that NEVER exits:
 * without a bound the judge waits for ever and a generated CI job waits out the host's own job limit
 * (GitHub's default is six hours). The bound is therefore unconditional — the document may tighten it
 * (`deliverable.timeoutMs`) but cannot remove it, because an unbounded invocation is not a check, it is
 * a hang that eventually reads as a failure for the wrong reason.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 120000;

/**
 * The smallest honest bound for a mutation run (ADR-039). A mutation tool executes the delivered suite
 * once per mutant, so a bound below five seconds cannot contain even a two-mutant pass; scenarios get one
 * second because they run one command once. This is a FLOOR, not a recommendation — a real suite should
 * declare far more (the design's example is 900000).
 */
export const MIN_MUTATION_TIMEOUT_MS = 5000;

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
  // A ratio is a division, so it needs the same rounding decision an aggregate does (ledger #99).
  'derived-ratio': ['half-up', 'truncate'],
};

/**
 * How many decisions a document may still leave OPEN when it is confirmed (ADR-036).
 *
 * Spec-kit caps `[NEEDS CLARIFICATION]` markers at three because a spec full of open questions is not a
 * spec; ours are explicit decisions with bounded options, so the budget is checked in two places: the
 * validator refuses a document that CARRIES more than this many decisions at all (the intake has to reach
 * for fewer, sharper questions), and the human's confirmation token carries how many were still open, so
 * "I confirmed this while three things were unanswered" is visible in the artifact rather than implied.
 */
export const MAX_OPEN_DECISIONS = 5;

/** The modes a relation kind can test, or undefined when the relation needs no meaning (it is a property). */
export function decisionModesFor(relation: string): readonly string[] | undefined {
  return JUDGE_DECISION_MODES[relation];
}

/**
 * What the document calls the PARTS of its own input (ADR-033). A judge has to build fixtures in the
 * document's world — the first real end-to-end run was judged with the judge's OWN employee/department
 * fixtures while the requirement was about temperature stations, so every relation failed for the wrong
 * reason and one of them passed because both sides were empty. The document is the only thing that knows
 * what its columns mean, so it says so.
 */
export const JUDGE_COLUMN_ROLES = ['id', 'measure', 'date', 'other'] as const;

/**
 * What the document calls the parts of its own OUTPUT (ADR-033): the roles a judge may expect in a
 * declared line shape, positionally. `<station> <count> <min> <max> <mean>` in the document's words is
 * `id`, `count`, `min`, `max`, `mean` in the judge's, and the judge computes the expectation from the
 * fixture rather than from prose.
 *
 * `numerator` / `denominator` / `ratio` exist for `derived-ratio` (ledger #99). A business answer is very
 * often a RATIO of two counts rather than an aggregate of a measure — availability = successes/probes,
 * hit rate, pass rate, conversion — and before this the vocabulary could only express it as a `mean` of
 * the raw measure, so the judge recomputed something the requirement never asked for and refused correct
 * deliveries. Measured 2026-10-23: a correct `availability = 100*(1-fail/probes)` report was rejected
 * because the judge compared `mean=25.0` against `0.8`.
 */
export const JUDGE_FIELD_ROLES = [
  'id', 'count', 'sum', 'min', 'max', 'mean', 'skipped-count',
  'numerator', 'denominator', 'ratio',
] as const;

export interface InputFormat {
  /** `date:date`, `station:id`, `temperature_c:measure` … the header, typed. */
  columns: { name: string; role: string }[];
  /** Two or more data lines, each with exactly one field per column: the world a judge starts from. */
  sample: string[];
}

export interface OutputLineFormat {
  shape: string;
  /** One role per `<placeholder>` in the shape, in order. Empty when the document declares only words. */
  fields: string[];
}

/**
 * A declared end-to-end scenario of the delivered surface (ADR-035). The document says what to START, what
 * to run and what to expect; the forged judge runs it and decides from the command's exit code and,
 * when declared, the report file it wrote. Nothing about a browser, a framework or a network lives in the
 * judge — the commands are the document's own, so the check is reproducible and the judge stays independent
 * of the thing it judges.
 */
export interface Scenario {
  id: string;
  /** The command that must exit 0 for the scenario to hold, run in the delivery worktree. */
  run: string;
  /** The decision this scenario settles, when it settles one. */
  decides?: string;
  /** How the surface is brought up (optional); the judge starts it and always kills what it started. */
  start?: string;
  /** A URL the judge waits for (bounded) before running `run`, when `start` was given. */
  url?: string;
  /** Where the verdict lives when the command writes a report rather than trusting its exit code. */
  report?: string;
  reportPath?: string;
  /** Required: the criterion in the human's words, so a failure reads as a requirement, not a script. */
  expect: string;
  /**
   * The HTTP status the surface must answer with (ADR-046). Declaring it (or `expectBody`) is what makes
   * a service scenario LOOK AT THE RESPONSE: without one, a scenario whose `run` merely reaches the
   * surface passes whatever the surface said, which is the vacuous green this project treats as the worst
   * kind of defect.
   */
  expectStatus?: number;
  /** A substring the response body must contain (ADR-046), the body half of the same assertion. */
  expectBody?: string;
  timeoutMs?: number;
}

export interface DeliverableBlock {
  run?: string;
  /**
   * The bound on ONE invocation of the deliverable (ADR-046), in milliseconds. Optional in the document;
   * the bound itself is not — the forge and the generated CI job apply `DEFAULT_RUN_TIMEOUT_MS` when the
   * document declares none, because a start-and-serve `run` never exits on its own.
   */
  timeoutMs?: number;
  /**
   * How a JUDGE reads the report of ONE fixture (ADR-047). A script prints its report on stdout, so this
   * is absent and `run` is the whole story. A SERVICE starts and serves: `run` prints NOTHING, so a judge
   * that reads stdout finds no report at all and every output-shape relation reports "the judge did not
   * exercise the deliverable". `read` is the command that FETCHES the report for the fixture `run` was
   * started with; `{csv}`, `{port}` and `{url}` are resolved by the judge.
   */
  read?: string;
  /**
   * The surface a judge waits for before it runs `read` (ADR-047), with `{port}` for a port the judge
   * ALLOCATES. `read` and `url` go together: a service whose report no judge can fetch is a delivery
   * judged on nothing, and both are refused when declared alone.
   */
  url?: string;
  /** The declared scenarios, in document order (ADR-035). */
  scenarios: Scenario[];
  /** The mutation tool configuration a `mutation-detection` relation runs (ADR-039), when declared. */
  mutation?: MutationBlock;
  /** The declared output shape a judge may parse, as written. */
  outputFormat?: unknown;
  /** The typed input world, and the shapes a judge may parse, when the document declares them. */
  input?: InputFormat;
  outputLines: OutputLineFormat[];
  bindings: DecisionBinding[];
}

/**
 * The `mutation:` block inside `deliverable` (ADR-039): how a `mutation-detection` relation runs a mutation
 * tool and reads its verdict. Unlike a scenario, this block is not itself a check — it CONFIGURES the
 * relation, which the document declares in `relations:` like any other. Flat keys, because the forge reads
 * the document line-wise and a nested structure it cannot read would just move the guesswork.
 */
export interface MutationBlock {
  /** The command the judge runs in the delivery worktree; it writes `reportPath`. */
  run: string;
  /** Where the tool writes its verdict, relative to the worktree. */
  reportPath: string;
  /** The declared report format; only `JUDGE_MUTATION_FORMATS` may be named. */
  format: string;
  /** How many uncaught mutants are tolerated (usually 0), when it is a non-negative integer. */
  maxSurvivors?: number;
  /** The bound for the whole run, when it is a finite number. */
  timeoutMs?: number;
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
  /**
   * The document's own statement that a PERSON decides this, whatever `default:` it carries (ADR-045).
   * It exists because a decision with a defensible default could otherwise never say "this one is not a
   * machine's to default" — a standing authorization would eat the default. A blocking decision with no
   * default is already a human's; this is how a decision WITH one is marked too.
   */
  human?: boolean;
}

/**
 * The `scenarios:` list inside `deliverable`, as written. Flat keys, because the forge reads the document
 * line-wise and a nested structure it cannot read would just move the guesswork (ADR-035).
 */
export function parseScenarios(text: string): Scenario[] {
  const list = deliverableOf(text)?.['scenarios'];
  if (!Array.isArray(list)) return [];
  const scenarios: Scenario[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const id = stringOf(entry['id']);
    if (id === undefined) continue;
    const number = entry['timeoutMs'];
    const status = entry['expect_status'];
    scenarios.push({
      id,
      run: stringOf(entry['run']) ?? '',
      expect: stringOf(entry['expect']) ?? '',
      ...(stringOf(entry['decides']) === undefined ? {} : { decides: stringOf(entry['decides']) }),
      ...(stringOf(entry['start']) === undefined ? {} : { start: stringOf(entry['start']) }),
      ...(stringOf(entry['url']) === undefined ? {} : { url: stringOf(entry['url']) }),
      ...(stringOf(entry['report']) === undefined ? {} : { report: stringOf(entry['report']) }),
      ...(stringOf(entry['report_path']) === undefined ? {} : { reportPath: stringOf(entry['report_path']) }),
      ...(typeof status === 'number' && Number.isFinite(status) ? { expectStatus: status } : {}),
      ...(stringOf(entry['expect_body']) === undefined ? {} : { expectBody: stringOf(entry['expect_body']) }),
      ...(typeof number === 'number' && Number.isFinite(number) ? { timeoutMs: number } : {}),
    });
  }
  return scenarios;
}

/**
 * The `mutation:` block inside `deliverable`, as written (ADR-039). Absent when the document declares no
 * mutation tool. The fields are returned as written (empty strings for a missing `run`/`report_path`/
 * `format`) so the validator can name the missing one rather than silently dropping it.
 */
export function parseMutation(text: string): MutationBlock | undefined {
  const raw = deliverableOf(text)?.['mutation'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const max = entry['max_survivors'];
  const timeout = entry['timeoutMs'];
  return {
    run: stringOf(entry['run']) ?? '',
    reportPath: stringOf(entry['report_path']) ?? '',
    format: stringOf(entry['format']) ?? '',
    ...(typeof max === 'number' && Number.isInteger(max) && max >= 0 ? { maxSurvivors: max } : {}),
    ...(typeof timeout === 'number' && Number.isFinite(timeout) ? { timeoutMs: timeout } : {}),
  };
}

export interface DecisionBinding {
  /** `REL-003`, `DIFF-001`, … the id the judge reports a check under. */
  checkId: string;
  kind: 'relation' | 'anchor' | 'scenario';
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
      ...(entry['human'] === true ? { human: true } : {}),
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
  const block = deliverable as { relations?: unknown; differential?: unknown; scenarios?: unknown };
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
  // A scenario is a check like any other: it may settle a decision (`decides:`), and then its verdict is
  // reported as a DEC-nnn line exactly as a relation's is (ADR-035).
  for (const scenario of parseScenarios(text)) {
    if (scenario.decides === undefined || scenario.decides.length === 0) continue;
    bindings.push({ checkId: scenario.id, kind: 'scenario', relation: 'browser-scenario', decides: scenario.decides });
  }
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

/** `date:date,station:id,temperature_c:measure` → typed columns. A flat, shell-parsable list, because the
 *  forge reads the document line-wise and a nested list it cannot parse would just move the guesswork. */
function parseColumns(raw: unknown): { name: string; role: string }[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const at = part.lastIndexOf(':');
      return at <= 0 ? { name: part, role: '' } : { name: part.slice(0, at).trim(), role: part.slice(at + 1).trim() };
    });
}

/** The input world the document declares (ADR-033), or undefined when it declares none. */
export function parseInputFormat(text: string): InputFormat | undefined {
  const block = deliverableOf(text);
  const raw = block?.['input_format'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const entry = raw as Record<string, unknown>;
  const columns = parseColumns(entry['columns']);
  const sampleRaw = entry['sample'];
  const sample =
    typeof sampleRaw === 'string'
      ? sampleRaw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
  if (columns.length === 0 && sample.length === 0) return undefined;
  return { columns, sample };
}

/** The declared output lines, with the roles of their placeholders when the document names them. */
export function parseOutputLines(text: string): OutputLineFormat[] {
  const raw = deliverableOf(text)?.['output_format'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const lines: OutputLineFormat[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      lines.push({ shape: value, fields: [] });
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const entry = value as { shape?: unknown; fields?: unknown };
    const shape = stringOf(entry.shape);
    if (shape === undefined) continue;
    lines.push({
      shape,
      fields: Array.isArray(entry.fields) ? entry.fields.filter((field): field is string => typeof field === 'string') : [],
    });
  }
  return lines;
}

/** Whether a top-level key under `deliverable` was WRITTEN at all (an empty list parses as `[]`, so the
 *  validator cannot tell "declared empty" from "absent" by looking at the parsed value alone). */
function objectHasKey(text: string, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(deliverableOf(text) ?? {}, key);
}

/** The `deliverable` mapping as written, for the parsers above. */
function deliverableOf(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const deliverable = (parsed as { deliverable?: unknown }).deliverable;
  if (deliverable === null || typeof deliverable !== 'object') return undefined;
  return deliverable as Record<string, unknown>;
}

/** The `deliverable` block as a whole: how the thing is run, the world it runs on, and what is checked. */
export function parseDeliverableBlock(text: string): DeliverableBlock | undefined {
  const block = deliverableOf(text);
  if (block === undefined) return undefined;
  const run = stringOf(block['run']);
  const input = parseInputFormat(text);
  const mutation = parseMutation(text);
  const timeout = block['timeoutMs'];
  const read = stringOf(block['read']);
  const url = stringOf(block['url']);
  return {
    ...(run === undefined ? {} : { run }),
    ...(typeof timeout === 'number' && Number.isFinite(timeout) ? { timeoutMs: timeout } : {}),
    ...(read === undefined ? {} : { read }),
    ...(url === undefined ? {} : { url }),
    ...(block['output_format'] === undefined ? {} : { outputFormat: block['output_format'] }),
    ...(input === undefined ? {} : { input }),
    ...(mutation === undefined ? {} : { mutation }),
    outputLines: parseOutputLines(text),
    scenarios: parseScenarios(text),
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
    // ADR-046: `deliverable.build` and `deliverable.tests` are DEAD TEXT. Nothing in the chain reads
    // either one: the delivered project's own tests are run from the WORKFLOW's `testCommand` (the
    // `ci_config` step and the quality gate), not from the document, and no install/build step exists in
    // `request-to-delivery{,-attempt}/workflow.yaml` at all. Before this refusal they were neither
    // executed nor refused, so a document that declared them READ as compliance while nothing ran — the
    // same defect class as a key inherited through a merge (docs/bugs-fixed.md #47). A silent declaration
    // is worse than a refusal, so the front door names the key and refuses.
    for (const deadKey of ['build', 'tests'] as const) {
      if (!objectHasKey(text, deadKey)) continue;
      issues.push(
        `the deliverable block declares ${deadKey}, which nothing in the chain reads or runs: a declaration that is never executed reads as compliance, which is worse than a refusal — either wire it as a real step or remove it (the delivered project's own tests are run from the workflow's testCommand, not from deliverable.tests)`,
      );
    }
    // ADR-047: `read` and `url` go together. A service's `run` starts and serves, so the judge needs a
    // command that FETCHES the report (`read`) and a surface to wait for first (`url`); declaring one
    // without the other is a delivery a judge cannot read, which is worse than a refusal.
    const declRead = deliverableOf(text)?.['read'];
    const declUrl = deliverableOf(text)?.['url'];
    const hasRead = typeof declRead === 'string' && declRead.trim().length > 0;
    const hasUrl = typeof declUrl === 'string' && declUrl.trim().length > 0;
    if (declRead !== undefined && !hasRead) {
      issues.push('the deliverable block declares an empty read: a judge told to fetch the report with nothing is told nothing');
    }
    if (declUrl !== undefined && !hasUrl) {
      issues.push('the deliverable block declares an empty url: a judge told to wait for nothing waits for ever');
    }
    if (hasRead && !hasUrl) {
      issues.push('the deliverable block declares read but no url: a judge that has to fetch the report must know which surface to wait for before it fetches');
    }
    if (hasUrl && !hasRead) {
      issues.push('the deliverable block declares url but no read: a service whose report the judge cannot fetch is judged on nothing — declare how one fixture\'s report is read (read: "curl -fsS {url}")');
    }
    // ADR-046: the bound on ONE invocation of the deliverable. Optional in the document (the forge and the
    // generated CI job apply DEFAULT_RUN_TIMEOUT_MS), but a declared one has to be a bound a judge can
    // apply: a whole number of milliseconds at or above the floor. A bound below the floor is a refusal
    // nobody sees; a non-number is a bound nobody can apply.
    const declaredRunTimeout = deliverableOf(text)?.['timeoutMs'];
    if (declaredRunTimeout !== undefined) {
      if (typeof declaredRunTimeout !== 'number' || !Number.isFinite(declaredRunTimeout) || declaredRunTimeout < MIN_RUN_TIMEOUT_MS) {
        issues.push(
          `the deliverable block declares timeoutMs ${JSON.stringify(declaredRunTimeout)}: the bound on one invocation of the deliverable must be a whole number of milliseconds at or above ${MIN_RUN_TIMEOUT_MS}, or the timeout is a refusal nobody sees (omit it to take the default of ${DEFAULT_RUN_TIMEOUT_MS})`,
        );
      }
    }
    const implemented = JUDGE_RELATION_VOCABULARY.join(', ');
    for (const binding of block.bindings) {
      if (!(JUDGE_RELATION_VOCABULARY as readonly string[]).includes(binding.relation)) {
        issues.push(`${binding.checkId} declares the relation "${binding.relation}", which no judge can check (implemented: ${implemented}): the document would be refused at acceptance time, after the implementation`);
      }
    }
    if (decisions.length > MAX_OPEN_DECISIONS) {
    issues.push(
      `the document carries ${decisions.length} decisions, over the budget of ${MAX_OPEN_DECISIONS}: an intake that asks more than ${MAX_OPEN_DECISIONS} questions is a document that has not decided what it is about (merge the related ones, or choose a default and say so in prose)`,
    );
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

    // ADR-033: a judge builds its fixtures AND its expectations in the document's world, so the document
    // has to name that world. Three real failures came from not naming it — a temperature requirement
    // judged with the judge's employee fixtures (every relation failed for the wrong reason), one relation
    // passing because both sides were empty, and the fixture rows living inside the forge, where no
    // document could reach them.
    // ... AND ONLY A DOCUMENT WHOSE CHECKS USE THAT WORLD HAS TO DECLARE ONE (ledger #85). The three
    // relations that recompute their expectations from the records need it; a scenario and a
    // mutation-detection run do not. Measured 2026-10-13: three runs of a shortest-path requirement — the
    // intake having written exactly the shape the prompt asks for, one scenario and no world — were
    // refused HERE, at the front door, in 2.5 minutes each, after #83 and #84 had already fixed the same
    // demand inside the forge. The list is shared with the forge and compared by a test.
    const input = block.input;
    const needsWorld = bindings.some((binding) =>
      (JUDGE_RELATIONS_THAT_NEED_THE_WORLD as readonly string[]).includes(binding.relation),
    );
    if (input === undefined && needsWorld) {
      issues.push(
        'the deliverable block declares no input_format: a judge with no declared world builds its own fixtures and judges a scenario nobody asked for (add `input_format` with typed `columns` and a `sample` of at least three rows)',
      );
    } else if (input !== undefined) {
      for (const column of input.columns) {
        if (!(JUDGE_COLUMN_ROLES as readonly string[]).includes(column.role)) {
          issues.push(
            `input_format column "${column.name}" declares the role "${column.role}", which a judge cannot use (implemented: ${JUDGE_COLUMN_ROLES.join(', ')})`,
          );
        }
      }
      const ids = input.columns.filter((column) => column.role === 'id');
      const measures = input.columns.filter((column) => column.role === 'measure');
      if (ids.length !== 1) {
        issues.push(`input_format declares ${ids.length} column(s) with role id where exactly one is needed: the judge groups rows by the id column`);
      }
      if (measures.length !== 1) {
        issues.push(
          `input_format declares ${measures.length} column(s) with role measure where exactly one is needed: the judge computes every expectation from it`,
        );
      }
      if (input.columns.filter((column) => column.role === 'date').length > 1) {
        issues.push('input_format declares more than one column with role date: the judge would not know which one orders the rows');
      }
      if (input.sample.length < 3) {
        issues.push(
          `input_format.sample has ${input.sample.length} row(s): a judge needs at least three to build a base, a reshuffled and a duplicated fixture`,
        );
      }
      const widthsOk = input.sample.every((line) => line.split(',').length === input.columns.length);
      if (!widthsOk) {
        issues.push(
          `input_format.sample does not have one field per declared column (${input.columns.length} declared): a fixture the document itself cannot read is not a fixture`,
        );
      }
      if (widthsOk && ids.length === 1) {
        const idIndex = input.columns.findIndex((column) => column.role === 'id');
        const distinct = new Set(input.sample.map((line) => line.split(',')[idIndex] ?? ''));
        if (input.sample.length > 0 && distinct.size < 2) {
          issues.push(
            `input_format.sample names ${distinct.size} distinct id(s): with one id there is nothing for additivity or an independent recomputation to separate`,
          );
        }
      }
      if (widthsOk && measures.length === 1) {
        const measureIndex = input.columns.findIndex((column) => column.role === 'measure');
        for (const line of input.sample) {
          const value = line.split(',')[measureIndex] ?? '';
          if (!Number.isFinite(Number(value))) {
            issues.push(
              `input_format.sample has "${value}" in the measure column: the judge computes its expectations from those values, and one it cannot add is one it cannot check`,
            );
            break;
          }
        }
      }
    }
    // A mode that picks a row by its DATE needs a date column to order by. The coupling is machine
    // checkable here, and refusing it before a human confirms beats a forge that cannot build the fixture.
    const dateColumns = input?.columns.filter((column) => column.role === 'date').length ?? 0;
    for (const decision of decisions) {
      if (decision.checkedAs === 'latest-start-date' && dateColumns !== 1) {
        issues.push(
          `${decision.id} says checkedAs: "latest-start-date", which picks the row with the latest date, but input_format declares ${dateColumns} column(s) with role date: the judge has nothing to order by`,
        );
      }
    }

    // ADR-035: a scenario is a check the document declares, so the same front-door discipline applies —
    // a scenario that cannot be run, cannot be read back, or settles nothing is refused BEFORE a human
    // confirms it, and long before an implementation is paid for.
    const scenarioIds = block.scenarios.map((s) => s.id);
    scenarioIds.forEach((id, index) => {
      const expected = `SCN-${String(index + 1).padStart(3, '0')}`;
      if (id !== expected) {
        issues.push(`the SCN ids are not sequential: entry ${index + 1} is ${id} where ${expected} was expected, and the judge reports a scenario by that id`);
      }
    });
    if (objectHasKey(text, 'scenarios') && block.scenarios.length === 0) {
      issues.push('the deliverable block declares an empty scenarios list: a scenario block that declares nothing is a document claiming a check it does not have');
    }
    const relationIds = new Set(block.bindings.filter((b) => b.kind !== 'scenario').map((b) => b.checkId));
    // The RAW scenario entries, so a value the parser had to drop (a non-numeric `expect_status`, a blank
    // `expect_body`) can be named in a refusal instead of vanishing into "declares no assertion".
    const rawScenarios = new Map<string, Record<string, unknown>>();
    {
      const list = deliverableOf(text)?.['scenarios'];
      if (Array.isArray(list)) {
        for (const raw of list) {
          if (raw === null || typeof raw !== 'object') continue;
          const entry = raw as Record<string, unknown>;
          const id = stringOf(entry['id']);
          if (id !== undefined) rawScenarios.set(id, entry);
        }
      }
    }
    for (const scenario of block.scenarios) {
      if (relationIds.has(scenario.id)) {
        issues.push(`${scenario.id} is declared twice (as a scenario and as a relation): a check id has to identify one check`);
      }
      if (scenario.run.trim().length === 0) {
        issues.push(`${scenario.id} declares no run: a scenario with no command to run is not a check`);
      }
      if (scenario.expect.trim().length === 0) {
        issues.push(`${scenario.id} declares no expect: the criterion has to be in words a human can read, because the scenario's verdict is reported against it`);
      }
      if ((scenario.report === undefined) !== (scenario.reportPath === undefined)) {
        issues.push(
          scenario.report === undefined
            ? `${scenario.id} declares report_path but no report: the judge would read a file without being told what wrote it (report: ${JUDGE_SCENARIO_REPORTS.join(' | ')})`
            : `${scenario.id} declares report "${scenario.report}" but no report_path: a report the judge cannot find is not evidence`,
        );
      }
      if (scenario.report !== undefined && !(JUDGE_SCENARIO_REPORTS as readonly string[]).includes(scenario.report)) {
        issues.push(`${scenario.id} declares the report format "${scenario.report}", which no judge can read (implemented: ${JUDGE_SCENARIO_REPORTS.join(', ')})`);
      }
      if (scenario.url !== undefined && scenario.start === undefined) {
        issues.push(`${scenario.id} declares a url but nothing to start: the judge waits for a surface it was never told how to bring up`);
      }
      // ADR-046: a scenario that reaches an HTTP surface has to SAY WHAT IT ASSERTS about the response.
      // Without this the check is vacuous by construction — the `run` command only has to exit 0, and a
      // command that reaches the surface but never looks at the status or the body passes whatever the
      // surface said. That is the vacuous green this project treats as the worst kind of defect, so the
      // document has to declare `expect_status` and/or `expect_body`, and a url/start with neither is
      // REFUSED.
      const rawEntry = rawScenarios.get(scenario.id);
      const declaresAssertion = rawEntry?.['expect_status'] !== undefined || rawEntry?.['expect_body'] !== undefined;
      if ((scenario.url !== undefined || scenario.start !== undefined) && !declaresAssertion) {
        issues.push(
          `${scenario.id} declares a url/start but neither expect_status nor expect_body: a scenario that reaches a surface without asserting anything about the response passes without ever looking at it, so the check is vacuous — declare expect_status: <100-599> and/or expect_body: <substring of the response body>`,
        );
      }
      const rawStatus = rawEntry?.['expect_status'];
      if (rawStatus !== undefined && (typeof rawStatus !== 'number' || !Number.isInteger(rawStatus) || rawStatus < 100 || rawStatus > 599)) {
        issues.push(
          `${scenario.id} declares expect_status ${JSON.stringify(rawStatus)}, which is not an HTTP status code (an integer from 100 to 599): the judge would compare the surface's answer against a number it cannot mean`,
        );
      }
      const rawBody = rawEntry?.['expect_body'];
      if (rawBody !== undefined && (typeof rawBody !== 'string' || rawBody.trim().length === 0)) {
        issues.push(
          `${scenario.id} declares expect_body ${JSON.stringify(rawBody)}, which is not a non-empty string: a body assertion the judge cannot search for asserts nothing`,
        );
      }
      if (scenario.timeoutMs !== undefined && scenario.timeoutMs < 1000) {
        issues.push(`${scenario.id} declares timeoutMs ${scenario.timeoutMs}: a scenario is given at least a second, or the timeout is a refusal nobody sees`);
      }
      if (scenario.decides !== undefined && !decisionById.has(scenario.decides)) {
        issues.push(`${scenario.id} settles ${scenario.decides}, which is not a decision in this document`);
      }
    }

    // ADR-039: a `mutation-detection` relation needs a `mutation:` block to run, and a `mutation:` block
    // with no relation using it is cost with no check. The front door refuses both, before a human confirms
    // and long before an expensive tool is run — a mutation check that cannot run is never a pass.
    const mutationRelations = block.bindings.filter((b) => b.relation === 'mutation-detection');
    const hasMutationBlock = objectHasKey(text, 'mutation');
    const mutation = block.mutation;
    if (mutationRelations.length > 1) {
      issues.push(
        `the document declares ${mutationRelations.length} mutation-detection relations (${mutationRelations.map((b) => b.checkId).join(', ')}): one mutation block configures one check, and running the tool once per relation is the same run paid for twice`,
      );
    }
    if (mutationRelations.length > 0 && mutation === undefined) {
      issues.push(
        `the relation ${mutationRelations[0]?.checkId} is a mutation-detection relation with no mutation: block: a check with nothing to run is not a check`,
      );
    }
    if (hasMutationBlock && mutationRelations.length === 0) {
      issues.push(
        'the deliverable block declares a mutation: block, but no relation uses it: a tool nobody checks with is cost with no check',
      );
    }
    if (hasMutationBlock) {
      const rawMutation = deliverableOf(text)?.['mutation'];
      const entry =
        rawMutation !== null && typeof rawMutation === 'object' && !Array.isArray(rawMutation)
          ? (rawMutation as Record<string, unknown>)
          : {};
      if (mutation === undefined) {
        issues.push('the mutation block is not a mapping: it has to declare run, report_path, format and max_survivors');
      } else {
        if (mutation.run.trim().length === 0) {
          issues.push('the mutation block declares no run: a mutation check with no command to run is not a check');
        }
        const format = stringOf(entry['format']);
        const reportPath = stringOf(entry['report_path']);
        if (format === undefined && reportPath === undefined) {
          issues.push('the mutation block declares neither format nor report_path: the judge would have nothing to read');
        } else if (format !== undefined && reportPath === undefined) {
          issues.push(
            `the mutation block declares format "${format}" but no report_path: a report the judge cannot find is not evidence`,
          );
        } else if (format === undefined && reportPath !== undefined) {
          issues.push('the mutation block declares report_path but no format: the judge would read a file without being told what wrote it');
        }
        if (format !== undefined && !(JUDGE_MUTATION_FORMATS as readonly string[]).includes(format)) {
          issues.push(
            `the mutation block declares the format "${format}", which no judge can read (implemented: ${JUDGE_MUTATION_FORMATS.join(', ')})`,
          );
        }
        const max = entry['max_survivors'];
        if (!Object.prototype.hasOwnProperty.call(entry, 'max_survivors')) {
          issues.push('the mutation block declares no max_survivors: a mutation check with no budget tolerates every survivor, which is not a check');
        } else if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
          issues.push(
            `the mutation block declares max_survivors ${JSON.stringify(max)}, which is not a non-negative integer: the budget is how many uncaught mutants are tolerated, and a budget nobody can count is not a budget`,
          );
        }
        if (Object.prototype.hasOwnProperty.call(entry, 'timeoutMs')) {
          const timeout = entry['timeoutMs'];
          if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < MIN_MUTATION_TIMEOUT_MS) {
            issues.push(
              `the mutation block declares timeoutMs ${JSON.stringify(timeout)}: a mutation run executes the delivered suite once per mutant, so a bound below ${MIN_MUTATION_TIMEOUT_MS}ms cannot honestly contain one`,
            );
          }
        }
      }
    }

    const namedLines = block.outputLines.filter((line) => line.fields.length > 0);
    if (block.outputLines.length > 0 && namedLines.length === 0) {
      issues.push(
        'no output_format entry names its fields: a judge can compare two runs but cannot say which number is the count (declare `fields: [id, count, …]` beside each machine-readable shape)',
      );
    }
    for (const line of block.outputLines) {
      if (line.fields.length === 0) continue;
      const placeholders = (line.shape.match(/<[^<>]+>/g) ?? []).length;
      if (line.fields.length !== placeholders) {
        issues.push(
          `an output_format entry declares ${line.fields.length} field(s) for ${placeholders} placeholder(s) in "${line.shape}": the roles are positional, so they must line up`,
        );
      }
      for (const field of line.fields) {
        if (!(JUDGE_FIELD_ROLES as readonly string[]).includes(field)) {
          issues.push(
            `an output_format entry declares the field role "${field}", which a judge cannot compute (implemented: ${JUDGE_FIELD_ROLES.join(', ')})`,
          );
        }
      }
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
  // ADR-045: `human: true` is how a document says a PERSON decides this decision, whatever default it
  // carries. Only a real boolean marks it — a truthy `human: yes` would read as "not marked" and the
  // decision would be defaulted by a standing authorization, which is the one thing the marker exists to
  // prevent. So it is refused by name here rather than silently ignored.
  let rawAmbiguities: unknown;
  try {
    rawAmbiguities = (parseYaml(text) as { ambiguities?: unknown } | null)?.ambiguities;
  } catch {
    rawAmbiguities = undefined;
  }
  if (Array.isArray(rawAmbiguities)) {
    for (const raw of rawAmbiguities) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(entry, 'human')) continue;
      if (typeof entry['human'] !== 'boolean') {
        issues.push(
          `${stringOf(entry['id']) ?? 'a decision'} declares human: ${JSON.stringify(entry['human'])}, which is not true or false: a marker a reader cannot trust is a decision that gets defaulted`,
        );
      }
    }
  }
  return issues;
}

/** The check id a judge line starts with: `REL-003`, `DIFF-001`, `DEC-002`, `DOC-001`, … */
export function checkIdOf(check: string): string {
  return /^([A-Z]+-[0-9]+)/.exec(check.trim())?.[1] ?? '';
}
