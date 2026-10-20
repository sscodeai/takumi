import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirementDigest } from '../review-digest.js';
import { buildSandboxPolicy } from '../sandbox-policy.js';
import { UnshareSandbox, sandboxCapability } from '../sandbox-unshare.js';

// S4 (ADR-058): the boundary is proved against the REAL harness, not a stub.
//
// The plan's A10: the real metamorphic judge forge reports `JUDGE_FORGE: ok`
// inside the boundary, the judge it writes runs there, and the delivered
// worktree's own `run-tests.sh` runs there — all with the host paths a real run
// uses, so the boundary must keep absolute paths mirrored.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FORGE = path.join(REPO, 'extensions/judges/metamorphic-forge.sh');
const FIXTURE_WORKTREE = path.join(REPO, '.takumi/worktrees/takumi-run-20261006T001959616Z-18dc560a');
const REQUIREMENT_REF = 'docs/requirements/intake.yaml';

const SCRATCH_ROOT = path.join(homedir(), '.cache', 'takumi-sandbox-tests');

function scratchProject(): { root: string; cleanup(): void } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(SCRATCH_ROOT, 'real-boundary-'));
  mkdirSync(path.join(root, 'extensions/judges'), { recursive: true });
  mkdirSync(path.join(root, 'docs/requirements'), { recursive: true });
  cpSync(FORGE, path.join(root, 'extensions/judges/metamorphic-forge.sh'));
  cpSync(path.join(FIXTURE_WORKTREE, REQUIREMENT_REF), path.join(root, REQUIREMENT_REF));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('real boundary (A10): the real forge, the forged judge, and the delivered run-tests.sh run inside', async (t) => {
  const capability = await sandboxCapability();
  if (!capability.available) {
    t.skip(`the boundary cannot be established on this host: ${capability.reason ?? 'unknown'}`);
    return;
  }
  if (!existsSync(FORGE) || !existsSync(FIXTURE_WORKTREE)) {
    t.skip('the real forge or the fixture worktree is not present in this checkout');
    return;
  }

  const project = scratchProject();
  const runId = 'wf-real-boundary';
  const stepId = 'accept';
  const judgeRoot = path.join(project.root, '.takumi/acceptance', runId);
  const judgeDir = path.join(judgeRoot, stepId);
  mkdirSync(judgeDir, { recursive: true });

  const requirementText = readFileSync(path.join(project.root, REQUIREMENT_REF), 'utf8');
  const policy = buildSandboxPolicy({
    projectRoot: project.root,
    worktree: FIXTURE_WORKTREE,
    judgeDir: judgeRoot,
    runId,
    staged: [
      { ref: REQUIREMENT_REF, hostPath: path.join(project.root, REQUIREMENT_REF) },
      { ref: 'extensions/judges/metamorphic-forge.sh', hostPath: FORGE },
    ],
  });
  const sandbox = new UnshareSandbox(policy);
  try {
    // 1. The real forge writes the judge inside the boundary.
    const forge = await sandbox.runStep({
      argv: ['bash', path.join(project.root, 'extensions/judges/metamorphic-forge.sh')],
      cwd: judgeDir,
      env: {
        TAKUMI_REQUIREMENT: REQUIREMENT_REF,
        TAKUMI_REQUIREMENT_DIGEST: `sha256:${requirementDigest(requirementText)}`,
        TAKUMI_WORKTREE: FIXTURE_WORKTREE,
        TAKUMI_PROJECT: project.root,
        TAKUMI_JUDGE_DIR: judgeDir,
      },
      timeoutMs: 120_000,
    });
    assert.equal(forge.code, 0, `the real forge must succeed inside the boundary:\n${forge.stdout}\n${forge.stderr}`);
    assert.match(forge.stdout, /^\s*JUDGE_FORGE\s*[:=]\s*ok\s*$/im, `no JUDGE_FORGE: ok marker:\n${forge.stdout}`);
    const declared = /^\s*JUDGE_PATH\s*[:=]\s*(.+?)\s*$/im.exec(forge.stdout)?.[1]?.replace(/^[*`"']|[*`"']$/g, '');
    assert.ok(declared !== undefined && declared.length > 0, 'the forge declared no JUDGE_PATH');
    const judgePath = path.isAbsolute(declared as string) ? (declared as string) : path.resolve(judgeDir, declared as string);
    assert.ok(existsSync(judgePath), 'the forged judge exists on the host at the declared path');

    // 2. The forged judge runs inside the boundary and reaches the worktree.
    const accept = await sandbox.runStep({
      argv: ['bash', judgePath],
      cwd: path.dirname(judgePath),
      env: {
        TAKUMI_WORKTREE: FIXTURE_WORKTREE,
        TAKUMI_PROJECT: project.root,
        TAKUMI_JUDGE_DIR: path.dirname(judgePath as string),
      },
      timeoutMs: 180_000,
    });
    assert.equal(accept.code, 0, `the forged judge must exit 0:\n${accept.stdout.slice(-2000)}\n${accept.stderr.slice(-2000)}`);
    assert.match(accept.stdout, /^\s*ACCEPT_VERDICT\s*[:=]\s*pass\s*$/im, `the judge must pass the fixture delivery:\n${accept.stdout.slice(-2000)}`);

    // 3. The delivered worktree's own suite runs inside the boundary.
    const tests = await sandbox.runStep({
      argv: ['bash', 'run-tests.sh'],
      cwd: FIXTURE_WORKTREE,
      timeoutMs: 180_000,
    });
    assert.equal(tests.code, 0, `run-tests.sh must pass inside the boundary:\n${tests.stdout.slice(-2000)}\n${tests.stderr.slice(-2000)}`);
  } finally {
    await sandbox.close();
    project.cleanup();
  }
});
