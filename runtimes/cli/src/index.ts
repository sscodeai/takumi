import { spawn, type ChildProcess } from 'node:child_process';
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
 * CliRuntimeAdapter — bridge to ANY external harness CLI via subprocess.
 *
 * This is the harness-agnostic "second runtime" seam: point it at a harness
 * binary (DeepSeek Harness `dsh`, Codex CLI, OpenCode, etc.) and it executes
 * tasks by spawning `command args... <prompt>`, streaming stdout as agent
 * messages. Config-only switch, no Core changes (ADR-002).
 *
 * The binary itself is NOT bundled here — provide it via `command`. When the
 * binary is missing, run() fails HONESTLY (no fake completion).
 *
 * Example for DeepSeek Harness (once `dsh` is installed):
 *   new CliRuntimeAdapter({
 *     id: 'deepseek-harness',
 *     name: 'DeepSeek Harness',
 *     command: 'dsh',
 *     args: ['run', '--print'],
 *   })
 */
export class CliRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly events = new Map<TaskId, AgentEvent[]>();
  private readonly statuses = new Map<TaskId, TaskStatus>();
  private readonly usages = new Map<TaskId, Usage>();
  private readonly children = new Map<TaskId, { proc: ChildProcess; aborted: boolean }>();
  private readonly eventSeq = new Map<TaskId, number>();

  constructor(
    private readonly options: {
      id: string;
      name: string;
      command: string;
      args?: string[];
      promptFlag?: string[];
      appendPrompt?: boolean;
      capabilities?: RuntimeCapabilities['capabilities'];
      cwd?: string;
      env?: Record<string, string>;
    },
  ) {
    this.options.args ??= [];
    this.options.appendPrompt ??= true;
  }

  metadata(): RuntimeMetadata {
    return {
      id: this.options.id,
      name: this.options.name,
      version: '0.1.0',
      description: `External harness CLI bridge (${this.options.command})`,
    };
  }

  capabilities(): RuntimeCapabilities {
    return {
      capabilities: this.options.capabilities ?? ['streaming'],
      maxParallelTasks: 2,
    };
  }

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    const id = task.id;
    const emit = (type: AgentEvent['type'], extra: Partial<AgentEvent> = {}): AgentEvent => {
      const event: AgentEvent = {
        id: `${id}-ev${this.eventSeq.get(id) ?? 0}`,
        taskId: id,
        timestamp: Date.now(),
        type,
        ...extra,
      };
      const list = this.events.get(id) ?? [];
      list.push(event);
      this.events.set(id, list);
      this.eventSeq.set(id, (this.eventSeq.get(id) ?? 0) + 1);
      return event;
    };

    this.statuses.set(id, 'running');
    yield emit('task.started');

    // Build the command line (appendPrompt decides how the prompt is passed).
    const args = [...(this.options.args ?? [])];
    const append = this.options.appendPrompt ?? true;
    if (this.options.promptFlag && this.options.promptFlag.length > 0) {
      args.push(...this.options.promptFlag, task.prompt);
    } else if (append) {
      args.push(task.prompt);
    }

    // Stream events into an array; yielded once the process finishes.
    const streamed: AgentEvent[] = [];

    let proc: ChildProcess;
    try {
      proc = spawn(this.options.command, args, {
        cwd: this.options.cwd ?? task.cwd,
        env: { ...process.env, ...this.options.env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.statuses.set(id, 'failed');
      yield emit('task.failed', { message: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.children.set(id, { proc, aborted: false });

    const out: string[] = [];
    const err: string[] = [];

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out.push(text);
      streamed.push(emit('agent.message', { message: text.trim() }));
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      err.push(text);
      streamed.push(emit('command.completed', { name: 'stderr', message: text.trim() }));
    });

    const exit = await new Promise<number>((resolve) => {
      proc.on('close', (code) => resolve(code ?? -1));
      proc.on('error', (e) => {
        err.push(e.message);
        resolve(-1);
      });
    });

    const fullOut = out.join('');
    const aborted = this.children.get(id)?.aborted ?? false;

    if (aborted) {
      // Cancellation must NOT surface as a failure (High fix: cancelled stays
      // cancelled; runTaskAndCollect maps task.cancelled → status cancelled).
      this.statuses.set(id, 'cancelled');
      streamed.push(emit('task.cancelled', { message: 'subprocess cancelled' }));
    } else if (exit !== 0) {
      const msg = err.join('') || fullOut.trim() || `command exited ${exit}`;
      this.statuses.set(id, 'failed');
      streamed.push(emit('task.failed', { message: msg.slice(0, 2000) }));
    } else {
      this.statuses.set(id, 'completed');
      streamed.push(emit('task.completed', { message: fullOut.trim().slice(0, 2000) }));
    }

    this.usages.set(id, {
      runtimeId: this.options.id,
      model: task.model ?? null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: Date.now(),
    });
    this.children.delete(id);

    // Yield everything (streamed events were buffered; task.started already sent).
    for (const ev of streamed) yield ev;
  }

  async cancel(taskId: TaskId): Promise<void> {
    const entry = this.children.get(taskId);
    if (entry && !entry.aborted) {
      entry.aborted = true;
      try {
        entry.proc.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    this.statuses.set(taskId, 'cancelled');
  }

  async getStatus(taskId: TaskId): Promise<TaskStatus> {
    return this.statuses.get(taskId) ?? 'pending';
  }

  async getUsage(taskId: TaskId): Promise<Usage> {
    return (
      this.usages.get(taskId) ?? {
        runtimeId: this.options.id,
        model: null,
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
}