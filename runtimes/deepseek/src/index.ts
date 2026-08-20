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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Sandbox } from '@takumi/core';
import { NoopSandbox, UnshareSandbox } from '@takumi/core';

const execFileAsync = promisify(execFile);

/**
 * DeepSeekRuntimeAdapter — a harness-agnostic OpenAI-compatible runtime.
 *
 * Talks to commandcode.ai's provider endpoint (deepseek/deepseek-v4-flash)
 * over plain HTTP chat/completions with a TOOL LOOP: the model can run bash,
 * read/write files, and list the workspace — exactly the capabilities a
 * workflow step needs — and the loop terminates when the model stops
 * requesting tools. This is the SECOND real harness (independent of the Pi
 * SDK), proving the Core's runtime abstraction is genuinely model-agnostic.
 *
 * Env: COMMANDCODE_API_KEY (or apiKey option). Base URL + model configurable.
 */
interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the project working directory. Output is returned.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'shell command to run' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file (relative to project cwd).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write text content to a file (relative to project cwd). Creates parent dirs.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files in a directory (relative to project cwd).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];

function resolveInCwd(cwd: string, p: string): string {
  const full = resolve(cwd, p);
  if (!full.startsWith(resolve(cwd))) throw new Error(`path escapes cwd: ${p}`);
  return full;
}

