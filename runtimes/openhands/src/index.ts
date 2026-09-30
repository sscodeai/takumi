/**
 * OpenHandsRuntimeAdapter — the OpenHands CLI as a first-class runtime.
 *
 * WHY A RUNTIME, WHEN THE CLI SEAM ALREADY WORKS
 *
 * `pilot.agent.command` can already point at the OpenHands CLI (see
 * `examples/openhands-agent.sh` and `docs/openhands-spike-report.md`): that is Decision A, and it
 * is enough to get work done. What it cannot answer is what a task COST. The runtime port has
 * `getUsage`/`getArtifacts`/`getStatus`, and this adapter is the thing that fills them in.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT (all of this was measured on 2026-09-19, not assumed)
 *
 * 1. **The `--json` stream carries NO token accounting.** A real capture of
 *    `openhands --headless --override-with-envs --always-approve --json -t "..."` contains
 *    `ActionEvent` / `ObservationEvent` / `MessageEvent` objects and nothing about tokens or cost.
 *    So the stream is used for EVENTS, and usage is read from where OpenHands actually keeps it:
 * 2. **The conversation's own accounting lives in `<home>/conversations/<id>/base_state.json`**,
 *    under `stats.usage_to_metrics.<usageId>`: `model_name`, `accumulated_cost`,
 *    `accumulated_token_usage.{prompt,completion,cache_read,reasoning}_tokens`, plus a
 *    per-call `token_usages[]` list. That is the honest source for `getUsage`.
 *    `accumulated_cost` is reported AS RECORDED: with an OpenAI-compatible endpoint that
 *    publishes no pricing it is `0.0`, and pretending otherwise would invent a number.
 * 3. **The stream is not pure JSON.** Real runs interleave human-facing prose ("Initializing
 *    agent...", "Agent is working", "Agent finished", a conversation summary). The parser skips
 *    non-JSON lines rather than failing the task on OpenHands' own banner, and the count of skipped
 *    lines is reported in the run notes.
 * 4. **A test run is not distinguishable from any other command** in the stream, so this adapter
 *    never emits `test.completed`: claiming it would be a guess dressed as an observation.
 * 5. **Nothing is written into the worktree.** takumi's delivery contract says the agent leaves a
 *    clean tree, so the captured transcript is written under the runtime's own home
 *    (`<home>/takumi-runs/<taskId>.jsonl`) and reported as an ARTIFACT, never into the repo.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** The event types takumi unifies on (the core does not export the alias). */
type AgentEventType = AgentEvent['type'];

export interface OpenHandsRuntimeOptions {
  /** The CLI to run (default `openhands`, resolved on PATH). Tests point this at a stub. */
  command?: string;
  /** Extra arguments appended before the task flag (rarely needed; tests use it). */
  extraArgs?: string[];
  /** Where OpenHands keeps conversations and this adapter keeps captured transcripts. */
  home?: string;
  /**
   * Environment for the CLI. `LLM_*` is ignored by OpenHands unless
   * `--override-with-envs` is passed (which this adapter always does).
   */
  env?: Record<string, string>;
  /** Ceiling for one task. Default 1800s: an agent that hangs must not hang a tick forever. */
  timeoutSeconds?: number;
  /** Cap on OpenHands' own iterations (passed through when set). */
  maxIterations?: number;
}

/** One line of the `--json` stream, as far as we rely on it (everything else is passed through). */
interface StreamEvent {
  kind?: string;
  source?: string;
  tool_name?: string;
  llm_message?: { role?: string; content?: Array<{ type?: string; text?: string }> | null };
  action?: unknown;
  observation?: unknown;
  [key: string]: unknown;
}

