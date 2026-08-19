import { parse } from 'yaml';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ArtifactStore,
  discoverExtensions,
  executeWorkflow,
  renderTraceabilityMatrix,
  WorkflowDefinition,
} from '@takumi/core';
import { AgentRuntimeAdapter, AgentTask, runTaskAndCollect } from '@takumi/core';
import { FakeRuntime } from '@takumi/runtime-fake';
import { CliRuntimeAdapter } from '@takumi/runtime-cli';

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
  };
  artifacts: string;
}

export function loadConfig(cwd: string): ProjectConfig {
  const p = join(cwd, 'takumi.yaml');
  if (!existsSync(p)) {
    throw new Error(`no takumi.yaml found in ${cwd} — run "takumi init" first`);
  }
  const raw = readFileSync(p, 'utf8');
  return parse(raw) as ProjectConfig;
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
export async function resolveRuntime(id: string): Promise<AgentRuntimeAdapter> {
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
      // Dynamic import of the opt-in pi-runtime package. Using an indirect
      // specifier keeps this from being statically resolved at build time so
      // the CLI builds without the Pi SDK installed (BLOCKED_BY_EXTERNAL_DEP).
      const mod = `@takumi/runtime-${'pi'}`;
      const m = (await import(mod)) as { PiRuntimeAdapter: new () => AgentRuntimeAdapter };
      return new m.PiRuntimeAdapter();
    } catch {
      throw new Error(
        `runtime "pi" is not installed on this machine (BLOCKED_BY_EXTERNAL_DEPENDENCY). ` +
          `It requires the unpublished @earendil-works/pi-coding-agent SDK. ` +
          `Set it up with: cd runtimes/pi && pnpm install && pnpm build, then build this CLI.`,
      );
    }
  }
  throw new Error(`unknown runtime "${id}" (available: fake, pi, cli:<command>)`);
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
}

export async function runTask(opts: RunOptions): Promise<{
  events: string[];
  summary: string;
  artifacts: string[];
  traceabilityMatrix?: string;
}> {
  const runtime = await resolveRuntime(opts.runtimeId);
  const store = new ArtifactStore(join(opts.cwd, opts.config.artifacts));
  const events: string[] = [];

  if (opts.workflow) {
    const wf = await loadWorkflow(opts.cwd, opts.config, opts.workflow);
    const result = await executeWorkflow(
      wf,
      {
        cwd: opts.cwd,
        runtime,
        artifacts: store,
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
    return {
      events,
      summary: `workflow "${opts.workflow}" ${result.status}`,
      artifacts: result.steps.flatMap((s) => s.artifacts),
      traceabilityMatrix: matrix,
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

  return {
    events,
    summary: result.summary,
    artifacts: result.artifacts.map((a) => a.path),
  };
}

/** List extensions from the registry dirs in the project config. */
export async function listExtensions(config: ProjectConfig, cwd: string, kind?: 'skill' | 'tool' | 'workflow' | 'runtime') {
  const out: { kind: string; name: string; version: string; description: string }[] = [];
  const kinds = kind ? [kind] : (['skill', 'tool', 'workflow', 'runtime'] as const);
  const plural: Record<string, keyof ProjectConfig['registry']> = {
    skill: 'skills',
    tool: 'tools',
    workflow: 'workflows',
    runtime: 'runtimes',
  };
  for (const k of kinds) {
    const dir = config.registry[plural[k] as keyof ProjectConfig['registry']];
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