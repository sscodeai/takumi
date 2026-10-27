/**
 * LEDGER #103 — keeping a quality gate's FAILING lines, wherever they are.
 *
 * The gate used a head slice of its output. That is right for a passing gate: the summary is already
 * at the top and the rest is repetition. It is wrong for a failing one, and wrong in the direction
 * that costs the most — the line naming the failure is often the only line that matters, and a head
 * slice drops it precisely when the output opens with something long, which is what a TAP stream
 * does (`ok 1` plus the decisions it found, ~1400 bytes in the sample that exposed this).
 *
 * So: keep the head as before, and ADD every falsifying line that fell outside it. The result stays
 * bounded, and when lines were dropped the summary says how many, so nobody mistakes a truncated
 * report for a complete one.
 */

const HEAD_BUDGET = 1200;
const TOTAL_BUDGET = 4000;

/**
 * Lines that report a failure, across the frameworks this gate meets: TAP (`not ok`), node:test
 * (`✗`, `not ok`), mocha/chai (`failing`, numbered `1)` under a `Failing` heading), go test (`--- FAIL`),
 * pytest (`FAILED`), cargo (`test ... FAILED`), and rust/assertion markers (`AssertionError`, `Error:`).
 */
const FALSIFYING = /^(?:not ok\b|✗|✘|×|---\s*FAIL|\s*✗)|FAILED\b|Failing\b|^AssertionError\b|^\s*Error:/;

/** How many lines the summary may spend on rescuing failures past the head. */
const RESCUE_BUDGET = TOTAL_BUDGET - HEAD_BUDGET;

/**
 * Return the part of a gate's output worth recording.
 *
 * @param out the gate command's combined output
 * @returns a bounded string: the head, plus any failing lines the head missed, plus a note when
 *          something was dropped
 */
export function summariseGateOutput(out: string): string {
  if (out.length <= HEAD_BUDGET) return out;

  const head = out.slice(0, HEAD_BUDGET);
  const lines = out.slice(HEAD_BUDGET).split('\n');
  const rescued: string[] = [];
  let spent = 0;
  for (const line of lines) {
    if (!FALSIFYING.test(line)) continue;
    const cost = line.length + 1;
    if (spent + cost > RESCUE_BUDGET) break;
    rescued.push(line);
    spent += cost;
  }
  if (rescued.length === 0) return head;

  const dropped = lines.length - rescued.length;
  return [head, `[... ${dropped} line(s) omitted; the failing lines follow ...]`, ...rescued].join('\n');
}
