import type { Artifact } from './types.js';

/**
 * Traceability Matrix generation (CHATTER.md §11).
 *
 * Builds the Requirement → Design → Code → Test → Evidence linkage from
 * artifact trace links, and renders a Markdown matrix.
 *
 * Model is harness-agnostic and Japanese-SI-agnostic: it works on any
 * Artifact[] with `trace` links (REQ-001, DESIGN-001, UT-001, EVIDENCE-001...).
 */
export function buildTraceability(artifacts: Artifact[]): TraceabilityNode[] {
  const nodes = new Map<string, TraceabilityNode>();
  const links: TraceLink[] = [];

  for (const a of artifacts) {
    const node: TraceabilityNode = {
      id: a.id,
      kind: a.kind,
      path: a.path,
      trace: a.trace,
    };
    nodes.set(a.id, node);
    for (const t of a.trace) {
      links.push({ from: a.id, to: t });
    }
  }

  return [...nodes.values()];
}

export interface TraceabilityNode {
  id: string;
  kind: string;
  path: string;
  trace: string[];
}

export interface TraceLink {
  from: string;
  to: string;
}

/**
 * Render a Markdown traceability matrix: rows = artifacts, columns = their
 * trace targets. Verifies every requirement is covered (missing linkage).
 */
export function renderTraceabilityMatrix(artifacts: Artifact[]): string {
  const rows: string[] = [];
  const allTraceIds = new Set<string>();
  for (const a of artifacts) {
    for (const t of a.trace) allTraceIds.add(t);
  }
  const headerIds = [...allTraceIds].sort();

  rows.push('| Artifact | ' + headerIds.join(' | ') + ' |');
  rows.push('|' + headerIds.map(() => '---').join('|') + '|---|');

  for (const a of artifacts) {
    const marks = headerIds.map((id) => (a.trace.includes(id) ? '✅' : ''));
    rows.push(`| ${a.id} (${a.kind}) | ${marks.join(' | ')} |`);
  }

  // Coverage: each REQ should be linked by at least one DOWNSTREAM artifact
  // (design/test/evidence/...). The requirements source doc itself carrying
  // its own REQ ids does not count as coverage.
  const reqIds = [...allTraceIds].filter((id) => id.startsWith('REQ'));
  const covered = new Set<string>();
  for (const a of artifacts) {
    if (a.kind === 'requirements') continue;
    for (const t of a.trace) if (t.startsWith('REQ')) covered.add(t);
  }
  const uncovered = reqIds.filter((id) => !covered.has(id));

  let out = rows.join('\n');
  if (uncovered.length > 0) {
    out += `\n\n> ⚠ Uncovered requirements: ${uncovered.join(', ')}`;
  }
  return out;
}