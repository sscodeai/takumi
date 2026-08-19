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
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';

/**
 * PiRuntimeAdapter — wraps the Pi SDK AgentSession in-process into the
 * Takumi AgentRuntimeAdapter contract (ADR-002).
 *
 * The adapter maps Pi's AgentSession events onto Takumi's unified AgentEvent
 * stream. It does NOT leak Pi types into Core: only this package imports
 * @earendil-works/pi-coding-agent.
 *
 * Phase 3 acceptance: switching fake → pi must require config only
 * (same Core, same workflow, same task).
 */
export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly sessions = new Map<TaskId, { session: Awaited<ReturnType<typeof createAgentSession>>['session']; abort: () => void }>();
  private readonly statuses = new Map<TaskId, TaskStatus>();
  private readonly usages = new Map<TaskId, Usage>();
  private readonly artifacts = new Map<TaskId, Artifact[]>();
  private readonly lastMessages = new Map<TaskId, string>();
  private readonly eventsCount = new Map<TaskId, number>();
  // Session pool keyed by cwd: reuse one AgentSession across consecutive
  // workflow steps in the same directory (followUp chaining), avoiding the
  // per-step cold-start cost. Disabled when reuseSession:false.
  private readonly pool = new Map<string, { session: Awaited<ReturnType<typeof createAgentSession>>['session']; unsubscribe: () => void }>();
  private readonly poolLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly options: {
      model?: string;
      apiKeyEnv?: string;
      /** Reuse one AgentSession per cwd across run() calls. Default true. */
      reuseSession?: boolean;
    } = {},
  ) {
    this.options.reuseSession ??= true;
  }

  /** Drop all pooled sessions and per-task bookkeeping (free Pi resources). */
  close(): void {
    for (const { unsubscribe } of this.pool.values()) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    this.pool.clear();
    this.statuses.clear();
    this.usages.clear();
    this.artifacts.clear();
    this.eventsCount.clear();
    this.lastMessages.clear();
    this.sessions.clear();
  }

  metadata(): RuntimeMetadata {
    return {
      id: 'pi',
      name: 'Pi Runtime',
      version: '0.1.0',
      description: 'Pi coding agent (AgentSession SDK, in-process, pooled sessions)',
    };
  }

  capabilities(): RuntimeCapabilities {
    return {
      capabilities: ['streaming', 'filesystem', 'shell', 'subagents', 'browser', 'usageTracking', 'parallelExecution'],
      maxParallelTasks: 4,
    };
  }

  /**
   * Acquire an AgentSession for a cwd: reuse from pool if available (same
   * cwd), else create one and register listeners. Serializes per-cwd so
   * concurrent run() calls in the same directory cannot interleave prompts.
   */
  private async acquireSession(
    cwd: string,
    taskId: TaskId,
    emit: (ev: AgentEvent) => void,
  ): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>['session']; isReused: boolean }> {
    // Serialize per-cwd acquisition to keep pooled session's prompt() non-overlapping.
    const prev = this.poolLocks.get(cwd) ?? Promise.resolve();
    let release!: (value?: unknown) => void;
    this.poolLocks.set(
      cwd,
      new Promise((res) => {
        release = res;
      }),
    );
    await prev;

    try {
      const existing = this.options.reuseSession ? this.pool.get(cwd) : undefined;
      if (existing) {
        return { session: existing.session, isReused: true };
      }

      const result = await createAgentSession({
        cwd,
        tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
        // model omitted: Pi resolves provider/model + API key from ~/.pi/agent.
      });
      const session = result.session;
      const unsubscribe = session.subscribe(() => {
        // Per-task event mapping happens in run() via its own listener;
        // the pool entry just holds the session alive for reuse.
      });
      if (this.options.reuseSession) {
        this.pool.set(cwd, { session, unsubscribe });
      }
      return { session, isReused: false };
    } finally {
      release();
    }
  }

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    const id = task.id;
    const emitter = new EventEmitter();
    let settle: (ev: AgentEvent) => void = () => {};
    const pending: AgentEvent[] = [];

    const emitEvent = (ev: AgentEvent) => {
      this.eventsCount.set(id, (this.eventsCount.get(id) ?? 0) + 1);
      if (pending.length === 0) {
        emitter.emit('event', ev);
      } else {
        pending.push(ev);
      }
    };

    // Buffer events until the consumer starts iterating.
    const buffered: AgentEvent[] = [];
    const realTime = (ev: AgentEvent) => buffered.push(ev);
    emitter.on('event', realTime);

    this.statuses.set(id, 'running');
    emitEvent({ id: `${id}-ev0`, taskId: id, type: 'task.started', timestamp: Date.now(), message: 'pi session starting' });

    try {
      // Ensure API key is present (from process env, loadable by pi's own env plumbing).
      const apiKeyEnv = this.options.apiKeyEnv ?? 'OPENCODE_GO_API_KEY';
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        throw new Error(`PiRuntimeAdapter: missing env ${apiKeyEnv} — set it or pass apiKeyEnv`);
      }

      // Acquire a session, reusing a pooled one for the same cwd when enabled.
      const { session, isReused } = await this.acquireSession(task.cwd, id, (ev) => emitEvent(ev));
      if (isReused) {
        emitEvent({ id: `${id}-ev0b`, taskId: id, type: 'agent.message', timestamp: Date.now(), message: 'reusing pooled pi session' });
      }

      // Per-run event mapping listener (each run has its own taskId mapping).
      let mappedCount = 0;
      const handler = (ev: unknown) => {
        const takumiEv = this.mapPiEvent(id, ev);
        if (takumiEv) {
          mappedCount++;
          emitEvent(takumiEv);
        }
      };
      const unsubscribe = session.subscribe(handler);

      const abortFn = () => {
        void session.abort();
      };

      this.sessions.set(id, { session, abort: abortFn });

      // Run the task. On a reused (warm) session, chaining with followUp keeps
      // the previous steps' context, so subsequent steps are faster and smarter.
      await session.prompt(task.prompt, { streamingBehavior: 'followUp' });
      let stats: { input: number; output: number; total: number; cost: number; sessionFile?: string } | null = null;
      try {
        const s = session.getSessionStats();
        stats = { input: s.tokens.input, output: s.tokens.output, total: s.tokens.total, cost: s.cost, sessionFile: s.sessionFile };
      } catch {
        stats = null;
      }

      this.statuses.set(id, 'completed');
      emitEvent({ id: `${id}-ev-end`, taskId: id, type: 'task.completed', timestamp: Date.now() });

      this.usages.set(id, {
        runtimeId: 'pi',
        model: this.options.model ?? task.model ?? null,
        promptTokens: stats?.input ?? 0,
        completionTokens: stats?.output ?? 0,
        totalTokens: stats?.total ?? 0,
        costUsd: stats?.cost ?? 0,
        durationMs: 0,
      });

      // Remove this run's mapping listener but keep the pooled session alive
      // for the next run() in the same cwd (unless reuseSession is disabled).
      unsubscribe();
    } catch (e) {
      this.statuses.set(id, 'failed');
      emitEvent({
        id: `${id}-ev-err`,
        taskId: id,
        type: 'task.failed',
        timestamp: Date.now(),
        message: e instanceof Error ? e.message : String(e),
      });
    }

    // Yield buffered events to the consumer, then stream any late ones.
    for (const ev of buffered) yield ev;
    const late = new Promise<AgentEvent[]>((resolve) => {
      const grab = (ev: AgentEvent) => {
        pending.push(ev);
        resolve([...pending]);
      };
      emitter.on('event', grab);
      setTimeout(() => {
        emitter.off('event', grab);
        resolve([...pending]);
      }, 50);
    });
    for (const ev of await late) yield ev;
  }

  private mapPiEvent(taskId: TaskId, ev: unknown): AgentEvent | null {
    const t = (ev as { type?: string }).type;
    const ts = Date.now();
    const seq = this.eventsCount.get(taskId) ?? 0;
    const base = { taskId, timestamp: ts };
    const msg = ev as { message?: { role?: string; content?: unknown } };

    // Real assistant text arrives via message_update / message_end events.
    if (t === 'message_update' || t === 'message_end') {
      const m = msg.message;
      let text = '';
      if (m && typeof m.content === 'string') {
        text = m.content;
      } else if (m && Array.isArray(m.content)) {
        text = m.content
          .map((part: { text?: string }) => part?.text ?? '')
          .join('')
          .trim();
      }
      if (m?.role === 'assistant' && text) {
        this.lastMessages.set(taskId, text);
        return {
          id: `${taskId}-ev${seq}`,
          type: 'agent.message',
          message: text,
          ...base,
        };
      }
      return null;
    }

    switch (t) {
      case 'agent_start':
      case 'turn_start':
        return { id: `${taskId}-ev${seq}`, type: 'agent.message', message: 'agent started', ...base };
      case 'tool_execution_start':
        return {
          id: `${taskId}-ev${seq}`,
          type: 'tool.started',
          name: (ev as { toolName?: string }).toolName,
          ...base,
        };
      case 'tool_execution_end':
        return {
          id: `${taskId}-ev${seq}`,
          type: 'tool.completed',
          name: (ev as { toolName?: string }).toolName,
          ...base,
        };
      case 'bash_execution_update':
        return { id: `${taskId}-ev${seq}`, type: 'command.completed', ...base };
      case 'agent_end':
        return {
          id: `${taskId}-ev${seq}`,
          type: 'agent.message',
          message: this.lastMessages.get(taskId) ?? 'agent turn finished',
          ...base,
        };
      case 'agent_settled':
        // No text payload — the real assistant text already arrived via
        // message_update/message_end. Emitting "agent settled" here would
        // clobber the summary downstream.
        return null;
      case 'compaction_start':
        return { id: `${taskId}-ev${seq}`, type: 'agent.message', message: 'context compaction', ...base };
      default:
        return null;
    }
  }

  async cancel(taskId: TaskId): Promise<void> {
    const entry = this.sessions.get(taskId);
    if (entry) entry.abort();
    this.statuses.set(taskId, 'cancelled');
  }

  async getStatus(taskId: TaskId): Promise<TaskStatus> {
    return this.statuses.get(taskId) ?? 'pending';
  }

  async getUsage(taskId: TaskId): Promise<Usage> {
    return (
      this.usages.get(taskId) ?? {
        runtimeId: 'pi',
        model: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        durationMs: 0,
      }
    );
  }

  async getArtifacts(taskId: TaskId): Promise<Artifact[]> {
    return this.artifacts.get(taskId) ?? [];
  }
}