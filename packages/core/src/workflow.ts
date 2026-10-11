import type { RuntimeCapability } from './types.js';
import type { ReviewRules } from './review-rules.js';
import type { DeliveryMergeMethod } from './delivery.js';

/**
 * Workflow model (ADR-003): declarative YAML/JSON workflows.
 * Steps run in TOPOLOGICAL order; `depends_on` expresses the DAG and the
 * engine executes it in a deterministic serial order today (parallel step
 * execution is declared in the model but NOT yet executed concurrently —
 * honest scope note; see docs/acceptance-report.md Gate 10).
 */

/**
 * Every step type the engine knows how to execute. This is the single source of
 * truth: `StepType` is derived from it and manifest validation reads it, so a
 * type cannot be added to the union while a manifest validator still rejects it.
 */
export const WORKFLOW_STEP_TYPES = [
  'agent',
  'approval',
  'tool',
  'quality_gate',
  'independent_review',
  'rule_review',
  'judge_forge',
  'acceptance',
  'repair',
  'ci_config',
  'await_checks',
  'publish',
  'merge',
  'delivery',
] as const;

export type StepType = (typeof WORKFLOW_STEP_TYPES)[number];

/**
 * The merge methods the delivery port implements (ADR-007). Repeated here as a runtime list so a
 * manifest that names a method no host implements is refused at load, rather than reaching a provider
 * that would have to guess.
 */
const MERGE_METHODS: readonly DeliveryMergeMethod[] = ['merge', 'squash', 'rebase'];

/** Is `value` one of the step types the engine can execute? */
export function isWorkflowStepType(value: unknown): value is StepType {
  return typeof value === 'string' && (WORKFLOW_STEP_TYPES as readonly string[]).includes(value);
}

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
  /**
   * `rule_review`: the ref that is the frozen base of the change set. Required
   * for a `rule_review` step (e.g. `origin/main` or a sha); manifest validation
   * refuses a rule_review without it, because a review with no base is not a
   * review.
   */
  baseRef?: string;
  /** `rule_review`: the delivered head to judge. Default `HEAD`. */
  headRef?: string;
  /** `rule_review`: rule configuration; absent means the deterministic defaults. */
  rules?: ReviewRules;
  /**
   * `acceptance`: the CONFIRMED requirement document this acceptance is about, as a path relative to
   * the project (ADR-025). Required: an acceptance that is not bound to a requirement is not an
   * acceptance — it is a machine grading its own work.
   */
  requirementRef?: string;
  /**
   * `judge_forge`: the generator that writes the acceptance judge, as a path executed by `bash`
   * (ADR-026). Required for a `judge_forge` step.
   *
   * It runs in the run's judge directory — `<project>/.takumi/acceptance/<stepId>/`, which is
   * outside the implementation worktree — and it is given the requirement document and its digest,
   * NOT the implementation. It must print `JUDGE_FORGE: ok` and `JUDGE_PATH: <file>`.
   */
  forgeRef?: string;
  /**
   * `acceptance`: the harness command the step runs, relative to the project. Required: with
   * nothing to run there is no verdict to report.
   *
   * Executed with the file name resolved by `bash` (the PoC-2 harness is a shell script), so a path
   * with a space is not a shell-injection question — no shell parses it.
   *
   * A `{judgePath}` placeholder resolves to the judge a `judge_forge` step produced; when the run
   * forged a judge, the acceptance MUST use that judge, and the engine refuses any other harness.
   */
  acceptanceRef?: string;
  /**
   * `repair`: the sub-workflow this step runs for each delivery attempt (ADR-034), loaded through the
   * run's workflow loader. Required: a repair loop with nothing to run is not a repair.
   */
  repairRef?: string;
  /**
   * `repair`: how many delivery attempts the step may spend, 1..5. Required: a repair budget is a number
   * a human chose, and an unbounded one is an unattended agent spending money until it feels done.
   */
  maxRounds?: number;
  /**
   * `ci_config`: the command that runs the DELIVERED project's own tests, written into the pipeline file.
   * Required: a pipeline that does not run the delivery's tests is decoration.
   */
  testCommand?: string;
  /**
   * `ci_config`: which dialect to write — `forgejo` (also Gitea), `github`, or `gitlab` (GitLab CI
   * YAML, a different language from the GitHub-Actions dialects). Defaults to `forgejo`.
   */
  dialect?: string;
  /** `await_checks`: how long to wait for the host's pipeline, in seconds (default 300, ceiling 1800). */
  waitSeconds?: number;
  /** `publish`: the base branch the pull request targets (default `main`). */
  baseBranch?: string;
  /** `publish`: the remote to push to (default `origin`). */
  remote?: string;
  /**
   * `await_checks`: which pull request's checks to read — a number or a URL. Absent means the run's own
   * published reference (`vars.deliveryRef`), and failing that the worktree's branch and HEAD.
   */
  ref?: string;
  /** `publish`: the pull request title; the provider has its own default (a run marker line). */
  prTitle?: string;
  /** `publish`: the issue title; defaults to the confirmed requirement ref and the branch. */
  issueTitle?: string;
  /**
   * `merge`: the merge method the host should use (ADR-040). One of `merge`, `squash`, `rebase`;
   * defaults to `merge`. This is the ONLY thing a `merge` step declares.
   *
   * There is deliberately NO field for the reference or the head: the pull request merged is the one
   * this RUN published (`vars.deliveryRef`, set by `publish`), and the commit merged is the head the
   * acceptance JUDGED (`vars.acceptedHead`, set by `acceptance`). A manifest that could name either
   * would be a manifest that could land a commit nobody reviewed — the failure this whole layer exists
   * to prevent.
   */
  mergeMethod?: DeliveryMergeMethod;
}

