import { parse } from 'yaml';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  ArtifactStore,
  buildSandboxPolicy,
  discoverExtensions,
  executeWorkflow,
  renderTraceabilityMatrix,
  requirementDigest,
  sandboxCapability,
  UnshareSandbox,
  validateWorkflowManifest,
  WorkflowDefinition,
  WorkflowStepResult,
} from '@takumi/core';
import type { SandboxCapability, SandboxRoots, SandboxStagedFile, StepSandbox } from '@takumi/core';
import { AgentRuntimeAdapter, AgentTask, runTaskAndCollect } from '@takumi/core';
import { FakeRuntime } from '@takumi/runtime-fake';
import { CliRuntimeAdapter } from '@takumi/runtime-cli';
import { createDeliveryFromSection, workflowNeedsHost } from './delivery-command.js';
import type { DeliveryProviderWithReporting, DeliverySection } from './delivery-command.js';
import { createBoardFromSection } from './board-projection-command.js';
import type { BoardSection } from './board-projection-command.js';
import { assertWorktreeQualifies, createDeliveryWorktree } from './worktree-command.js';

/**
 * Interactive approval gate. Prompts the user with [a] approve / [r] reject /
 * [v] view. Auto-approves when stdin is not a TTY (pipelines, CI).
 * `input` is injectable for tests (defaults to process.stdin).
 */
export async function interactiveApprove(
  stepId: string,
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<boolean> {
  const isTTY = (input as { isTTY?: boolean }).isTTY;
  // Non-interactive (pipe/CI): auto-approve, still record the decision.
  if (!isTTY) {
    console.log(`  [auto] ${stepId} approved (non-interactive)`);
    return true;
  }

  console.log('');
  console.log(`  🔒 Approval required — ${stepId}`);
  console.log(`    ${prompt.split('\n')[0] ?? ''}`);
  console.log('    [a] approve   [r] reject   [v] view prompt');

  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: input as NodeJS.ReadableStream, output: process.stdout });
    rl.setPrompt('    > ');
    rl.prompt();
    rl.on('line', (line) => {
      const inputStr = line.trim().toLowerCase();
      if (inputStr === 'a' || inputStr === 'approve' || inputStr === 'y' || inputStr === 'yes') {
        rl.close();
        resolve(true);
      } else if (inputStr === 'r' || inputStr === 'reject' || inputStr === 'n' || inputStr === 'no') {
        rl.close();
        resolve(false);
      } else if (inputStr === 'v' || inputStr === 'view') {
        console.log(`\n  --- prompt ---\n${prompt}\n  --- end ---`);
        rl.prompt();
      } else {
        console.log('    type a (approve), r (reject), or v (view)');
        rl.prompt();
      }
    });
  });
}

