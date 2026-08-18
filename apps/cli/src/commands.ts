import { parse } from 'yaml';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactStore,
  discoverExtensions,
  executeWorkflow,
  WorkflowDefinition,
} from '@takumi/core';
import { AgentRuntimeAdapter, AgentTask, runTaskAndCollect } from '@takumi/core';
import { FakeRuntime } from '@takumi/runtime-fake';

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
 * Built-ins: "fake". Future: "pi" (Phase 3), plus dynamic runtimes/ directory.
 */
export function resolveRuntime(id: string): AgentRuntimeAdapter {
  switch (id) {
    case 'fake':
      return new FakeRuntime();
    default:
      throw new Error(`unknown runtime "${id}" (available: fake)`);
  }
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
}

export async function runTask(opts: RunOptions): Promise<{
  events: string[];
  summary: string;
  artifacts: string[];
}> {
  const runtime = resolveRuntime(opts.runtimeId);
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
        onApproval: () => {
          events.push('approval: auto-approved');
          return true;
        },
        onEvent: (stepId, message) => events.push(`workflow[${stepId}]: ${message}`),
      },
      { input: opts.prompt },
    );
    for (const s of result.steps) {
      events.push(`step ${s.stepId}: ${s.status} — ${s.summary}`);
    }
    return {
      events,
      summary: `workflow "${opts.workflow}" ${result.status}`,
      artifacts: result.steps.flatMap((s) => s.artifacts),
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