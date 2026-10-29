import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { WorkflowDefinition } from '../workflow.js';

/**
 * LEDGER #106 — every gate can pass and publish still refuse.
 *
 * Measured 2026-10-29 on `wf-a46dd47e` (the `ratio` sample of the intake rate measurement):
 *
 *   ci_config            wrote .github/workflows/ci.yml            (uncommitted)
 *   implementation       committed its own files, left that one
 *   quality_gate         PASSED (0 failing)   <- runs tests, never reads git status
 *   rule_review          passed
 *   judge_forge          forged
 *   artifact_acceptance  PASSED 4/4
 *   publish              REFUSED: "the worktree has uncommitted changes;
 *                                 the runner never commits them"
 *
 * A whole implementation, a forged judge and a full acceptance were spent proving a delivery that a
 * `git status` would have caught in the first second. The rule publish enforces is right — the
 * agent's boundary IS the commit, so the runner must never `git add -A` — it was simply checked in
 * the most expensive possible place.
 */

const ATTEMPT = new URL('../../../../extensions/workflows/request-to-delivery-attempt/workflow.yaml', import.meta.url);

function attemptWorkflow(): WorkflowDefinition {
  return parseYaml(readFileSync(ATTEMPT, 'utf8')) as WorkflowDefinition;
}

test('the attempt checks the worktree is clean, and does it BEFORE the expensive gates', () => {
  const def = attemptWorkflow();
  const steps = def.steps ?? [];
  const clean = steps.find((s) => s.id === 'worktree_clean');
  assert.ok(clean, 'the attempt has a worktree_clean step, or an uncommitted file is found at publish');

  const order = steps.map((s) => s.id);
  const at = (id: string) => order.indexOf(id);

  assert.ok(at('worktree_clean') > at('quality_gate'), 'it runs after the tests it is not a substitute for');
  assert.ok(
    at('worktree_clean') < at('rule_review'),
    'and before every gate that spends a judge or an acceptance on a delivery that cannot be pushed',
  );
  assert.ok(at('worktree_clean') < at('judge_forge'), 'forging a judge is the expensive part');
  assert.ok(at('worktree_clean') < at('artifact_acceptance'), 'and acceptance is the other one');
});

test('the clean check FAILS on a leftover file, and names every one of them', () => {
  const def = attemptWorkflow();
  const clean = (def.steps ?? []).find((s) => s.id === 'worktree_clean');
  assert.ok(clean);
  assert.equal(clean?.type, 'tool', 'it is a shell step: nothing here needs a model');

  const script = String(clean?.prompt ?? '');
  assert.match(script, /git status --porcelain/, 'it reads the real status, not a marker file');
  assert.match(script, /exit 1/, 'a leftover fails the step');
  // The point of listing ALL of them: the repair round is told the whole list, not one path per round.
  assert.match(script, /printf '%s\\n' "\$left"/, 'it prints the full porcelain, not a first entry');
  assert.doesNotMatch(
    script,
    /git add -A|git commit/,
    'it must NEVER commit for the agent: the boundary is the agent\'s commit, and a runner that commits is a runner that launders an unfinished attempt',
  );
});

test('the clean check runs in the DELIVERY worktree, which is what publish will look at', () => {
  // The engine runs `tool` steps with `cwd: ctx.worktree ?? ctx.cwd`; asserting the step's
  // dependencies is the manifest-side half of that. If this step ever grew a `cwd` of its own it
  // would read takumi's tree and pass while the delivery worktree is filthy.
  const def = attemptWorkflow();
  const clean = (def.steps ?? []).find((s) => s.id === 'worktree_clean');
  assert.ok(clean);
  assert.equal((clean as { cwd?: string }).cwd, undefined, 'no cwd override: it inherits the worktree');
});
