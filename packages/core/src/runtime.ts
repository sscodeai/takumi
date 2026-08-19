import type {
  AgentEvent,
  AgentResult,
  AgentTask,
  Artifact,
  RuntimeCapabilities,
  RuntimeMetadata,
  TaskId,
  TaskStatus,
  Usage,
} from './types.js';

/**
 * The single contract every runtime adapter implements.
 * See ADR-002: we unify Task → Events → Result → Artifacts → Usage,
 * NOT each harness's internal tool calls.
 */
export interface AgentRuntimeAdapter {
  /** Static identity of this runtime. */
  metadata(): RuntimeMetadata;

  /** Declared capabilities; workflows validate against these before running. */
  capabilities(): RuntimeCapabilities;

  /**
   * Run a task, yielding a stream of unified events.
   * Resolves when the task finishes (or throws on failure; or resolves
   * with cancelled status if cancelled).
   */
  run(task: AgentTask): AsyncIterable<AgentEvent>;

  /** Request cancellation of a running task by id. */
  cancel(taskId: TaskId): Promise<void>;

  /** Current status of a task. */
  getStatus(taskId: TaskId): Promise<TaskStatus>;

  /** Token/cost accounting for a task. */
  getUsage(taskId: TaskId): Promise<Usage>;

  /** Artifacts produced by a task. */
  getArtifacts(taskId: TaskId): Promise<Artifact[]>;
}

export type { AgentResult } from './types.js';

export function runTaskAndCollect(
  runtime: AgentRuntimeAdapter,
  task: AgentTask,
  onEvent?: (ev: AgentEvent) => void,
): Promise<AgentResult> {
  return new Promise(async (resolve, reject) => {
    try {
      let lastSummary = '';
      let failed = false;
      let cancelled = false;
      let error: string | undefined;
      for await (const ev of runtime.run(task)) {
        onEvent?.(ev);
        if (ev.type === 'task.failed') {
          failed = true;
          error = ev.message;
        }
        if (ev.type === 'task.cancelled') {
          cancelled = true;
          error = ev.message ?? 'task cancelled';
        }
        if (ev.message && ev.type !== 'task.failed' && ev.type !== 'task.cancelled') lastSummary = ev.message;
      }
      if (cancelled) {
        const usage = await runtime.getUsage(task.id).catch(() => null);
        resolve({
          taskId: task.id,
          status: 'cancelled',
          summary: error ?? 'task cancelled',
          changedFiles: [],
          tests: [],
          usage: usage ?? { runtimeId: '', model: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 },
          artifacts: await runtime.getArtifacts(task.id).catch(() => [] as Artifact[]),
          trace: [],
          error,
        });
        return;
      }
      if (failed) {
        resolve({
          taskId: task.id,
          status: 'failed',
          summary: error ?? 'task failed',
          changedFiles: [],
          tests: [],
          usage: await runtime.getUsage(task.id),
          artifacts: await runtime.getArtifacts(task.id),
          trace: [],
          error,
        });
        return;
      }
      const status = await runtime.getStatus(task.id);
      const usage = await runtime.getUsage(task.id);
      const artifacts = await runtime.getArtifacts(task.id);
      resolve({
        taskId: task.id,
        status: status === 'cancelled' ? 'cancelled' : 'completed',
        summary: lastSummary,
        changedFiles: [],
        tests: [],
        usage,
        artifacts,
        trace: artifacts.flatMap((a) => a.trace),
      });
    } catch (e) {
      // A runtime SHOULD emit task.failed itself, but if it throws/errors
      // internally we must still resolve a failed result (not reject/crash),
      // so the orchestration loop can react — Gate 16: fail explicitly,
      // record the error, preserve state. No silent failure, no fake success.
      const message = e instanceof Error ? e.message : String(e);
      resolve({
        taskId: task.id,
        status: 'failed',
        summary: message,
        changedFiles: [],
        tests: [],
        usage: await runtime.getUsage(task.id).catch(() => ({
          runtimeId: 'unknown',
          model: null,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          durationMs: 0,
        })),
        artifacts: await runtime.getArtifacts(task.id).catch(() => [] as Artifact[]),
        trace: [],
        error: message,
      });
      // Ensure the caller's event stream also sees the failure (event integrity).
      try {
        onEvent?.({
          id: `${task.id}-ev-runtime-error`,
          taskId: task.id,
          type: 'task.failed',
          timestamp: Date.now(),
          message,
        });
      } catch {
        // ignore observer errors
      }
    }
  });
}

/** Verify a runtime satisfies a workflow's declared capability requirements. */
export function validateCapabilities(
  runtime: AgentRuntimeAdapter,
  required: string[],
): { ok: true } | { ok: false; missing: string[] } {
  const have = new Set(runtime.capabilities().capabilities);
  const missing = required.filter((c) => !have.has(c as never));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}