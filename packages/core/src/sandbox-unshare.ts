/**
 * UnshareSandbox — an unprivileged mount-policy boundary (P1-2).
 *
 * Built from `unshare` and `chroot` as PROGRAMS (util-linux, invoked by argv;
 * no source is linked or copied) plus a tmpfs root, so it needs no root and no
 * daemon:
 *
 *   unshare --user --map-root-user --net --pid --mount --propagation private
 *           --fork /bin/sh <setup-script> <root> <command>
 *
 * What a step actually gets, and what it does NOT get:
 *
 *   - filesystem: a tmpfs root, mirrored host paths only. Read-write roots are
 *     the delivery worktree and this run's judge directory; the platform
 *     repository is NOT one of them (a read of `<cwd>/package.json` fails, and
 *     a write into `<cwd>` is denied by the read-only root). The requirement
 *     document and any harness script enter as read-only STAGED copies.
 *   - network: a fresh network namespace with loopback up and no route off the
 *     host. `1.1.1.1:443` is unreachable. (The delivery AGENT runtime keeps
 *     provider egress — a named limitation, see ADR-058; this boundary covers
 *     step shell commands.)
 *   - processes: a fresh pid namespace. A backgrounded grandchild cannot
 *     outlive the step: when pid 1 exits the kernel kills the namespace.
 *   - resources: `ulimit -v/-t/-f` before the command runs.
 *
 * This replaces an implementation that claimed filesystem isolation it did not
 * have: writes to a sibling directory and to the platform repository both
 * succeeded, and its `/etc` test was vacuous because `/etc` is read-only on the
 * host. That claim is deleted, not softened — the honest statement is the list
 * above, and the boundary self-test below measures it at every run.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Sandbox,
  SandboxOptions,
  SandboxPolicy,
  SandboxResult,
  StepSandbox,
  StepSandboxRequest,
} from './sandbox.js';
import {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_REQUIRED_TOOLS,
  assertSandboxPolicy,
  buildSandboxPolicy,
  renderBoundaryScript,
  renderInnerCommand,
  shQuote,
} from './sandbox-policy.js';

/** Result code used when the boundary refuses to run a command at all. */
export const SANDBOX_REFUSED_CODE = 126;
/** stderr prefix that carries the named refusal reason. */
export const SANDBOX_REFUSED_PREFIX = 'SANDBOX_REFUSED: ';
/** Marker each self-test check prints inside the boundary. */
const SELFTEST_MARKER = 'TAKUMI_SELFTEST';

/** Host paths the boundary is built from; probed first, then by absolute name. */
const UNSHARE_CANDIDATES = ['/usr/bin/unshare', '/bin/unshare'];
const CHROOT_CANDIDATES = ['/usr/sbin/chroot', '/sbin/chroot', '/bin/chroot'];

function firstExistingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function unshareBin(): string {
  return firstExistingPath(UNSHARE_CANDIDATES) ?? 'unshare';
}

function refused(reason: string): SandboxResult {
  return { stdout: '', stderr: `${SANDBOX_REFUSED_PREFIX}${reason}`, code: SANDBOX_REFUSED_CODE, timedOut: false };
}

/** '512m' | '2g' | undefined → MiB. */
function parseMemoryMb(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SANDBOX_LIMITS.memoryMb;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([mg])?\s*$/i.exec(value);
  if (match === null) return DEFAULT_SANDBOX_LIMITS.memoryMb;
  const amount = Number.parseFloat(match[1] as string);
  const unit = (match[2] ?? 'm').toLowerCase();
  return Math.max(16, Math.round(unit === 'g' ? amount * 1024 : amount));
}

function parseCpuSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SANDBOX_LIMITS.cpuSeconds;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.round(parsed)) : DEFAULT_SANDBOX_LIMITS.cpuSeconds;
}

// ---------------------------------------------------------------------------
// Running the boundary
// ---------------------------------------------------------------------------

const SETUP_GRACE_MS = 5000;
const MAX_CAPTURED_BYTES = 1024 * 1024;

/**
 * Run one command inside a freshly created boundary. No policy check happens
 * here (the caller has already run the guards); this is the mechanism.
 */
