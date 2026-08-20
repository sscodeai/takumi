import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWorkflow, ArtifactStore } from '@takumi/core';
import { FakeRuntime } from '@takumi/runtime-fake';

/**
 * Takumi lightweight web console (P2).
 * Zero-dependency Node HTTP server:
 *   GET  /         → HTML page (run form + live log area)
 *   POST /run      → executes a small workflow on FakeRuntime, streams step
 *                    events back over SSE (text/event-stream)
 *   GET  /health   → liveness
 *
 * This is intentionally minimal — a local dev console, not a production UI.
 */

const PORT = Number(process.env.TAKUMI_CONSOLE_PORT ?? 8787);

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Takumi Console</title>
<style>
  body { font-family: ui-monospace, Menlo, monospace; background: #0f1117; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .card { background: #171a21; border: 1px solid #2a2e3a; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  input[type=text] { width: 70%; padding: 8px; background: #0f1117; border: 1px solid #3a3f4d; color: #e6e6e6; border-radius: 4px; }
  button { padding: 8px 16px; background: #2f6feb; color: white; border: none; border-radius: 4px; cursor: pointer; }
  button:disabled { opacity: .5; }
  #log { white-space: pre-wrap; font-size: 12px; line-height: 1.5; max-height: 60vh; overflow-y: auto; }
  .ok { color: #3fb950; } .fail { color: #f85149; } .info { color: #58a6ff; }
</style>
</head>
<body>
<h1>⚙ Takumi Console <span style="font-size:12px;color:#8b949e">(local dev console)</span></h1>
<div class="card">
  <input type="text" id="prompt" placeholder="e.g. 社員管理システムの要件を分析してください" value="Analyze the requirements and produce a summary" />
  <button id="runBtn" onclick="run()">▶ Run workflow</button>
</div>
<div class="card"><div id="log">Ready. Enter a prompt and click Run.</div></div>
<script>
async function run() {
  const prompt = document.getElementById('prompt').value;
  const log = document.getElementById('log');
  const btn = document.getElementById('runBtn');
  log.innerHTML = ''; btn.disabled = true;
  const res = await fetch('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    for (const line of chunk.split('\\n')) {
      if (!line.startsWith('data: ')) continue;
      const ev = JSON.parse(line.slice(6));
      const cls = ev.type === 'task.completed' ? 'ok' : ev.type === 'task.failed' ? 'fail' : 'info';
      log.innerHTML += '<div class="' + cls + '">' + (ev.message ?? ev.type).replace(/</g, '&lt;') + '</div>';
      log.scrollTop = log.scrollHeight;
    }
  }
  log.innerHTML += '<div class="ok">— run finished —</div>';
  btn.disabled = false;
}
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'takumi-console' }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/run') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { prompt } = JSON.parse(body || '{}') as { prompt?: string };
    const text = (prompt ?? '').trim() || 'Analyze and summarize';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (type: string, message: string) => {
      res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
    };

    const rt = new FakeRuntime((t: { prompt: string }) => `analyzed: ${t.prompt.slice(0, 80)}`);
    const dir = mkdtempSync(join(tmpdir(), 'takumi-console-'));
    const wf = {
      name: 'console-wf',
      version: '0.1.0',
      description: 'console demo',
      steps: [
        { id: 'analyze', type: 'agent' as const, prompt: text, dependsOn: [] },
        { id: 'summarize', type: 'agent' as const, prompt: 'Summarize the analysis', dependsOn: ['analyze'] },
        { id: 'deliver', type: 'delivery' as const, prompt: 'bundle', dependsOn: ['summarize'] },
      ],
    };
    send('info', `▶ run started (runtime=fake, workflow=console-wf)`);
    try {
      const result = await executeWorkflow(
        wf,
        {
          cwd: dir,
          runtime: rt,
          artifacts: new ArtifactStore(join(dir, 'a')),
          onApproval: () => true,
          onEvent: (stepId, message) => send('info', `[${stepId}] ${message}`),
        },
        { input: text },
      );
      for (const s of result.steps) {
        send(s.status === 'completed' ? 'task.completed' : 'task.failed', `step ${s.stepId}: ${s.status} — ${s.summary.slice(0, 120)}`);
      }
      send(result.status === 'completed' ? 'task.completed' : 'task.failed', `workflow ${result.status}`);
    } catch (e) {
      send('task.failed', `error: ${e instanceof Error ? e.message : String(e)}`);
    }
    res.end();
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

export function start(port = PORT): ReturnType<typeof createServer> {
  server.listen(port, () => {
    console.log(`⚙ Takumi Console: http://localhost:${port}`);
  });
  return server;
}

// Run directly: `node apps/console/dist/index.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
