/**
 * Sandbox policy — the pure half of the boundary (P1-2).
 *
 * Everything in this module is a pure function of data: build a policy from a
 * run's facts, check the policy's guards, and render the mount script. No
 * namespace is created here, so the guards and the script shape can be tested
 * without a kernel that grants unprivileged user namespaces.
 *
 * The guards exist because a boundary is only as good as the roots it is given.
 * Two of the three are about the platform repository not leaking back in:
 *
 *   G1  no read-only root may be, or contain, the project root. The toolchain
 *       lives in directories that are SIBLINGS of the project (`node` is at
 *       <home>/.local/bin, the project at <home>/workspaces/takumi),
 *       so mirroring those siblings is safe — but mirroring a parent such as
 *       the home directory would re-expose the platform repository by accident.
 *   G2  a read-write root must be the delivery worktree or this run's own judge
 *       directory. The project root itself and `.takumi` wholesale are refused:
 *       an implementer that can write the platform repository is not contained.
 *   G3  the only paths inside the project root are the explicitly staged files.
 *       The requirement document is a read-only copy, not a bind of the project.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type {
  SandboxLimits,
  SandboxPolicy,
  SandboxStagedFile,
} from './sandbox.js';

export type SandboxGuard = 'G1' | 'G2' | 'G3' | 'G4';

export class SandboxPolicyError extends Error {
  readonly guard: SandboxGuard;
  constructor(guard: SandboxGuard, message: string) {
    super(`${guard}: ${message}`);
    this.name = 'SandboxPolicyError';
    this.guard = guard;
  }
}

/** True when `child` is `parent` itself or lives below it (resolved, no symlinks). */
export function isInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : `${p}${path.sep}`);
}

// ---------------------------------------------------------------------------
// Toolchain probe
// ---------------------------------------------------------------------------

/**
 * Directories every boundary needs. They are the loader's and the shell's
 * world (`/bin/sh`, `/lib*`, `/etc`) and contain nothing of Takumi's.
 */
export const SANDBOX_BASE_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'] as const;

/** Tools a boundary must be able to run for a step to mean anything. */
export const SANDBOX_REQUIRED_TOOLS = ['sh', 'bash', 'git', 'node'] as const;

export interface SandboxToolProbe {
  name: string;
  /** Host path the name resolves to. */
  path: string;
}

export interface SandboxToolchainProbe {
  /** Host roots safe to mirror read-only (G1-clean), in a stable order. */
  roots: string[];
  /** Candidates dropped because mirroring them would expose the project (G1). */
  dropped: Array<{ path: string; reason: string }>;
  tools: SandboxToolProbe[];
  /** Required tools that do not resolve on the host. */
  missing: string[];
}