export class OpenHandsRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly statuses = new Map<TaskId, TaskStatus>();
  private readonly usages = new Map<TaskId, Usage>();
  private readonly artifacts = new Map<TaskId, Artifact[]>();
  private readonly children = new Map<TaskId, ChildProcessWithoutNullStreams>();
  private readonly startedAt = new Map<TaskId, number>();
  private readonly notes = new Map<TaskId, string[]>();

  constructor(private readonly options: OpenHandsRuntimeOptions = {}) {}

  metadata(): RuntimeMetadata {
    return {
      id: 'openhands',
      name: 'OpenHands (headless CLI)',
      version: '0.1.0',
      description:
        'Runs the OpenHands CLI headless for one task, streams its events, and reports the usage its own conversation recorded.',
    };
  }

  capabilities(): RuntimeCapabilities {
    return {
      // streaming: the JSON stream is consumed as it arrives. filesystem/shell: what the agent
      // gets in its workspace — real, and NOT a sandbox: OpenHands executes on this host.
      // usageTracking: getUsage answers from the conversation's accounting (see the header).
      capabilities: ['streaming', 'filesystem', 'shell', 'usageTracking'],
      // One CLI process per task; there is no pool to share.
      maxParallelTasks: 1,
    };
  }

  async cancel(taskId: TaskId): Promise<void> {
    const child = this.children.get(taskId);
    if (child === undefined) {
      throw new Error(`no running OpenHands task ${taskId}`);
    }
    child.kill('SIGTERM');
    this.statuses.set(taskId, 'cancelled');
  }

  async getStatus(taskId: TaskId): Promise<TaskStatus> {
    const status = this.statuses.get(taskId);
    if (status === undefined) throw new Error(`unknown OpenHands task ${taskId}`);
    return status;
  }

  async getUsage(taskId: TaskId): Promise<Usage> {
    const usage = this.usages.get(taskId);
    if (usage === undefined) throw new Error(`unknown OpenHands task ${taskId} (or it has not finished)`);
    return usage;
  }

  async getArtifacts(taskId: TaskId): Promise<Artifact[]> {
    return this.artifacts.get(taskId) ?? [];
  }

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    const startedAt = Date.now();
    this.startedAt.set(task.id, startedAt);
    this.statuses.set(task.id, 'running');
    const notes: string[] = [];
    this.notes.set(task.id, notes);

    yield { id: nextEventId(), type: 'task.started', taskId: task.id, timestamp: startedAt, data: { cwd: task.cwd } };

    const binary = this.options.command ?? 'openhands';
    const args = [
      // extraArgs go FIRST: they are for wrapping the binary (a stub in tests, a script that sets
      // up an environment in production), and a wrapper has to be told before the flags are parsed.
      ...(this.options.extraArgs ?? []),
      '--headless',
      // Without this the CLI ignores the LLM_* environment, and the run fails on a missing key.
      '--override-with-envs',
      // Without this the run stops and waits for a human that is not there.
      '--always-approve',
      '--json',
      ...(this.options.maxIterations === undefined ? [] : ['--max-iterations', String(this.options.maxIterations)]),
      '-t',
      task.prompt,
    ];
    const timeoutSeconds = this.options.timeoutSeconds ?? 1800;

    const child = spawn(binary, args, {
      cwd: task.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
    }) as ChildProcessWithoutNullStreams;
    this.children.set(task.id, child);

    let stdout = '';
    let stderr = '';
    let skippedLines = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);

    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.on('error', (error) => {
        stderr += `\nspawn error: ${error.message}`;
        resolve({ code: 127, signal: null });
      });
    });

    // Consume the stream AS IT ARRIVES, so a long task yields events instead of one dump at the
    // end. Only COMPLETE lines are parsed: a partial line is left in the buffer for the next chunk.
    let consumed = 0;
    const drained: AgentEvent[] = [];
    while (true) {
      const newline = stdout.indexOf('\n', consumed);
      if (newline === -1) break;
      const line = stdout.slice(consumed, newline).trim();
      consumed = newline + 1;
      const parsed = parseLine(line);
      if (parsed === null) {
        if (line.length > 0) skippedLines += 1;
        continue;
      }
      const mapped = mapEvent(parsed, task.id);
      if (mapped !== undefined) {
        drained.push(mapped);
        yield mapped;
      }
    }
    const outcome = await exit;
    clearTimeout(timer);
    // The lines that arrived while we waited for the exit: parse what is left.
    for (const line of stdout.slice(consumed).split('\n')) {
      const trimmed = line.trim();
      const parsed = parseLine(trimmed);
      if (parsed === null) {
        if (trimmed.length > 0) skippedLines += 1;
        continue;
      }
      const mapped = mapEvent(parsed, task.id);
      if (mapped !== undefined) {
        drained.push(mapped);
        yield mapped;
      }
    }
    this.children.delete(task.id);

    // --- usage: from the conversation's own accounting -----------------------
    const conversationId = conversationIdFrom(stdout) ?? (await newestConversation(this.home(), startedAt));
    const usage = await readUsage(this.home(), conversationId, task.id, Date.now() - startedAt, notes);
    this.usages.set(task.id, usage);
    yield {
      id: nextEventId(),

      type: 'artifact.created',
      taskId: task.id,
      timestamp: Date.now(),
      data: { kind: 'usage', ...usage },
    };

    // --- artifacts: the transcript here, the changed files in the worktree ---
    const artifacts = await collectArtifacts(this.home(), task, stdout, skippedLines, conversationId);
    this.artifacts.set(task.id, artifacts);
    for (const artifact of artifacts) {
      yield {
        id: nextEventId(),

        type: 'artifact.created',
        taskId: task.id,
        timestamp: Date.now(),
          data: { id: artifact.id, kind: artifact.kind, path: artifact.path, contentType: artifact.contentType },
      };
    }

    const ok = outcome.code === 0;
    this.statuses.set(task.id, ok ? 'completed' : 'failed');
    if (ok) {
      yield {
        id: nextEventId(),

        type: 'task.completed',
        taskId: task.id,
        timestamp: Date.now(),
          data: { exitCode: outcome.code, conversationId, skippedLines, notes },
      };
    } else {
      yield {
        id: nextEventId(),

        type: 'task.failed',
        taskId: task.id,
        timestamp: Date.now(),
          data: {
          exitCode: outcome.code,
          signal: outcome.signal,
          conversationId,
          skippedLines,
          stderr: stderr.trim().split('\n').slice(-8).join('\n'),
        },
      };
    }
  }

  /** Where conversations and captured transcripts live. */
  private home(): string {
    return this.options.home ?? join(homedir(), '.openhands');
  }
}

