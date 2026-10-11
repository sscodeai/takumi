import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  analyseFeedback,
  FEEDBACK_CLOSURE_KINDS,
  parseFeedback,
  renderFeedbackBrief,
  resolveFeedback,
  validateRequirementDocument,
  type FeedbackClosureKind,
  type FeedbackEntry,
} from '@takumi/core';
import { requirementConfirmation } from './commands.js';

/**
 * `takumi requirement confirm` — the bounded-choice confirmation (ADR-027).
 *
 * The point of this command is the shape of the answer, not its rendering: every open decision in the
 * requirement document is put to the human as a NUMBERED, bounded choice, one question at a time, and
 * the answer is written back into the document itself. The document is then hashed, and that digest is
 * the token the run's acceptance step binds to — so "what was confirmed" and "what was built" cannot
 * drift apart without one of them being named as stale.
 *
 * Two refusals matter as much as the questions:
 *   * a NON-INTERACTIVE confirmation is refused. Piping answers in, or running this in CI, is exactly
 *     the auto-approval hole the design calls out: a requirement confirmation nobody read is not a
 *     confirmation. `--dry-run` exists for CI, and it never writes and never prints a token.
 *   * a BLOCKING decision left undecided at the end refuses to produce a token at all.
 *
 * ADR-029 adds the other end of the loop: an open `feedback:` entry (an acceptance failure the machine
 * wrote back) is put to the human as its own bounded choice, and choosing "leave it open" refuses the
 * confirmation. A human may therefore resolve a failure in the same act as re-confirming the document,
 * but not confirm around one.
 */

interface Ambiguity {
  id: string;
  question: string;
  options: string[];
  default?: string;
  chosen?: string;
  blocking: boolean;
}

export interface ConfirmIO {
  /** Answer stream. Defaults to process.stdin; injectable so a test can drive the questions. */
  input?: NodeJS.ReadableStream;
  /** Line sink. Defaults to console.log; injectable for the same reason. */
  out?: (line: string) => void;
}

export interface RequirementDocument {
  ref: string;
  path: string;
  text: string;
  ambiguities: Ambiguity[];
}

/** Read the requirement document and the decisions it still holds. */
export function readRequirementDocument(cwd: string, ref: string): RequirementDocument {
  const path = join(cwd, ref);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`the requirement document "${ref}" could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  let parsed: { ambiguities?: unknown };
  try {
    parsed = parseYaml(text) as { ambiguities?: unknown };
  } catch (e) {
    throw new Error(`the requirement document "${ref}" is not valid YAML (${e instanceof Error ? e.message : String(e)})`);
  }
  const list = Array.isArray(parsed.ambiguities) ? parsed.ambiguities : [];
  const ambiguities: Ambiguity[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry['id'] !== 'string') continue;
    const options = Array.isArray(entry['options']) ? entry['options'].filter((o): o is string => typeof o === 'string') : [];
    ambiguities.push({
      id: entry['id'],
      question: typeof entry['question'] === 'string' ? entry['question'] : '',
      options,
      ...(typeof entry['default'] === 'string' ? { default: entry['default'] } : {}),
      ...(typeof entry['chosen'] === 'string' ? { chosen: entry['chosen'] } : {}),
      blocking: entry['blocking'] !== false,
    });
  }
  return { ref, path, text, ambiguities };
}

/**
 * Write `chosen: "<option>"` into the document TEXTUALLY: the document is a hand-written, commented
 * artefact, and re-serialising the YAML would delete every comment in it. The indentation of an
 * existing `chosen:` line is preserved; a missing one is inserted at the end of its own ambiguity
 * block.
 */
export function withChosen(text: string, id: string, chosen: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(line));
  if (start === -1) throw new Error(`the requirement document has no ambiguity ${id}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*-\s*id:/.test(line) || (/^\S/.test(line) && line.trim() !== '')) {
      end = i;
      break;
    }
  }
  const escaped = chosen.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*chosen:/.test(line)) {
      const indent = /^\s*/.exec(line)?.[0] ?? '    ';
      lines[i] = `${indent}chosen: "${escaped}"`;
      return lines.join('\n');
    }
  }
  lines.splice(end, 0, `    chosen: "${escaped}"`);
  return lines.join('\n');
}

