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
 * The coverage of the requirements, as DATA rather than as a sentence in a report.
 *
 * `uncovered` is the THIRD STATE: not a pass (nothing checks it) and not a failure (nothing
 * contradicted it) — a named gap. A pass/fail report renders "a requirement nothing exercises"
 * and "a requirement that passes" identically; this is what tells them apart, and it is why the
 * matrix's warning line is now a rendering of this value instead of the only place the fact lives.
 */
export interface TraceabilityCoverage {
  /** Every REQ id any artifact names. */
  required: string[];
  /** REQ ids a DOWNSTREAM artifact links (the requirements document itself does not count). */
  covered: string[];
  /** REQ ids no downstream artifact links. */
  uncovered: string[];
}

export function traceabilityCoverage(artifacts: Artifact[]): TraceabilityCoverage {
  const allTraceIds = new Set<string>();
  for (const a of artifacts) for (const t of a.trace) allTraceIds.add(t);
  const required = [...allTraceIds].filter((id) => id.startsWith('REQ')).sort();
  const covered = new Set<string>();
  for (const a of artifacts) {
    if (a.kind === 'requirements') continue;
    for (const t of a.trace) if (t.startsWith('REQ')) covered.add(t);
  }
  return { required, covered: required.filter((id) => covered.has(id)), uncovered: required.filter((id) => !covered.has(id)) };
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

  // The matrix renders what `traceabilityCoverage` computes; the fact lives there as data, so a
  // caller can act on it without parsing the Markdown this function produces.
  const { uncovered } = traceabilityCoverage(artifacts);

  let out = rows.join('\n');
  if (uncovered.length > 0) {
    out += `\n\n> ⚠ Uncovered requirements: ${uncovered.join(', ')}`;
  }
  return out;
}