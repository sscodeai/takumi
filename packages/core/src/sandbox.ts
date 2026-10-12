/**
 * Sandbox abstraction — P1-2 (Isolation / security red line).
 *
 * Runtimes execute agent shell commands in the project cwd. Without a sandbox
 * an agent can read/write anywhere the process can (host files, network,
 * /etc, other projects). The Sandbox interface lets a runtime run a command
 * inside an isolated environment:
 *
 *   - filesystem: project dir mounted rw, everything else read-only/no access
 *   - network:    disabled (unless allowNetwork: true)
 *   - process:    isolated pid namespace
 *   - resources:  bounded CPU/memory/time
 *
 * Implementations: DockerSandbox (docker run --network none --read-only ...)
 * is the reference; a NoopSandbox (plain exec) is used when sandboxing is
 * disabled or unavailable — so the default remains "unsandboxed" and the
 * capability 'sandbox' is only advertised when a real sandbox is available.
 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface SandboxOptions {
  /** working directory inside the sandbox (default: /work) */
  workdir?: string;
  /** allow network (default: false) */
  allowNetwork?: boolean;
  /** memory limit, e.g. '512m' (default: 512m) */
  memory?: string;
  /** cpu limit, e.g. '1' (default: 1) */
  cpus?: string;
  /** timeout ms (default: 60_000) */
  timeoutMs?: number;
}

export interface Sandbox {
  /** Human-readable id (e.g. 'docker', 'none'). */
  readonly id: string;
  /** Run a command inside the sandbox with the project mounted at /work (rw). */
  run(projectDir: string, command: string, opts?: SandboxOptions): Promise<SandboxResult>;
  /** Release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Boundary spec (P1-2): the data a mount-policy boundary is built from.
//
// The `Sandbox` interface above is an opaque "run this in a box" call. A
// boundary is stricter than that: it is built from an explicit, auditable list
// of host paths that may be reached from inside, and a command that is not
// covered by that list is refused before any mount is created. `SandboxPolicy`
// is that list; `StepSandbox` is the seam the workflow engine routes step
// commands through.
// ---------------------------------------------------------------------------

/** How a mirrored host path is exposed inside the boundary. */
export type SandboxMountMode = 'ro' | 'rw';

/**
 * A file copied read-only into the boundary. Used for the requirement document
 * and for harness scripts: paths a step is allowed to read that live in the
 * platform repository, which is otherwise not exposed at all.
 */
export interface SandboxStagedFile {
  /** Path relative to the mirrored cwd. Must not escape it. */
  ref: string;
  /** Host file that is copied to `<cwd>/<ref>` inside the boundary. */
  hostPath: string;
}

/** Resource bounds applied with `ulimit` before the command runs. */
export interface SandboxLimits {
  /** Address-space limit (`ulimit -v`), MiB. */
  memoryMb: number;
  /** CPU-seconds (`ulimit -t`). */
  cpuSeconds: number;
  /** Largest file the command may create (`ulimit -f`), MiB. */
  fileSizeMb: number;
}

/**
 * A boundary policy: exactly which host paths exist inside, at which mode.
 * Paths are mirrored at the same absolute path, so absolute paths a caller
 * already uses (TAKUMI_PROJECT, TAKUMI_WORKTREE, a judge's own path) keep their
 * values and no delivered script needs to learn a new layout.
 */
export interface SandboxPolicy {
  /** Project root, mirrored as a directory that holds only `staged` files. */
  cwd: string;
  /**
   * True only for a run with no separate worktree, where the project really is
   * the sandbox root (`UnshareSandbox.run(projectDir, …)`). Delivery runs set
   * this false so the platform repository can never be a write root.
   */
  projectIsRoot: boolean;
  /** Run this boundary belongs to; required for an acceptance rw root. */
  runId?: string;
  /** Host roots exposed read-write (a delivery worktree, this run's judge dir). */
  rw: string[];
  /** Host roots exposed read-only (the toolchain and `/etc`). */
  ro: string[];
  /** Files copied read-only into `<cwd>`; the only project paths visible. */
  staged: SandboxStagedFile[];
  /** Host path that exists under `cwd` but must be invisible inside. */
  hiddenProbe?: string;
  /** Working tree whose `git rev-parse HEAD` must work inside. */
  gitRepoProbe?: string;
  /** Tools that must resolve inside; a missing one is a named refusal. */
  requiredTools: string[];
  limits: SandboxLimits;
  /** Size of the scratch tmpfs mounted at `/tmp`, MiB. */
  tmpSizeMb: number;
  /** Size of the tmpfs mounted at `/dev/shm`, MiB. */
  shmSizeMb: number;
  /** Size of the boundary root tmpfs, MiB. */
  rootSizeMb: number;
}

/** One command a boundary is asked to run. */
export interface StepSandboxRequest {
  /** Shell command, run as `/bin/sh -c <shell>`. */
  shell?: string;
  /** argv form (`bash <script>`); exactly one of shell/argv. */
  argv?: string[];
  /** Mirrored absolute working directory (must exist inside the boundary). */
  cwd: string;
  /** Extra environment for the command (merged over the host environment). */
  env?: Record<string, string>;
  /** Wall-clock timeout, ms (default 60_000). */
  timeoutMs?: number;
}

/**
 * The step-command seam. Fail-closed by contract: an implementation that
 * cannot establish its boundary returns `code: SANDBOX_REFUSED_CODE` with a
 * `SANDBOX_REFUSED: <reason>` stderr instead of running the command.
 */
export interface StepSandbox {
  readonly id: string;
  runStep(req: StepSandboxRequest): Promise<SandboxResult>;
  close(): Promise<void>;
}