export interface ProjectConfig {
  runtime: string;
  registry: {
    skills: string;
    tools: string;
    workflows: string;
    runtimes: string;
    /** Where task-board providers are discovered from (ADR-006). */
    boards?: string;
    /** Where delivery providers are discovered from (ADR-007). */
    deliveries?: string;
  };
  artifacts: string;
  /**
   * The host a `publish` step publishes through (ADR-007 / ADR-037), selected by configuration.
   * Absent means a workflow that declares a `publish` step is refused BEFORE the run starts: a run
   * that spends its work and only then discovers it cannot publish is the failure that refusal
   * exists to prevent.
   */
  delivery?: DeliverySection;
  /**
   * The DELIVERY board a run projects its progress onto (ADR-044): the write-only row a human reads,
   * one per delivery run. Absent means the run projects nowhere — which is not an error: the
   * projection is for readers, and a run nobody is watching is still a run. It is NOT the task board
   * (that is the `pilot:` section's business): a black-box run has no work to find or claim.
   */
  board?: BoardSection;
  /** Audit trail dir (default `.takumi/audit`). */
  audit?: string;
  /**
   * The unattended runner (ADR-009). Present only in a project that runs a pilot:
   * everything here is a deployment decision, so none of it has a default that could
   * silently start working on the wrong repository.
   */
  pilot?: {
    repo: string;
    worktreeRoot: string;
    slotDir: string;
    baseBranch: string;
    remote?: string;
    board: string;
    boardOptions?: Record<string, string>;
    delivery: string;
    deliveryOptions?: Record<string, string>;
    agent: { command: string; args?: string[]; timeoutSeconds?: number; env?: Record<string, string> };
    policy: { reviewMode: 'checks-only' | 'label' | 'rules'; reviewRules?: { forbidTestWeakening?: boolean; protectedPaths?: string[]; replaceProtectedPaths?: boolean; testPathPatterns?: string[]; testOnlyChange?: 'note' | 'block' | 'ignore' }; approvalLabel?: string; maxReviewRounds?: number; retainWorktreesHours?: number; agentRetries?: number; agentRetryDelaySeconds?: number; blockStaleClaims?: boolean; staleClaimSeconds?: number; checksWaitSeconds?: number; checksPollSeconds?: number; mergeabilityReads?: number; mergeabilityReadSeconds?: number; progressIntervalSeconds?: number; fileIssueOnExhaustedChecks?: boolean; scopeQuery?: string };
    /**
     * Write-only projections of the primary board (ADR-017): the board OTHER people look at
     * (a Notion database, a second Redmine project). The primary stays the authority — reading,
     * claiming and every decision — and a mirror only ever receives state and comments. A mirror
     * failure is loud (`mirror.failed`) and never fails the work.
     */
    boardMirrors?: Array<{
      /** The name used in events and in the id map, e.g. `notion`. */
      id: string;
      /** A board provider id (the same ones `takumi board --provider` accepts). */
      provider: string;
      /** Provider options, named as the provider documents them (e.g. `{ databaseId: '<notion id>' }`). */
      options?: Record<string, string>;
      /** Where the id map (a CACHE, rebuildable with `pilot --resync`) is kept. */
      idMapFile?: string;
      /**
       * Project the primary's labels onto this mirror. Default true.
       *
       * Set FALSE for a mirror whose board has no labels column: such a board refuses a labelled
       * create (fail-closed, `precondition`), which is loud but leaves the mirror empty until an
       * operator decides. Saying so here — once — is that decision.
       */
      labels?: boolean;
    }>;
    /**
     * WHICH reviewer judges a `rules` delivery (ADR-021). `rules` (the default) is the built-in
     * deterministic engine; `semgrep` is the pinned sidecar, composed with the built-in rules unless
     * `composeDeterministic: false`. There is deliberately no default that reaches the network.
     */
    reviewer?: 'rules' | 'semgrep';
    /** Where the findings are SHOWN (ADR-022): `reviewdog` posts them on the host's review surface. */
    reporter?: 'reviewdog';
    reviewdog?: {
      reporter?: string;
      filterMode?: 'added' | 'diff_context' | 'file' | 'nofilter';
      name?: string;
      binary?: string;
      timeoutSeconds?: number;
    };
    semgrep?: {
      /** The PINNED rule set. Required for `reviewer: semgrep` — there is no `--config auto` path. */
      configPath: string;
      /** The tool version this rule set was written against. A mismatch fails closed. */
      expectedVersion?: string;
      binary?: string;
      composeDeterministic?: boolean;
      severityMap?: Record<string, 'block' | 'human' | 'note'>;
      maxFindings?: number;
      timeoutSeconds?: number;
    };
    eventsFile?: string;
    /** Counters (JSON), and a Prometheus textfile beside it for whatever scrapes it. */
    metricsFile?: string;
    metricsTextfile?: string;
  };
}

/** True for a YAML mapping (`{...}`): an object that is not an array and not null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One key a local override changed: its dotted path, and whether it was set or cleared. */
export interface ConfigOverrideChange {
  path: string;
  kind: 'set' | 'cleared';
}

/**
 * Recursively merge a local override over the base config, recording what it changed.
 *
 * Objects merge key by key; every other value (a scalar, an array) is REPLACED by the local value, and an
 * explicit `null` CLEARS the key — it is removed from the merged config entirely, so an inherited value
 * cannot survive. That last rule exists because OMITTING a key does not clear it (the merge is PER KEY): an
 * operator who wanted to drop the committed Forgejo placeholder `apiBase` wrote a local file without it,
 * silently inherited the placeholder anyway, and live runs failed closed against it (docs/bugs-fixed.md
 * #47). `apiBase: null` is now how one says "there is no apiBase" — and the change is reported, so the
 * transcript names the keys rather than merely saying a local file was merged.
 */
export function mergeConfigWithChanges(
  base: unknown,
  override: unknown,
): { merged: unknown; changes: ConfigOverrideChange[] } {
  const changes: ConfigOverrideChange[] = [];
  return { merged: mergeInto(base, override, '', changes), changes };
}

/** The recursion behind {@link mergeConfigWithChanges}; `prefix` is the dotted path so far. */
function mergeInto(base: unknown, override: unknown, prefix: string, changes: ConfigOverrideChange[]): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (value === null) {
      // An explicit null CLEARS the key: it leaves the merged config entirely, so an inherited value
      // (the committed placeholder host, for one) cannot survive a local file that meant to drop it.
      if (key in merged) {
        delete merged[key];
        changes.push({ path, kind: 'cleared' });
      }
      continue;
    }
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      merged[key] = mergeInto(base[key], value, path, changes);
    } else {
      merged[key] = value;
      changes.push({ path, kind: 'set' });
    }
  }
  return merged;
}

/**
 * Recursively merge a local override over the base config.
 *
 * Kept as the plain entry point (its result is the merged config only); {@link mergeConfigWithChanges}
 * additionally reports which keys the override set or cleared, which the loader prints.
 */
export function mergeConfig(base: unknown, override: unknown): unknown {
  return mergeConfigWithChanges(base, override).merged;
}

