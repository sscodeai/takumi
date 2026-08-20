import type { EvalTask } from '../types.js';

/**
 * Task set A — TypeScript/Node (fixtures under eval/fixtures/ts/).
 * Each fixture is a tiny npm project with a failing or missing test suite
 * that constitutes the INDEPENDENT ground truth (hidden from the agent).
 */
export const tsTasks: EvalTask[] = [
  {
    task_id: 'ts-bugfix-001',
    description:
      'In the project, the function `sumEven(numbers)` in src/even.ts is supposed to return the sum of only the EVEN numbers in the array, but it currently sums ALL numbers. Fix the bug. Do not change the function signature. Add or update tests under test/ to cover: empty array returns 0, odd-only array returns 0, mixed array returns sum of evens.',
    fixture: 'ts/even',
    language: 'typescript',
    expected_behavior: 'sumEven sums only even numbers; tests cover empty/odd/mixed.',
    verify: {
      command: 'cd {workdir} && npm test',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 300_000,
    allowed_tools: ['bash', 'read_file', 'write_file', 'list_dir'],
    completion_criteria: 'npm test passes (node --test) with hidden ground-truth tests.',
    max_repair_attempts: 2,
  },
  {
    task_id: 'ts-bugfix-002',
    description:
      'src/format.ts exports `formatMoney(n: number): string` which should return "$1,234.56" style (thousands separators, 2 decimals, $ prefix). It currently returns wrong formatting for numbers >= 1000. Fix it. Do not change the signature.',
    fixture: 'ts/money',
    language: 'typescript',
    expected_behavior: 'formatMoney formats thousands separators + 2 decimals + $ prefix.',
    verify: {
      command: 'cd {workdir} && npm test',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 300_000,
    completion_criteria: 'npm test passes.',
    max_repair_attempts: 2,
  },
  {
    task_id: 'ts-feature-001',
    description:
      'Add a function `flatten<T>(nested: (T | T[])[]): T[]` to src/flatten.ts that flattens ONE level of nesting. E.g. flatten([1,[2,3],4]) === [1,2,3,4]. Export it. Add tests under test/ covering: empty input, no nesting, one level nesting.',
    fixture: 'ts/flatten',
    language: 'typescript',
    expected_behavior: 'flatten flattens one level; exported; tests added.',
    verify: {
      command: 'cd {workdir} && npm test',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 300_000,
    completion_criteria: 'npm test passes.',
    max_repair_attempts: 2,
  },
  {
    task_id: 'ts-regression-001',
    description:
      'src/sort.ts has a function `sortDesc(numbers: number[]): number[]` that previously sorted descending but a recent change broke it (it now sorts ascending). Restore the descending behavior WITHOUT changing the signature. Keep existing tests passing and add a test for [3,1,2] → [3,2,1].',
    fixture: 'ts/sort',
    language: 'typescript',
    expected_behavior: 'sortDesc sorts descending; existing + new tests pass.',
    verify: {
      command: 'cd {workdir} && npm test',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 300_000,
    completion_criteria: 'npm test passes.',
    max_repair_attempts: 2,
  },
  {
    task_id: 'ts-unit-test-001',
    description:
      'src/counter.ts implements a Counter class with increment() and get() but has NO tests. Write comprehensive unit tests in test/counter.test.ts covering: starts at 0, increment returns new value, multiple increments accumulate, get does not mutate. Do not change the implementation.',
    fixture: 'ts/counter',
    language: 'typescript',
    expected_behavior: 'Counter tests cover start/increment/accumulate/get-no-mutate.',
    verify: {
      command: 'cd {workdir} && npm test',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 300_000,
    completion_criteria: 'npm test passes.',
    max_repair_attempts: 2,
  },
  {
    task_id: 'ts-api-001',
    description:
      'src/api.ts exports `getUser(id: string): Promise<User>` that fetches from a REST endpoint. It should throw an Error("not found") when the id does not exist (HTTP 404), but currently returns undefined. Fix it. Add a test using the provided mock (test/helpers.ts exports mockFetch) covering the 404 case.',
    fixture: 'ts/api',
    language: 'typescript',
    expected_behavior: 'getUser throws on 404; test covers it via mock.',
    verify: {
      command: 'cd {workdir} && npm test',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 300_000,
    completion_criteria: 'npm test passes.',
    max_repair_attempts: 2,
  },
];