export class DeepSeekRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly statuses = new Map<TaskId, TaskStatus>();
  private readonly usages = new Map<TaskId, Usage>();
  private readonly artifacts = new Map<TaskId, Artifact[]>();
  private readonly aborts = new Map<TaskId, AbortController>();
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxTurns: number;
  private readonly sandbox: Sandbox;

  constructor(
    private readonly options: {
      model?: string;
      baseUrl?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      maxTurns?: number;
      /** Sandbox for bash tool. 'none' (default) | 'unshare' | Sandbox instance. */
      sandbox?: 'none' | 'unshare' | Sandbox;
    } = {},
  ) {
    this.baseUrl = options.baseUrl ?? 'https://api.commandcode.ai/provider/v1';
    this.model = options.model ?? 'deepseek/deepseek-v4-flash';
    const env = options.apiKeyEnv ?? 'COMMANDCODE_API_KEY';
    this.apiKey = options.apiKey ?? process.env[env] ?? '';
    this.maxTurns = options.maxTurns ?? 30;
    if (typeof options.sandbox === 'string') {
      this.sandbox = options.sandbox === 'unshare' ? new UnshareSandbox() : new NoopSandbox();
    } else {
      this.sandbox = options.sandbox ?? new NoopSandbox();
    }
  }

  metadata(): RuntimeMetadata {
    return {
      id: 'deepseek',
      name: 'DeepSeek Harness Runtime',
      version: '0.1.0',
      description: `OpenAI-compatible tool loop via commandcode.ai (${this.model})`,
    };
  }

  capabilities(): RuntimeCapabilities {
    return {
      capabilities: ['streaming', 'filesystem', 'shell', 'usageTracking', ...(this.sandbox.id !== 'none' ? (['sandbox'] as const) : [])],
      maxParallelTasks: 2,
    };
  }

  close(): void {
    for (const ac of this.aborts.values()) ac.abort();
    this.statuses.clear();
    this.usages.clear();
    this.artifacts.clear();
    this.aborts.clear();
  }

  async cancel(taskId: TaskId): Promise<void> {
    const ac = this.aborts.get(taskId);
    if (ac) ac.abort();
    this.statuses.set(taskId, 'cancelled');
  }

  async getStatus(taskId: TaskId): Promise<TaskStatus> {
    return this.statuses.get(taskId) ?? 'pending';
  }

  async getUsage(taskId: TaskId): Promise<Usage> {
    return this.usages.get(taskId) ?? { runtimeId: 'deepseek', model: this.model, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 };
  }

  async getArtifacts(taskId: TaskId): Promise<Artifact[]> {
    return this.artifacts.get(taskId) ?? [];
  }

  private async chat(messages: ChatMessage[], signal: AbortSignal) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 4000,
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`deepseek API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices: { message: ChatMessage; finish_reason: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    return data;
  }

  private async execTool(name: string, args: string, cwd: string): Promise<string> {
    const a = JSON.parse(args) as Record<string, string>;
    switch (name) {
      case 'bash': {
        const cmd = a.command ?? '';
        try {
          const res = await this.sandbox.run(cwd, cmd, { timeoutMs: 60_000 });
          const out = `${res.stdout}\n${res.stderr}`.trim() || '(no output)';
          return res.code === 0 ? out : `(exit ${res.code}) ${out}`;
        } catch (e: any) {
          return `(error) ${e.message}`;
        }
      }
      case 'read_file': {
        try {
          return await readFile(resolveInCwd(cwd, a.path ?? ''), 'utf8');
        } catch (e: any) {
          return `(error) ${e.message}`;
        }
      }
      case 'write_file': {
        try {
          const full = resolveInCwd(cwd, a.path ?? '');
          await mkdir(join(full, '..'), { recursive: true });
          await writeFile(full, a.content ?? '', 'utf8');
          return `wrote ${a.path}`;
        } catch (e: any) {
          return `(error) ${e.message}`;
        }
      }
      case 'list_dir': {
        try {
          const full = resolveInCwd(cwd, a.path ?? '.');
          const entries = await readdir(full, { withFileTypes: true });
          return entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n');
        } catch (e: any) {
          return `(error) ${e.message}`;
        }
      }
      default:
        return `(unknown tool ${name})`;
    }
  }

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    const id = task.id;
    const ac = new AbortController();
    this.aborts.set(id, ac);
    this.statuses.set(id, 'running');

    const emit = (ev: AgentEvent) => {
      // async generator yields — events are emitted as the loop proceeds
    };
    void emit;

    yield { id: `${id}-ev0`, taskId: id, type: 'task.started', timestamp: Date.now(), message: 'deepseek session starting' };

    if (!this.apiKey) {
      this.statuses.set(id, 'failed');
      yield { id: `${id}-ev-err`, taskId: id, type: 'task.failed', timestamp: Date.now(), message: 'DeepSeekRuntimeAdapter: missing COMMANDCODE_API_KEY (or apiKey option)' };
      return;
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are an autonomous software engineering agent. Complete the user task by using the available tools ' +
          '(bash, read_file, write_file, list_dir) to inspect and modify the project at the working directory. ' +
          'When done, reply with a concise final summary of what you did. Use write_file to create deliverables.',
      },
      { role: 'user', content: task.prompt },
    ];

    let turns = 0;
    let lastText = '';
    try {
      for (;;) {
        if (ac.signal.aborted) {
          this.statuses.set(id, 'cancelled');
          yield { id: `${id}-ev-cancel`, taskId: id, type: 'task.cancelled', timestamp: Date.now() };
          return;
        }
        if (++turns > this.maxTurns) {
          throw new Error(`deepseek: exceeded ${this.maxTurns} tool turns`);
        }
        yield { id: `${id}-ev-turn-${turns}`, taskId: id, type: 'agent.message', timestamp: Date.now(), message: `deepseek turn ${turns}` };

        const data = await this.chat(messages, ac.signal);
        const msg = data.choices[0]?.message;
        if (!msg) throw new Error('deepseek: empty response');
        const usage = data.usage;
        if (usage) {
          this.usages.set(id, {
            runtimeId: 'deepseek',
            model: this.model,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            costUsd: 0,
            durationMs: 0,
          });
        }

        const toolCalls = msg.tool_calls ?? [];
        if (toolCalls.length === 0) {
          // Final answer
          lastText = msg.content ?? '';
          this.statuses.set(id, 'completed');
          yield { id: `${id}-ev-end`, taskId: id, type: 'task.completed', timestamp: Date.now(), message: lastText };
          return;
        }

        // Execute tools and append results
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls });
        for (const tc of toolCalls) {
          const fn = tc.function;
          const result = await this.execTool(fn.name, fn.arguments, task.cwd);
          yield {
            id: `${id}-ev-tool-${turns}-${fn.name}`,
            taskId: id,
            type: 'agent.message',
            timestamp: Date.now(),
            message: `tool ${fn.name}: ${result.slice(0, 200)}`,
          };
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 20000) });
        }
      }
    } catch (e: any) {
      if (ac.signal.aborted) {
        this.statuses.set(id, 'cancelled');
        yield { id: `${id}-ev-cancel`, taskId: id, type: 'task.cancelled', timestamp: Date.now() };
        return;
      }
      this.statuses.set(id, 'failed');
      yield { id: `${id}-ev-err`, taskId: id, type: 'task.failed', timestamp: Date.now(), message: `deepseek error: ${e.message}` };
      return;
    }
  }
}