/** `set a, b; cleared c` — the keys a local override changed, for the loader's one-line report. */
function describeOverrideChanges(changes: ConfigOverrideChange[]): string {
  const set = changes.filter((c) => c.kind === 'set').map((c) => c.path).sort();
  const cleared = changes.filter((c) => c.kind === 'cleared').map((c) => c.path).sort();
  const parts: string[] = [];
  if (set.length > 0) parts.push(`set ${set.join(', ')}`);
  if (cleared.length > 0) parts.push(`cleared ${cleared.join(', ')}`);
  return parts.length === 0 ? 'no keys changed' : parts.join('; ');
}

/**
 * The project config: `takumi.yaml`, with an optional `takumi.local.yaml` merged OVER it.
 *
 * The committed file is the SHAREABLE example — it names placeholder hosts
 * (`forgejo.internal.invalid`), never an operator's real endpoint. An operator who needs the real
 * one keeps it in `takumi.local.yaml` (gitignored), which is merged over the committed file before
 * the config is used: objects merge recursively, scalars and arrays are replaced by the local
 * value, and an explicit `null` CLEARS an inherited key (omitting it does NOT — the merge is per key).
 * Applying it prints exactly ONE line, naming the file AND the keys the override set or cleared, so a
 * run's transcript records that the effective config was not the committed one and WHICH parts of it
 * came from where. A local file that exists but cannot be read as a mapping fails LOUDLY: silently
 * ignoring it would run the whole thing against the committed placeholders while the operator believed
 * their real endpoint was in use.
 */
export function loadConfig(cwd: string): ProjectConfig {
  const p = join(cwd, 'takumi.yaml');
  if (!existsSync(p)) {
    throw new Error(`no takumi.yaml found in ${cwd} — run "takumi init" first`);
  }
  const base = parse(readFileSync(p, 'utf8')) as unknown;
  const localPath = join(cwd, 'takumi.local.yaml');
  if (!existsSync(localPath)) {
    return base as ProjectConfig;
  }
  let local: unknown;
  try {
    local = parse(readFileSync(localPath, 'utf8'));
  } catch (err) {
    throw new Error(`takumi.local.yaml in ${cwd} is not valid YAML: ${(err as Error).message}`);
  }
  if (!isPlainObject(local)) {
    throw new Error(
      `takumi.local.yaml in ${cwd} must contain a YAML mapping (an object), not ` +
        `${local === null ? 'null' : typeof local}`,
    );
  }
  const { merged, changes } = mergeConfigWithChanges(base, local);
  console.log(
    `  [config] local override applied: ${localPath} (merged over takumi.yaml): ${describeOverrideChanges(changes)}`,
  );
  return merged as ProjectConfig;
}

/**
 * The HUMAN-ONLY escape hatch (ADR-058 decision 2). It is read from the process
 * environment and from nothing else: no CLI flag, no `takumi.yaml` key and no
 * workflow step can set it, so an agent or a step cannot turn the boundary off
 * for the run it is part of. A value other than exactly `1` is not the override.
 */
export const UNSAFE_NO_SANDBOX_ENV = 'TAKUMI_UNSAFE_NO_SANDBOX';

/** True only when a human operator launched this process with the override set. */
export function unsafeNoSandboxSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UNSAFE_NO_SANDBOX_ENV] === '1';
}

/** What the preflight decided about confinement, before any step runs. */
export type SandboxDecision =
  | { mode: 'none'; note: string }
  | { mode: 'unshare' }
  | { mode: 'unsafe-override'; note: string; warning: string }
  | { mode: 'refused'; reason: string; message: string };

/**
 * Decide confinement from facts alone, so the fail-closed behaviour is a pure,
 * tested rule rather than a branch buried in the run path.
 *
 *  - a DELIVERY run (a worktree) is confined by default; `--sandbox none` on it
 *    is refused, because the only sanctioned bypass is the human-only override;
 *  - `--sandbox unshare` confines even a run without a worktree;
 *  - when confinement is intended but the host cannot establish the boundary,
 *    the run is REFUSED unless the human-only override is set — in which case it
 *    runs unconfined and says so, loudly and in the record.
 */
export function decideSandbox(input: {
  worktree?: string | undefined;
  sandbox?: 'none' | 'unshare' | undefined;
  capability: Pick<SandboxCapability, 'available' | 'reason'>;
  unsafeOverride: boolean;
}): SandboxDecision {
  const { worktree, sandbox, capability } = input;
  if (worktree !== undefined && sandbox === 'none' && !input.unsafeOverride) {
    return {
      mode: 'refused',
      reason: 'explicit_none_on_delivery_run',
      message:
        '--sandbox none is not permitted for a delivery run: the boundary is the whole point of a ' +
        `delivery. Use the boundary, or (human only) set ${UNSAFE_NO_SANDBOX_ENV}=1 to run without it ` +
        'and have the override recorded.',
    };
  }
  if (input.unsafeOverride) {
    return {
      mode: 'unsafe-override',
      note: 'none (unsafe override)',
      warning:
        `${UNSAFE_NO_SANDBOX_ENV}=1 is set: running WITHOUT a sandbox boundary. ` +
        'This is a human-only override and is recorded in this run\'s record and audit.',
    };
  }
  const confine = sandbox === 'unshare' || worktree !== undefined;
  if (!confine) return { mode: 'none', note: 'none' };
  if (!capability.available) {
    const reason = capability.reason ?? 'unknown';
    return {
      mode: 'refused',
      reason,
      message:
        `sandbox refused: the boundary cannot be established on this host (${reason}); no step was run. ` +
        `A human operator may set ${UNSAFE_NO_SANDBOX_ENV}=1 to run without it, which is recorded.`,
    };
  }
  return { mode: 'unshare' };
}

