import type { RuntimeCapability } from './types.js';

/**
 * Workflow model (ADR-003): declarative YAML/JSON workflows.
 * Steps are sequential by default; `depends_on` forms a DAG for parallel steps.
 */

export type StepType = 'agent' | 'approval' | 'tool';

export interface WorkflowStep {
  id: string;
  type: StepType;
  /** Prompt template for agent steps (skill-driven). */
  prompt?: string;
  /** Skill id to load, e.g. "jp-requirements". */
  skill?: string;
  /** Prompt action within the skill (prompts/<action>.md). Defaults to the first prompt. */
  skillAction?: string;
  /** Tool ids required by this step. */
  tools?: string[];
  /** Runtime capability requirements (validated before run). */
  requires?: RuntimeCapability[];
  /** Steps that must finish before this one. Empty = only previous sequential step (or none). */
  dependsOn?: string[];
  /** Retry strategy for agent steps. */
  retry?: {
    maxAttempts: number;
    /** Backoff base seconds between attempts. */
    backoffSeconds?: number;
  };
  /** Optional timeout ms. */
  timeoutMs?: number;
}

export interface WorkflowDefinition {
  name: string;
  version: string;
  description: string;
  /** Default runtime id (may be overridden by CLI --runtime). */
  runtime?: string;
  /** Runtime capability requirements for the whole workflow. */
  requires?: RuntimeCapability[];
  /** Required skills across the workflow. */
  requiredSkills?: string[];
  /** Required tools across the workflow. */
  requiredTools?: string[];
  steps: WorkflowStep[];
}

export interface WorkflowRun {
  id: string;
  workflow: WorkflowDefinition;
  runtimeId: string;
  /** stepId → status */
  stepStatus: Record<string, 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_approval' | 'cancelled'>;
  /** stepId → result summary */
  stepResults: Record<string, string>;
  /** Which steps ran in which order. */
  order: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
}

/**
 * Topological order of steps respecting depends_on.
 * Steps with no dependsOn follow the declared array order.
 * Throws on cycles.
 */
export function topoSort(steps: WorkflowStep[]): string[] {
  const ids = new Set(steps.map((s) => s.id));
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: string[] = [];

  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`workflow step cycle at ${id}`);
    visiting.add(id);
    const step = byId.get(id);
    if (step) {
      for (const dep of step.dependsOn ?? []) {
        if (!ids.has(dep)) throw new Error(`workflow step ${id} depends on unknown step ${dep}`);
        visit(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
    out.push(id);
  };

  for (const step of steps) visit(step.id);
  return out;
}