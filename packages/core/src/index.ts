// Takumi Core — public API surface.
// Harness-agnostic: no Pi / DeepSeek / Japanese-SI specifics live here.

export type {
  AgentEvent,
  AgentResult,
  AgentTask,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  EventId,
  RuntimeCapabilities,
  RuntimeCapability,
  RuntimeMetadata,
  TaskId,
  TaskStatus,
  TraceId,
  TestResultDetail,
  Usage,
} from './types.js';

export type { AgentRuntimeAdapter } from './runtime.js';
export { runTaskAndCollect, validateCapabilities } from './runtime.js';

export type {
  DiscoveredExtension,
  ExtensionKind,
  ExtensionManifest,
  SkillMetadata,
} from './extensions.js';
export { discoverExtensions } from './extensions.js';

export type { WorkflowDefinition, WorkflowRun, WorkflowStep, StepType } from './workflow.js';
export { topoSort, groupByLevel } from './workflow.js';
export { executeWorkflow, renderPrompt, resolveStepPrompt } from './workflow-engine.js';
export type { WorkflowExecutionContext, WorkflowRunResult, WorkflowStepResult } from './workflow-engine.js';

export { ArtifactStore } from './artifact-store.js';
export { buildTraceability, renderTraceabilityMatrix } from './traceability.js';
export type { TraceabilityNode, TraceLink } from './traceability.js';
export { runRuntimeContractSuite } from './contract.js';
export type { Sandbox, SandboxOptions, SandboxResult } from './sandbox.js';
export { DockerSandbox, NoopSandbox, dockerAvailable } from './sandbox-docker.js';
export { UnshareSandbox } from './sandbox-unshare.js';