import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_MASKED_PREFIXES,
  SandboxPolicyError,
  assertWriteRootsSafe,
  boundaryDirs,
  buildSandboxPolicy,
  isInside,
  maskedPrefixOf,
  probeToolchain,
  renderBoundaryScript,
  renderInnerCommand,
  shQuote,
} from '../sandbox-policy.js';
import type { SandboxPolicyInput, SandboxToolchainProbe } from '../sandbox-policy.js';

// The pure half of the boundary: guards G1-G3 and the mount script. No
// namespace is created here, so these run everywhere.

const PROJECT = '/srv/hermes/workspaces/takumi';
const WORKTREE = path.join(PROJECT, '.takumi', 'worktrees', 'takumi-run-1');
const RUN_ID = 'takumi-run-1';
const JUDGE = path.join(PROJECT, '.takumi', 'acceptance', RUN_ID, 'accept_step');

const CLEAN_TOOLCHAIN: SandboxToolchainProbe = {
  roots: ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/srv/hermes/.local/bin'],
  dropped: [],
  tools: [],
  missing: [],
};

function deliveryPolicy(overrides: Partial<SandboxPolicyInput> = {}) {
  return buildSandboxPolicy({
    projectRoot: PROJECT,
    worktree: WORKTREE,
    judgeDir: JUDGE,
    runId: RUN_ID,
    toolchain: CLEAN_TOOLCHAIN,
    ...overrides,
  });
}

/**
 * Fixtures live outside the paths the boundary mounts as a private tmpfs
 * (`/tmp`, `/var/tmp`, `/dev/shm`): a project root under one of those is
 * refused by guard G4, so a `/tmp` fixture would only ever test the refusal.
 */
const FIXTURE_ROOT =
  process.env.TAKUMI_SANDBOX_TEST_DIR ?? path.join(homedir(), '.cache', 'takumi-sandbox-tests');

function mkFixture(prefix: string): string {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  return mkdtempSync(path.join(FIXTURE_ROOT, prefix));
}

function guardOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof SandboxPolicyError ? e.guard : `not-a-policy-error:${String(e)}`;
  }
}

test('sandbox policy: isInside is a resolved, segment-aware containment check', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/bc', '/a/b'), false);
});

test('sandbox policy (G1): the toolchain probe drops a PATH entry that contains the project', () => {
  const probe = probeToolchain({
    cwd: PROJECT,
    pathValue: ['/srv/hermes', '/srv/hermes/.local/bin', '/usr/bin', '/usr/bin'].join(path.delimiter),
    exists: () => true,
    realpath: (p) => p,
  });
  assert.ok(!probe.roots.includes('/srv/hermes'), 'a directory containing the project must not be mirrored');
  assert.ok(probe.roots.includes('/srv/hermes/.local/bin'), 'a sibling of the project is safe to mirror');
  assert.deepEqual(
    probe.dropped.map((entry) => entry.path),
    ['/srv/hermes'],
    'the dropped candidate must be reported, not silently ignored',
  );
});

test('sandbox policy (G3): the toolchain probe drops a PATH entry inside the project (pnpm .bin)', () => {
  const bin = path.join(PROJECT, 'packages', 'core', 'node_modules', '.bin');
  const probe = probeToolchain({
    cwd: PROJECT,
    pathValue: [bin, path.join(PROJECT, 'node_modules', '.bin'), '/usr/bin'].join(path.delimiter),
    exists: () => true,
    realpath: (p) => p,
  });
  assert.deepEqual(probe.dropped.map((entry) => entry.path), [bin, path.join(PROJECT, 'node_modules', '.bin')]);
  assert.ok(!probe.roots.some((root) => isInside(PROJECT, root)), 'nothing inside the project may be mirrored');
  assert.ok(probe.roots.includes('/usr/bin'));
});

test('sandbox policy (G1): the toolchain probe mirrors the real path behind a symlinked tool', () => {
  const probe = probeToolchain({
    cwd: PROJECT,
    requiredTools: ['node'],
    pathValue: '/srv/hermes/.local/bin',
    exists: () => true,
    realpath: () => '/srv/hermes/.hermes/node/bin/node',
  });
  // Without the real directory the mirrored `node` symlink dangles inside.
  assert.ok(probe.roots.includes('/srv/hermes/.hermes/node/bin'));
  assert.deepEqual(probe.missing, []);
});

