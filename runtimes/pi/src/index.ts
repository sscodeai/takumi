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

  constructor(private readonly options: { model?: string; apiKeyEnv?: string } = {}) {}

  metadata(): RuntimeMetadata {
    return {
      id: 'pi',
      name: 'Pi Runtime',
      version: '0.1.0',
      description: 'Pi coding agent (AgentSession SDK, in-process)',
    };
  }

  capabilities(): RuntimeCapabilities {
    return {
      capabilities: ['streaming', 'filesystem', 'shell', 'subagents', 'browser', 'usageTracking', 'parallelExecution'],
      maxParallelTasks: 4,
    };
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

      const result = await createAgentSession({
        cwd: task.cwd,
        tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
        // model omitted: Pi resolves provider/model + API key from
        // ~/.pi/agent (models.json, settings.json, env $OPENCODE_GO_API_KEY).
      });

      const session = result.session;
      const unsubscribe = session.subscribe((ev) => {
        const takumiEv = this.mapPiEvent(id, ev);
        if (takumiEv) emitEvent(takumiEv);
      });

      const abortFn = () => {
        void session.abort();
      };

      this.sessions.set(id, { session, abort: abortFn });

      // Run the task.
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