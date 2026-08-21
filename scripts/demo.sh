#!/usr/bin/env bash
# Takumi 20-45s demo — one command shows the whole story.
# Usage: bash scripts/demo.sh [--runtime deepseek]
set -e
RUNTIME="${1:-fake}"

echo "=============================================="
echo "  Takumi — Agents propose. Takumi verifies."
echo "=============================================="
echo ""

# 1. Fake runtime: instant, deterministic
echo "▶ [1/4] Workflow run (runtime=$RUNTIME)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -d examples/minimal-vmodel ]; then
  cd examples/minimal-vmodel
  if [ "$RUNTIME" = "deepseek" ]; then
    node ../../apps/cli/dist/index.js run requirements.md --workflow pi-probe --runtime deepseek 2>&1 | head -15
  else
    node ../../apps/cli/dist/index.js run requirements.md --workflow pi-probe --runtime fake 2>&1 | head -15
  fi
else
  echo "  (examples/minimal-vmodel not present)"
fi
echo ""

# 2. Eval data (real, from results/)
echo "▶ [2/4] Agent Eval — 23 tasks, model-agnostic"
LATEST_EVAL=$(ls -t "$ROOT"/eval/results/deepseek-*.json 2>/dev/null | head -1)
if [ -n "$LATEST_EVAL" ]; then
  node -e "
    const d = require('$LATEST_EVAL');
    const m = d.metrics;
    console.log('  model:', d.model, '| tasks:', d.sample_size);
    console.log('  first_pass_rate:   ' + (m.first_pass_rate*100).toFixed(0) + '%');
    console.log('  false_completion:  ' + (m.false_completion_rate*100).toFixed(0) + '%');
    console.log('  repair_success:    ' + (m.repair_success_rate === null ? 'n/a' : (m.repair_success_rate*100).toFixed(0)+'%'));
    console.log('  final_success:     ' + (m.final_success_rate*100).toFixed(0) + '%');
  "
else
  echo "  (no eval results yet — run node eval/scripts/run-eval.mjs first)"
fi
echo ""

# 3. Manager Loop (MEA) — quick demo with fake runtime
echo "▶ [3/4] Manager Loop (MEA, arXiv 2608.01964 aligned)"
rm -rf /tmp/takumi-demo-loop && cp -r "$ROOT/eval/fixtures/ts/even" /tmp/takumi-demo-loop 2>/dev/null || {
  echo "  (fixtures not built — run node eval/scripts/create-fixtures.mjs)"
}
if [ -d /tmp/takumi-demo-loop ]; then
  LOOP_RT="fake"
  if [ -n "${COMMANDCODE_API_KEY:-}" ]; then LOOP_RT="deepseek"; fi
  (cd /tmp/takumi-demo-loop && node "$ROOT/apps/cli/dist/index.js" loop "Fix sumEven to sum only even numbers and add tests" --runtime "$LOOP_RT" --max-rounds 2 2>&1 | head -12)
fi
echo ""

# 4. Golden Path evidence
echo "▶ [4/4] Golden Path — real LLM, real tests"
cd "$ROOT"
if [ -d examples/pi10 ]; then
  SRC=$(find examples/pi10/src/main -name '*.java' | wc -l)
  TST=$(find examples/pi10/src/test -name '*.java' | wc -l)
  echo "  examples/pi10: $SRC Java sources, $TST test classes"
  echo "  (mvn test → 59/59 BUILD SUCCESS — see docs/final-state-audit.md)"
else
  echo "  (pi10 example not present)"
fi
echo ""
echo "=============================================="
echo "  More: docs/evaluation.md · docs/interview-qa.md"
echo "=============================================="
