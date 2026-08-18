import type {
  AgentEvent,
  AgentRuntimeAdapter,
  AgentTask,
  Artifact,
  RuntimeCapabilities,
  RuntimeMetadata,
  TaskId,
  TaskStatus,
  Usage,
} from '@takumi/core';

/**
 * FakeRuntime — deterministic, in-process runtime for tests and vertical-slice work.
 * Contract-identical to a real runtime: same AgentRuntimeAdapter interface,
 * same event stream shape. Used to prove the Core↔Runtime contract before
 * wiring any real harness (Phase 3 switches to Pi by config, no Core changes).
 */
export class FakeRuntime implements AgentRuntimeAdapter {
  private readonly events = new Map<TaskId, AgentEvent[]>();
  private readonly statuses = new Map<TaskId, TaskStatus>();
  private readonly artifacts = new Map<TaskId, Artifact[]>();
  private cancelled = new Set<TaskId>();

  /** Optional hook: interpret the task prompt and produce a summary. */
  constructor(private readonly onTask?: (task: AgentTask) => string) {}

  metadata(): RuntimeMetadata {
    return {
      id: 'fake',
      name: 'Fake Runtime',
      version: '0.1.0',
      description: 'Deterministic in-process runtime for tests and development.',
    };
  }

  capabilities(): RuntimeCapabilities {
    return {
      capabilities: ['streaming', 'filesystem', 'shell', 'subagents', 'usageTracking', 'parallelExecution'],
      maxParallelTasks: 16,
    };
  }

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    const id = task.id;
    const emit = (ev: Omit<AgentEvent, 'id' | 'taskId' | 'timestamp'> & { type: AgentEvent['type'] }) => {
      const event: AgentEvent = {
        id: `${id}-ev${this.events.get(id)?.length ?? 0}`,
        taskId: id,
        timestamp: Date.now(),
        ...ev,
      };
      const list = this.events.get(id) ?? [];
      list.push(event);
      this.events.set(id, list);
      return event;
    };

    this.statuses.set(id, 'running');
    yield emit({ type: 'task.started' });

    if (this.cancelled.has(id)) {
      this.statuses.set(id, 'cancelled');
      yield emit({ type: 'task.failed', message: 'cancelled before start' });
      return;
    }

    // Deterministic interpretation of the prompt so vertical slices produce
    // real observable output without a real model.
    const summary = this.onTask
      ? this.onTask(task)
      : `processed: ${task.prompt}`;

    yield emit({ type: 'agent.message', message: summary });
    yield emit({ type: 'command.started', name: 'fake:analyze' });
    yield emit({ type: 'command.completed', name: 'fake:analyze', exitCode: 0 });
    yield emit({ type: 'test.completed', name: 'fake:test', exitCode: 0 });

    if (this.cancelled.has(id)) {
      this.statuses.set(id, 'cancelled');
      yield emit({ type: 'task.failed', message: 'cancelled' });
      this.artifacts.set(id, []);
      return;
    }
    this.statuses.set(id, 'completed');
    yield emit({ type: 'task.completed' });
  }

  async cancel(taskId: TaskId): Promise<void> {
    this.cancelled.add(taskId);
    this.statuses.set(taskId, 'cancelled');
  }

  async getStatus(taskId: TaskId): Promise<TaskStatus> {
    return this.statuses.get(taskId) ?? 'pending';
  }

  async getUsage(taskId: TaskId): Promise<Usage> {
    return {
      runtimeId: 'fake',
      model: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: 0,
    };
  }

  async getArtifacts(taskId: TaskId): Promise<Artifact[]> {
    return this.artifacts.get(taskId) ?? [];
  }
}