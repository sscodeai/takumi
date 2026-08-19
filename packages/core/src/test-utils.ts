import type { AgentRuntimeAdapter } from './runtime.js';
import type {
  AgentEvent,
  AgentTask,
  Artifact,
  RuntimeCapabilities,
  RuntimeMetadata,
  TaskId,
  TaskStatus,
  Usage,
} from './types.js';

/**
 * TestRuntime — a MINIMAL, self-contained runtime used ONLY by Core's own tests.
 *
 * Purpose (acceptance Gate 2 / Gate 3): Core's unit tests must not import any
 * real runtime package (@takumi/runtime-fake / pi / cli). This keeps the Core
 * build self-contained and proves Core is harness-agnostic — Core proves
 * itself with a local stub that satisfies AgentRuntimeAdapter, independent of
 * any concrete harness. It mirrors the FakeRuntime contract surface.
 */
export class TestRuntime implements AgentRuntimeAdapter {
  private readonly statuses = new Map<TaskId, TaskStatus>();
  private readonly usages = new Map<TaskId, Usage>();
  constructor(
    private readonly onResult: (task: AgentTask) => string | void = () => 'ok',
    private readonly caps: RuntimeCapabilities = { capabilities: ['streaming'], maxParallelTasks: 4 },
    private readonly id = 'test',
  ) {}

  metadata(): RuntimeMetadata {
    return { id: this.id, name: `TestRuntime(${this.id})`, version: '0.0.0', description: 'in-repo Core test stub' };
  }

  capabilities(): RuntimeCapabilities {
    return this.caps;
  }

  async *run(task: AgentTask): AsyncGenerator<AgentEvent> {
    const started: AgentEvent = {
      id: `${task.id}-started`,
      taskId: task.id,
      type: 'task.started',
      timestamp: Date.now(),
    };
    yield started;

    try {
      const summary = this.onResult(task) ?? 'ok';
      this.statuses.set(task.id, 'completed');
      this.usages.set(task.id, {
        runtimeId: 'test',
        model: 'test',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        costUsd: 0,
        durationMs: 0,
      });
      const msg: string = typeof summary === 'string' ? summary : 'ok';
      yield { id: `${task.id}-msg`, taskId: task.id, type: 'agent.message', timestamp: Date.now(), message: msg };
      yield { id: `${task.id}-done`, taskId: task.id, type: 'task.completed', timestamp: Date.now(), message: msg };
    } catch (e) {
      this.statuses.set(task.id, 'failed');
      yield {
        id: `${task.id}-failed`,
        taskId: task.id,
        type: 'task.failed',
        timestamp: Date.now(),
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async getStatus(taskId: TaskId): Promise<TaskStatus> {
    return this.statuses.get(taskId) ?? 'pending';
  }

  async getUsage(taskId: TaskId): Promise<Usage> {
    return (
      this.usages.get(taskId) ?? {
        runtimeId: 'test',
        model: 'test',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        durationMs: 0,
      }
    );
  }

  async getArtifacts(_taskId: TaskId): Promise<Artifact[]> {
    return [];
  }

  async cancel(_taskId: TaskId): Promise<void> {
    // no-op for the deterministic stub
  }
}
