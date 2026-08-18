/**
 * Core domain types for Takumi.
 *
 * These types are harness-agnostic by design: they must not reference any
 * specific runtime (Pi, DeepSeek Harness, Codex...) nor any Japanese-SI-specific
 * artifact shape. See ADR-002.
 */

/** Unique task identifier. */
export type TaskId = string;

/** Unique event identifier (monotonic within a task run). */
export type EventId = string;

/** Stable identifier used for traceability links. */
export type TraceId = string;

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Capabilities a runtime can advertise; workflows declare `requires` against these. */
export type RuntimeCapability =
  | 'streaming'
  | 'filesystem'
  | 'shell'
  | 'subagents'
  | 'browser'
  | 'resume'
  | 'usageTracking'
  | 'sandbox'
  | 'parallelExecution';

export interface RuntimeMetadata {
  /** Stable runtime id, e.g. "pi", "fake", "deepseek". */
  id: string;
  name: string;
  version: string;
  /** Human description for `takumi runtime list`. */
  description: string;
}

export interface RuntimeCapabilities {
  capabilities: RuntimeCapability[];
  /** Max parallel tasks this runtime can host (>=1). */
  maxParallelTasks: number;
}

/** An agent task: the unit of work handed to a runtime. */
export interface AgentTask {
  id: TaskId;
  /** Natural-language instruction, e.g. "Implement user authentication API". */
  prompt: string;
  /** Working directory for the task. */
  cwd: string;
  /** Optional model override (runtime-specific; null = runtime default). */
  model?: string | null;
  /** Optional structured context (e.g. parsed requirements). */
  context?: Record<string, unknown>;
  /** Runtime-specific extra options. */
  options?: Record<string, unknown>;
  /** Traceability links carried with the task (e.g. REQ-001). */
  trace?: TraceId[];
}

/** Event types observed on the unified AgentEvent stream. */
export type AgentEventType =
  | 'task.started'
  | 'agent.message'
  | 'tool.started'
  | 'tool.completed'
  | 'file.changed'
  | 'command.started'
  | 'command.completed'
  | 'test.completed'
  | 'artifact.created'
  | 'approval.required'
  | 'task.failed'
  | 'task.completed';

export interface AgentEvent {
  id: EventId;
  taskId: TaskId;
  type: AgentEventType;
  /** Millisecond timestamp (epoch). */
  timestamp: number;
  /** Human-readable detail, optional. */
  message?: string;
  /** Tool/command name where relevant. */
  name?: string;
  /** Exit code for command/test events. */
  exitCode?: number;
  /** Extra structured payload (runtime-specific, tolerated but not required). */
  data?: Record<string, unknown>;
  /** Traceability links carried by this event. */
  trace?: TraceId[];
}

export interface TestResultDetail {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  durationMs?: number;
  message?: string;
}

/** Usage accounting from a runtime (models token/cost). */
export interface Usage {
  runtimeId: string;
  model?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  /** Free-form extra usage data. */
  extra?: Record<string, unknown>;
}

/** An artifact produced by a task (design doc, test log, evidence file...). */
export interface Artifact {
  id: TraceId;
  taskId: TaskId;
  /** Artifact kind, e.g. "requirement", "design", "code", "test", "evidence", "report". */
  kind: string;
  /** Path relative to the artifact store root. */
  path: string;
  /** MIME-ish type for rendering hints. */
  contentType: string;
  /** Byte size, when known. */
  sizeBytes?: number;
  /** Traceability links: e.g. ["REQ-001", "DESIGN-001"]. */
  trace: TraceId[];
  /** When the artifact was created (epoch ms). */
  createdAt: number;
  /** Optional checksum for integrity verification. */
  sha256?: string;
}

export interface AgentResult {
  taskId: TaskId;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  changedFiles: string[];
  tests: TestResultDetail[];
  usage: Usage;
  artifacts: Artifact[];
  /** Final trace links resolved by this task. */
  trace: TraceId[];
  /** Runtime-provided error, when failed. */
  error?: string;
}

/** Approval gate request surfaced by a workflow. */
export interface ApprovalRequest {
  id: string;
  workflowRunId: string;
  taskId: TaskId;
  /** Which step requires approval, e.g. "basic_design". */
  stepId: string;
  prompt: string;
  /** Options for CLI interaction: [a] approve / [r] reject / [v] view. */
  options: ('approve' | 'reject' | 'view')[];
  createdAt: number;
}

export type ApprovalDecision = 'approved' | 'rejected';