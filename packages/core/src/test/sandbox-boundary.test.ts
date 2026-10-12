import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { NoopSandbox } from '../sandbox-docker.js';
import {
  SANDBOX_REFUSED_CODE,
  UnshareSandbox,
  sandboxCapability,
  sandboxSelfTest,
} from '../sandbox-unshare.js';
import { buildSandboxPolicy, shQuote } from '../sandbox-policy.js';
import type { SandboxPolicyInput } from '../sandbox-policy.js';
import type { SandboxPolicy, StepSandboxRequest } from '../sandbox.js';

// The boundary itself, measured on a live namespace. Every assertion here is a
// property of the real mechanism; when the host cannot grant one the suite
// skips with a named reason rather than reporting a green it did not measure.
//
// Anti-vacuity: the assertions that could pass for the wrong reason are paired
// with the same command through NoopSandbox, which is the unsandboxed default.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Scratch {
  base: string;
  projectRoot: string;
  worktree: string;
  sibling: string;
  runId: string;
  judgeDir: string;
  cleanup(): void;
}

/**
 * Where the fixtures live. It must be OUTSIDE the paths the boundary mounts as
 * a private tmpfs (`/tmp`, `/var/tmp`, `/dev/shm` — guard G4): a project root
 * under one of those is shadowed by the boundary's own scratch tmpfs, so the
 * fixture would silently stop measuring the read-only mirror.
 */
const SCRATCH_ROOT =
  process.env.TAKUMI_SANDBOX_TEST_DIR ?? path.join(homedir(), '.cache', 'takumi-sandbox-tests');

function makeScratch(): Scratch {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const base = mkdtempSync(path.join(SCRATCH_ROOT, 'sbx-'));
  const projectRoot = path.join(base, 'platform');
  const worktree = path.join(base, 'worktree');
  const sibling = path.join(base, 'sibling');
  const runId = 'run-boundary';
  const judgeDir = path.join(projectRoot, '.takumi', 'acceptance', runId, 'step-1');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  mkdirSync(judgeDir, { recursive: true });
  mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"platform"}\n');
  writeFileSync(path.join(projectRoot, 'docs', 'secret.md'), 'platform secret\n');
  return {
    base,
    projectRoot,
    worktree,
    sibling,
    runId,
    judgeDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function policyFor(scratch: Scratch, overrides: Partial<SandboxPolicyInput> = {}): SandboxPolicy {
  return buildSandboxPolicy({
    projectRoot: scratch.projectRoot,
    worktree: scratch.worktree,
    judgeDir: scratch.judgeDir,
    runId: scratch.runId,
    ...overrides,
  });
}

/** A policy with no judge directory: the project root stays completely empty. */
function barePolicyFor(scratch: Scratch, overrides: Partial<SandboxPolicyInput> = {}): SandboxPolicy {
  return buildSandboxPolicy({
    projectRoot: scratch.projectRoot,
    worktree: scratch.worktree,
    ...overrides,
  });
}

async function boundaryOrSkip(t: { skip(reason: string): void }): Promise<boolean> {
  const capability = await sandboxCapability();
  if (capability.available) return true;
  t.skip(`the boundary cannot be established on this host: ${capability.reason ?? 'unknown'}`);
  return false;
}

function run(sandbox: UnshareSandbox, req: StepSandboxRequest) {
  return sandbox.runStep(req);
}

// ---------------------------------------------------------------------------
// A1 — a write outside the read-write roots is denied
// ---------------------------------------------------------------------------

test('boundary (A1): a write outside the read-write roots is denied, and lands without a boundary', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const outside = path.join(scratch.projectRoot, 'outside.txt');
    const command = `echo leaked > ${shQuote(outside)}; echo write_rc=$?`;

    // Non-vacuity: the unsandboxed default runs the very same command and the
    // write lands, so the denial below is the boundary's doing.
    const noop = new NoopSandbox();
    const unconfined = await noop.run(scratch.worktree, command);
    assert.equal(unconfined.code, 0);
    assert.ok(existsSync(outside), 'without a boundary the write must succeed');
    rmSync(outside, { force: true });

    const sandbox = new UnshareSandbox(policyFor(scratch));
    const result = await run(sandbox, { shell: command, cwd: scratch.worktree });
    assert.match(result.stdout, /write_rc=[1-9]/, `the write must be denied: ${result.stdout}${result.stderr}`);
    assert.equal(existsSync(outside), false, 'nothing may land outside the write roots');

    // The worktree itself IS writable: the boundary constrains, it does not break.
    const write = await run(sandbox, { shell: `echo ok > ${shQuote(path.join(scratch.worktree, 'in.txt'))} && echo ok`, cwd: scratch.worktree });
    assert.equal(write.code, 0);
    assert.ok(existsSync(path.join(scratch.worktree, 'in.txt')));
  } finally {
    scratch.cleanup();
  }
});

