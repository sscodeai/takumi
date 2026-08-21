/**
 * LoopHost implementation for the CLI — turns the core MEA loop engine into
 * a real loop command. Manager/Executor/Auditor are all driven by the same
 * runtime (fresh-context per round), aligned with LongHorizon-Harness:
 * - Manager: LLM decides next subtask (or done/blocked) from task state only.
 * - Executor: LLM performs the contract in the workspace (only writer).
 * - Auditor: LLM independently verifies by running tests/commands; verdict
 *   comes from evidence, not the executor's claim.
 */
import type { AgentRuntimeAdapter } from '@takumi/core';
import type { LoopHost, LoopContract, TaskState, AuditResult, LoopRecord } from '@takumi/core';
import { runTaskAndCollect } from '@takumi/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Convert task state + audit history into the manager prompt. */
function managerPrompt(state: TaskState, auditHistory: AuditResult[]): string {
  const recs = state.records
    .map((r) => `- [${r.status}] ${r.type} ${r.id}: ${r.description}${r.evidence ? ` (evidence: ${r.evidence.slice(0, 80)})` : ''}`)
    .join('\n');
  const audits = auditHistory.length
    ? auditHistory.map((a, i) => `round ${i + 1}: ${a.report.slice(0, 150)}`).join('\n')
    : '(none yet)';
  return `You are the MANAGER of an agent execution loop. You do NOT touch the environment.
Original task: ${state.task}

Current task state (records):
${recs}

Audit history:
${audits}

Decide the next action. Reply with ONE line, exactly one of:
- CONTRACT: <one specific subtask the executor should do next, e.g. "implement the reserve method in src/inventory-service.js and run the unit tests">
- DONE: <summary of what was verified complete>
- BLOCKED: <why it cannot proceed>
Only mark DONE when ALL records are completed with clean audit evidence.`;
}

/** Convert contract + state into the executor prompt. */
function executorPrompt(contract: LoopContract, state: TaskState): string {
  const relevant = state.records
    .filter((r) => contract.recordIds.includes(r.id) || r.status === 'completed')
    .map((r) => `- [${r.status}] ${r.id}: ${r.description.slice(0, 120)}`)
    .join('\n');
  return `You are the EXECUTOR. Perform this subtask in the workspace (you may modify files and run commands):
${contract.instruction}

Relevant task state:
${relevant}

Do the work, then reply with a short summary of what you changed and the commands you ran.`;
}

/** Convert audit inputs into the auditor prompt. */
function auditorPrompt(contract: LoopContract, state: TaskState, executorSummary: string): string {
  return `You are the AUDITOR. You have READ-ONLY authority: verify the executor's work by inspecting the actual workspace — run tests, read files, check outputs. Do NOT modify anything.

Original task: ${state.task}
Subtask contract: ${contract.instruction}
Executor claims: ${executorSummary.slice(0, 500)}

Verify whether the contract is truly satisfied. Run the project's tests (e.g. npm test / node --test) and inspect the results. Reply with EXACTLY one line:
VERDICT: PASS or VERDICT: FAIL
Then on the next line, briefly say what evidence you checked.`;
}

export function makeLoopHost(runtime: AgentRuntimeAdapter, cwd: string): LoopHost {
  /** Run a prompt through the runtime with fresh context. */
  async function runOnce(id: string, prompt: string): Promise<string> {
    const res = await runTaskAndCollect(
      runtime,
      { id, prompt, cwd },
      () => {},
    );
    return res.summary ?? '';
  }

  /** Auditor also runs verification commands directly (read-only). */
  async function runVerify(instruction: string): Promise<string> {
    const out: string[] = [];
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', 'npm test'], { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      out.push(`npm test exit 0:\n${stdout.slice(0, 1500)}`);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out.push(`npm test failed:\n${String(err.stdout ?? err.stderr ?? e).slice(0, 1500)}`);
    }
    return out.join('\n');
  }

  return {
    async execute(contract, state) {
      return { summary: await runOnce(`loop-exec-${state.rounds}`, executorPrompt(contract, state)) };
    },
    async audit(contract, state, executorSummary) {
      const probe = await runOnce(`loop-audit-${state.rounds}`, auditorPrompt(contract, state, executorSummary));
      const verifyOutput = await runVerify(contract.instruction);
      const pass = /VERDICT:\s*PASS/i.test(probe);
      const statuses = contract.recordIds.map((recordId) => ({
        recordId,
        status: pass ? ('completed' as const) : ('untrusted' as const),
        evidence: `${pass ? 'PASS' : 'FAIL'}: ${probe.slice(0, 120)} | ${verifyOutput.slice(0, 200)}`,
      }));
      return { recordStatuses: statuses, report: `${pass ? 'PASS' : 'FAIL'} — ${probe.slice(0, 100)} | tests: ${verifyOutput.slice(0, 100)}` };
    },
    async manage(state, auditHistory) {
      const decision = await runOnce(`loop-mgr-${state.rounds}`, managerPrompt(state, auditHistory));
      const m = decision.match(/^CONTRACT:\s*(.+)$/m);
      if (m) {
        const recordId = state.records.find((r) => r.status === 'pending' || r.status === 'untrusted')?.id ?? state.records[0]!.id;
        return { decision: 'execute', contract: { recordIds: [recordId], instruction: m[1]!.trim() } };
      }      if (/^DONE:/m.test(decision)) return { decision: 'done', note: decision.slice(5).trim() };
      if (/^BLOCKED:/m.test(decision)) return { decision: 'blocked', note: decision.slice(8).trim() };
      // Fallback: treat as execute with raw decision.
      const recordId2 = state.records.find((r) => r.status === 'pending' || r.status === 'untrusted')?.id ?? state.records[0]!.id;
      return { decision: 'execute', contract: { recordIds: [recordId2], instruction: decision.trim() } };
    },
  };
}
