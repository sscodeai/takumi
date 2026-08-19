import { runBenchmark, renderLeaderboard } from './index.js';
import type { AgentRuntimeAdapter } from '@takumi/core';
import { FakeRuntime } from '@takumi/runtime-fake';
import { PiRuntimeAdapter } from '@takumi/runtime-pi';

// Japan SWE-Agent Benchmark runner.
// - Always runs the deterministic FakeRuntime (no API cost, sanity check).
// - When OPENCODE_GO_API_KEY is set, ALSO runs the real Pi runtime to produce
//   honest harness-quality numbers (tokens/cost/duration/pass).
// Add more runtimes (DeepSeek Harness, Codex CLI bridge) here later.
async function main() {
  const runtimes: { id: string; make: () => AgentRuntimeAdapter }[] = [
    { id: 'fake', make: () => new FakeRuntime((t) => `handled ${t.prompt}`) },
  ];

  if (process.env.OPENCODE_GO_API_KEY) {
    runtimes.push({ id: 'pi', make: () => new PiRuntimeAdapter() });
    console.log('# Pi runtime enabled (OPENCODE_GO_API_KEY present)');
  } else {
    console.log('# No OPENCODE_GO_API_KEY — running FakeRuntime only (sanity check)');
  }

  const results = await runBenchmark(runtimes);
  console.log('');
  console.log('# Japan SWE-Agent Benchmark');
  console.log('');
  console.log(renderLeaderboard(results));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nPassed ${passed}/${results.length}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});