/**
 * The project files a boundary must make readable for the run's HARNESS steps.
 *
 * A `judge_forge` runs `bash <cwd>/<forgeRef>` and reads `<cwd>/<requirementRef>`; an
 * `acceptance` runs `bash <resolved acceptanceRef>`. Those live in the platform repository,
 * which is otherwise not mounted, so each is staged as a READ-ONLY copy at its mirror path.
 * Refs that are placeholders (`{requirement}`, `{judgePath}`) are resolved at run time and
 * are never staged. A ref that does not exist on the host is skipped here and fails in the
 * step, which is where a missing harness should be named.
 */
export function collectStagedRefs(
  workflow: WorkflowDefinition,
  confirmedRequirement: { ref: string } | undefined,
  cwd: string,
): SandboxStagedFile[] {
  const refs = new Set<string>();
  if (confirmedRequirement !== undefined && confirmedRequirement.ref.trim().length > 0) {
    refs.add(confirmedRequirement.ref.trim());
  }
  for (const step of workflow.steps) {
    for (const raw of [step.requirementRef, step.forgeRef, step.acceptanceRef]) {
      if (typeof raw !== 'string') continue;
      const ref = raw.trim();
      if (ref.length === 0 || ref.includes('{')) continue;
      refs.add(ref);
    }
  }
  const staged: SandboxStagedFile[] = [];
  for (const ref of refs) {
    const hostPath = join(cwd, ref);
    if (existsSync(hostPath)) staged.push({ ref, hostPath });
  }
  return staged;
}

/**
 * Build the boundary for a confined run. The judge directory is this run's own
 * `acceptance/<runId>` tree (the engine creates `<stepId>` under it), created here
 * because the boundary bind needs it to exist. The platform repository is not a
 * root; only the worktree and the judge tree are read-write.
 */
export function prepareRunSandbox(input: {
  cwd: string;
  runId: string;
  worktree?: string | undefined;
  staged: SandboxStagedFile[];
}): { sandbox: StepSandbox; roots: SandboxRoots } {
  const judgeRoot = join(input.cwd, '.takumi', 'acceptance', input.runId);
  mkdirSync(judgeRoot, { recursive: true });
  const policy =
    input.worktree === undefined
      ? buildSandboxPolicy({ projectRoot: input.cwd })
      : buildSandboxPolicy({
          projectRoot: input.cwd,
          worktree: input.worktree,
          judgeDir: judgeRoot,
          runId: input.runId,
          staged: input.staged,
        });
  return {
    sandbox: new UnshareSandbox(policy),
    roots: { rw: [...policy.rw], ro: [...policy.ro], cwd: policy.cwd },
  };
}

/**
 * Runtime registry: resolve a runtime id to an AgentRuntimeAdapter.
 *
 * Built-ins: "fake" (deterministic). "pi" (real Pi AgentSession) is OPT-IN —
 * it depends on the unpublished @earendil-works/pi-coding-agent SDK, so it is
 * dynamically imported and reports BLOCKED_BY_EXTERNAL_DEPENDENCY when absent
 * (never a fake stand-in). "cli:<command>" bridges ANY external harness CLI
 * (the harness-agnostic third-runtime seam that Gate 24/31 require).
 */