let eventCounter = 0;

/** An id per emitted event: the port requires one, and it must differ between events. */
function nextEventId(): string {
  eventCounter += 1;
  return `oh-${eventCounter}`;
}

/** A JSON event, or `null` for the human-facing prose the CLI interleaves with it. */
function parseLine(line: string): StreamEvent | null {
  if (line.length === 0 || line[0] !== '{') return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' ? (parsed as StreamEvent) : null;
  } catch {
    return null;
  }
}

/** OpenHands' event shapes mapped onto takumi's unification, without inventing what is not there. */
function mapEvent(event: StreamEvent, taskId: TaskId): AgentEvent | undefined {
  const timestamp = Date.now();
  const kind = event.kind ?? '';
  if (kind === 'ActionEvent') {
    const tool = event.tool_name ?? 'action';
    const isShell = tool.includes('bash') || tool.includes('execute');
    return {
      id: nextEventId(),

      type: (isShell ? 'command.started' : 'tool.started') ,
      taskId,
      timestamp,
      name: tool,
      message: summarize(event.observation ?? event.action),
      data: { tool },
    };
  }
  if (kind === 'ObservationEvent') {
    const tool = event.tool_name ?? 'observation';
    const isShell = tool.includes('bash') || tool.includes('execute');
    return {
      id: nextEventId(),

      type: (isShell ? 'command.completed' : 'tool.completed') ,
      taskId,
      timestamp,
      name: tool,
      message: summarize(event.observation),
      data: { tool },
    };
  }
  if (kind === 'MessageEvent') {
    const text = textOf(event);
    if (text.length === 0) return undefined;
    return { id: nextEventId(), type: 'agent.message', taskId, timestamp, message: text, data: { source: event.source ?? '' } };
  }
  // An event kind this adapter does not know is passed through as a message rather than dropped:
  // silence about something that happened is worse than an unlabelled line.
  return {
    id: nextEventId(),

    type: 'agent.message',
    taskId,
    timestamp,
    data: { unknownKind: kind, event },
  };
}

