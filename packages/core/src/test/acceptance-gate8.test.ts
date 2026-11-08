import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStepPrompt, renderPrompt, WorkflowStep } from '../index.js';

// Acceptance Gate 8 — Skill System actually drives behavior (Critical#2 fix).
// A step declaring `skill` must resolve its prompt from the skill's prompt
// template, not just brand the artifact folder.

function makeSkills(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  const skill = join(dir, 'jp-requirements');
  mkdirSync(join(skill, 'prompts'), { recursive: true });
  writeFileSync(
    join(skill, 'manifest.yaml'),
    'name: jp-requirements\nkind: skill\nversion: 0.1.0\nprompts:\n  analyze: prompts/analyze.md\n',
  );
  writeFileSync(join(skill, 'prompts', 'analyze.md'), '要件定義スキル: {input} を標準REQに変換せよ');
  return { dir };
}

test('Gate 8: step.skill resolves prompt from skill template (not just branding)', async () => {
  const s = makeSkills();
  try {
    const step: WorkflowStep = {
      id: 'requirements',
      type: 'agent',
      skill: 'jp-requirements',
      prompt: 'fallback inline prompt',
    };
    const prompt = await resolveStepPrompt(step, s.dir, { input: '社員管理' });
    // The resolved prompt comes from prompts/analyze.md template, not the
    // inline 'fallback inline prompt', with {input} substituted.
    assert.ok(prompt.includes('要件定義スキル'), 'should use the skill prompt template');
    assert.ok(prompt.includes('社員管理'), 'should substitute {input}');
    assert.ok(!prompt.includes('fallback inline prompt'), 'must not use the inline fallback when skill applies');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('Gate 8: skill without manifest/skill follows step.prompt fallback (never hangs)', async () => {
  const step: WorkflowStep = { id: 'x', type: 'agent', skill: 'nonexistent', prompt: 'plain {name}' };
  const out = await resolveStepPrompt(step, '/nonexistent', { name: 'takumi' });
  assert.equal(out, 'plain takumi');
});

test('renderPrompt: unknown placeholders left intact', () => {
  assert.equal(renderPrompt('keep {unknown}', {}), 'keep {unknown}');
});
// LEDGER #133 — a var name may contain DOTS.
//
// `{step.shape_decision}` is how one workflow step hands its own answer to the next; the engine stores
// it as `vars['step.shape_decision']`. `renderPrompt` substituted with `\w+`, which does NOT match a
// dot, so every such placeholder reached its consumer VERBATIM.
//
// Measured 2026-11-08: two real unattended runs died with "intake-repair: step 1 recorded no
// ANSWER_SHAPE" while step 1 had answered perfectly — the script was handed the literal text
// `{step.shape_decision}`. And because the engine deliberately leaves unknown keys intact (an unfilled
// placeholder should be visible, not blank), nothing threw: the failure surfaced three steps later,
// naming the wrong cause.
test('renderPrompt: a DOTTED placeholder is substituted', () => {
  assert.equal(
    renderPrompt('answer: {step.shape_decision}', { 'step.shape_decision': 'ANSWER_SHAPE: QUOTIENT' }),
    'answer: ANSWER_SHAPE: QUOTIENT',
  );
});

test('renderPrompt: dotted and plain placeholders resolve in one template', () => {
  const out = renderPrompt(
    '{requirement} says {step.shape_decision}',
    { requirement: 'docs/requirements/intake.yaml', 'step.shape_decision': 'QUOTIENT' },
  );
  assert.equal(out, 'docs/requirements/intake.yaml says QUOTIENT');
});

test('renderPrompt: an unknown DOTTED key is still left intact', () => {
  // The deliberate behaviour must survive the widening: a placeholder nobody filled stays visible.
  assert.equal(renderPrompt('keep {step.nobody}', {}), 'keep {step.nobody}');
});