test('sandbox policy (G1): a read-only root that contains the project is refused', () => {
  const guard = guardOf(() => deliveryPolicy({ ro: ['/srv/hermes'] }));
  assert.equal(guard, 'G1');
  const root = guardOf(() => deliveryPolicy({ ro: ['/'] }));
  assert.equal(root, 'G1');
});

test('sandbox policy (G1): the probed toolchain has no read-only root above the project (A8)', () => {
  // Injected `exists`/`pathValue` so the property is tested on ANY host, not only
  // one whose PATH happens to contain the sibling toolchain directory.
  const nodeBin = '/srv/hermes/.local/bin';
  const insideProject = path.join(PROJECT, 'node_modules', '.bin');
  const probe = probeToolchain({
    cwd: PROJECT,
    pathValue: [nodeBin, insideProject, '/srv/hermes', '/usr/bin', '/bin'].join(path.delimiter),
    exists: () => true,
    realpath: (p) => p,
    requiredTools: ['sh'],
  });
  assert.ok(probe.roots.includes(nodeBin), 'a SIBLING toolchain directory is mirrored');
  assert.ok(!probe.roots.includes('/srv/hermes'), 'the parent of the workspace tree must not be mirrored');
  assert.ok(
    probe.dropped.some((d) => d.path === insideProject),
    'a PATH entry inside the project (pnpm puts node_modules/.bin there) is dropped',
  );
  const policy = deliveryPolicy({ ro: probe.roots });
  for (const root of policy.ro) {
    assert.ok(!isInside(root, policy.cwd), `read-only root ${root} must not contain ${policy.cwd}`);
    assert.ok(!isInside(policy.cwd, root), `read-only root ${root} must not be inside ${policy.cwd}`);
  }
});

test('sandbox policy (G4): a project root under a path the boundary masks is refused when it stages files', () => {
  for (const masked of SANDBOX_MASKED_PREFIXES) {
    assert.equal(maskedPrefixOf(path.join(masked, 'x')), masked);
    assert.equal(maskedPrefixOf(masked), masked);
    const root = path.join(masked, 'x');
    assert.equal(
      guardOf(() =>
        buildSandboxPolicy({
          projectRoot: root,
          toolchain: CLEAN_TOOLCHAIN,
          staged: [{ ref: 'req.md', hostPath: path.join(root, 'req.md') }],
        }),
      ),
      'G4',
      `${masked} is mounted as a private tmpfs, so a project root under it that stages files cannot be mirrored read-only`,
    );
    // Without staged files the masking is harmless (the read-write binds attach
    // after the tmpfs mounts), so the same root is not refused.
    assert.doesNotThrow(() => buildSandboxPolicy({ projectRoot: root, toolchain: CLEAN_TOOLCHAIN }));
  }
  assert.equal(maskedPrefixOf('/tmpfoo/x'), undefined, 'the prefix check is segment-aware');
  assert.equal(maskedPrefixOf(PROJECT), undefined);
});

test('sandbox policy (G2): the project root is never a write root of a delivery boundary', () => {
  assert.equal(guardOf(() => deliveryPolicy({ rw: [PROJECT] })), 'G2');
  assert.equal(guardOf(() => deliveryPolicy({ rw: [path.dirname(PROJECT)] })), 'G2');
  assert.equal(guardOf(() => deliveryPolicy({ rw: [path.join(PROJECT, '.takumi')] })), 'G2');
  assert.equal(
    guardOf(() => deliveryPolicy({ rw: [path.join(PROJECT, '.takumi', 'acceptance', 'another-run', 'step')] })),
    'G2',
    'another run\'s judge directory is not this run\'s write root',
  );
  assert.equal(
    guardOf(() => deliveryPolicy({ rw: [path.join(PROJECT, '.takumi', 'acceptance', RUN_ID, 'step')], runId: undefined })),
    'G2',
    'an acceptance write root needs the run it belongs to',
  );
  assert.equal(guardOf(() => deliveryPolicy()), undefined);
});