async function runBoundary(policy: SandboxPolicy, req: StepSandboxRequest): Promise<SandboxResult> {
  const timeoutMs = req.timeoutMs ?? 60_000;
  const scratch = mkdtempSync(path.join(tmpdir(), 'takumi-sbx-'));
  const root = path.join(scratch, 'root');
  const script = path.join(scratch, 'setup.sh');
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(script, renderBoundaryScript(policy), { mode: 0o700 });
    const args = [
      '--user',
      '--map-root-user',
      '--net',
      '--pid',
      '--mount',
      '--propagation',
      'private',
      '--fork',
      '/bin/sh',
      script,
      root,
      renderInnerCommand(req),
    ];

    return await new Promise<SandboxResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(unshareBin(), args, {
          cwd: policy.cwd,
          env: { ...process.env, ...(req.env ?? {}) },
          // Its own session/group, so a timeout can take the whole namespace
          // down with one kill instead of orphaning a forked child.
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ stdout: '', stderr: e instanceof Error ? e.message : String(e), code: 127, timedOut: false });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const append = (current: string, chunk: Buffer): string =>
        current.length >= MAX_CAPTURED_BYTES ? current : current + chunk.toString();
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      const killTree = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs + SETUP_GRACE_MS);
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code, timedOut });
      };

      child.on('error', (e: Error) => {
        if (stderr.length === 0) stderr = e.message;
        finish(127);
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (timedOut) {
          finish(-1);
          return;
        }
        finish(signal === null ? code ?? 1 : 1);
      });
    });
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* the mount namespace is gone with the process; the directory is empty */
    }
  }
}

// ---------------------------------------------------------------------------
// Self-test — the boundary measures itself before a step is allowed to run
// ---------------------------------------------------------------------------

export interface SandboxSelfTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SandboxSelfTestResult {
  ok: boolean;
  /** Named reason the boundary is not usable, when it is not. */
  reason?: string;
  checks: SandboxSelfTestCheck[];
}

const selfTestCache = new Map<string, Promise<SandboxSelfTestResult>>();

/** Forget cached self-tests (used by tests and after a policy change). */
export function clearSandboxSelfTestCache(): void {
  selfTestCache.clear();
}

function sanitizeDetail(value: string): string {
  return value.replace(/\s+/g, '_').slice(0, 200);
}

/** The shell script that measures the boundary from the inside. */
function renderSelfTestScript(policy: SandboxPolicy): string {
  const lines: string[] = [];
  lines.push('set +e');
  lines.push(`emit() { printf '%s %s %s\\n' ${shQuote(SELFTEST_MARKER)} "$1" "$2"; }`);
  lines.push(
    `prop=$(findmnt -no PROPAGATION / 2>/dev/null); ` +
      `[ "$prop" = private ] && emit propagation OK || emit propagation "FAIL:$prop"`,
  );
  lines.push(
    `( : > /.takumi-ro-probe ) 2>/dev/null && { rm -f /.takumi-ro-probe; emit root-readonly FAIL:writable; } || emit root-readonly OK`,
  );
  for (const root of policy.rw) {
    const probe = path.join(root, '.takumi-rw-probe');
    lines.push(
      `( : > ${shQuote(probe)} && rm -f ${shQuote(probe)} ) 2>/dev/null && emit ${shQuote(
        `rw-writable:${root}`,
      )} OK || emit ${shQuote(`rw-writable:${root}`)} FAIL:not_writable`,
    );
  }
  lines.push(`[ -d ${shQuote(policy.cwd)} ] && emit cwd-present OK || emit cwd-present FAIL:missing`);
  if (policy.hiddenProbe !== undefined) {
    lines.push(
      `[ -e ${shQuote(policy.hiddenProbe)} ] && emit hidden-probe FAIL:visible || emit hidden-probe OK`,
    );
  }
  if (policy.gitRepoProbe !== undefined) {
    lines.push(
      `git -C ${shQuote(policy.gitRepoProbe)} rev-parse HEAD >/dev/null 2>&1 && emit git-rev-parse OK || emit git-rev-parse FAIL:git_failed`,
    );
  }
  for (const file of policy.staged) {
    const mirror = path.resolve(policy.cwd, file.ref);
    lines.push(
      `[ -s ${shQuote(mirror)} ] && emit ${shQuote(`staged:${file.ref}`)} OK || emit ${shQuote(
        `staged:${file.ref}`,
      )} FAIL:not_readable`,
    );
  }
  for (const tool of policy.requiredTools) {
    lines.push(
      `command -v ${shQuote(tool)} >/dev/null 2>&1 && emit ${shQuote(`tool:${tool}`)} OK || emit ${shQuote(
        `tool:${tool}`,
      )} FAIL:not_resolvable`,
    );
  }
  lines.push(
    `timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null && emit no-network FAIL:reachable || emit no-network OK`,
  );
  lines.push(`ip link show lo 2>/dev/null | grep -q UP && emit loopback OK || emit loopback FAIL:down`);
  lines.push(`[ -r /proc/1/status ] && emit proc OK || emit proc FAIL:unreadable`);
  lines.push(`( : > /dev/null ) && emit dev-null OK || emit dev-null FAIL:unwritable`);
  lines.push('exit 0');
  return lines.join('\n');
}