export async function resolveRuntime(id: string, sandbox?: 'none' | 'unshare'): Promise<AgentRuntimeAdapter> {
  if (id === 'fake') {
    return new FakeRuntime();
  }
  if (id.startsWith('cli:')) {
    const cmd = id.slice(4);
    if (!cmd) throw new Error('cli: runtime requires a command, e.g. --runtime cli:echo');
    return new CliRuntimeAdapter({ id: `cli-${cmd}`, name: `CLI (${cmd})`, command: cmd });
  }
  if (id === 'pi') {
    try {
      // Opt-in Pi runtime. Resolution order:
      //  1) explicit path via TAKUMI_PI_RUNTIME (skip module resolution)
      //  2) '@takumi/runtime-pi' from the project's node_modules
      // The pi package depends on the unpublished @earendil-works SDK, so it
      // is NOT a workspace member; it must be installed per-project (or its
      // built output pointed at directly) on a machine that has the SDK.
      const explicit = process.env.TAKUMI_PI_RUNTIME;
      const mod = explicit ?? '@takumi/runtime-pi';
      const m = (await import(mod)) as { PiRuntimeAdapter: new () => AgentRuntimeAdapter };
      return new m.PiRuntimeAdapter();
    } catch {
      throw new Error(
        `runtime "pi" is not available (BLOCKED_BY_EXTERNAL_DEPENDENCY). ` +
          `It requires the unpublished @earendil-works/pi-coding-agent SDK. ` +
          `Set up the pi package (cd runtimes/pi && pnpm install && pnpm build) then either ` +
          `install it into this project (npm i @takumi/runtime-pi) or point TAKUMI_PI_RUNTIME at its dist: ` +
          `TAKUMI_PI_RUNTIME=/abs/path/to/runtimes/pi/dist/index.js`,
      );
    }
  }
  if (id === 'deepseek') {
    try {
      // DeepSeek Harness runtime (OpenAI-compatible tool loop via
      // commandcode.ai). Pure HTTP — no private SDK — so it is a workspace
      // member and installable everywhere. Key from COMMANDCODE_API_KEY env
      // or the custom:commandcode credential pool.
      const m = (await import('@takumi/runtime-deepseek')) as {
        DeepSeekRuntimeAdapter: new (opts?: { sandbox?: 'none' | 'unshare' }) => AgentRuntimeAdapter;
      };
      return new m.DeepSeekRuntimeAdapter({ sandbox });
    } catch {
      throw new Error(
        `runtime "deepseek" is not available. It is a workspace member — run ` +
          `pnpm install && pnpm -C runtimes/deepseek build. Requires COMMANDCODE_API_KEY ` +
          `(or apiKey option) for ${'deepseek/deepseek-v4-flash'}`,
      );
    }
  }
  throw new Error(`unknown runtime "${id}" (available: fake, pi, deepseek, cli:<command>)`);
}

/** Load a workflow extension from the project's workflows registry dir by name. */
export async function loadWorkflow(cwd: string, config: ProjectConfig, name: string): Promise<WorkflowDefinition> {
  const dir = join(cwd, config.registry.workflows, name);
  const manifest = existsSync(join(dir, 'workflow.yaml'))
    ? join(dir, 'workflow.yaml')
    : existsSync(join(dir, 'workflow.json'))
      ? join(dir, 'workflow.json')
      : null;
  if (!manifest) {
    throw new Error(`workflow "${name}" not found in ${dir} (need workflow.yaml or workflow.json)`);
  }
  const raw = readFileSync(manifest, 'utf8');
  const def = (manifest.endsWith('.json') ? JSON.parse(raw) : parse(raw)) as WorkflowDefinition;
  if (!def.name || !def.steps) {
    throw new Error(`invalid workflow manifest at ${manifest}: missing name or steps`);
  }
  // The engine dispatches on step type; refusing an unknown one here means a
  // typo fails at load with the allowed list instead of silently behaving like
  // an agent step. A rule_review with no baseRef is refused for the same reason:
  // a review with no base is not a review.
  const issues = validateWorkflowManifest(def);
  if (issues.length > 0) {
    const detail = issues.map((issue) => (issue.stepId === undefined ? issue.message : `${issue.stepId}: ${issue.message}`)).join('; ');
    throw new Error(`invalid workflow manifest at ${manifest}: ${detail}`);
  }
  return def;
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  runtimeId: string;
  workflow?: string;
  config: ProjectConfig;
  /** Stream workflow step events to stdout as they happen. */
  verbose?: boolean;
  /** Sandbox mode for runtimes that support it ('none' | 'unshare'). */
  sandbox?: 'none' | 'unshare';
  /** Durable resume: continue from the last audit record's completed steps. */
  resume?: boolean;
  /**
   * ADR-025: the requirement digest a human confirmed, and the ref it covers. Required by a workflow
   * that runs an `acceptance` step — the step refuses to accept a document that does not hash to it.
   */
  confirmedRequirement?: { ref: string; digest: string };
  /**
   * ADR-026: where the implementation is produced, when that is not the run's own directory. The
   * judge must live outside it, and naming it is what makes that separation assertable.
   */
  worktree?: string;
  /**
   * The runtime to run with, when the caller already has one. Absent means the run resolves one from
   * `runtimeId`, which is the CLI's own path.
   *
   * The run RELEASES whichever runtime it used (`close?.()`), so an injected runtime is released exactly
   * like a resolved one: a test can assert the contract directly instead of inferring it from a process
   * that happens to exit, and an embedding caller knows who owns the teardown.
   */
  runtime?: AgentRuntimeAdapter;
}

export interface RunTaskResult {
  events: string[];
  summary: string;
  artifacts: string[];
  traceabilityMatrix?: string;
  /** The workflow's own outcome. Absent on the plain (non-workflow) path. */
  status?: 'completed' | 'failed' | 'cancelled';
}