/** Append (or replace) the top-level `confirmation:` block that records who confirmed when. */
export function withConfirmation(text: string, by: string, at: string): string {
  const body = ['confirmation:', `  by: "${by.replace(/"/g, "'")}"`, `  at: "${at}"`, '  method: bounded-choice'].join('\n');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^confirmation:\s*$/.test(line));
  if (start === -1) return `${text.replace(/\s*$/, '')}\n\n${body}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...body.split('\n'), ...lines.slice(end)].join('\n');
}

/** Who is confirming: the repository's git identity, or the OS user. A name, not an identity. */
function confirmer(cwd: string): string {
  try {
    return execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' }).trim() || process.env['USER'] || 'unknown';
  } catch {
    return process.env['USER'] ?? 'unknown';
  }
}

/** `--flag value` or `--flag=value`, the two spellings this CLI accepts. */
function flagValue(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index !== -1) {
    const value = rest[index + 1];
    if (value !== undefined && !value.startsWith('--')) return value;
  }
  const inline = rest.find((arg) => arg.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

/** The line a human reads for one written-back failure. */
function describeFeedback(entry: FeedbackEntry): string {
  return `${entry.id} (run ${entry.run}): ${entry.checks.map((c) => c.split(' ')[0]).join(', ')}`;
}

/** The keyword that ends the questions early: everything unanswered is then listed as undecided. */
const DONE = 'done';
/** How many times the questions may come round again (ADR-036): a bounded number of rounds, not a loop. */
const MAX_ROUNDS = 3;

const RESOLVE_OPTION = 'the failure is addressed — mark it resolved';
const IMPL_CHANGES_OPTION = 'the recorded answer stands and the IMPLEMENTATION changes — mark it resolved';
const ANSWER_WRONG_OPTION = 'the answer was wrong — decide that decision again below';
// ADR-038: the third possibility, the one ADR-030 could not express — the failing CHECK is what is
// wrong, and neither the implementation nor the recorded answer is. It is worded to deny both of the
// other claims explicitly, and it is a CLAIM by the human, not a machine verdict.
const CHECK_AT_FAULT_OPTION = 'the CHECK was at fault — the implementation and the recorded answer were right — mark it resolved';
const LEAVE_OPEN_OPTION = 'leave it open';

async function ask(question: string, options: string[], fallback: string | undefined, io: ConfirmIO): Promise<string | null> {
  const out = io.out ?? ((line: string) => console.log(line));
  const input = io.input ?? process.stdin;
  return new Promise<string | null>((resolve) => {
    const rl = createInterface({ input: input as NodeJS.ReadableStream, output: process.stdout });
    out('');
    out(`  ${question}`);
    options.forEach((option, index) => {
      const marks = [option === fallback ? 'recommended' : '', option === options[0] ? '' : ''].filter(Boolean).join(' ');
      out(`    [${index + 1}] ${option}${marks ? `   (${marks})` : ''}`);
    });
    // The recommendation is a DEFAULT, and a default is an argument, not an absence: a human who presses
    // enter is accepting the intake's reasoning, so the reasoning has to be on screen (ADR-036).
    if (fallback !== undefined) {
      out(`    recommended: ${fallback}`);
      out('    [enter] take the recommendation   [yes] same   [s] leave undecided   [done] stop asking   [q] abort');
    } else out('    [s] leave undecided (only when this decision is not blocking)   [done] stop asking   [q] abort');
    rl.setPrompt('    > ');
    rl.prompt();
    rl.on('line', (line) => {
      const answer = line.trim();
      if (answer === 'q' || answer === 'quit') {
        rl.close();
        resolve(null);
        return;
      }
      if (answer === '') {
        if (fallback !== undefined) {
          rl.close();
          resolve(fallback);
          return;
        }
        out('    this decision is blocking: pick one of the numbers, or [q] to abort');
        rl.prompt();
        return;
      }
      if (answer === 'done') {
        rl.close();
        resolve(DONE);
        return;
      }
      if (answer === 's' || answer === 'skip') {
        rl.close();
        resolve('');
        return;
      }
      if ((answer === 'yes' || answer === 'y' || answer === 'recommended') && fallback !== undefined) {
        rl.close();
        resolve(fallback);
        return;
      }
      const index = Number.parseInt(answer, 10);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) {
        rl.close();
        resolve(options[index - 1] ?? '');
        return;
      }
      out(`    enter a number between 1 and ${options.length}${fallback === undefined ? ', [s] to leave undecided,' : ''} or [q] to abort`);
      rl.prompt();
    });
  });
}

/**
 * A required free-text note (ADR-038). The bounded choice names WHICH claim the human is making; the note
 * is where they state the BASIS for it. For "the check was at fault" that basis is the whole point — the
 * claim blames the verifier, so the record has to say why — and an empty note is refused here exactly as
 * `resolveFeedback` refuses it, so the new closure cannot become a way to wave a real failure through.
 */
async function askNote(question: string, io: ConfirmIO): Promise<string | null> {
  const out = io.out ?? ((line: string) => console.log(line));
  const input = io.input ?? process.stdin;
  return new Promise<string | null>((resolve) => {
    const rl = createInterface({ input: input as NodeJS.ReadableStream, output: process.stdout });
    out('');
    out(`  ${question}`);
    out('    Say what the check got wrong. A note is required: it is the basis for the claim, not decoration.');
    out('    [q] abort');
    rl.setPrompt('    > ');
    rl.prompt();
    rl.on('line', (line) => {
      const answer = line.trim();
      if (answer === 'q' || answer === 'quit') {
        rl.close();
        resolve(null);
        return;
      }
      if (answer.length === 0) {
        out('    a note is required: say what the check got wrong, or [q] to abort');
        rl.prompt();
        return;
      }
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * `takumi requirement confirm <ref> [--dry-run]`.
 *
 * Exit codes: 0 confirmed (a token was printed), 1 refused (non-interactive, an unanswered blocking
 * decision, or a document that could not be read/written), 2 aborted by the human.
 */
export async function runRequirementCommand(cwd: string, rest: string[], io: ConfirmIO = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const sub = rest[0] ?? '';
  const ref = rest[1] ?? '';
  const dryRun = rest.includes('--dry-run');

  if (sub === 'digest') {
    if (ref.length === 0) {
      out('usage: takumi requirement digest <ref>');
      return 1;
    }
    try {
      const token = requirementConfirmation(cwd, ref);
      out(token.ref);
      out(`sha256:${token.digest}`);
      return 0;
    } catch (e) {
      out(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }

  if (sub === 'brief') {
    // The intake's input (ADR-030), read-only: what each written-back failure is about, which decision
    // it exercises, what answer was recorded, and which answers the human could give instead. Nothing
    // here is generated by a model, so nothing here is a guess.
    if (ref.length === 0) {
      out('usage: takumi requirement brief <ref>');
      return 1;
    }
    let doc: RequirementDocument;
    try {
      doc = readRequirementDocument(cwd, ref);
    } catch (e) {
      out(e instanceof Error ? e.message : String(e));
      return 1;
    }
    out(renderFeedbackBrief(ref, doc.text).replace(/\n$/, ''));
    return 0;
  }

  if (sub === 'feedback') {
    // The read-only view of what the machine wrote back (ADR-029). It exits non-zero while a failure
    // is open, because that is the question this command answers: is there something here a human has
    // not dealt with?
    if (ref.length === 0) {
      out('usage: takumi requirement feedback <ref>');
      return 1;
    }
    let doc: RequirementDocument;
    try {
      doc = readRequirementDocument(cwd, ref);
    } catch (e) {
      out(e instanceof Error ? e.message : String(e));
      return 1;
    }
    const entries = parseFeedback(doc.text);
    const open = entries.filter((e) => e.status === 'open');
    if (entries.length === 0) {
      out(`${ref}: no acceptance failure has been written back into this document.`);
      return 0;
    }
    out(`${ref}: ${entries.length} feedback entr${entries.length === 1 ? 'y' : 'ies'}, ${open.length} open`);
    for (const entry of entries) {
      out(`  ${entry.id} [${entry.status}] ${entry.at}`);
      out(`    run: ${entry.run}`);
      out(`    judged: requirement ${entry.requirementDigest} by ${entry.judgeDigest}`);
      for (const check of entry.checks) out(`    failing: ${check}`);
      if (entry.status === 'resolved') {
        // ADR-038: name the closure kind too, so a reader can tell the three claims apart here as well.
        out(`    resolved by ${entry.resolvedBy ?? 'unknown'} at ${entry.resolvedAt ?? '?'} [${entry.resolvedKind ?? 'kind unrecorded'}]: ${entry.resolvedNote ?? ''}`);
      }
    }
    if (open.length > 0) {
      out(`refused: ${open.length} acceptance failure(s) are still open. Address them, then either re-confirm`);
      out(`  (takumi requirement confirm ${ref}) or record the resolution:`);
      out(`  takumi requirement resolve ${ref} --id ${open[0]?.id ?? 'FB-001'} --note "what addresses it"`);
      return 1;
    }
    return 0;
  }

  if (sub === 'resolve') {
    // The scriptable form of the closure `confirm` performs interactively. A resolution without a note
    // is refused: the note is the only record of WHY the failure is considered dealt with.
    if (ref.length === 0) {
      out('usage: takumi requirement resolve <ref> --id FB-001 --note "what addresses it"');
      return 1;
    }
    const id = flagValue(rest, '--id');
    const note = flagValue(rest, '--note');
    const kindFlag = flagValue(rest, '--kind');
    if (id === undefined || note === undefined) {
      out('usage: takumi requirement resolve <ref> --id FB-001 --note "what addresses it" [--kind implementation-changes|answer-wrong|check-at-fault|addressed]');
      return 1;
    }
    // ADR-038: the scriptable path may name the closure kind too; an unknown one is refused by name.
    if (kindFlag !== undefined && !(FEEDBACK_CLOSURE_KINDS as readonly string[]).includes(kindFlag)) {
      out(`refused: --kind "${kindFlag}" is not a closure kind (implemented: ${FEEDBACK_CLOSURE_KINDS.join(', ')})`);
      return 1;
    }
    const kind = kindFlag as FeedbackClosureKind | undefined;
    let doc: RequirementDocument;
    try {
      doc = readRequirementDocument(cwd, ref);
    } catch (e) {
      out(e instanceof Error ? e.message : String(e));
      return 1;
    }
    const resolved = resolveFeedback(doc.text, id, confirmer(cwd), note, new Date().toISOString(), kind === undefined ? {} : { kind });
    if (resolved.error !== undefined) {
      out(`refused: ${resolved.error}`);
      return 1;
    }
    try {
      parseYaml(resolved.text);
    } catch (e) {
      out(`refused: the resolved document would not be valid YAML (${e instanceof Error ? e.message : String(e)}); nothing was written`);
      return 1;
    }
    writeFileSync(doc.path, resolved.text, 'utf8');
    const token = requirementConfirmation(cwd, ref);
    out(`resolved: ${id} [${kind ?? 'kind unrecorded'}] — ${note}`);
    out('The document changed, so the confirmation token moved. Re-confirm it before the next run:');
    out(`  takumi requirement confirm ${ref}`);
    out(token.ref);
    out(`sha256:${token.digest}`);
    return 0;
  }

  if (sub !== 'confirm') {
    out('usage: takumi requirement confirm <ref> [--dry-run]   |   takumi requirement digest <ref>    |');
    out('       takumi requirement feedback <ref>              |   takumi requirement brief <ref>     |');
    out('       takumi requirement resolve <ref> --id FB-001 --note "…" [--kind check-at-fault]');
    return 1;
  }
  if (ref.length === 0) {
    out('usage: takumi requirement confirm <ref> [--dry-run]');
    return 1;
  }

  let doc: RequirementDocument;
  try {
    doc = readRequirementDocument(cwd, ref);
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  }
  // A revision (or a hand edit) that cites nothing is refused before anything is asked or written: the
  // intake's output has to be readable back, and `--dry-run` is where CI can see that it is not.
  const coherence = validateRequirementDocument(doc.text);
  if (coherence.length > 0) {
    out(`${ref}: the document does not hold together — ${coherence.length} issue(s):`);
    for (const issue of coherence) out(`  ${issue}`);
    out('Nothing was written. Fix the document first (a decision that came from a failure must name one).');
    return 1;
  }

  if (doc.ambiguities.length === 0) {
    out(`the requirement document ${ref} records no open decisions (no AMB-nnn entries).`);
    out('An intake with nothing undecided has nothing to confirm — approve the digest instead:');
    out(`  takumi requirement digest ${ref}`);
    return 1;
  }

  const undecided = doc.ambiguities.filter((a) => a.chosen === undefined && a.default === undefined);
  // ADR-029: the other thing that stops a document from being confirmable — an acceptance failure the
  // machine wrote back that nobody has dealt with.
  const openFeedback = parseFeedback(doc.text).filter((e) => e.status === 'open');
  if (dryRun) {
    out(`${ref}: ${doc.ambiguities.length} open decision(s)`);
    for (const a of doc.ambiguities) {
      const state = a.chosen ?? a.default;
      out(`  ${a.id}${a.blocking ? ' (blocking)' : ''}: ${a.question}`);
      out(`    ${state === undefined ? 'UNDECIDED' : `decided: ${state}`}   options: ${a.options.join(' | ')}`);
    }
    for (const entry of openFeedback) {
      out(`  ${describeFeedback(entry)}`);
    }
    if (undecided.length > 0) {
      out(`refused: ${undecided.length} blocking decision(s) have no default and no choice — a human must decide them`);
      return 1;
    }
    if (openFeedback.length > 0) {
      out(`refused: ${openFeedback.length} open acceptance failure(s) — re-confirm from a terminal to answer them`);
      return 1;
    }
    return 0;
  }

  const isTTY = ((io.input ?? process.stdin) as { isTTY?: boolean }).isTTY === true;
  if (!isTTY) {
    // The design's rule 2, enforced rather than documented: a confirmation that nobody read is not a
    // confirmation, and a pipeline must not be able to produce one.
    out('refused: a requirement confirmation must be interactive (stdin is not a TTY).');
    out('  In CI, use --dry-run to see what is still undecided; a human confirms from a terminal.');
    return 1;
  }

  out('');
  out(`Confirming ${ref} — ${doc.ambiguities.length} open decision(s). Nothing is written until the last one is answered.`);
  out('Each answer is written into the document itself, and the document\'s digest is the token the acceptance binds to.');

  // First the failures, then the decisions: a document carrying an unanswered failure cannot be
  // re-confirmed, and the human's number is what closes it (ADR-029).
  //
  // ADR-030 makes that number a CHOICE ABOUT WHICH SIDE IS WRONG. When the failing check exercises a
  // decision, the implementation may have ignored the recorded answer, or the answer itself may have been
  // wrong — and the machine cannot tell them apart (it has no semantics, only the check). ADR-038 adds the
  // third side: the CHECK itself may be at fault, which blames neither the implementation nor the human's
  // earlier answer. Naming the choice is what turns "addressed" into a statement a reviewer can read later.
  const analysis = analyseFeedback(doc.text);
  const resolvedOpen: { entry: FeedbackEntry; kind: FeedbackClosureKind; byDecision?: string; basis?: string }[] = [];
  const mustChange = new Map<string, string>();
  for (const entry of openFeedback) {
    // Several failing checks can exercise the SAME decision (REL-003 and the DEC-002 line that reports
    // on it): the human is answering the decision, once, so the decisions are deduped here.
    const mapped = [
      ...new Map(
        (analysis.find((a) => a.entry.id === entry.id)?.failures ?? [])
          .filter((f) => f.kind === 'decision-not-honoured' && f.decision !== undefined)
          .map((f) => [f.decision?.id ?? '', f]),
      ).values(),
    ];
    out('');
    out(`The last acceptance of this document FAILED and wrote ${entry.id} back into it (${entry.at}):`);
    for (const check of entry.checks) out(`  ${check}`);
    let options: string[];
    if (mapped.length === 0) {
      options = [RESOLVE_OPTION, LEAVE_OPEN_OPTION];
    } else {
      options = [IMPL_CHANGES_OPTION, ANSWER_WRONG_OPTION, CHECK_AT_FAULT_OPTION, LEAVE_OPEN_OPTION];
      out('');
      const named = mapped
        .map((f) => `${f.decision?.id}, currently answered \"${f.decision?.chosen ?? f.decision?.default ?? '(undecided)'}\"`)
        .join('; ');
      out(`  This failure is about ${named}.`);
      out('  Either the implementation ignored that answer, or the answer itself was wrong, or the check that failed is itself at fault.');
    }
    let answer = await ask(`${entry.id}: what settles this failure?`, options, LEAVE_OPEN_OPTION, io);
    while (answer === DONE) {
      // The failure is the machine's report that the last acceptance failed (ADR-029): it is not one of the
      // clarifications, so `done` cannot skip it — a token over a document with an open failure is the one
      // thing the black-box loop refuses to produce.
      out(`    ${entry.id} is an open acceptance failure, not a clarification: it has to be answered.`);
      answer = await ask(`${entry.id}: what settles this failure?`, options, LEAVE_OPEN_OPTION, io);
    }
    if (answer === null) {
      out('\naborted: nothing was written and no token was produced.');
      return 2;
    }
    if (answer === ANSWER_WRONG_OPTION) {
      for (const failure of mapped) {
        const decision = failure.decision;
        if (decision === undefined) continue;
        mustChange.set(decision.id, decision.chosen ?? decision.default ?? '');
      }
      resolvedOpen.push({ entry, kind: 'answer-wrong', byDecision: mapped[0]?.decision?.id });
      continue;
    }
    if (answer === CHECK_AT_FAULT_OPTION) {
      // ADR-038: the check is at fault, so the recorded answers stand and there is NOTHING to re-decide —
      // this branch deliberately does not touch `mustChange`, which is what makes the decision re-asked.
      // The claim is a human's, so it needs a stated basis: the note. An empty one is refused here, and
      // `resolveFeedback` refuses it again for the scriptable path, so this cannot wave a failure through.
      const basis = await askNote(`${entry.id}: what did the failing check get wrong?`, io);
      if (basis === null) {
        out('\naborted: nothing was written and no token was produced.');
        return 2;
      }
      resolvedOpen.push({ entry, kind: 'check-at-fault', basis });
      continue;
    }
    if (answer !== IMPL_CHANGES_OPTION && answer !== RESOLVE_OPTION) {
      out(`\nrefused: ${entry.id} is still open. A document with a known failure in it is not confirmable:`);
      out(`  fix what failed and re-confirm, or record a resolution and say what addresses it:`);
      out(`  takumi requirement resolve ${ref} --id ${entry.id} --note "what addresses it"`);
      return 1;
    }
    resolvedOpen.push({ entry, kind: answer === IMPL_CHANGES_OPTION ? 'implementation-changes' : 'addressed' });
  }

  const answers = new Map<string, string>();
  // The rounds (ADR-036): a decision is put to the human in a round; the answers from that round are read
  // back in the next one, and the loop stops as soon as nothing is open. A human who has answered enough can
  // say `done` — the summary then lists exactly what was left undecided, so the same information reaches the
  // confirmation line and the token as would have reached it by answering everything.
  let round = 0;
  let stoppedEarly = false;
  for (;;) {
    const effective = (a: { chosen?: string; default?: string }): string | undefined => a.chosen ?? a.default;
    // A decision is put again when it has no answer AND when the human said (about a failure) that the
    // answer itself was wrong: `mustChange` is that statement, and a decision marked for change is asked
    // about even though the document still carries the old `chosen` (ADR-030 + ADR-036).
    // Round 1 asks EVERY decision: a human confirming a document gets to look at every answer, including the
    // ones the intake defaulted. Later rounds only re-ask what is still unanswered — that is what makes the
    // loop converge instead of repeating the whole document (ADR-036).
    round += 1;
    const open = doc.ambiguities.filter(
      (a) =>
        (mustChange.has(a.id) && !answers.has(a.id)) ||
        round === 1 ||
        (answers.get(a.id) ?? effective(a)) === undefined,
    );
    if (open.length === 0) break;
    if (round > MAX_ROUNDS) {
      out(`refused: ${open.length} decision(s) are still open after ${MAX_ROUNDS} rounds — a document whose answers keep raising questions is a document to rewrite, not to confirm`);
      return 1;
    }
    out('');
    out(`round ${round} of at most ${MAX_ROUNDS} — ${open.length} decision(s) still open`);
    for (const ambiguity of open) {
      if (ambiguity.options.length === 0) {
        out(`refused: ${ambiguity.id} has no options, so there is nothing to choose between`);
        return 1;
      }
      const fallback = ambiguity.chosen ?? ambiguity.default;
      const answer = await ask(ambiguity.question || ambiguity.id, ambiguity.options, fallback, io);
      if (answer === null) {
        out('\naborted: nothing was written and no token was produced.');
        return 2;
      }
      if (answer === DONE) {
        stoppedEarly = true;
        break;
      }
      if (answer === '' && ambiguity.blocking) {
        out(`refused: ${ambiguity.id} is blocking and was left undecided`);
        return 1;
      }
      if (answer !== '') answers.set(ambiguity.id, answer);
      // ADR-030: refusing HERE rather than after the last question, because the claim is about this
      // decision and the human is looking at it right now.
      if (mustChange.has(ambiguity.id)) {
        const eff = answer === '' ? (ambiguity.chosen ?? ambiguity.default ?? '') : answer;
        if (eff === mustChange.get(ambiguity.id)) {
          out('');
          out(`refused: you answered that the answer was wrong, but ${ambiguity.id} still reads \"${eff}\" — nothing changed.`);
          out(`  Pick a different option for ${ambiguity.id}, or say that the implementation changes instead.`);
          return 1;
        }
      }
    }
    if (stoppedEarly) break;
  }

  let text = doc.text;
  const resolvedAt = new Date().toISOString();
  for (const { entry, kind, byDecision, basis } of resolvedOpen) {
    const note =
      kind === 'answer-wrong'
        ? `the answer was wrong: ${byDecision} was re-decided at this confirmation (${resolvedAt})`
        : kind === 'check-at-fault'
          ? `the check itself was at fault: ${basis} — a human's claim at re-confirmation, not a machine verdict (${resolvedAt})`
          : kind === 'addressed'
            ? `the failure is addressed (bounded choice at re-confirmation, ${resolvedAt})`
            : `the recorded answer stands; the implementation changes (bounded choice at re-confirmation, ${resolvedAt})`;
    const resolved = resolveFeedback(text, entry.id, confirmer(cwd), note, resolvedAt, {
      kind,
      ...(byDecision === undefined ? {} : { byDecision }),
    });
    if (resolved.error !== undefined) {
      out(`refused: ${resolved.error}`);
      return 1;
    }
    text = resolved.text;
  }
  for (const [id, chosen] of answers) {
    try {
      text = withChosen(text, id, chosen);
    } catch (e) {
      out(`refused: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  text = withConfirmation(text, confirmer(cwd), new Date().toISOString());

  // Validate before writing: a confirmation that corrupts the document is worse than a refusal.
  try {
    parseYaml(text);
  } catch (e) {
    out(`refused: the confirmed document would not be valid YAML (${e instanceof Error ? e.message : String(e)}); nothing was written`);
    return 1;
  }
  writeFileSync(doc.path, text, 'utf8');

  out('');
  const undecidedCount = doc.ambiguities.filter(
    (a) => (answers.get(a.id) ?? a.chosen ?? a.default) === undefined,
  ).length;
  out(`Confirmed decisions — a checklist a reviewer reads, not the machine (${doc.ambiguities.length - undecidedCount}/${doc.ambiguities.length} decided):`);
  for (const ambiguity of doc.ambiguities) {
    const chosen = answers.get(ambiguity.id) ?? ambiguity.chosen ?? ambiguity.default;
    out(`  ${chosen === undefined ? '[ ]' : '[x]'} ${ambiguity.id}: ${chosen ?? 'left undecided'}`);
  }
  if (undecidedCount > 0) {
    out('');
    out(`  ${undecidedCount} decision(s) were left UNDECIDED. A blocking decision cannot be: naming this`);
    out('  before the token is the point — the run binds to a document whose open questions are visible.');
  }
  const token = requirementConfirmation(cwd, ref);
  out('');
  out('The confirmation token for this document — pass it to a run:');
  out(token.ref);
  out(`sha256:${token.digest}`);
  return 0;
}
