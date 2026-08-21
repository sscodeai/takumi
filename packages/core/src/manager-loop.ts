/**
 * Manager Loop (P3 — Loop Engineering, aligned with LongHorizon-Harness
 * arXiv 2608.01964 MEA loop).
 *
 * Manage-Execute-Audit:
 * - Manager: owns persistent task state (records with status), decides next
 *   subtask contract or done/blocked/ask. No direct environment access.
 * - Executor: fresh-context per round, only role allowed to modify env.
 * - Auditor: fresh-context, read-only verification of environment state.
 *   Executor claims NEVER change state directly — only clean audit evidence
 *   marks a record completed.
 *
 * This file is the CORE loop engine (harness-agnostic). The actual
 * executor/auditor/manager implementations are injected via LoopHost,
 * keeping Takumi model-agnostic.
 */

/** A task-state record (论文的 requirement/artifact/fact). */
export interface LoopRecord {
  id: string;
  type: 'requirement' | 'artifact' | 'fact';
  description: string;
  status: 'pending' | 'completed' | 'blocked' | 'untrusted';
  /** Audit evidence supporting the current status (file/command/result). */
  evidence?: string;
}

/** Persistent task state S. */
export interface TaskState {
  task: string;
  records: LoopRecord[];
  rounds: number;
}

/** Manager control decision q. */
export type LoopDecision = 'execute' | 'done' | 'blocked' | 'ask';

/** Subtask contract produced by the manager for the executor. */
export interface LoopContract {
  /** Unresolved record(s) this round should advance. */
  recordIds: string[];
  /** Concrete instruction to the executor (fresh context). */
  instruction: string;
}

/** Auditor result v_i. */
export interface AuditResult {
  /** Verdict per target record. */
  recordStatuses: { recordId: string; status: LoopRecord['status']; evidence: string }[];
  /** Human-readable audit report (fed to manager next round). */
  report: string;
}

/** Interfaces the loop needs from the host (Takumi runtime + verification). */
export interface LoopHost {
  /** Execute a subtask with fresh context. Returns executor's summary claim. */
  execute(contract: LoopContract, state: TaskState): Promise<{ summary: string }>;
  /** Independently verify environment state after execution (read-only). */
  audit(contract: LoopContract, state: TaskState, executorSummary: string): Promise<AuditResult>;
  /** Manager: given task + state + audit history, decide next. */
  manage(state: TaskState, auditHistory: AuditResult[]): Promise<{ decision: LoopDecision; contract?: LoopContract; note?: string }>;
}

/** Run the MEA loop until done/blocked/ask or maxRounds. */
export async function runManagerLoop(host: LoopHost, task: string, opts: { maxRounds?: number; initialRecords?: LoopRecord[] } = {}): Promise<{
  state: TaskState;
  decision: LoopDecision;
  rounds: number;
  auditHistory: AuditResult[];
  finalNote?: string;
}> {
  const maxRounds = opts.maxRounds ?? 10;
  const state: TaskState = {
    task,
    records: opts.initialRecords ?? [{ id: 'r1', type: 'requirement', description: task, status: 'pending' }],
    rounds: 0,
  };
  const auditHistory: AuditResult[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    state.rounds = round;
    // 1. MANAGE: decide next action from state + audit history.
    const mgr = await host.manage(state, auditHistory);
    if (mgr.decision !== 'execute' || !mgr.contract) {
      return { state, decision: mgr.decision, rounds: round - 1, auditHistory, finalNote: mgr.note };
    }
    // 2. EXECUTE: fresh-context executor performs the contract.
    const exec = await host.execute(mgr.contract, state);
    // 3. AUDIT: independent read-only verification.
    const audit = await host.audit(mgr.contract, state, exec.summary);
    auditHistory.push(audit);
    // Apply audit verdicts to task state (only audit evidence changes state).
    for (const rs of audit.recordStatuses) {
      const rec = state.records.find((r) => r.id === rs.recordId);
      if (rec) {
        rec.status = rs.status;
        rec.evidence = rs.evidence;
      }
    }
  }
  return { state, decision: 'blocked', rounds: maxRounds, auditHistory, finalNote: `maxRounds (${maxRounds}) reached` };
}