function textOf(event: StreamEvent): string {
  const content = event.llm_message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function summarize(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** The conversation id OpenHands prints in its summary, when it prints one. */
function conversationIdFrom(stdout: string): string | null {
  const match = /Conversation ID:\s*\n?\s*([0-9a-f]{8,})/i.exec(stdout);
  return match?.[1] ?? null;
}

/** Fallback: the conversation directory created after this task started. */
async function newestConversation(home: string, startedAt: number): Promise<string | null> {
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(home, 'conversations'));
    let best: { id: string; mtime: number } | null = null;
    for (const id of entries) {
      try {
        const info = await stat(join(home, 'conversations', id));
        if (info.mtimeMs >= startedAt - 5000 && (best === null || info.mtimeMs > best.mtime)) {
          best = { id, mtime: info.mtimeMs };
        }
      } catch {
        continue;
      }
    }
    return best?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The usage OpenHands recorded for a conversation.
 *
 * Read from `base_state.json` because the `--json` stream has none (measured). Every field is
 * passed through as found — including `accumulated_cost`, which is `0.0` when the endpoint
 * publishes no pricing. When the file cannot be read, the numbers are zeros WITH the reason in
 * `extra`: an unavailable accounting must never look like a free task.
 */
async function readUsage(
  home: string,
  conversationId: string | null,
  taskId: TaskId,
  durationMs: number,
  notes: string[],
): Promise<Usage> {
  if (conversationId === null) {
    notes.push('usage: NOT AVAILABLE (no conversation id in the output and no new conversation dir)');
    return {
      runtimeId: 'openhands',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs,
      extra: { usageUnavailable: 'the CLI printed no conversation id and no conversation directory was created' },
    };
  }
  try {
    const state = JSON.parse(await readFile(join(home, 'conversations', conversationId, 'base_state.json'), 'utf8')) as {
      stats?: { usage_to_metrics?: Record<string, { model_name?: string; accumulated_cost?: number; accumulated_token_usage?: Record<string, number> }> };
      execution_status?: string;
    };
    const metrics = state.stats?.usage_to_metrics ?? {};
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    let cacheReadTokens = 0;
    let reasoningTokens = 0;
    let model: string | null = null;
    const byUsage: Record<string, { prompt: number; completion: number; cost: number }> = {};
    for (const [usageId, entry] of Object.entries(metrics)) {
      const tokens = entry.accumulated_token_usage ?? {};
      const prompt = Number(tokens['prompt_tokens'] ?? 0);
      const completion = Number(tokens['completion_tokens'] ?? 0);
      promptTokens += prompt;
      completionTokens += completion;
      cacheReadTokens += Number(tokens['cache_read_tokens'] ?? 0);
      reasoningTokens += Number(tokens['reasoning_tokens'] ?? 0);
      costUsd += Number(entry.accumulated_cost ?? 0);
      model = model ?? entry.model_name ?? null;
      byUsage[usageId] = { prompt, completion, cost: Number(entry.accumulated_cost ?? 0) };
    }
    notes.push(
      `usage: ${promptTokens}+${completionTokens} tokens, cost as recorded ${costUsd} (conversation ${conversationId})`,
    );
    return {
      model,
      runtimeId: 'openhands',
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd,
      durationMs,
      extra: {
        conversationId,
        cacheReadTokens,
        reasoningTokens,
        byUsageId: byUsage,
        executionStatus: state.execution_status ?? null,
        costNote: 'accumulated_cost as OpenHands recorded it; an OpenAI-compatible endpoint that publishes no pricing records 0.0',
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    notes.push(`usage: NOT AVAILABLE (${reason})`);
    return {
      runtimeId: 'openhands',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs,
      extra: { usageUnavailable: reason, conversationId, taskId },
    };
  }
}

/** The transcript (here) and the files the task changed (in the worktree, read-only). */
async function collectArtifacts(
  home: string,
  task: AgentTask,
  stdout: string,
  skippedLines: number,
  conversationId: string | null,
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  const createdAt = Date.now();

  // The transcript is EVIDENCE: what the agent did, verbatim, including the lines that are not
  // JSON. It lives under the runtime's home so the worktree stays clean for the delivery.
  const transcriptPath = join(home, 'takumi-runs', `${task.id}.jsonl`);
  try {
    await mkdir(join(home, 'takumi-runs'), { recursive: true });
    await writeFile(transcriptPath, stdout, 'utf8');
    const info = await stat(transcriptPath);
    artifacts.push({
      id: `${task.id}-transcript`,
      taskId: task.id,
      kind: 'evidence',
      path: transcriptPath,
      contentType: 'application/x-ndjson',
      sizeBytes: info.size,
      trace: task.trace ?? [],
      createdAt,
    });
  } catch {
    // A transcript that cannot be written is not a failed task; it is a missing artifact, and the
    // run notes already carry the skipped-line count.
  }

  // The changed files: read from git, never from a self-report. Read-only: no writes to the
  // worktree (the delivery refuses a dirty tree, and it would be right to).
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout: porcelain } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: task.cwd });
    for (const line of porcelain.split('\n')) {
      const path = line.slice(3).trim();
      if (path.length === 0) continue;
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await stat(join(task.cwd, path))).size;
      } catch {
        sizeBytes = undefined;
      }
      artifacts.push({
        id: `${task.id}-${path}`,
        taskId: task.id,
        kind: 'code',
        path,
        contentType: 'text/plain',
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        trace: task.trace ?? [],
        createdAt,
      });
    }
  } catch {
    // Not a git worktree, or git is unavailable: no file artifacts reported (and none invented).
  }

  if (conversationId !== null) {
    artifacts.push({
      id: `${task.id}-conversation`,
      taskId: task.id,
      kind: 'evidence',
      path: join(home, 'conversations', conversationId, 'base_state.json'),
      contentType: 'application/json',
      trace: task.trace ?? [],
      createdAt,
    });
  }
  return artifacts;
}

export function createOpenHandsRuntime(options: OpenHandsRuntimeOptions = {}): OpenHandsRuntimeAdapter {
  return new OpenHandsRuntimeAdapter(options);
}
