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