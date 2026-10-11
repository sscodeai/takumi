/**
 * THE OPERATOR'S DECISION (2026-10-11): a GREEN delivery lands itself.
 *
 * Moon's answer to "when all the checks are green, merge" is not a new mechanism — the mechanism is
 * already in `request-to-delivery/workflow.yaml` and is asserted elsewhere: `merge` declares
 * `dependsOn: [await_checks]`, so a red or still-pending host pipeline SKIPS the landing structurally
 * (`packages/core/src/test/merge-step.test.ts`, 'when await_checks fails, the merge step is SKIPPED'),
 * and a green one merges the head the acceptance judged, unchanged (`merge: the accepted head is
 * merged…`, ADR-040). The run at 2026-10-11 07:50 is the live evidence: `await_checks` 4/4 on the
 * published head, then `merge`, with no person in the loop.
 *
 * What this file pins is the DECISION, because a decision nobody can read is a decision a later
 * commit can silently reverse — and because the way to reverse it is a field that READS like a gate
 * and is read by NOTHING. A `merge` step declaring `requiresApproval: true` is dead text that a
 * reader takes for a human gate: the same defect class as `deliverable.build` / `deliverable.tests`
 * (docs/bugs-fixed.md #54), where a declaration that is never executed reads as compliance. So the
 * gate a human may declare is the PILOT's `reviewMode: 'label'` (a board-driven wait, recorded as
 * `awaiting_review`), never a key on a step; and a step that declares one is refused BY NAME.
 *
 * The counterpart is deliberately NOT relaxed: a FAILED check still stops the run and asks a person.
 * "Green lands itself" is a statement about the green path, not a licence for a machine to close its
 * own failing check (ADR-045, ADR-038: a machine never declares `answer-wrong` / `check-at-fault`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { validateWorkflowManifest, type WorkflowDefinition, type WorkflowStep } from '../workflow.js';

/** The keys that read as a gate a person must pass. None of them is a field of a workflow step. */
const APPROVAL_KEYS: readonly string[] = [
  'requiresApproval',
  'requiresHuman',
  'approval',
  'approvalLabel',
  'approvedBy',
  'human',
  'awaitingHuman',
  'requireReview',
];

function realManifest(name: string): WorkflowDefinition {
  const url = new URL(`../../../../extensions/workflows/${name}/workflow.yaml`, import.meta.url);
  return parseYaml(readFileSync(url, 'utf8')) as WorkflowDefinition;
}

function stepsOf(def: WorkflowDefinition): WorkflowStep[] {
  return (def.steps ?? []) as WorkflowStep[];
}

// ---------------------------------------------------------------------------------------------
// (a) the real manifest: nothing to approve, and the landing waits on the host's own pipeline
// ---------------------------------------------------------------------------------------------

test('green lands itself: the REAL request-to-delivery manifest declares no approval, and merge waits on await_checks', () => {
  const def = realManifest('request-to-delivery');

  // The manifest the self-driving path actually runs must be clean by its own reader.
  assert.deepEqual(validateWorkflowManifest(def), [], 'the shipped manifest passes its own validator');

  const merge = stepsOf(def).find((s) => s.type === 'merge');
  assert.ok(merge, 'the real manifest has a merge step');
  assert.ok(
    (merge.dependsOn ?? []).includes('await_checks'),
    'the merge depends on await_checks: a red or pending pipeline skips the landing structurally',
  );

  // Nothing in the real chain reads an approval, so nothing in it may READ like one either.
  for (const step of stepsOf(def)) {
    const declared = Object.keys(step).filter((k) => APPROVAL_KEYS.includes(k));
    assert.deepEqual(declared, [], `step ${step.id} declares no key that reads as a human gate`);
  }

  // ADR-040: the ONLY thing a merge step declares is its method — neither the ref nor the head is a
  // field, because both come from the run. An approval key would be a third kind of field.
  const mergeKeys = Object.keys(merge).filter((k) => k !== 'id' && k !== 'type' && k !== 'dependsOn');
  assert.deepEqual(mergeKeys, ['mergeMethod'], 'a merge step declares its method and nothing else');
});

// ---------------------------------------------------------------------------------------------
// (b) the refusal: a step that declares an approval gate is refused BY NAME
// ---------------------------------------------------------------------------------------------

test('green lands itself: a step declaring an approval gate is REFUSED by name (dead text reads as compliance)', () => {
  const def: WorkflowDefinition = {
    name: 'a-merge-behind-a-person',
    version: '0.0.1',
    description: '',
    steps: [
      { id: 'await_checks', type: 'await_checks', waitSeconds: 300 },
      { id: 'merge', type: 'merge', mergeMethod: 'merge', dependsOn: ['await_checks'], requiresApproval: true } as WorkflowStep,
    ],
  };

  const issues = validateWorkflowManifest(def);
  const refusal = issues.find((i) => i.stepId === 'merge');
  assert.ok(refusal, `the step is refused, not ignored (issues: ${JSON.stringify(issues)})`);
  assert.match(refusal.message, /requiresApproval/);
  assert.match(
    refusal.message,
    /read by nothing|nothing in the chain reads/i,
    'the refusal says the field is read by nothing, which is why it is worse than a refusal to keep it',
  );
  assert.match(
    refusal.message,
    /await_checks|green/i,
    'the refusal names the gate that actually unlocks a landing, so the reader knows where the gate lives',
  );
});

test('green lands itself: every spelling of a human gate on a step is refused by name', () => {
  for (const key of ['requiresHuman', 'approval', 'approvalLabel', 'approvedBy', 'human', 'awaitingHuman']) {
    const def = {
      name: `a-${key}`,
      steps: [{ id: 'merge', type: 'merge', dependsOn: ['await_checks'], [key]: true }],
    } as unknown as WorkflowDefinition;
    const issues = validateWorkflowManifest(def);
    assert.ok(
      issues.some((i) => i.message.includes(key)),
      `"${key}" is refused by name (issues: ${JSON.stringify(issues.map((i) => i.message))})`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// (c) the counterpart is NOT relaxed: a green gate is the only thing that lands a change
// ---------------------------------------------------------------------------------------------

test('green lands itself: the merge step is the only step that lands a change, and it is the one gated on the pipeline', () => {
  const def = realManifest('request-to-delivery');
  const landings = stepsOf(def).filter((s) => s.type === 'merge');
  assert.equal(landings.length, 1, 'exactly one step lands a change');

  // Every step that could land a change waits on the checks. There is no second landing path that
  // skips the green gate — the decision is only defensible if the gate is unavoidable.
  for (const step of landings) {
    assert.ok(
      (step.dependsOn ?? []).includes('await_checks'),
      `step ${step.id} cannot land a change on a pipeline that did not go green`,
    );
  }
});
