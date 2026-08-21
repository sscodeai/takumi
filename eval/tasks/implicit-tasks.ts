import type { EvalTask } from '../types.js';

/**
 * Task set F — IMPLICIT-CONSTRAINT tasks.
 *
 * The spec LOOKS simple, but has one or more UNSTATED constraints that the
 * agent cannot infer from the visible code. Agents that implement the surface
 * meaning (and self-verify against it) will produce output that fails the
 * hidden acceptance criteria — the classic false-completion trigger.
 */
export const implicitTasks: EvalTask[] = [
  {
    task_id: 'ts-implicit-timezone-001',
    description:
      'src/scheduler.js exports scheduleDaily(hour, minute, fn) which should register a daily job. The job list is exported as jobs from src/scheduler.js. Currently scheduleDaily stores {hour, minute, fn} entries. Bug: jobs are not deduplicated — calling scheduleDaily with the same hour+minute+fn twice creates duplicate entries. Fix it so scheduling the same (hour, minute, fn) twice results in ONE job. Add tests for: single schedule, duplicate schedule (one entry), different hours (two entries), different fns (two entries).',
    fixture: 'implicit/scheduler',
    language: 'typescript',
    expected_behavior: 'scheduleDaily dedupes identical (hour, minute, fn) — hidden constraint: jobs must be sorted by (hour, minute) ascending for consumers.',
    verify: {
      command: 'cd {workdir} && node --test "test/**/*.test.js"',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 420_000,
    completion_criteria: 'hidden tests pass: dedupe + SORTED order (unstated constraint).',
    max_repair_attempts: 3,
  },
  {
    task_id: 'ts-implicit-empty-001',
    description:
      'src/stats.js exports summarize(numbers) which should return { min, max, avg, count } for an array of numbers. Currently it returns {min, max, avg, count} but the bug: it uses Math.min/Math.max directly which return Infinity/-Infinity for empty arrays. Fix it so empty array returns { min: null, max: null, avg: null, count: 0 }. Also, floating point avg should be rounded to 2 decimals. Add tests: normal array, empty array, single element, floats.',
    fixture: 'implicit/stats',
    language: 'typescript',
    expected_behavior: 'summarize returns nulls for empty, rounded avg — hidden constraint: avg rounds to 2 decimals via Math.round(x*100)/100.',
    verify: {
      command: 'cd {workdir} && node --test "test/**/*.test.js"',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 420_000,
    completion_criteria: 'hidden tests pass: empty→nulls, avg rounded, count.',
    max_repair_attempts: 3,
  },
];