export interface SandboxToolchainProbeOptions {
  /** Project root the mirrored toolchain must not contain. */
  cwd: string;
  requiredTools?: readonly string[];
  /** Defaults to `process.env.PATH`. */
  pathValue?: string;
  /** Injected for tests. */
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

/**
 * Resolve the read-only toolchain roots for a boundary: the base directories,
 * every PATH entry, and the real location of each required tool.
 *
 * A required tool is added through the REAL path it resolves to as well as
 * through PATH: `node` may be a symlink into a toolchain directory, and
 * a boundary that only mirrors `<home>/.local/bin` would expose a dangling
 * symlink. A PATH entry that would contain the project (G1) is dropped here
 * rather than mirrored, and the dropped entry is reported.
 */
export function probeToolchain(opts: SandboxToolchainProbeOptions): SandboxToolchainProbe {
  const exists = opts.exists ?? existsSync;
  const realpath = opts.realpath ?? ((p: string) => realpathSync(p));
  const cwd = path.resolve(opts.cwd);
  const required = [...(opts.requiredTools ?? SANDBOX_REQUIRED_TOOLS)];
  const pathValue = opts.pathValue ?? process.env.PATH ?? '';

  const pathEntries: string[] = [];
  for (const entry of pathValue.split(path.delimiter)) {
    if (entry.length === 0 || !path.isAbsolute(entry)) continue;
    const resolved = path.resolve(entry);
    if (resolved === path.sep) continue; // mirroring / is not a boundary
    if (!pathEntries.includes(resolved)) pathEntries.push(resolved);
  }

  const dropped: Array<{ path: string; reason: string }> = [];
  const droppedSeen = new Set<string>();
  const roots: string[] = [];
  const push = (candidate: string): void => {
    const resolved = path.resolve(candidate);
    if (isInside(resolved, cwd)) {
      if (!droppedSeen.has(resolved)) {
        droppedSeen.add(resolved);
        dropped.push({ path: resolved, reason: 'would mirror a directory that contains the project root (G1)' });
      }
      return;
    }
    // A path entry inside the project root is part of the platform repository
    // (`pnpm` puts `<repo>/node_modules/.bin` on PATH): mirroring it would
    // re-expose project files, which only staged files may do (G3).
    if (isInside(cwd, resolved)) {
      if (!droppedSeen.has(resolved)) {
        droppedSeen.add(resolved);
        dropped.push({ path: resolved, reason: 'would mirror a directory inside the project root (G3)' });
      }
      return;
    }
    if (exists(resolved) && !roots.includes(resolved)) roots.push(resolved);
  };

  for (const base of SANDBOX_BASE_ROOTS) push(base);
  for (const entry of pathEntries) push(entry);

  const tools: SandboxToolProbe[] = [];
  const missing: string[] = [];
  for (const name of required) {
    let found: string | undefined;
    for (const entry of pathEntries) {
      const candidate = path.join(entry, name);
      if (exists(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found === undefined) {
      missing.push(name);
      continue;
    }
    let real = found;
    try {
      real = realpath(found);
    } catch {
      real = found;
    }
    tools.push({ name, path: found });
    // Mirror the real directory too, so the symlink a PATH entry contains still
    // resolves inside the boundary.
    push(path.dirname(real));
  }

  return { roots, dropped, tools, missing };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** G1 — no read-only root may be, or contain, the project root. */
export function assertReadOnlyRootsSafe(
  policy: Pick<SandboxPolicy, 'cwd' | 'ro'> & Partial<Pick<SandboxPolicy, 'platformReadOnly'>>,
): void {
  const cwd = path.resolve(policy.cwd);
  const platformVisible = policy.platformReadOnly === true;
  for (const root of policy.ro) {
    const resolved = path.resolve(root);
    if (!path.isAbsolute(root)) {
      throw new SandboxPolicyError('G1', `read-only root "${root}" is not an absolute path`);
    }
    if (resolved === path.sep) {
      throw new SandboxPolicyError('G1', `read-only root "/" would mirror the whole host, including the project`);
    }
    if (resolved === cwd) {
      // A platform tool step may SEE this repository (it lives here), read-only. A step that is not
      // the platform may not: for it, the project root stays unmounted (ledger #79).
      if (platformVisible) continue;
      throw new SandboxPolicyError(
        'G1',
        `read-only root "${resolved}" IS the project root "${cwd}": only a platform tool step may mirror the platform repository, and read-only`,
      );
    }
    if (isInside(resolved, cwd)) {
      // Refused even for a platform tool step: a parent mirror would also re-expose SIBLINGS of the
      // project (other workspaces, other repositories), which is the leak this guard exists for.
      throw new SandboxPolicyError(
        'G1',
        `read-only root "${resolved}" contains the project root "${cwd}": mirroring it would re-expose the platform repository${platformVisible ? ' and its siblings' : ''}`,
      );
    }
  }
}

/** G2 — a read-write root is the worktree, or this run's own judge directory. */
export function assertWriteRootsSafe(
  policy: Pick<SandboxPolicy, 'cwd' | 'rw' | 'projectIsRoot' | 'runId'>,
): void {
  const cwd = path.resolve(policy.cwd);
  for (const root of policy.rw) {
    const resolved = path.resolve(root);
    if (!path.isAbsolute(root)) {
      throw new SandboxPolicyError('G2', `read-write root "${root}" is not an absolute path`);
    }
    if (policy.projectIsRoot) {
      if (resolved !== cwd) {
        throw new SandboxPolicyError(
          'G2',
          `read-write root "${resolved}" is not the project root "${cwd}" of a project-as-root boundary`,
        );
      }
      continue;
    }
    if (resolved === cwd) {
      throw new SandboxPolicyError('G2', `the project root "${cwd}" may not be a read-write root`);
    }
    if (isInside(resolved, cwd)) {
      throw new SandboxPolicyError(
        'G2',
        `read-write root "${resolved}" contains the project root "${cwd}"`,
      );
    }
    const takumiDir = path.join(cwd, '.takumi');
    if (isInside(takumiDir, resolved)) {
      const worktrees = path.join(takumiDir, 'worktrees');
      if (isInside(worktrees, resolved)) continue;
      const acceptance = path.join(takumiDir, 'acceptance');
      if (policy.runId !== undefined && isInside(path.join(acceptance, policy.runId), resolved)) continue;
      throw new SandboxPolicyError(
        'G2',
        `read-write root "${resolved}" is under ${takumiDir} but is neither a delivery worktree (${worktrees}) nor this run's judge directory (${path.join(
          acceptance,
          policy.runId ?? '<runId>',
        )})`,
      );
    }
  }
}

/** G3 — the only project paths inside are the staged files, each read-only. */
export function assertStagedFilesSafe(
  policy: Pick<SandboxPolicy, 'cwd' | 'ro' | 'staged'>,
): void {
  const cwd = path.resolve(policy.cwd);
  for (const file of policy.staged) {
    if (file.ref.length === 0 || file.ref.trim().length === 0) {
      throw new SandboxPolicyError('G3', 'a staged file has an empty ref');
    }
    if (path.isAbsolute(file.ref)) {
      throw new SandboxPolicyError('G3', `staged ref "${file.ref}" is absolute; refs are relative to the project root`);
    }
    const mirror = path.resolve(cwd, file.ref);
    if (mirror === cwd || !isInside(cwd, mirror)) {
      throw new SandboxPolicyError('G3', `staged ref "${file.ref}" escapes the project root ${cwd}`);
    }
    if (!path.isAbsolute(file.hostPath)) {
      throw new SandboxPolicyError('G3', `staged file "${file.ref}" has a non-absolute host path`);
    }
  }
  for (const root of policy.ro) {
    const resolved = path.resolve(root);
    if (isInside(cwd, resolved) && resolved !== cwd) {
      throw new SandboxPolicyError(
        'G3',
        `read-only root "${resolved}" is inside the project root ${cwd}: only staged files may be visible there`,
      );
    }
  }
}

/**
 * Host paths the boundary replaces with a private tmpfs: `/tmp`, `/dev/shm`
 * and `/var/tmp`. Anything at or under them resolves to disposable scratch
 * space inside, never to the host path.
 */
export const SANDBOX_MASKED_PREFIXES = ['/tmp', '/var/tmp', '/dev/shm'] as const;

/** The masked prefix of `p`, when it has one. */
export function maskedPrefixOf(p: string): string | undefined {
  const resolved = path.resolve(p);
  return SANDBOX_MASKED_PREFIXES.find((prefix) => isInside(prefix, resolved));
}

/**
 * G4 — a boundary that stages files may not be rooted under a masked path.
 * Measured: a project root of `/tmp/x` is *shadowed* by the boundary's own
 * `/tmp` tmpfs, so a staged read-only copy is invisible and a step silently
 * reads nothing. Without staged files the masking is harmless: the read-write
 * binds are attached after the tmpfs mounts, so they still resolve. Refresh
 * the wording of this failure whenever the masking mounts change.
 */
export function assertMirroredRootUnmasked(policy: Pick<SandboxPolicy, 'cwd' | 'staged'>): void {
  if (policy.staged.length === 0) return;
  const prefix = maskedPrefixOf(policy.cwd);
  if (prefix !== undefined) {
    throw new SandboxPolicyError(
      'G4',
      `project root "${policy.cwd}" is under ${prefix}, which this boundary mounts as a private tmpfs: ` +
        'staged files would be invisible, so harness steps would read nothing',
    );
  }
}

/** Run every guard. Throws `SandboxPolicyError` naming the guard that failed. */
export function assertSandboxPolicy(
  policy: Pick<SandboxPolicy, 'cwd' | 'ro' | 'rw' | 'staged' | 'projectIsRoot' | 'runId'> &
    Partial<Pick<SandboxPolicy, 'platformReadOnly'>>,
): void {
  if (!path.isAbsolute(policy.cwd)) {
    throw new SandboxPolicyError('G1', `project root "${policy.cwd}" is not an absolute path`);
  }
  assertMirroredRootUnmasked(policy);
  assertReadOnlyRootsSafe(policy);
  assertWriteRootsSafe(policy);
  assertStagedFilesSafe(policy);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface SandboxPolicyInput {
  /** Project root (the platform repository for a delivery run). */
  projectRoot: string;
  /** Delivery worktree exposed read-write. Omitted for a project-as-root run. */
  worktree?: string;
  /** This run's judge directory exposed read-write. */
  judgeDir?: string;
  /** Required whenever `judgeDir` is given. */
  runId?: string;
  /** Explicit read-write roots; defaults to the worktree (or the project root). */
  rw?: string[];
  /** Explicit read-only roots; defaults to the probed toolchain. */
  ro?: string[];
  /**
   * Mirror the project root READ-ONLY (a platform tool step). Default false: the project root is
   * not mirrored at all, which is what the model's seam needs.
   */
  platformReadOnly?: boolean;
  staged?: SandboxStagedFile[];
  hiddenProbe?: string;
  gitRepoProbe?: string;
  requiredTools?: readonly string[];
  limits?: Partial<SandboxLimits>;
  tmpSizeMb?: number;
  shmSizeMb?: number;
  rootSizeMb?: number;
  /** Defaults to `process.env.PATH`. */
  pathValue?: string;
  /** Injected for tests. */
  toolchain?: SandboxToolchainProbe;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  // node reserves a large address space (it will not start below ~1 GiB of
  // `ulimit -v`), so the default leaves room for the real toolchain.
  memoryMb: 2048,
  cpuSeconds: 30,
  fileSizeMb: 256,
};

function firstExisting(candidates: string[], exists: (p: string) => boolean): string | undefined {
  return candidates.find((candidate) => exists(candidate));
}

/**
 * Build a boundary policy from a run's facts and run the guards over it. The
 * policy is the only thing the mount script is rendered from, so anything the
 * guards refuse never reaches a namespace.
 */
export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const cwd = path.resolve(input.projectRoot);
  const worktree = input.worktree === undefined ? undefined : path.resolve(input.worktree);
  const judgeDir = input.judgeDir === undefined ? undefined : path.resolve(input.judgeDir);
  const projectIsRoot = worktree === undefined && input.rw === undefined;

  const toolchain =
    input.toolchain ??
    probeToolchain({
      cwd,
      requiredTools: input.requiredTools,
      pathValue: input.pathValue,
    });

  const rw =
    input.rw ??
    (projectIsRoot ? [cwd] : [worktree as string, ...(judgeDir === undefined ? [] : [judgeDir])]);
  const platformReadOnly = input.platformReadOnly === true;
  const roBase = input.ro ?? toolchain.roots;
  // The platform root is ADDED, never substituted: a platform tool still needs the toolchain.
  const ro =
    platformReadOnly && !roBase.some((r) => path.resolve(r) === cwd) ? [...roBase, cwd] : roBase;

  const hiddenProbe =
    input.hiddenProbe ??
    firstExisting([path.join(cwd, '.git'), path.join(cwd, 'package.json'), path.join(cwd, 'README.md')], existsSync);

  // A linked worktree's `.git` is a file pointing into the platform repository,
  // which is not mirrored — only a self-contained repository can be probed.
  const gitCandidate = worktree ?? (projectIsRoot ? cwd : undefined);
  const gitRepoProbe =
    input.gitRepoProbe ??
    (gitCandidate !== undefined && existsSync(path.join(gitCandidate, '.git', 'HEAD')) ? gitCandidate : undefined);

  const policy: SandboxPolicy = {
    cwd,
    projectIsRoot,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    rw,
    ro,
    platformReadOnly,
    staged: input.staged ?? [],
    ...(hiddenProbe === undefined ? {} : { hiddenProbe }),
    ...(gitRepoProbe === undefined ? {} : { gitRepoProbe }),
    requiredTools: [...(input.requiredTools ?? SANDBOX_REQUIRED_TOOLS)],
    limits: { ...DEFAULT_SANDBOX_LIMITS, ...(input.limits ?? {}) },
    tmpSizeMb: input.tmpSizeMb ?? 256,
    shmSizeMb: input.shmSizeMb ?? 64,
    rootSizeMb: input.rootSizeMb ?? 16,
  };
  assertSandboxPolicy(policy);
  return policy;
}

// ---------------------------------------------------------------------------
// Mount script rendering
// ---------------------------------------------------------------------------

/** Device nodes bound from the host (no others: `/dev` is not mirrored wholesale). */
export const SANDBOX_DEV_NODES = ['null', 'zero', 'full', 'random', 'urandom', 'tty'] as const;

/** POSIX single-quote a string, so policy data can never become shell syntax. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Directories the boundary must create inside its own root tmpfs. */
export function boundaryDirs(policy: SandboxPolicy): string[] {
  const dirs = new Set<string>(['/proc', '/dev', '/dev/shm', '/tmp', policy.cwd]);
  for (const root of [...policy.ro, ...policy.rw]) dirs.add(path.resolve(root));
  for (const file of policy.staged) dirs.add(path.dirname(path.resolve(policy.cwd, file.ref)));
  return [...dirs].sort();
}

/** The command run inside the boundary, as a single shell string. */
export function renderInnerCommand(req: { shell?: string; argv?: string[]; cwd: string }): string {
  if ((req.shell === undefined) === (req.argv === undefined)) {
    throw new Error('a step sandbox request must set exactly one of shell/argv');
  }
  if (req.argv !== undefined) {
    if (req.argv.length === 0) throw new Error('argv form needs at least one element');
    return `cd ${shQuote(req.cwd)} && exec ${req.argv.map(shQuote).join(' ')}`;
  }
  return `cd ${shQuote(req.cwd)} && ${req.shell as string}`;
}

/**
 * Render the boundary setup script. It is invoked as
 * `/bin/sh <script> <root-tmpfs-dir> <command>`, so the command travels as an
 * argv element and is never interpolated into this script.
 *
 * The ordering is the measured one for this host (util-linux 2.38.1):
 * `mount -o remount,ro <tmpfs>` is NOT supported here ("mount point not
 * mounted or bad option"), while `mount --bind $R $R` followed by
 * `mount -o remount,ro,bind $R` seals the root — and it must happen BEFORE any
 * submount exists, because a later attach keeps its own flags. So: create the
 * root, make every directory and device placeholder, stage the read-only
 * copies, seal the root, then attach the read-only binds, `/proc`, the tmpfs
 * mounts, and finally the read-write binds on top.
 */
export function renderBoundaryScript(policy: SandboxPolicy): string {
  const dirs = boundaryDirs(policy);
  const lines: string[] = [];
  lines.push('#!/bin/sh');
  lines.push('# Takumi boundary setup — generated from a validated SandboxPolicy.');
  lines.push('# $1 = boundary root directory (host tmpfs mount point), $2 = command to run.');
  lines.push('set -eu');
  lines.push('R="$1"');
  lines.push('CMD="$2"');
  lines.push('');
  lines.push('# Mounts must not propagate back to the operator: private propagation,');
  lines.push('# and a recursive make-private of the inherited tree as belt and braces.');
  lines.push('mount --make-rprivate / 2>/dev/null || true');
  lines.push('');
  lines.push('# The boundary root: a tmpfs we own, empty apart from what is listed here.');
  lines.push(`mount -t tmpfs -o size=${policy.rootSizeMb}m,mode=0755 tmpfs "$R"`);
  lines.push('');
  lines.push('# Every directory a later mount needs, created while the root is writable.');
  for (const dir of dirs) lines.push(`mkdir -p "$R${dir}"`);
  lines.push('');
  lines.push('# Device nodes are regular placeholder files: mknod needs more than a');
  lines.push('# user namespace gives. The host nodes are bound over them below.');
  lines.push(
    `for n in ${SANDBOX_DEV_NODES.join(' ')}; do : > "$R/dev/$n"; done`,
  );
  lines.push('# Process substitution (<(...)) and `read -u`/here-strings need the fd devices.');
  lines.push('# They are symlinks into the fresh /proc, created before the root is sealed.');
  lines.push('ln -sf /proc/self/fd "$R/dev/fd"');
  lines.push('ln -sf /proc/self/fd/0 "$R/dev/stdin"');
  lines.push('ln -sf /proc/self/fd/1 "$R/dev/stdout"');
  lines.push('ln -sf /proc/self/fd/2 "$R/dev/stderr"');
  lines.push('');
  if (policy.staged.length > 0) {
    lines.push('# Staged read-only copies (the requirement document, harness scripts):');
    lines.push('# snapshots taken from the host before the root is sealed, never binds.');
    for (const file of policy.staged) {
      const mirror = path.resolve(policy.cwd, file.ref);
      lines.push(`cp -f ${shQuote(file.hostPath)} "$R${mirror}"`);
      lines.push(`chmod 0444 "$R${mirror}"`);
    }
    lines.push('');
  }
  lines.push('# Seal the root read-only BEFORE any submount exists (measured pattern).');
  lines.push('mount --bind "$R" "$R"');
  lines.push('mount -o remount,ro,bind "$R"');
  lines.push('');
  lines.push('# Read-only system binds: the loader, the shell, the toolchain.');
  lines.push('# Each one is remounted read-only explicitly (measured to work), so the');
  lines.push('# guarantee does not depend on how the host happens to have them mounted.');
  for (const root of policy.ro) {
    const resolved = path.resolve(root);
    lines.push(`mount --bind ${shQuote(resolved)} "$R${resolved}"`);
    lines.push(`mount -o remount,ro,bind "$R${resolved}"`);
  }
  lines.push('');
  lines.push('# A curated /dev: only these six nodes, and the two tmpfs scratch areas.');
  for (const node of SANDBOX_DEV_NODES) lines.push(`mount --bind "/dev/${node}" "$R/dev/${node}"`);
  lines.push('mount -t proc proc "$R/proc"');
  lines.push(`mount -t tmpfs -o size=${policy.shmSizeMb}m,mode=1777 tmpfs "$R/dev/shm"`);
  lines.push(`mount -t tmpfs -o size=${policy.tmpSizeMb}m,mode=1777 tmpfs "$R/tmp"`);
  lines.push('');
  lines.push('# The tmpfs mounts above hide directories created under /tmp or /dev/shm');
  lines.push('# before they were mounted, so the whole directory list is re-created.');
  lines.push('# `mkdir -p` on a path that already exists is a no-op, including on the');
  lines.push('# read-only root.');
  for (const dir of dirs) lines.push(`mkdir -p "$R${dir}"`);
  lines.push('');
  lines.push('# Read-write binds (the delivery worktree, this run\'s judge directory).');
  for (const root of policy.rw) lines.push(`mount --bind ${shQuote(path.resolve(root))} "$R${path.resolve(root)}"`);
  lines.push('');
  lines.push('# Resource bounds. They apply to everything the command forks.');
  lines.push('ulimit -c 0 2>/dev/null || true');
  lines.push(`ulimit -v ${policy.limits.memoryMb * 1024} 2>/dev/null || true`);
  lines.push(`ulimit -t ${policy.limits.cpuSeconds} 2>/dev/null || true`);
  lines.push(`ulimit -f ${policy.limits.fileSizeMb * 2048} 2>/dev/null || true`);
  lines.push('');
  lines.push('# Service-shaped judges bind loopback; there is no route off the host.');
  lines.push('ip link set lo up 2>/dev/null || true');
  lines.push('');
  lines.push('# chroot lives in /usr/sbin, which is not on PATH here (measured).');
  lines.push('exec /usr/sbin/chroot "$R" /bin/sh -c "$CMD"');
  return `${lines.join('\n')}\n`;
}