/**
 * Run one task, and RELEASE the runtime afterwards — on every path.
 *
 * The release is not cosmetic. A runtime holds real resources (the pi adapter pools a live
 * `AgentSession` so that a retry is cheap), and nothing closed it, so a process that had finished its
 * work kept its event loop alive: measured 2026-10-12, a real `request-intake` run ended at 01:23:10Z
 * with its record and artifact written, and the CLI was still alive at 01:25:30Z — an earlier
 * foreground invocation had to be killed at 600 s. A supervisor sequences unattended runs by waiting
 * for an EXIT, so a run that never exits cannot be sequenced, retried or measured. `finally` because a
 * FAILED run is exactly when the operator wants the process back.
 */
export async function runTask(opts: RunOptions): Promise<RunTaskResult> {
  const runtime = opts.runtime ?? (await resolveRuntime(opts.runtimeId, opts.sandbox));
  try {
    return await runWithRuntime(opts, runtime);
  } finally {
    runtime.close?.();
  }
}

async function runWithRuntime(opts: RunOptions, runtime: AgentRuntimeAdapter): Promise<RunTaskResult> {
  const store = new ArtifactStore(join(opts.cwd, opts.config.artifacts));
  const events: string[] = [];

  /** Persist an audit trail for the run (Gate 19: auditable execution). */
  const writeAudit = async (payload: Record<string, unknown>) => {
    try {
      const fs = await import('node:fs/promises');
      const dir = join(opts.cwd, opts.config.audit ?? '.takumi/audit');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
        JSON.stringify({ ...payload, events, ts: Date.now() }, null, 2),
        'utf8',
      );
    } catch {
      // audit is best-effort; never fail the run over logging
    }
  };

  if (opts.workflow) {
    const wf = await loadWorkflow(opts.cwd, opts.config, opts.workflow);
    // THE FRONT DOOR (ADR-037). A workflow that declares a `publish` step needs a host to publish
    // to, and that host comes from `takumi.yaml`. Building it here — before any step runs — is the
    // whole point: the alternative is a run that spends its work (and an agent's money) and only
    // then discovers it cannot publish. An invalid section (an unknown provider, a missing repo)
    // refuses here too, naming what is wrong.
    const publishSteps = wf.steps.filter((s) => s.type === 'publish').map((s) => s.id);
    let delivery: DeliveryProviderWithReporting | undefined;
    const deliverySection = opts.config.delivery;
    if (deliverySection !== undefined) {
      // The token is required up front only when this workflow ever TALKS TO THE HOST (ADR-051):
      // `request-intake` produces a document and stops, and refusing it for a missing GITHUB_TOKEN would
      // make the front of the chain impossible without a credential the run never uses.
      delivery = await createDeliveryFromSection(deliverySection, { requireToken: workflowNeedsHost(wf.steps) });
    } else if (publishSteps.length > 0) {
      throw new Error(
        `workflow "${wf.name}" declares a publish step [${publishSteps.join(', ')}] but takumi.yaml has no ` +
          '`delivery:` section: there is no host to publish to, and the run would discover that only after ' +
          'spending its work. Add a `delivery:` section naming the provider and its options ' +
          '(e.g. `delivery: { provider: forgejo, repo: owner/name }`).',
      );
    }

    // The DELIVERY board (ADR-044): write-only, injected exactly like `ctx.delivery`. Built here,
    // before any step runs, so an invalid `board:` section (an unknown provider, a missing databaseId)
    // refuses up front rather than after the run has spent its work. Absent means the run projects
    // nowhere, which is not an error — the projection is for readers, and a run nobody is watching is
    // still a run.
    const board = opts.config.board === undefined ? undefined : await createBoardFromSection(opts.config.board);

    // (B)/(C) THE WORKTREE. `--worktree` is an EXPLICIT OVERRIDE for an existing checkout
    // (continuing an existing branch, an advanced case); with a configured `delivery:` and no
    // `--worktree`, the run CREATES its own worktree from the target repository, so the ancestry
    // the publish step checks holds by construction and the implementer sees the real repository
    // (docs/bugs-fixed.md #43). Both branches of this decision happen BEFORE `executeWorkflow`: a
    // run that spends its work and only then discovers it cannot publish is the failure both fixes
    // exist to prevent.
    const deliveryRemote = deliverySection?.remote ?? 'origin';
    const deliveryBaseBranch = deliverySection?.baseBranch ?? 'main';
    let worktreePath = opts.worktree;
    if (worktreePath !== undefined) {
      // Only a run that will use the delivery boundary needs a qualifying worktree; a workflow
      // that declares no publish step with no `delivery:` section is unchanged from before.
      if (delivery !== undefined || publishSteps.length > 0) {
        await assertWorktreeQualifies({ worktree: worktreePath, remote: deliveryRemote, baseBranch: deliveryBaseBranch });
      }
    } else if (deliverySection !== undefined && publishSteps.length > 0) {
      const created = await createDeliveryWorktree({ cwd: opts.cwd, section: deliverySection });
      worktreePath = created.path;
      const line = `worktree: created ${created.path} (branch ${created.branch}, cloned from ${created.cloneUrl})`;
      events.push(line);
      if (opts.verbose) console.log(`  ${line}`);
    }

    // (D) THE BOUNDARY (ADR-058). Decided BEFORE the first step: a delivery run whose
    // boundary cannot be established is refused here, and the only sanctioned bypass is
    // the human-only environment override, recorded loudly and in this run's record.
    const confineIntended =
      opts.sandbox === 'unshare' || (worktreePath !== undefined && opts.sandbox !== 'none');
    const capability = confineIntended ? await sandboxCapability() : { available: false };
    const decision = decideSandbox({
      worktree: worktreePath,
      sandbox: opts.sandbox,
      capability,
      unsafeOverride: unsafeNoSandboxSet(),
    });
    let sandbox: StepSandbox | undefined;
    let sandboxRoots: SandboxRoots | undefined;
    let sandboxNote = 'none';
    let runId: string | undefined;
    if (decision.mode === 'refused') {
      events.push(decision.message);
      console.error(`\n\u2717 ${decision.message}\n`);
      await writeAudit({
        kind: 'workflow',
        workflow: opts.workflow,
        runtimeId: opts.runtimeId,
        status: 'failed',
        sandbox: { mode: 'refused', reason: decision.reason },
        steps: [],
      });
      return { events, summary: decision.message, artifacts: [], status: 'failed' };
    }
    if (decision.mode === 'unsafe-override') {
      console.warn(`\n\u26a0 ${decision.warning}\n`);
      events.push(decision.warning);
      sandboxNote = decision.note;
    } else if (decision.mode === 'unshare') {
      runId = `wf-${randomUUID().slice(0, 8)}`;
      const prepared = prepareRunSandbox({
        cwd: opts.cwd,
        runId,
        worktree: worktreePath,
        staged: collectStagedRefs(wf, opts.confirmedRequirement, opts.cwd),
      });
      sandbox = prepared.sandbox;
      sandboxRoots = prepared.roots;
      sandboxNote = 'unshare';
      const line = `sandbox: unshare boundary (run ${runId})`;
      events.push(line);
      if (opts.verbose) console.log(`  ${line}`);
    }
    // Durable resume: rebuild completed steps from the newest audit record.
    let resumeCtx: { completed: Map<string, WorkflowStepResult> } | undefined;
    if (opts.resume) {
      const fs = await import('node:fs');
      const { readdirSync } = fs;
      const auditDir = join(opts.cwd, opts.config.audit ?? '.takumi/audit');
      let latest: string | undefined;
      try {
        const files = readdirSync(auditDir).filter((f) => f.endsWith('.json')).sort();
        latest = files.length > 0 ? join(auditDir, files[files.length - 1]!) : undefined;
      } catch {
        latest = undefined;
      }
      if (latest) {
        const rec = JSON.parse(fs.readFileSync(latest, 'utf8')) as { steps?: { stepId: string; status: string; summary: string }[] };
        const completed = new Map<string, WorkflowStepResult>();
        for (const s of rec.steps ?? []) {
          if (s.status === 'completed') {
            completed.set(s.stepId, { stepId: s.stepId, status: 'completed' as const, summary: s.summary ?? '(resumed)', artifacts: [], tests: [] });
          }
        }
        resumeCtx = { completed };
        events.push(`resume: ${completed.size} completed step(s) from ${latest}`);
        if (opts.verbose) console.log(`  resume: ${completed.size} completed step(s) from ${latest}`);
      } else {
        events.push('resume: no audit record found — starting fresh');
      }
    }
    const result = await executeWorkflow(
      wf,
      {
        cwd: opts.cwd,
        runtime,
        artifacts: store,
        skillsRoot: join(opts.cwd, opts.config.registry.skills),
        // A `repair` step's sub-workflow is loaded by name out of the project's workflow registry, the
        // same way the outer workflow was (ADR-034). The loader is injected rather than imported so the
        // engine keeps no opinion about where a project keeps its workflows.
        loadWorkflow: (ref: string) => loadWorkflow(opts.cwd, opts.config, ref),
        resume: resumeCtx,
        ...(delivery === undefined ? {} : { delivery }),
        ...(board === undefined ? {} : { board }),
        // The `publish` step falls back to these when the step itself declares neither: the base
        // branch and remote are deployment decisions, so a project names them once in takumi.yaml
        // rather than in every workflow.
        ...(opts.config.delivery === undefined
          ? {}
          : {
              deliveryDefaults: {
                ...(opts.config.delivery.baseBranch === undefined ? {} : { baseBranch: opts.config.delivery.baseBranch }),
                ...(opts.config.delivery.remote === undefined ? {} : { remote: opts.config.delivery.remote }),
              },
            }),
        ...(opts.confirmedRequirement === undefined ? {} : { confirmedRequirement: opts.confirmedRequirement }),
        ...(worktreePath === undefined ? {} : { worktree: worktreePath }),
        ...(sandbox === undefined ? {} : { sandbox }),
        ...(sandboxRoots === undefined ? {} : { sandboxRoots }),
        ...(runId === undefined ? {} : { runId }),
        sandboxNote,
        onApproval: async (req) => {
          const line = `approval required [${req.stepId}]: ${req.prompt}`;
          events.push(line);
          if (opts.verbose) console.log(`  ${line}`);
          return interactiveApprove(req.stepId, req.prompt);
        },
        onEvent: (stepId, message) => {
          const line = `workflow[${stepId}]: ${message}`;
          events.push(line);
          if (opts.verbose) console.log(`  ${line}`);
        },
      },
      { input: opts.prompt },
    );
    for (const s of result.steps) {
      events.push(`step ${s.stepId}: ${s.status} — ${s.summary}`);
    }
    // Traceability matrix from artifacts produced during the run.
    let matrix = '';
    try {
      const artifacts = await store.list();
      if (artifacts.length > 0) {
        matrix = renderTraceabilityMatrix(artifacts);
      }
    } catch {
      matrix = '';
    }
    await writeAudit({
      kind: 'workflow',
      workflow: opts.workflow,
      runtimeId: opts.runtimeId,
      status: result.status,
      sandbox: sandboxNote,
      steps: result.steps.map((s) => ({ stepId: s.stepId, status: s.status, summary: s.summary })),
    });
    return {
      events,
      summary: `workflow "${opts.workflow}" ${result.status}`,
      artifacts: result.steps.flatMap((s) => s.artifacts),
      traceabilityMatrix: matrix,
      status: result.status,
    };
  }

  // A minimal workflow (or the plain run path) — Phase 4 will formalize this.
  const task: AgentTask = {
    id: `task-${Date.now()}`,
    prompt: opts.prompt,
    cwd: opts.cwd,
    trace: [],
  };

  const result = await runTaskAndCollect(runtime, task, (ev) => {
    events.push(`${ev.type}${ev.name ? ` (${ev.name})` : ''}${ev.message ? `: ${ev.message}` : ''}`);
  });

  // Persist artifacts (empty for fake runtime; real runtimes fill this).
  for (const art of result.artifacts) {
    events.push(`artifact: ${art.path}`);
  }

  await writeAudit({
    kind: 'task',
    runtimeId: opts.runtimeId,
    status: result.status,
    summary: result.summary,
  });
  return {
    events,
    summary: result.summary,
    artifacts: result.artifacts.map((a) => a.path),
  };
}

