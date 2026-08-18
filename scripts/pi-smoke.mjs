// CI smoke test for the Pi runtime. Requires OPENCODE_GO_API_KEY in env.
// Usage: node scripts/pi-smoke.mjs
import { PiRuntimeAdapter } from '../runtimes/pi/dist/index.js';
import { runTaskAndCollect } from '../packages/core/dist/index.js';

const r = new PiRuntimeAdapter();
const res = await runTaskAndCollect(
  r,
  { id: 'ci-smoke', prompt: 'Reply with exactly: PONG', cwd: process.cwd() },
);
if (res.status !== 'completed') {
  console.error('Pi runtime FAILED:', res.summary);
  process.exit(1);
}
console.log('Pi runtime OK:', res.summary.slice(0, 40));
console.log(`tokens=${res.usage.totalTokens} cost=${res.usage.costUsd.toFixed(5)}`);