test('boundary (A1): a write to a sibling directory is denied', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const leak = path.join(scratch.sibling, 'leak.txt');
    const sandbox = new UnshareSandbox(policyFor(scratch));
    const result = await run(sandbox, { shell: `echo x > ${shQuote(leak)}; echo rc=$?`, cwd: scratch.worktree });
    assert.match(result.stdout, /rc=[1-9]/);
    assert.equal(existsSync(leak), false);
  } finally {
    scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A2 — the platform repository is invisible
// ---------------------------------------------------------------------------

test('boundary (A2): the platform repository is invisible and unwritable inside', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const sentinel = path.join(scratch.projectRoot, 'package.json');
    const command =
      `test -e ${shQuote(sentinel)} && echo sentinel=visible || echo sentinel=hidden; ` +
      `echo files=$(ls -A ${shQuote(scratch.projectRoot)} | wc -l); ` +
      `echo docs=$(test -e ${shQuote(path.join(scratch.projectRoot, 'docs'))} && echo visible || echo hidden); ` +
      `touch ${shQuote(path.join(scratch.projectRoot, 'evil'))} 2>/dev/null; echo touch_rc=$?`;

    const noop = new NoopSandbox();
    const unconfined = await noop.run(scratch.worktree, command);
    assert.match(unconfined.stdout, /sentinel=visible/, 'non-vacuity: the sentinel is a real file');
    rmSync(path.join(scratch.projectRoot, 'evil'), { force: true });

    const sandbox = new UnshareSandbox(barePolicyFor(scratch));
    const result = await run(sandbox, { shell: command, cwd: scratch.worktree });
    assert.match(result.stdout, /sentinel=hidden/, 'the platform repository must not be reachable');
    assert.match(result.stdout, /docs=hidden/);
    assert.match(result.stdout, /files=0/, 'the project root is an empty directory inside the boundary');
    assert.match(result.stdout, /touch_rc=[1-9]/, 'the read-only root must refuse the write');
    assert.equal(existsSync(path.join(scratch.projectRoot, 'evil')), false);
  } finally {
    scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A3 — the requirement document is readable, read-only, and alone
// ---------------------------------------------------------------------------

test('boundary (G2): this run\u2019s judge directory is writable and the rest of .takumi is not', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    mkdirSync(path.join(scratch.projectRoot, '.takumi', 'worktrees', 'other-run'), { recursive: true });
    writeFileSync(path.join(scratch.projectRoot, '.takumi', 'worktrees', 'other-run', 'secret.txt'), 'x\n');
    const sandbox = new UnshareSandbox(policyFor(scratch));
    const judgeFile = path.join(scratch.judgeDir, 'judge.sh');
    const result = await run(sandbox, {
      shell:
        `echo ok > ${shQuote(judgeFile)}; echo judge_rc=$?; ` +
        `touch ${shQuote(path.join(scratch.projectRoot, '.takumi', 'evil'))} 2>/dev/null; echo takumi_rc=$?; ` +
        `echo worktrees=$(test -e ${shQuote(path.join(scratch.projectRoot, '.takumi', 'worktrees'))} && echo visible || echo hidden)`,
      cwd: scratch.worktree,
    });
    assert.match(result.stdout, /judge_rc=0/, `the judge directory is the run\u2019s own: ${result.stdout}`);
    assert.match(result.stdout, /takumi_rc=[1-9]/, 'the rest of .takumi is not writable');
    assert.match(result.stdout, /worktrees=hidden/, 'another run\u2019s worktree is not reachable');
    assert.ok(existsSync(judgeFile));
  } finally {
    scratch.cleanup();
  }
});