/**
 * The process exit code for a run. A workflow that FAILED (or was cancelled) is
 * not a success: before this, the CLI printed `✓ workflow "<name>" failed` and
 * exited 0, so a CI job could not tell a failed delivery from a green one, and a
 * failed black-box acceptance looked like a shipped feature. The plain
 * (non-workflow) path has no workflow outcome and stays 0.
 */
export function workflowExitCode(status?: 'completed' | 'failed' | 'cancelled'): number {
  return status === undefined || status === 'completed' ? 0 : 1;
}

/**
 * The confirmation token for a requirement document (ADR-025): the ref and the digest of its text.
 * Printing it is how a human gets something concrete to confirm; passing it back into a run is how
 * the acceptance step proves the document it judged is still the one that was confirmed.
 */
export function requirementConfirmation(cwd: string, ref: string): { ref: string; digest: string } {
  const path = join(cwd, ref);
  if (!existsSync(path)) {
    throw new Error(`the requirement document "${ref}" does not exist in ${cwd}`);
  }
  return { ref, digest: requirementDigest(readFileSync(path, 'utf8')) };
}

/** List extensions from the registry dirs in the project config. */
export async function listExtensions(
  config: ProjectConfig,
  cwd: string,
  kind?: 'skill' | 'tool' | 'workflow' | 'runtime' | 'board' | 'delivery',
) {
  const out: { kind: string; name: string; version: string; description: string }[] = [];
  const kinds = kind ? [kind] : (['skill', 'tool', 'workflow', 'runtime', 'board', 'delivery'] as const);
  const plural: Record<string, keyof ProjectConfig['registry']> = {
    skill: 'skills',
    tool: 'tools',
    workflow: 'workflows',
    runtime: 'runtimes',
    board: 'boards',
    delivery: 'deliveries',
  };
  for (const k of kinds) {
    // A project that never declared a board registry simply has none: an absent
    // key is skipped rather than treated as a directory named "undefined".
    const dir = config.registry[plural[k] as keyof ProjectConfig['registry']];
    if (dir === undefined || dir.length === 0) continue;
    const found = await discoverExtensions(join(cwd, dir), k);
    for (const e of found) {
      out.push({
        kind: e.manifest.kind,
        name: e.manifest.name,
        version: e.manifest.version,
        description: e.manifest.description,
      });
    }
  }
  return out;
}