test('sandbox policy (G2): with no worktree the project is the root, on purpose', () => {
  const policy = buildSandboxPolicy({ projectRoot: PROJECT, toolchain: CLEAN_TOOLCHAIN });
  assert.equal(policy.projectIsRoot, true);
  assert.deepEqual(policy.rw, [PROJECT]);
  // The project-as-root mode is explicit, not a loophole: it is the only
  // projectIsRoot write root allowed, and anything else is still refused.
  const guard = guardOf(() => assertWriteRootsSafe({ cwd: PROJECT, rw: [WORKTREE], projectIsRoot: true }));
  assert.equal(guard, 'G2');
});

test('sandbox policy (G3): a staged ref may not escape the project root', () => {
  assert.equal(guardOf(() => deliveryPolicy({ staged: [{ ref: '../escape.md', hostPath: '/tmp/x' }] })), 'G3');
  assert.equal(guardOf(() => deliveryPolicy({ staged: [{ ref: '/etc/passwd', hostPath: '/tmp/x' }] })), 'G3');
  assert.equal(guardOf(() => deliveryPolicy({ staged: [{ ref: '', hostPath: '/tmp/x' }] })), 'G3');
  assert.equal(guardOf(() => deliveryPolicy({ staged: [{ ref: 'req.md', hostPath: 'relative/path' }] })), 'G3');
  assert.equal(guardOf(() => deliveryPolicy({ staged: [{ ref: 'docs/req.md', hostPath: '/tmp/req.md' }] })), undefined);
});

test('sandbox policy (G3): a read-only root inside the project root is refused', () => {
  assert.equal(guardOf(() => deliveryPolicy({ ro: [path.join(PROJECT, 'extensions')] })), 'G3');
  assert.equal(guardOf(() => deliveryPolicy({ ro: [path.join(PROJECT, '.takumi', 'acceptance', RUN_ID)] })), 'G3');
});

