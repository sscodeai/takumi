import { runBenchmark, renderLeaderboard } from './index.js';
import { FakeRuntime } from '@takumi/runtime-fake';

// Example: run the benchmark with the deterministic fake runtime first
// (no API cost, verifies the plumbing). Add Pi runtime when OPENCODE_GO_API_KEY
// is present:
//   import { PiRuntimeAdapter } from '@takumi/runtime-pi';
//   runtimes.push({ id: 'pi', make: () => new PiRuntimeAdapter() });
async function main() {
  const runtimes = [{ id: 'fake', make: () => new FakeRuntime((t) => `handled ${t.prompt}`) }];
  const results = await runBenchmark(runtimes);
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