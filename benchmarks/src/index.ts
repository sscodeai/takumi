import type {
  AgentEvent,
  AgentRuntimeAdapter,
  AgentTask,
} from '@takumi/core';
import { runTaskAndCollect } from '@takumi/core';

/**
 * Japan SWE-Agent Benchmark — task model.
 * Each task is a real, scoped Japanese enterprise software-engineering task
 * (bug fix, API change, UT generation, review...). Same task can run across
 * multiple runtimes (pi / deepseek / codex) with the SAME model for fair
 * comparison of harness quality.
 */
export interface BenchTask {
  id: string;
  title: string;
  category: 'bug-fix' | 'api' | 'sql' | 'unit-test' | 'design' | 'review' | 'legacy-refactor';
  /** Natural-language instruction (Japanese-aware). */
  prompt: string;
  /** Expected outcome markers to score against (substring checks). */
  expectedMarkers: string[];
  /** Working directory for the task (project under test). */
  cwd: string;
}

/** One run of one task on one runtime. */
export interface BenchRunResult {
  taskId: string;
  runtimeId: string;
  model: string | null;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  tokens: number;
  costUsd: number;
  durationMs: number;
  /** Substring markers that matched in the summary/output. */
  markersMatched: string[];
  markersTotal: number;
  /** Pass/fail on markers. */
  pass: boolean;
  /** Human interventions required (0 for now; approval gates record here). */
  interventions: number;
}

/** Benchmark suite. */
export const DEFAULT_TASKS: BenchTask[] = [
  {
    id: 'jp-001',
    title: 'Java バグ修正（NPE）',
    category: 'bug-fix',
    prompt: 'このコードの NullPointerException の原因を特定し、null 安全な修正を加えてください。',
    expectedMarkers: ['null', 'check'],
    cwd: '.',
  },
  {
    id: 'jp-002',
    title: 'Spring API 追加',
    category: 'api',
    prompt: '社員一覧を返す GET /api/employees エンドポイントを Spring Boot で実装してください。',
    expectedMarkers: ['GET', '/api/employees'],
    cwd: '.',
  },
  {
    id: 'jp-003',
    title: '単体テスト生成',
    category: 'unit-test',
    prompt: 'このサービスクラスの単体テストを、正常系・異常系・境界値を含めて生成してください。',
    expectedMarkers: ['test', '正常'],
    cwd: '.',
  },
];

/**
 * Run a single bench task on a runtime and produce a comparable result.
 * Death: score = fraction of expectedMarkers found in the final summary.
 */
export async function runSingleBenchTask(
  runtime: AgentRuntimeAdapter,
  runtimeId: string,
  task: BenchTask,
  model: string | null = null,
): Promise<BenchRunResult> {
  const start = Date.now();
  const events: AgentEvent[] = [];
  const agentTask: AgentTask = {
    id: `bench-${task.id}`,
    prompt: task.prompt,
    cwd: task.cwd,
    model: model ?? undefined,
  };
  const res = await runTaskAndCollect(runtime, agentTask, (ev) => events.push(ev));

  const combined = [res.summary, ...events.map((e) => e.message ?? '')].join('\n').toLowerCase();
  const matched = task.expectedMarkers.filter((m) => combined.includes(m.toLowerCase()));

  return {
    taskId: task.id,
    runtimeId,
    model: res.usage.model ?? null,
    status: res.status,
    summary: res.summary,
    tokens: res.usage.totalTokens,
    costUsd: res.usage.costUsd,
    durationMs: Date.now() - start,
    markersMatched: matched,
    markersTotal: task.expectedMarkers.length,
    pass: matched.length === task.expectedMarkers.length,
    interventions: 0,
  };
}

/** Run a suite of tasks across runtimes and render a Markdown leaderboard. */
export async function runBenchmark(
  runtimes: { id: string; make: () => AgentRuntimeAdapter }[],
  tasks: BenchTask[] = DEFAULT_TASKS,
): Promise<BenchRunResult[]> {
  const results: BenchRunResult[] = [];
  for (const { id, make } of runtimes) {
    const runtime = make();
    for (const task of tasks) {
      results.push(await runSingleBenchTask(runtime, id, task));
    }
  }
  return results;
}

/** Render a Markdown leaderboard from run results. */
export function renderLeaderboard(results: BenchRunResult[]): string {
  const lines = [
    '| Task | Runtime | Status | Pass | Markers | Tokens | Cost $ | Duration |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.taskId} | ${r.runtimeId} | ${r.status} | ${r.pass ? '✅' : '❌'} | ${r.markersMatched.length}/${r.markersTotal} | ${r.tokens} | ${r.costUsd.toFixed(5)} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  return lines.join('\n');
}