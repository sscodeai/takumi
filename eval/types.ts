/**
 * Eval task interface — Takumi Agent Eval (Protocol §3).
 *
 * Every task MUST have machine-verifiable ground truth (hidden/independent
 * tests or deterministic checks). An agent's self-generated tests are NEVER
 * the sole ground truth.
 */
export interface EvalTask {
  /** Stable id, e.g. "ts-bugfix-001" */
  task_id: string;
  /** Human description given to the agent. */
  description: string;
  /** Path to the fixture (initial repo state), relative to eval/fixtures. */
  fixture: string;
  /** Language/stack hint. */
  language: 'typescript' | 'java' | 'other';
  /** Expected behavior (for the report, not fed to the agent verbatim). */
  expected_behavior: string;
  /**
   * Verification: command(s) run in the task dir. Non-zero exit or failing
   * tests → task FAILS independent verification (regardless of agent claim).
   * Supports {workdir} substitution.
   */
  verify: {
    /** Command to run (cwd = task workdir). */
    command: string;
    /** Optional: expected stdout substring for a PASS (deterministic check). */
    expect_stdout?: string;
  };
  /** Timeout for the whole task (agent + verify + repair), ms. */
  timeout_ms: number;
  /** Tools the agent may use. */
  allowed_tools?: string[];
  /** Completion criteria (for the report). */
  completion_criteria: string;
  /** Max repair attempts after first verification failure. */
  max_repair_attempts: number;
}
