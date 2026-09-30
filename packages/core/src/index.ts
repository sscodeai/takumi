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
export { runManagerLoop } from './manager-loop.js';
export type { LoopRecord, TaskState, LoopDecision, LoopContract, AuditResult, LoopHost } from './manager-loop.js';

// Task board abstraction (ADR-006): providers own where work comes from and
// where its delivery state lives; core never learns a board's internals.
export {
  BOARD_WORK_ITEM_STATES,
  BOARD_TERMINAL_STATES,
  BOARD_TRANSITIONS,
  BoardStateError,
  canTransition,
  assertTransition,
  isTerminalState,
  isBoardWorkItemState,
} from './board-state.js';
export type { BoardWorkItemState } from './board-state.js';
export {
  BOARD_STATE_MARKER_VERSION,
  BOARD_STATE_MARKER_PREFIX,
  BoardStateRecordError,
  renderBoardStateRecord,
  parseBoardStateRecord,
  validateBoardStateRecord,
  newestBoardStateRecord,
} from './board-state-record.js';
export type { BoardStateRecord } from './board-state-record.js';
export {
  BoardError,
  BoardUnsupportedError,
  validateBoardCapabilities,
  assertBoardCapability,
  runTaskBoardProviderContractSuite,
} from './task-board.js';
export type {
  TaskBoardProvider,
  BoardProviderMetadata,
  BoardCapabilities,
  BoardDeliveryCapabilities,
  BoardWorkItem,
  BoardWorkQuery,
  BoardCommentRef,
  BoardCommentAuthor,
  ClaimResult,
  BoardTransitionEvidence,
  BoardErrorKind,
  BoardCapabilityRequirement,
  BoardContractSuiteOptions,
} from './task-board.js';
export {
  classifyBoardHttpStatus,
  boardErrorFromResponse,
  assertBoardHttpOk,
  parseBoardJson,
  requestBoardJson,
  createCurlRequestFn,
  unconfiguredRequestFn,
} from './board-transport.js';
export type { BoardHttpRequest, BoardHttpResponse, BoardRequestFn, CurlRequestFnOptions } from './board-transport.js';

// The git seam and the run marker: shared by every delivery adapter.
export { createGitRunner, unconfiguredGitRunner, gitFailure } from './git-runner.js';
export type { GitRunner, GitResult, GitRunnerOptions } from './git-runner.js';
export { renderRunMarker, parseRunMarkers, hasRunMarker } from './run-marker.js';

// The delivery loop: claim -> agent -> deliver -> review -> merge, in order.
export { runDeliveryLoop } from './delivery-loop.js';
export type {
  DeliveryLoopDeps,
  DeliveryLoopHooks,
  DeliveryLoopOutcome,
  DeliveryLoopPlan,
  DeliveryLoopResult,
  LoopStep,
  ReviewContext,
  ReviewOutcome,
} from './delivery-loop.js';

// The delivery port (ADR-007): how a committed change reaches the host.
export {
  ProviderError,
  isUnsupported,
  isRetriable,
} from './provider-error.js';
export type { ProviderErrorKind, ProviderErrorOptions } from './provider-error.js';
export {
  DeliveryError,
  DeliveryUnsupportedError,
  runDeliveryProviderContractSuite,
} from './delivery.js';
export type {
  DeliveryProvider,
  DeliveryProviderMetadata,
  DeliveryCapabilities,
  DeliveryRequest,
  DeliveryBase,
  DeliveryOutcome,
  DeliveryPushRecord,
  DeliveryMergeMethod,
  DeliveryErrorKind,
  DeliveryFixture,
  DeliveryContractSuiteOptions,
  PullRequestRef,
  PullRequestStatus,
  CheckSummary,
  CheckConclusion,
  MergeOutcome,
} from './delivery.js';