test('boundary (A3): a staged requirement is readable read-only, and nothing else is', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const requirement = path.join(scratch.projectRoot, 'requirement.md');
    writeFileSync(requirement, 'REQUIREMENT-BODY-42\n');
    const sandbox = new UnshareSandbox(
      barePolicyFor(scratch, { staged: [{ ref: 'requirement.md', hostPath: requirement }] }),
    );
    const result = await run(sandbox, {
      shell:
        `echo body=$(cat ${shQuote(path.join(scratch.projectRoot, 'requirement.md'))}); ` +
        `echo files=$(ls -A ${shQuote(scratch.projectRoot)} | tr '\\n' ','); ` +
        `echo docs=$(test -e ${shQuote(path.join(scratch.projectRoot, 'docs'))} && echo visible || echo hidden); ` +
        `echo modified >> ${shQuote(path.join(scratch.projectRoot, 'requirement.md'))} 2>/dev/null; echo write_rc=$?`,
      cwd: scratch.worktree,
    });
    assert.match(result.stdout, /body=REQUIREMENT-BODY-42/);
    assert.match(result.stdout, /files=requirement\.md,/);
    assert.match(result.stdout, /docs=hidden/);
    assert.match(result.stdout, /write_rc=[1-9]/, 'the staged copy is read-only');
    assert.equal(readFileSync(requirement, 'utf8'), 'REQUIREMENT-BODY-42\n', 'the host original is untouched');
  } finally {
    scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A4 — no external network, loopback up
// ---------------------------------------------------------------------------
test('boundary (A4): no external network inside the step, loopback up', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const command =
      `timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null; echo net_rc=$?; ` +
      `ip link show lo 2>/dev/null | head -1; ip route 2>/dev/null | wc -l`;
    const sandbox = new UnshareSandbox(policyFor(scratch));
    const result = await run(sandbox, { shell: command, cwd: scratch.worktree });
    assert.match(result.stdout, /net_rc=[1-9]/, `1.1.1.1:443 must be unreachable: ${result.stdout}`);
    assert.match(result.stdout, /LOOPBACK,UP/, 'loopback must be up for service-shaped judges');

    // Non-vacuity, only when the host itself can reach the address.
    const noop = new NoopSandbox();
    const hostReaches = await noop.run(scratch.worktree, command);
    if (/net_rc=0/.test(hostReaches.stdout)) {
      assert.match(
        result.stdout,
        /net_rc=[1-9]/,
        'the host reaches the address, so the denial is the network namespace at work',
      );
    }
  } finally {
    scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A5 — resource bounds
// ---------------------------------------------------------------------------

test('boundary (A5): the memory bound is the configured one and a large allocation fails', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const sandbox = new UnshareSandbox(policyFor(scratch, { limits: { memoryMb: 256 } }));
    const ulimit = await run(sandbox, { shell: 'bash -c "ulimit -v"', cwd: scratch.worktree });
    assert.equal(ulimit.stdout.trim(), String(256 * 1024), 'the configured address-space bound applies');

    // node will not start, let alone allocate 400 MB, under this bound — and
    // the identical command succeeds without a boundary (non-vacuity).
    const allocate = 'node -e "Buffer.alloc(400 * 1024 * 1024).fill(7); console.log(\'allocated\')"';
    const noop = new NoopSandbox();
    const unconfined = await noop.run(scratch.worktree, allocate);
    assert.equal(unconfined.code, 0, 'without a boundary the allocation succeeds');
    const confined = await run(sandbox, { shell: allocate, cwd: scratch.worktree });
    assert.notEqual(confined.code, 0, 'the allocation must fail under the memory bound');
  } finally {
    scratch.cleanup();
  }
});