export interface WorkflowManifestIssue {
  /** Step the issue belongs to, when it can be attributed to one. */
  stepId?: string;
  message: string;
}

/**
 * Validate a workflow manifest before anything runs.
 *
 * This exists so a manifest that names a step type the engine does not execute
 * (or a `rule_review` with no base to judge, or an `acceptance` with no requirement
 * to be about) fails at load time with an actionable message, instead of silently
 * behaving like an agent step. NOTE, measured rather than assumed: the engine's
 * dispatch is a CHAIN of `if (step.type === …)` blocks whose last branch is the
 * agent fallthrough, so it is NOT exhaustive — a type that is added to
 * `WORKFLOW_STEP_TYPES` and to this validator but not to the engine runs silently as
 * an agent step (scout finding; see docs/design/blackbox-acceptance-scout.md §1.2).
 * This is the reader that keeps a YAML file honest about that contract, and the
 * reason a new type must land with its engine branch in the same commit.
 */
export function validateWorkflowManifest(def: WorkflowDefinition): WorkflowManifestIssue[] {
  const issues: WorkflowManifestIssue[] = [];
  if (typeof def?.name !== 'string' || def.name.length === 0) {
    issues.push({ message: 'missing workflow name' });
  }
  const steps = Array.isArray(def?.steps) ? def.steps : [];
  if (steps.length === 0) {
    issues.push({ message: 'missing or empty workflow steps' });
    return issues;
  }
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] as Partial<WorkflowStep> | undefined;
    const stepId = typeof step?.id === 'string' && step.id.length > 0 ? step.id : `#${i + 1}`;
    if (stepId.startsWith('#')) issues.push({ stepId, message: `step ${stepId} has no id` });
    if (!isWorkflowStepType(step?.type)) {
      issues.push({
        stepId,
        message: `step ${stepId} has unknown type "${String(step?.type)}" (allowed: ${WORKFLOW_STEP_TYPES.join(', ')})`,
      });
    }
    if (step?.type === 'rule_review' && (typeof step.baseRef !== 'string' || step.baseRef.trim().length === 0)) {
      issues.push({ stepId, message: `step ${stepId} is a rule_review and requires a non-empty baseRef` });
    }
    if (step?.type === 'judge_forge') {
      // A forge with nothing to read from and nothing to run cannot produce a judge.
      if (typeof step.requirementRef !== 'string' || step.requirementRef.trim().length === 0) {
        issues.push({
          stepId,
          message: `step ${stepId} is a judge_forge and requires a non-empty requirementRef (the confirmed requirement the judge is derived from)`,
        });
      }
      if (typeof step.forgeRef !== 'string' || step.forgeRef.trim().length === 0) {
        issues.push({ stepId, message: `step ${stepId} is a judge_forge and requires a non-empty forgeRef (the generator to run)` });
      }
    }
    // The judge path must never reach the steps that produce or gate the implementation: an agent
    // that can read the judge can fit it. This is a LOAD-time refusal rather than a hope, because
    // the judge is written after those steps have run and nothing else would notice the reference.
    const stepPrompt = typeof step?.prompt === 'string' ? step.prompt : '';
    if (step?.type !== 'judge_forge' && step?.type !== 'acceptance' && /\{judge/i.test(stepPrompt)) {
      issues.push({
        stepId,
        message: `step ${stepId} is a ${String(step?.type)} step whose prompt references {judge…}: the judge is for the acceptance step only, and a step that can see it can fit it`,
      });
    }
    if (step?.type === 'ci_config') {
      // A pipeline file with no test command would run nothing and still report green: the command is
      // required, and it is the DELIVERED project's, not takumi's (ADR-037).
      if (typeof step.testCommand !== 'string' || step.testCommand.trim().length === 0) {
        issues.push({
          stepId,
          message: `step ${stepId} writes a pipeline configuration and requires a non-empty testCommand (the command that runs the delivered project's own tests)`,
        });
      }
      const dialect = step.dialect ?? 'forgejo';
      if (dialect !== 'forgejo' && dialect !== 'github' && dialect !== 'gitlab') {
        issues.push({
          stepId,
          message: `step ${stepId} declares dialect "${dialect}": implemented are forgejo (also Gitea), github and gitlab`,
        });
      }
    }
    if (step?.type === 'await_checks') {
      const seconds = step.waitSeconds ?? 300;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) {
        issues.push({
          stepId,
          message: `step ${stepId} declares waitSeconds ${String(step.waitSeconds)}: it must be an integer from 1 to 1800 (a pipeline that is still pending when the budget runs out fails, it does not pass)`,
        });
      }
    }
    if (step?.type === 'publish') {
      // Publishing needs a base branch to target: a pull request against nothing is not a pull request.
      if (typeof step.baseBranch === 'string' && step.baseBranch.trim().length === 0) {
        issues.push({ stepId, message: `step ${stepId} declares an empty baseBranch: a pull request needs a branch to target` });
      }
    }
    if (step?.type === 'merge') {
      // The only thing a merge step declares is its method; a method no host implements is refused here
      // rather than handed to a provider that would have to guess. The reference and the head are NOT
      // fields on purpose (ADR-040): both come from the run — the published pull request and the head the
      // acceptance judged — so a manifest cannot land a commit nobody reviewed.
      const method = step.mergeMethod;
      if (method !== undefined && !(MERGE_METHODS as readonly string[]).includes(method)) {
        issues.push({
          stepId,
          message: `step ${stepId} is a merge whose mergeMethod is "${String(method)}": implemented are ${MERGE_METHODS.join(', ')}`,
        });
      }
    }
    if (step?.type === 'repair') {
      // A repair with nothing to run, or with an unbounded budget, is refused at load: both are
      // numbers/nodes a human chose, and neither can be repaired at run time.
      if (typeof step.repairRef !== 'string' || step.repairRef.trim().length === 0) {
        issues.push({
          stepId,
          message: `step ${stepId} is a repair and requires a non-empty repairRef (the sub-workflow it runs for each delivery attempt)`,
        });
      }
      const rounds = step.maxRounds;
      if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
        issues.push({
          stepId,
          message: `step ${stepId} is a repair whose maxRounds is ${String(rounds)}: it must be an integer from 1 to 5 (a repair budget is a number a human chose, and an unbounded one is an unattended agent spending money until it feels done)`,
        });
      }
    }
    if (step?.type === 'acceptance') {
      // An acceptance is a verdict about ONE requirement document, judged by a harness that lives
      // outside the thing it judges. Refusing both absences here means a manifest cannot ship an
      // acceptance that is decorative: it fails at load, with the reason, instead of at the end of
      // a long run.
      if (typeof step.requirementRef !== 'string' || step.requirementRef.trim().length === 0) {
        issues.push({
          stepId,
          message: `step ${stepId} is an acceptance and requires a non-empty requirementRef (the confirmed requirement document it is about)`,
        });
      }
      if (typeof step.acceptanceRef !== 'string' || step.acceptanceRef.trim().length === 0) {
        issues.push({
          stepId,
          message: `step ${stepId} is an acceptance and requires a non-empty acceptanceRef (the harness to run)`,
        });
      }
    }
  }
  return issues;
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

/**
 * Group a topo-ordered step list into CONCURRENCY LEVELS (P2 parallel).
 * Steps in the same level have no dependency on each other (all deps are in
 * earlier levels), so they MAY run in parallel. Levels are ordered: level[i]
 * only depends on levels [0..i-1]. Returns e.g. [['a','b'], ['c'], ['d','e']].
 */
export function groupByLevel(steps: WorkflowStep[], order: string[]): string[][] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const levelOf = new Map<string, number>();
  const levels: string[][] = [];
  for (const id of order) {
    const step = byId.get(id);
    const deps = step?.dependsOn ?? [];
    const depLevels = deps.map((d) => levelOf.get(d) ?? 0);
    const level = depLevels.length === 0 ? 0 : Math.max(...depLevels) + 1;
    levelOf.set(id, level);
    (levels[level] ??= []).push(id);
  }
  return levels;
}