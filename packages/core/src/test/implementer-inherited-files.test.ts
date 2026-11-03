import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { WorkflowDefinition } from '../workflow.js';

/**
 * LEDGER #114 — a delivery based on a busy `main` must not build on the PREVIOUS request's work.
 *
 * Measured 2026-10-29 (`wf-77e08360`): a request for a per-suite pass PERCENTAGE (document:
 * `suite:id,passed:measure,total:other`) produced an implementation whose own docstring described
 * `region,amount` — the input of an earlier request. The worktree is based on the delivery
 * repository's `main`, and `sscodeai/takumi-delivery-demo`'s main already held eight prior runs
 * (PR #56–#70), every one of them writing the same `docs/requirements/intake.yaml` and `summary.py`.
 * The implementer found `summary.py` already there and CONTINUED it.
 *
 * The judge refused the delivery — `nothing in its output matched a declared output shape` — so
 * nothing incorrect landed. But the run was spent, and the prompt that caused it said nothing at all
 * about files it did not write.
 *
 * Two ways to close this were considered. "Use a clean repository per request" is a configuration
 * that the operator controls and this code cannot promise; "tell the implementer what an inherited
 * file means" is a behaviour this repository can hold itself to, and it is the one that also helps
 * when a human legitimately reuses a repository. So the implementer is told, and the manifest pins it.
 */

const ATTEMPT = new URL(
  '../../../../extensions/workflows/request-to-delivery-attempt/workflow.yaml',
  import.meta.url,
);

function implementerPrompt(): string {
  const def = parseYaml(readFileSync(ATTEMPT, 'utf8')) as WorkflowDefinition;
  const impl = (def.steps ?? []).find((s) => s.id === 'implementation');
  assert.ok(impl, 'the attempt declares an implementation step');
  return String(impl?.prompt ?? '');
}

test('the implementer is told the worktree may already hold another request\'s work', () => {
  const prompt = implementerPrompt();
  assert.match(
    prompt,
    /another request|a previous request|previous run/i,
    'the prompt names the situation, or the implementer has no reason to suspect it',
  );
});

test('and is told what to DO about it: replace, do not extend', () => {
  const prompt = implementerPrompt();
  // The failure mode was CONTINUING an inherited file. The instruction must be about the file this
  // requirement does not ask for, not merely a warning that files exist.
  assert.match(prompt, /replace/i, 'the word that contradicts "continue"');
  assert.match(
    prompt,
    /the requirement (document )?(does not|never)/i,
    'the test is whether the requirement asks for it, stated as such',
  );
});

test('and is told to check the document\'s declared input, not the file it found', () => {
  // The concrete failure: the docstring described `region,amount` because the file did. An
  // implementer that reads the document's `input_format.columns` cannot make that mistake.
  const prompt = implementerPrompt();
  assert.match(prompt, /input_format/, 'it points at the declared input world by name');
  assert.match(
    prompt,
    /do not (assume|trust|infer)|never (assume|trust|infer)/i,
    'and forbids inferring the input from what is already on disk',
  );
});

test('the instruction does not tell the implementer to delete files it did not create', () => {
  // "Replace" must not become "clean the directory": a human may reuse a repository on purpose, and
  // an implementer that deletes unreviewed files is worse than one that leaves them.
  const prompt = implementerPrompt();
  assert.doesNotMatch(
    prompt,
    /delete (every|all|any) (file|files)|wipe|rm -rf|clear the (directory|worktree)/i,
    'no instruction to destructively clean a repository the operator chose',
  );
});
