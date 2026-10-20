import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTraceabilityMatrix, traceabilityCoverage } from '../traceability.js';
import type { Artifact } from '../types.js';

const base = { taskId: 't', contentType: 'text/markdown', createdAt: 0 };

test('renderTraceabilityMatrix: builds matrix with coverage check', () => {
  const artifacts: Artifact[] = [
    { ...base, id: 'REQ-DOC', kind: 'requirements', path: 'requirements.md', trace: ['REQ-001', 'REQ-002', 'REQ-003'] },
    { ...base, id: 'DESIGN-001', kind: 'design', path: 'design/basic.md', trace: ['REQ-001', 'REQ-002'] },
    { ...base, id: 'UT-001', kind: 'test', path: 'tests/ut-001.md', trace: ['REQ-001', 'DESIGN-001'] },
    { ...base, id: 'EVIDENCE-001', kind: 'evidence', path: 'evidence/ut-001/', trace: ['UT-001'] },
  ];
  const matrix = renderTraceabilityMatrix(artifacts);
  assert.ok(matrix.includes('REQ-001'));
  assert.ok(matrix.includes('DESIGN-001'));
  assert.ok(matrix.includes('✅'));
  // REQ-003 is never linked by any downstream artifact → warning
  assert.ok(matrix.includes('Uncovered requirements'));
  assert.ok(matrix.includes('REQ-003'));
});

test('renderTraceabilityMatrix: no uncovered warning when all traced', () => {
  const artifacts: Artifact[] = [
    { ...base, id: 'REQ-DOC', kind: 'requirements', path: 'requirements.md', trace: ['REQ-001'] },
    { ...base, id: 'DESIGN-001', kind: 'design', path: 'design/basic.md', trace: ['REQ-001'] },
    { ...base, id: 'UT-001', kind: 'test', path: 'tests/ut-001.md', trace: ['REQ-001'] },
  ];
  const matrix = renderTraceabilityMatrix(artifacts);
  assert.ok(!matrix.includes('Uncovered requirements'));
});

// ---------------------------------------------------------------------------------------------
// The third state, as DATA (borrowed from a spec-suite shape: pass / fail / unsupported)
// ---------------------------------------------------------------------------------------------

test('traceabilityCoverage: "a requirement nothing exercises" is a named gap, not silence', () => {
  const artifacts: Artifact[] = [
    { ...base, id: 'REQ-DOC', kind: 'requirements', path: 'requirements.md', trace: ['REQ-001', 'REQ-002', 'REQ-003'] },
    { ...base, id: 'DESIGN-001', kind: 'design', path: 'design/basic.md', trace: ['REQ-001'] },
    { ...base, id: 'UT-001', kind: 'test', path: 'tests/ut-001.md', trace: ['REQ-001'] },
  ];
  const c = traceabilityCoverage(artifacts);
  assert.deepEqual(c.required, ['REQ-001', 'REQ-002', 'REQ-003']);
  assert.deepEqual(c.covered, ['REQ-001']);
  // Not a failure and not a pass: exactly which requirements are UNEXERCISED, by name.
  assert.deepEqual(c.uncovered, ['REQ-002', 'REQ-003']);
});

test('traceabilityCoverage: the requirements document does not cover its own ids', () => {
  const artifacts: Artifact[] = [
    { ...base, id: 'REQ-DOC', kind: 'requirements', path: 'requirements.md', trace: ['REQ-001'] },
  ];
  const c = traceabilityCoverage(artifacts);
  assert.deepEqual(c.covered, [], 'a document naming its own requirement is not evidence about it');
  assert.deepEqual(c.uncovered, ['REQ-001']);
});

test('traceabilityCoverage: nothing to cover is not the same as everything covered', () => {
  const c = traceabilityCoverage([{ ...base, id: 'ART-1', kind: 'design', path: 'x.md', trace: ['DESIGN-001'] }]);
  assert.deepEqual(c.required, []);
  assert.deepEqual(c.uncovered, []);
});
