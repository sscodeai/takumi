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

export type { WorkflowDefinition, WorkflowRun, WorkflowStep, StepType, WorkflowManifestIssue } from './workflow.js';
export {
  WORKFLOW_STEP_TYPES,
  isWorkflowStepType,
  topoSort,
  groupByLevel,
  validateWorkflowManifest,
} from './workflow.js';
export {
  ACCEPT_VERDICT_VALUES,
  executeWorkflow,
  renderPrompt,
  resolveStepPrompt,
  parseAcceptVerdict,
  parseReviewVerdict,
  runStepCommand,
} from './workflow-engine.js';
export type {
  AcceptVerdict,
  ParsedAcceptVerdict,
  StepCommandError,
  StepCommandRequest,
  WorkflowExecutionContext,
  WorkflowRunResult,
  WorkflowStepResult,
  ParsedReviewVerdict,
  ReviewVerdict,
} from './workflow-engine.js';

export { detectHardFailure, parseTestReport, judgeGate } from './quality-gate.js';
export type { TestReport, TestShape } from './quality-gate.js';

export { ArtifactStore } from './artifact-store.js';
export { buildTraceability, renderTraceabilityMatrix, traceabilityCoverage } from './traceability.js';
export type { TraceabilityCoverage } from './traceability.js';
export type { TraceabilityNode, TraceLink } from './traceability.js';
export { runRuntimeContractSuite } from './contract.js';
export {
  appendFeedback,
  FEEDBACK_CLOSURE_KINDS,
  openFeedback,
  parseFeedback,
  renderFeedbackEntry,
  resolveFeedback,
} from './requirement-feedback.js';
export type {
  FeedbackAppendInput,
  FeedbackAppendResult,
  FeedbackClosureKind,
  FeedbackEntry,
  FeedbackResolveOptions,
  FeedbackResolveResult,
} from './requirement-feedback.js';
export {
  checkIdOf,
  decisionCheckIds,
  parseDecisionBindings,
  JUDGE_COLUMN_ROLES,
  JUDGE_DECISION_MODES,
  JUDGE_FIELD_ROLES,
  JUDGE_MUTATION_FORMATS,
  JUDGE_SCENARIO_REPORTS,
  JUDGE_RELATION_VOCABULARY,
  JUDGE_RELATIONS_THAT_NEED_THE_WORLD,
  MIN_MUTATION_TIMEOUT_MS,
  MIN_RUN_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  decisionModesFor,
  parseDeliverableBlock,
  parseInputFormat,
  parseMutation,
  parseOutputLines,
  parseScenarios,
  parseRequirements,
  validateRequirementDocument,
} from './requirement-decisions.js';
export type {
  Decision,
  DecisionBinding,
  DeliverableBlock,
  InputFormat,
  MutationBlock,
  OutputLineFormat,
  Scenario,
} from './requirement-decisions.js';
export { FEEDBACK_BRIEF_MARKER, analyseFeedback, failuresWithoutDecision, renderFeedbackBrief } from './feedback-brief.js';
export type { AnalysedFailure, AnalysedFeedback, FailureKind } from './feedback-brief.js';

// A standing authorization (ADR-045): a signed grant that lets a requirement document be confirmed by
// its OWN defaults, non-interactively, and says so in the record. The scope is SELECTABLE — a `pin` (one
// revision of one document) or a `scope` (a family of documents by glob) — and either way it may only
// NARROW the licensable set (a widening field is refused at load, by name), and the confirmation it
// produces is the same digest-bound token an interactive one produces (ADR-025).
export {
  AUTHORIZATION_CLASSES,
  AUTHORIZATION_FAILURE_CLASSES,
  AUTHORIZATION_POLICIES,
  SCOPE_FORMS,
  UNMECHANISED_CLASS,
  authorizationDigest,
  decisionClass,
  documentMatchesScope,
  licenseStandingConfirmation,
  parseStandingAuthorization,
  readRequirementConfirmation,
} from './standing-authorization.js';
export type {
  AuthorizationFailureGrant,
  AuthorizationGrant,
  AuthorizationLoad,
  AuthorizationPin,
  AuthorizationScope,
  ConfirmedAuthorization,
  DefaultedDecision,
  RequirementConfirmation,
  StandingAuthorization,
  StandingLicence,
  StandingLicenceInput,
} from './standing-authorization.js';
export { carryStateRecordForward } from './board-state-record.js';
export {
  NO_REQUIREMENT,
  REVIEWER_DETERMINISTIC_RULES,
  policyHash,
  requirementDigest,
  reviewDigest,
  rulesetHash,
  shortDigest,
  type ReviewInputs,
} from './review-digest.js';
export {
  MirroringBoard,
  mirrorMarker,
  readMirrorIdMap,
  writeMirrorIdMap,
  type BoardMirror,
  type MirrorIdMap,
} from './board-mirror.js';