test('boundary (A5): the configured cpu bound kills a spin, without the step asking', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    // The limit is the policy's, not the command's: a bare spin gets SIGXCPU.
    const sandbox = new UnshareSandbox(policyFor(scratch, { limits: { cpuSeconds: 1 } }));
    const started = Date.now();
    const result = await run(sandbox, {
      shell: 'while :; do :; done',
      cwd: scratch.worktree,
      timeoutMs: 20_000,
    });
    const elapsed = Date.now() - started;
    assert.notEqual(result.code, 0, 'a cpu-hog step must not exit 0');
    assert.ok(elapsed < 15_000, `the cpu bound must end the step (took ${elapsed}ms)`);
  } finally {
    scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A6 — a backgrounded grandchild does not survive the step
// ---------------------------------------------------------------------------

test('boundary (A6): a backgrounded grandchild does not outlive the step', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const leaked = path.join(scratch.worktree, 'leaked.txt');
    const ran = path.join(scratch.worktree, 'ran.txt');
    const sandbox = new UnshareSandbox(policyFor(scratch));
    const result = await run(sandbox, {
      shell:
        `echo ran > ${shQuote(ran)}; ` +
        `( sleep 3; touch ${shQuote(leaked)} ) & echo backgrounded; exit 0`,
      cwd: scratch.worktree,
    });
    assert.equal(result.code, 0);
    assert.ok(existsSync(ran), 'the step itself must have run (non-vacuity)');
    await sleep(5000);
    assert.equal(existsSync(leaked), false, 'a backgrounded grandchild must not outlive its pid namespace');
  } finally {
    scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A8 — mounts are private and do not leak to the host
// ---------------------------------------------------------------------------

test('boundary (A8): mount propagation is private and nothing leaks to the host', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const sandbox = new UnshareSandbox(policyFor(scratch));
    const result = await run(sandbox, { shell: 'findmnt -no PROPAGATION /', cwd: scratch.worktree });
    assert.equal(result.stdout.trim(), 'private');

    const hostMounts = readFileSync('/proc/self/mountinfo', 'utf8');
    for (const line of hostMounts.split('\n')) {
      assert.ok(!line.includes('takumi-sbx-'), `the host must not see a boundary mount: ${line}`);
      assert.ok(!line.includes(scratch.worktree), `the host must not see the worktree bind: ${line}`);
    }
    // The worktree is still a plain directory on the host, with no mount on it.
    assert.ok(!execFileSync('findmnt', ['-no', 'TARGET'], { encoding: 'utf8' }).includes(scratch.worktree));
  } finally {
    scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Self-test: fail closed, naming what is missing
// ---------------------------------------------------------------------------

test('boundary: the self-test refuses a boundary whose required tool is missing', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const policy = policyFor(scratch, { requiredTools: ['definitely-not-a-real-tool-xyz'] });
    const result = await sandboxSelfTest(policy);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /tool:definitely-not-a-real-tool-xyz/);

    // The named refusal is what runStep returns — before any command runs.
    const sandbox = new UnshareSandbox(policy);
    const refused = await run(sandbox, {
      shell: `echo must-not-run > ${shQuote(path.join(scratch.worktree, 'must-not-run.txt'))}`,
      cwd: scratch.worktree,
    });
    assert.equal(refused.code, SANDBOX_REFUSED_CODE);
    assert.match(refused.stderr, /^SANDBOX_REFUSED: /);
    assert.equal(existsSync(path.join(scratch.worktree, 'must-not-run.txt')), false);
  } finally {
    scratch.cleanup();
  }
});

test('boundary: a self-test for a good policy passes and reports every check', async (t) => {
  if (!(await boundaryOrSkip(t))) return;
  const scratch = makeScratch();
  try {
    const requirement = path.join(scratch.projectRoot, 'req.md');
    writeFileSync(requirement, 'requirement\n');
    const result = await sandboxSelfTest(
      policyFor(scratch, { staged: [{ ref: 'req.md', hostPath: requirement }] }),
    );
    assert.equal(result.ok, true, result.reason);
    const names = result.checks.map((check) => check.name);
    for (const expected of ['propagation', 'root-readonly', 'cwd-present', 'hidden-probe', 'no-network', 'loopback', 'proc', 'tool:node']) {
      assert.ok(names.includes(expected), `missing self-test check ${expected}: ${names.join(', ')}`);
    }
    assert.ok(names.some((name) => name.startsWith('rw-writable:')));
  } finally {
    scratch.cleanup();
  }
});
