import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bumpMetrics,
  emptyMetrics,
  readMetricsFile,
  renderPrometheus,
  writeMetricsFile,
} from '../index.js';
import type { PilotTickResult } from '../index.js';

const tick = (outcome: PilotTickResult['outcome']): PilotTickResult => ({ outcome, detail: outcome });

test('bumpMetrics: counts every outcome, and nothing else moves', () => {
  let m = emptyMetrics();
  m = bumpMetrics(m, tick('idle'), { atSeconds: 100 });
  m = bumpMetrics(m, tick('delivered'), { atSeconds: 200 });
  m = bumpMetrics(m, tick('delivered'), { atSeconds: 300, agentRetries: 2, checksWaitedSeconds: 45 });

  assert.equal(m.ticks, 3);
  assert.equal(m.outcomes.delivered, 2);
  assert.equal(m.outcomes.idle, 1);
  assert.equal(m.outcomes.blocked, 0);
  assert.equal(m.outcomes.agentRetries, 2);
  assert.equal(m.outcomes.checksWaitedSeconds, 45);
  assert.equal(m.lastTickAtSeconds, 300);
  assert.equal(m.lastOutcome, 'delivered');
});

test('renderPrometheus: the series an operator would alert on, with their types', () => {
  let m = emptyMetrics();
  m = bumpMetrics(m, tick('blocked'), { atSeconds: 1757900000 });
  const text = renderPrometheus(m);

  assert.match(text, /# TYPE takumi_pilot_ticks_total counter/);
  assert.match(text, /takumi_pilot_ticks_total 1/);
  assert.match(text, /takumi_pilot_outcome_blocked_total 1/);
  assert.match(text, /takumi_pilot_outcome_delivered_total 0/);
  assert.match(text, /# TYPE takumi_pilot_last_tick_timestamp_seconds gauge/);
  assert.match(text, /takumi_pilot_last_tick_timestamp_seconds 1757900000/);
  // Every series needs HELP and TYPE lines: a scraper rejects the file otherwise.
  const series = text.split('\n').filter((l) => l.startsWith('takumi_'));
  const types = text.split('\n').filter((l) => l.startsWith('# TYPE'));
  assert.equal(series.length, types.length);
});

test('renderPrometheus: no tick yet is 0, not a missing line', () => {
  const text = renderPrometheus(emptyMetrics());
  assert.match(text, /takumi_pilot_last_tick_timestamp_seconds 0/);
});

test('metrics files: round-trip, and a corrupt file resets instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-metrics-'));
  try {
    const file = join(dir, 'metrics.json');
    const textfile = join(dir, 'metrics.prom');
    assert.deepEqual(readMetricsFile(file), emptyMetrics(), 'absent file starts from zero');

    const m = bumpMetrics(emptyMetrics(), tick('retriable'), { atSeconds: 42 });
    writeMetricsFile(file, m, textfile);
    assert.deepEqual(readMetricsFile(file), m);
    assert.match(readFileSync(textfile, 'utf8'), /takumi_pilot_outcome_retriable_total 1/);
    assert.equal(existsSync(`${file}.tmp`), false, 'the temporary file must not be left behind');

    writeFileSync(file, '{ this is not json');
    assert.deepEqual(readMetricsFile(file), emptyMetrics(), 'a broken counter file must not stop the runner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