// The deterministic reviewer (ADR-013): rules over the real change set, pure and testable.
export type {
  ReviewFileChange,
  ReviewFinding,
  ReviewInput,
  ReviewRules,
  ReviewSeverity,
} from './review-rules.js';
export {
  describeFindings,
  hasBlockingFinding,
  hasHumanFinding,
  isTestPath,
  REVIEW_RULESET_ID,
  runReviewRules,
} from './review-rules.js';
export { collectReviewInput, createRuleReviewer, verdictFromFindings } from './review.js';
export type { CollectReviewInputOptions, RuleReviewerOptions } from './review.js';
export type {
  Sandbox,
  SandboxLimits,
  SandboxMountMode,
  SandboxOptions,
  SandboxPolicy,
  SandboxResult,
  SandboxRoots,
  SandboxStagedFile,
  StepSandbox,
  StepSandboxRequest,
} from './sandbox.js';
export { DockerSandbox, NoopSandbox, dockerAvailable } from './sandbox-docker.js';
export {
  SANDBOX_REFUSED_CODE,
  SANDBOX_REFUSED_PREFIX,
  UnshareSandbox,
  clearSandboxSelfTestCache,
  sandboxCapability,
  sandboxSelfTest,
  unshareAvailable,
} from './sandbox-unshare.js';
export type { SandboxCapability, SandboxSelfTestCheck, SandboxSelfTestResult } from './sandbox-unshare.js';
export {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_BASE_ROOTS,
  SANDBOX_DEV_NODES,
  SANDBOX_MASKED_PREFIXES,
  SANDBOX_REQUIRED_TOOLS,
  SandboxPolicyError,
  assertMirroredRootUnmasked,
  assertReadOnlyRootsSafe,
  assertSandboxPolicy,
  assertStagedFilesSafe,
  assertWriteRootsSafe,
  boundaryDirs,
  buildSandboxPolicy,
  isInside,
  maskedPrefixOf,
  probeToolchain,
  renderBoundaryScript,
  renderInnerCommand,
  shQuote,
} from './sandbox-policy.js';
export type {
  SandboxGuard,
  SandboxPolicyInput,
  SandboxToolProbe,
  SandboxToolchainProbe,
  SandboxToolchainProbeOptions,
} from './sandbox-policy.js';
export {
  SandboxFsError,
  accessWithin,
  existsWithin,
  globWithin,
  mkdirWithin,
  readFileWithin,
  readdirWithin,
  resolveWithinRoots,
  statWithin,
  writeFileWithin,
} from './sandbox-fs-ops.js';
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
  decideClaim,
  assertScopeQuery,
  runTaskBoardProviderContractSuite,
} from './task-board.js';
export type {
  TaskBoardProvider,
  BoardProviderMetadata,
  BoardBootstrapAction,
  BoardBootstrapReport,
  BoardCapabilities,
  BoardDeliveryCapabilities,
  BoardWorkItem,
  BoardWorkItemSpec,
  BoardWorkQuery,
  CreateWorkResult,
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

// The pilot safety rails (ADR-008): one runner per slot, a closed event
// vocabulary, and a report on whether the board can even express the six states.
export { acquireSlot, isProcessAlive, slotLockPath, withSlot } from './slot-lock.js';
export type { SlotAcquisition, SlotHandle, SlotLockOptions, SlotOwner, SlotRunResult } from './slot-lock.js';
export {
  EVENT_KINDS,
  createEventLog,
  formatEventLine,
  isEventKind,
  lineSink,
  arraySink,
  nullEventLog,
} from './events.js';
export type { EventKind, EventLog, EventLogOptions, EventSink, EventValue, RunEvent } from './events.js';

// The git seam and the run marker: shared by every delivery adapter.
export { createGitRunner, unconfiguredGitRunner, gitFailure } from './git-runner.js';
export type { GitRunner, GitResult, GitRunnerOptions } from './git-runner.js';
export { renderRunMarker, parseRunMarkers, hasRunMarker } from './run-marker.js';
export { createKeyOf, hasCreateMarker, parseCreateMarkers, renderCreateMarker } from './create-marker.js';

// The run record: one machine-readable file per run, so cost / success rate / the
// most-failing step are answered from data rather than by reading logs (see run-record.ts).
export {
  RUN_RECORD_DIR,
  formatDuration,
  readRunRecords,
  renderRunAggregate,
  runRecordPath,
  summarizeRuns,
  writeRunRecord,
} from './run-record.js';
export type {
  RunAggregate,
  RunCostAggregate,
  RunRecord,
  RunRecordCost,
  RunRecordPublished,
  RunRecordStep,
  RunRecordUnreadable,
  RunStepFailureCount,
  RunStepStatus,
} from './run-record.js';

// Pilot metrics: counters a scheduler's monitoring can scrape.
export {
  bumpMetrics,
  emptyMetrics,
  readMetricsFile,
  renderPrometheus,
  writeMetricsFile,
} from './metrics.js';
export type { PilotMetrics, PilotOutcomeCounters } from './metrics.js';

// The pilot: one tick of an unattended runner, and the worktrees it uses.
export { runPilotTick, pilotRunId } from './pilot.js';
export type { PilotPolicy, PilotTickDeps, PilotTickOutcome, PilotTickResult } from './pilot.js';
export {
  createTaskWorktree,
  currentBranch,
  currentHead,
  pruneTaskWorktrees,
  readFrozenBase,
  removeTaskWorktree,
  resolveRef,
  worktreeBranchName,
  worktreeDirName,
} from './worktree.js';
export type {
  PruneOptions,
  PruneResult,
  WorktreeHandle,
  WorktreeManagerOptions,
  WorktreeRequest,
} from './worktree.js';

// The delivery loop: claim -> agent -> deliver -> review -> merge, in order.
export { runDeliveryLoop } from './delivery-loop.js';
export type {
  DeliveryLoopDeps,
  DeliveryLoopHooks,
  DeliveryLoopOutcome,
  DeliveryLoopPlan,
  DeliveryLoopResult,
  LoopStep,
  ReportContext,
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

// The board-projection port (ADR-044): a black-box run's progress written where a human reads it.
// Write-only on purpose — a port with no read cannot be used to make a decision (ADR-017 rule 1).
export type {
  DeliveryBoardPort,
  DeliveryBoardMetadata,
  DeliveryBoardProjection,
  DeliveryBoardRef,
  DeliveryBoardState,
} from './delivery-board.js';
// The label + state vocabulary the engine and any adapter share, so neither invents its own.
export { DELIVERY_BOARD_LABELS, DELIVERY_BOARD_STEP_STATES } from './delivery-board.js';