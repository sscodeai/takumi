import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
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

async function ask(question: string, options: string[], fallback: string | undefined, io: ConfirmIO): Promise<string | null> {
  const out = io.out ?? ((line: string) => console.log(line));
  const input = io.input ?? process.stdin;
  return new Promise<string | null>((resolve) => {
    const rl = createInterface({ input: input as NodeJS.ReadableStream, output: process.stdout });
    out('');
    out(`  ${question}`);
    options.forEach((option, index) => {
      const marks = [option === fallback ? 'current' : '', option === options[0] ? '' : ''].filter(Boolean).join(' ');
      out(`    [${index + 1}] ${option}${marks ? `   (${marks})` : ''}`);
    });
    if (fallback !== undefined) out('    [enter] keep the current/default choice      [q] abort');
    else out('    [s] leave undecided (only when this decision is not blocking)   [q] abort');
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
      if (answer === 's' || answer === 'skip') {
        rl.close();
        resolve('');
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

  if (sub !== 'confirm') {
    out('usage: takumi requirement confirm <ref> [--dry-run]   |   takumi requirement digest <ref>');
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
  if (doc.ambiguities.length === 0) {
    out(`the requirement document ${ref} records no open decisions (no AMB-nnn entries).`);
    out('An intake with nothing undecided has nothing to confirm — approve the digest instead:');
    out(`  takumi requirement digest ${ref}`);
    return 1;
  }

  const undecided = doc.ambiguities.filter((a) => a.chosen === undefined && a.default === undefined);
  if (dryRun) {
    out(`${ref}: ${doc.ambiguities.length} open decision(s)`);
    for (const a of doc.ambiguities) {
      const state = a.chosen ?? a.default;
      out(`  ${a.id}${a.blocking ? ' (blocking)' : ''}: ${a.question}`);
      out(`    ${state === undefined ? 'UNDECIDED' : `decided: ${state}`}   options: ${a.options.join(' | ')}`);
    }
    if (undecided.length > 0) {
      out(`refused: ${undecided.length} blocking decision(s) have no default and no choice — a human must decide them`);
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

  const answers = new Map<string, string>();
  for (const ambiguity of doc.ambiguities) {
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
    if (answer === '' && ambiguity.blocking) {
      out(`refused: ${ambiguity.id} is blocking and was left undecided`);
      return 1;
    }
    if (answer !== '') answers.set(ambiguity.id, answer);
  }

  let text = doc.text;
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
  out('Confirmed decisions (each written into the document):');
  for (const ambiguity of doc.ambiguities) {
    const chosen = answers.get(ambiguity.id) ?? ambiguity.chosen ?? ambiguity.default;
    out(`  ${chosen === undefined ? 'UNDECIDED' : 'x'} ${ambiguity.id}: ${chosen ?? '(left undecided)'}`);
  }
  const token = requirementConfirmation(cwd, ref);
  out('');
  out('The confirmation token for this document — pass it to a run:');
  out(token.ref);
  out(`sha256:${token.digest}`);
  return 0;
}