test('sandbox policy: the builder picks a hidden probe that exists in the project', () => {
  const base = mkFixture('policy-hidden-');
  try {
    writeFileSync(path.join(base, 'package.json'), '{}\n');
    const policy = buildSandboxPolicy({ projectRoot: base, toolchain: CLEAN_TOOLCHAIN });
    assert.equal(policy.hiddenProbe, path.join(base, 'package.json'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sandbox policy: the builder only probes git in a self-contained repository', () => {
  const base = mkFixture('policy-git-');
  try {
    const worktree = path.join(base, 'wt');
    mkdirSync(worktree, { recursive: true });
    // A linked worktree's `.git` is a file; the gitdir lives in the platform
    // repository, which the boundary does not mirror.
    writeFileSync(path.join(worktree, '.git'), 'gitdir: /platform/.git/worktrees/wt\n');
    const linked = buildSandboxPolicy({ projectRoot: base, worktree, toolchain: CLEAN_TOOLCHAIN });
    assert.equal(linked.gitRepoProbe, undefined);
    // A plain repository has a real `.git/HEAD`.
    const plain = path.join(base, 'plain');
    mkdirSync(path.join(plain, '.git'), { recursive: true });
    writeFileSync(path.join(plain, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const probed = buildSandboxPolicy({ projectRoot: base, worktree: plain, toolchain: CLEAN_TOOLCHAIN });
    assert.equal(probed.gitRepoProbe, plain);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sandbox policy: limits have a default and are overridable', () => {
  assert.deepEqual(deliveryPolicy().limits, DEFAULT_SANDBOX_LIMITS);
  const tight = deliveryPolicy({ limits: { memoryMb: 256 } });
  assert.equal(tight.limits.memoryMb, 256);
  assert.equal(tight.limits.cpuSeconds, DEFAULT_SANDBOX_LIMITS.cpuSeconds);
});

// ---- the rendered script --------------------------------------------------

test('sandbox script: the root is sealed read-only before the first submount exists', () => {
  const policy = deliveryPolicy();
  const script = renderBoundaryScript(policy);
  const sealLine = script.indexOf('mount --bind "$R" "$R"');
  const remount = script.indexOf('mount -o remount,ro,bind "$R"');
  assert.ok(sealLine >= 0, 'the root must be bind-mounted onto itself before the remount');
  assert.ok(remount > sealLine, 'the bind must be remounted read-only');
  const firstHostBind = script.indexOf("mount --bind '");
  assert.ok(firstHostBind > remount, 'no host bind may be attached before the root is sealed');
  // Every directory a later mount needs exists before the seal: after it, the
  // root is read-only and `mkdir` would fail.
  for (const dir of boundaryDirs(policy)) {
    const mkdirAt = script.indexOf(`mkdir -p "$R${dir}"`);
    assert.ok(mkdirAt >= 0, `directory ${dir} must be created`);
    assert.ok(mkdirAt < sealLine, `directory ${dir} must be created before the root is sealed`);
  }
});

test('sandbox script: directories under the tmpfs mounts are re-created after them', () => {
  const policy = deliveryPolicy();
  const script = renderBoundaryScript(policy);
  const tmpfsAt = script.indexOf('tmpfs "$R/tmp"');
  assert.ok(tmpfsAt > 0, 'the scratch tmpfs must be mounted');
  const worktreeMkdir = script.indexOf(`mkdir -p "$R${policy.rw[0]}"`, tmpfsAt);
  assert.ok(worktreeMkdir > tmpfsAt, 'a directory hidden by the tmpfs mount must be re-created');
  const worktreeBind = script.indexOf(`mount --bind '${policy.rw[0]}'`, tmpfsAt);
  assert.ok(worktreeBind > worktreeMkdir, 'the write bind follows the re-created directory');
});

test('sandbox script: every read-only root is bound and remounted read-only', () => {
  const policy = deliveryPolicy();
  const script = renderBoundaryScript(policy);
  for (const root of policy.ro) {
    assert.ok(script.includes(`mount --bind '${root}' "$R${root}"`), `missing bind for ${root}`);
    assert.ok(
      script.includes(`mount -o remount,ro,bind "$R${root}"`),
      `missing explicit read-only remount for ${root}`,
    );
  }
});

test('sandbox script: only the curated /dev nodes are bound, and /proc is fresh', () => {
  const script = renderBoundaryScript(deliveryPolicy());
  assert.ok(script.includes('mount -t proc proc "$R/proc"'));
  assert.ok(script.includes('mount --bind "/dev/null" "$R/dev/null"'));
  assert.ok(!script.includes('mount --bind "/dev" "$R/dev"'), 'all of /dev must never be mirrored');
  assert.ok(script.includes('mode=1777'), '/tmp and /dev/shm must be world-writable inside');
});

test('sandbox script: the command is passed as argv, never interpolated into the setup', () => {
  const sentinel = 'BOUNDARY_COMMAND_SENTINEL; rm -rf /';
  const script = renderBoundaryScript(deliveryPolicy());
  assert.ok(!script.includes('BOUNDARY_COMMAND_SENTINEL'));
  const command = renderInnerCommand({ shell: sentinel, cwd: WORKTREE });
  assert.equal(command, `cd '${WORKTREE}' && ${sentinel}`);
});

test('sandbox script: paths are single-quoted so policy data cannot become syntax', () => {
  assert.equal(shQuote('/a/b'), "'/a/b'");
  assert.equal(shQuote("/a/it's"), "'/a/it'\\''s'");
  const policy = deliveryPolicy({
    staged: [{ ref: "odd'name.md", hostPath: "/tmp/it's.md" }],
  });
  const script = renderBoundaryScript(policy);
  assert.ok(script.includes(`cp -f '/tmp/it'\\''s.md'`), 'the staged source is quoted');
  assert.ok(script.includes(`"$R${PROJECT}/odd'name.md"`));
});

test('sandbox script: a staged file is copied read-only, never bound', () => {
  const script = renderBoundaryScript(
    deliveryPolicy({ staged: [{ ref: 'docs/req.md', hostPath: '/tmp/req.md' }] }),
  );
  assert.ok(script.includes(`cp -f '/tmp/req.md' "$R${PROJECT}/docs/req.md"`));
  assert.ok(script.includes('chmod 0444'));
  assert.ok(!script.includes("mount --bind '/tmp/req.md'"), 'the requirement must be a copy, not a bind');
});

test('sandbox script: renderInnerCommand refuses an ambiguous request', () => {
  assert.throws(() => renderInnerCommand({ cwd: '/w' }), /exactly one of shell\/argv/);
  assert.throws(() => renderInnerCommand({ cwd: '/w', shell: 'ls', argv: ['ls'] }), /exactly one of shell\/argv/);
  assert.equal(
    renderInnerCommand({ cwd: '/w', argv: ['bash', '/j/run.sh'] }),
    "cd '/w' && exec 'bash' '/j/run.sh'",
  );
});
