import { executeWorkflow, ArtifactStore } from '../packages/core/dist/index.js';
import { TestRuntime } from '../packages/core/dist/test-utils.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rt = new TestRuntime((t) => 'ok: ' + t.prompt?.slice(0, 20), { capabilities: ['streaming', 'shell'], maxParallelTasks: 4 }, 'bench');
const makeCtx = (label) => {
  const dir = join(tmpdir(), `bench-${label}-${Date.now()}`);
  return { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true };
};

const cases = [
  { name: 'green', prompt: 'echo "# tests 3"; echo "# pass 3"; echo "# fail 0"', expect: 'completed' },
  { name: 'red', prompt: 'echo "# tests 3"; echo "# pass 2"; echo "# fail 1"; exit 1', expect: 'failed' },
  { name: 'zero', prompt: 'echo "# tests 0"; echo "# pass 0"; echo "# fail 0"; exit 0', expect: 'failed' },
  { name: 'maven-green', prompt: 'echo "Tests run: 5, Failures: 0, Errors: 0, Skipped: 0"; echo "BUILD SUCCESS"', expect: 'completed' },
  { name: 'maven-red', prompt: 'echo "Tests run: 5, Failures: 2, Errors: 1, Skipped: 0"; echo "BUILD FAILURE"', expect: 'failed' },
];

for (const c of cases) {
  const w = { name: 'qg', version: '0.1.0', description: '', steps: [{ id: 'gate', type: 'quality_gate', prompt: c.prompt, dependsOn: [], timeoutMs: 30000 }] };
  const res = await executeWorkflow(w, makeCtx(c.name), {});
  const gate = res.steps.find((s) => s.stepId === 'gate');
  console.log(`${c.name}: got=${gate?.status} expect=${c.expect} | ${gate?.summary?.split('\n')[0]}`);
  console.log(`   RAW: ${JSON.stringify(gate?.summary?.slice(0, 150))}`);
}