async function runSelfTest(policy: SandboxPolicy): Promise<SandboxSelfTestResult> {
  const result = await runBoundary(policy, { shell: renderSelfTestScript(policy), cwd: policy.cwd, timeoutMs: 30_000 });
  const checks: SandboxSelfTestCheck[] = [];
  const pattern = new RegExp(`^${SELFTEST_MARKER} (\\S+) (\\S+)$`, 'gm');
  for (const match of result.stdout.matchAll(pattern)) {
    const ok = match[2] === 'OK';
    const detail = match[2]?.startsWith('FAIL:') ? match[2].slice('FAIL:'.length) : undefined;
    checks.push(detail === undefined ? { name: match[1] as string, ok } : { name: match[1] as string, ok, detail });
  }
  if (checks.length === 0) {
    const detail = sanitizeDetail(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
    return {
      ok: false,
      reason: `the boundary produced no self-test output (exit ${result.code}${result.timedOut ? ', timed out' : ''}: ${detail})`,
      checks,
    };
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    const named = failed.map((check) => `${check.name}${check.detail === undefined ? '' : ` (${check.detail})`}`).join(', ');
    return { ok: false, reason: `the boundary failed its self-test: ${named}`, checks };
  }
  return { ok: true, checks };
}

/**
 * Measure a boundary for a policy, once per process per policy. A boundary that
 * cannot be established is a refusal, never a smaller sandbox.
 */
export async function sandboxSelfTest(policy: SandboxPolicy): Promise<SandboxSelfTestResult> {
  assertSandboxPolicy(policy);
  const key = JSON.stringify(policy);
  const cached = selfTestCache.get(key);
  if (cached !== undefined) return cached;
  const pending = runSelfTest(policy);
  selfTestCache.set(key, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

let capabilityPolicy: SandboxPolicy | undefined;

/**
 * Where the capability probe lives. It must be a path the boundary can mirror
 * read-only, so it may not sit under the private tmpfs mounts (guard G4): the
 * process temp directory is deliberately not usable here.
 */
function sandboxScratchBase(): string {
  return process.env.TAKUMI_SANDBOX_SCRATCH ?? path.join(homedir(), '.cache', 'takumi-sandbox');
}

/**
 * A throwaway boundary rooted in an empty directory: enough to measure whether
 * this host can create the mechanism at all, and nothing else. The directory is
 * per-process (the self-test writes a probe file into each read-write root) and
 * removed when the process exits.
 */
function capabilityBoundaryPolicy(): SandboxPolicy {
  if (capabilityPolicy !== undefined) return capabilityPolicy;
  const base = sandboxScratchBase();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'capability-'));
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover probe directory is inert.
    }
  });
  capabilityPolicy = buildSandboxPolicy({
    projectRoot: dir,
    requiredTools: SANDBOX_REQUIRED_TOOLS,
    tmpSizeMb: 16,
    shmSizeMb: 8,
    rootSizeMb: 8,
  });
  return capabilityPolicy;
}

export interface SandboxCapability {
  available: boolean;
  /** Why the boundary is unavailable: a named reason, never a bare `false`. */
  reason?: string;
  checks: SandboxSelfTestCheck[];
}

let capabilityProbe: Promise<SandboxCapability> | undefined;

/**
 * Measure whether this host can build and self-test a boundary, and say why not
 * when it cannot. The old check was a naked `unshare … true` probe, which also
 * passes on hosts where the mounts fail; this one establishes the mechanism and
 * measures it from the inside.
 */
export function sandboxCapability(): Promise<SandboxCapability> {
  if (capabilityProbe !== undefined) return capabilityProbe;
  capabilityProbe = (async (): Promise<SandboxCapability> => {
    if (platform() !== 'linux') return { available: false, reason: 'not_linux', checks: [] };
    if (firstExistingPath(UNSHARE_CANDIDATES) === undefined) {
      return { available: false, reason: 'unshare_not_found', checks: [] };
    }
    if (firstExistingPath(CHROOT_CANDIDATES) === undefined) {
      return { available: false, reason: 'chroot_not_found', checks: [] };
    }
    try {
      const result = await sandboxSelfTest(capabilityBoundaryPolicy());
      const failed = result.checks.filter((check) => !check.ok);
      if (result.ok) return { available: true, checks: result.checks };
      return {
        available: false,
        reason:
          result.reason ??
          `self_test_failed: ${failed.map((check) => `${check.name}(${check.detail ?? 'fail'})`).join(', ')}`,
        checks: result.checks,
      };
    } catch (error) {
      return { available: false, reason: `probe_error: ${String(error)}`, checks: [] };
    }
  })();
  return capabilityProbe;
}

/**
 * True when this host can build and self-test a boundary. Prefer
 * `sandboxCapability()` when the reason matters.
 */
export async function unshareAvailable(): Promise<boolean> {
  return (await sandboxCapability()).available;
}

// ---------------------------------------------------------------------------
// UnshareSandbox
// ---------------------------------------------------------------------------

export class UnshareSandbox implements Sandbox, StepSandbox {
  readonly id = 'unshare';
  private readonly policy?: SandboxPolicy;

  /**
   * With a policy, `runStep` executes step commands inside that boundary. With
   * no policy, the legacy `run(projectDir, command)` form builds a
   * project-as-root boundary for the directory it is handed.
   */
  constructor(policy?: SandboxPolicy) {
    if (policy !== undefined) assertSandboxPolicy(policy);
    this.policy = policy;
  }

  /** Run a step command in this boundary. Refuses (code 126) if it cannot. */
  async runStep(req: StepSandboxRequest): Promise<SandboxResult> {
    if (this.policy === undefined) {
      return refused('this UnshareSandbox was constructed without a boundary policy, so it has no roots to run in');
    }
    if (!path.isAbsolute(req.cwd)) {
      return refused(`the step working directory "${req.cwd}" is not an absolute path`);
    }
    return this.execute(this.policy, req);
  }

  /**
   * Legacy `Sandbox` entry point: run a command with the project directory as
   * the boundary root. A run with a separate delivery worktree must use a
   * policy instead — `run` cannot express "worktree rw, project invisible".
   */
  async run(projectDir: string, command: string, opts: SandboxOptions = {}): Promise<SandboxResult> {
    let policy: SandboxPolicy;
    try {
      policy = buildSandboxPolicy({
        projectRoot: projectDir,
        limits: {
          memoryMb: parseMemoryMb(opts.memory),
          cpuSeconds: parseCpuSeconds(opts.cpus),
        },
      });
    } catch (e) {
      return refused(e instanceof Error ? e.message : String(e));
    }
    return this.execute(policy, { shell: command, cwd: projectDir, ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) });
  }

  async close(): Promise<void> {}

  private async execute(policy: SandboxPolicy, req: StepSandboxRequest): Promise<SandboxResult> {
    const test = await sandboxSelfTest(policy);
    if (!test.ok) return refused(test.reason ?? 'the boundary self-test failed');
    return runBoundary(policy, req);
  }
}
