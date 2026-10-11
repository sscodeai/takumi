import { parseFeedback, type FeedbackEntry } from './requirement-feedback.js';
import {
  checkIdOf,
  decisionCheckIds,
  parseDecisionBindings,
  parseRequirements,
  type Decision,
  type DecisionBinding,
} from './requirement-decisions.js';

// The intake brief (ADR-030): the bridge between a failure the machine wrote back and the DECISION that
// has to be made about it.
//
// A rejection says a check failed. It does not say whose fault that is, and the two candidates are
// genuinely different actions: the implementation did not honour the recorded answer, or the answer
// itself was wrong. The machine can tell WHICH DECISION a failing check belongs to (the document's own
// `decides:` bindings), name the answer that was recorded, and offer the decision's own alternative
// options — the bounded choices the human could answer instead. That is the whole content of this file:
// deterministic, and verifiable without an LLM, which is the part of "the intake proposes a new
// decision" a machine may claim.
//
// When a failing check belongs to NO decision, the brief says so instead of inventing one: the response
// to an outstanding relationship or the intake's judgement is exactly the semantic work that must not be
// faked here.

export type FailureKind = 'decision-not-honoured' | 'no-decision' | 'undeclared-check';

export interface AnalysedFailure {
  /** The check id as the judge reported it (`REL-003`, `DEC-002`, `DOC-001`, …). */
  checkId: string;
  /** The check text, verbatim. */
  check: string;
  kind: FailureKind;
  /** The decision this check settles, when there is one. */
  decision?: Decision;
  /** The alternatives the human could answer instead — the decision's own options, minus the answer. */
  alternatives: string[];
  /** Why no decision is named, when none is. */
  reason?: string;
}

export interface AnalysedFeedback {
  entry: FeedbackEntry;
  failures: AnalysedFailure[];
}

/** Which decision each failing check belongs to, and what could be answered instead. */
export function analyseFeedback(text: string): AnalysedFeedback[] {
  const decisions = parseRequirements(text);
  const bindings = parseDecisionBindings(text);
  const decIds = decisionCheckIds(decisions, bindings);
  const byAmbiguity = new Map(decIds.size === 0 ? [] : [...decIds].map(([id, dec]) => [dec, id]));
  const bindingByCheck = new Map<string, DecisionBinding>(bindings.map((b) => [b.checkId, b]));
  const decisionById = new Map<string, Decision>(decisions.map((d) => [d.id, d]));

  const analyse = (check: string): AnalysedFailure => {
    const checkId = checkIdOf(check);
    if (checkId === '') {
      return { checkId, check, kind: 'undeclared-check', alternatives: [], reason: 'the line names no check id' };
    }
    // A `DEC-nnn` line reports on a decision directly; a relation/anchor line reports on whatever the
    // document bound it to. Both end at the same place when the document is coherent.
    const bound = bindingByCheck.get(checkId);
    const ambiguityIdOf = (): string | undefined => {
      if (bound?.decides !== undefined) return bound.decides;
      if (checkId.startsWith('DEC-')) return byAmbiguity.get(checkId);
      return undefined;
    };
    const ambiguityId = ambiguityIdOf();
    if (ambiguityId === undefined) {
      if (checkId.startsWith('DEC-')) {
        return {
          checkId,
          check,
          kind: 'undeclared-check',
          alternatives: [],
          reason: `${checkId} is not a decision line this document can produce (its decisions and decides: bindings do not add up to that numbering)`,
        };
      }
      if (!bindingByCheck.has(checkId)) {
        if (checkId.startsWith('DOC-')) {
          return {
            checkId,
            check,
            kind: 'no-decision',
            alternatives: [],
            reason: `${checkId} is a check on the requirement document itself (not on the implementation or an answer), so there is nothing for the intake to decide`,
          };
        }
        return {
          checkId,
          check,
          kind: 'undeclared-check',
          alternatives: [],
          reason: `${checkId} is not declared in this document's deliverable block, so this document cannot account for the check: either the harness produced it on its own or the document is out of date`,
        };
      }
      return {
        checkId,
        check,
        kind: 'no-decision',
        alternatives: [],
        reason: `${checkId} is a declared check, and it exercises no decision: the failure is about the implementation (or about a piece of the requirement no decision covers), not about an answer the human gave`,
      };
    }
    const decision = decisionById.get(ambiguityId);
    if (decision === undefined) {
      return {
        checkId,
        check,
        kind: 'undeclared-check',
        alternatives: [],
        reason: `${checkId} claims to settle ${ambiguityId}, which the document does not contain`,
      };
    }
    const current = decision.chosen ?? decision.default;
    return {
      checkId,
      check,
      kind: 'decision-not-honoured',
      decision,
      alternatives: decision.options.filter((option) => option !== current),
    };
  };

  return parseFeedback(text).map((entry) => ({ entry, failures: entry.checks.map(analyse) }));
}

/** The marker the intake recognises: the block that means "this pass is a re-pass". */
export const FEEDBACK_BRIEF_MARKER = '## Acceptance feedback (written back by the machine)';

/**
 * The brief the intake reads, as markdown. It is deliberately printable and pasteable: an operator can
 * hand it to the intake as the run input, and a human can read it to see what the machine thinks the
 * failure is about.
 */
export function renderFeedbackBrief(ref: string, text: string): string {
  const analysed = analyseFeedback(text);
  const open = analysed.filter((a) => a.entry.status === 'open');
  const decisions = parseRequirements(text);
  const cited = new Map<string, string[]>();
  for (const decision of decisions) {
    if (decision.fromFeedback === undefined) continue;
    cited.set(decision.fromFeedback, [...(cited.get(decision.fromFeedback) ?? []), decision.id]);
  }

  const lines: string[] = [];
  lines.push(FEEDBACK_BRIEF_MARKER);
  lines.push('');
  if (analysed.length === 0) {
    lines.push(`No acceptance failure has been written back into ${ref}.`);
    lines.push('');
    lines.push('Nothing is being asked of the intake: the document stands as it is.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`The document ${ref} carries ${analysed.length} acceptance failure(s), ${open.length} of them open.`);
  lines.push('Each failing check below is traced to the decision it belongs to, if any, with the answer that');
  lines.push('was recorded and the alternatives that answer could take.');
  lines.push('');
  lines.push('**Answering a failure is a choice between three different repairs, and only a human can make it:**');
  lines.push('');
  lines.push('- the recorded answer stands and the IMPLEMENTATION changes; or');
  lines.push('- the answer was wrong and the DECISION changes — the alternatives are listed, and the');
  lines.push('  confirmation will ask for one of them; or');
  lines.push('- the CHECK itself was at fault — the implementation and the recorded answer were both right,');
  lines.push('  and the failing check is what has to be repaired. This one is a CLAIM by a human, with the');
  lines.push('  basis stated in the resolution note: it is not a machine verdict, and closing a failure this');
  lines.push('  way repairs nothing — the next acceptance still runs the same check.');
  lines.push('');
  lines.push('A failure that traces to NO decision is not a hint to invent one: it says the implementation');
  lines.push('(or a part of the requirement no decision covers) is where the problem is. Only the intake can');
  lines.push('propose a new decision, and only when the failure really does expose an undecided point — and');
  lines.push('such a decision must cite the failure it came from (`fromFeedback: FB-nnn`).');
  lines.push('');

  for (const { entry, failures } of analysed) {
    lines.push(`### ${entry.id} — ${entry.status.toUpperCase()} (run ${entry.run})`);
    lines.push('');
    lines.push(`Judged at requirement digest \`${entry.requirementDigest}\` by judge \`${entry.judgeDigest}\`.`);
    if (entry.status === 'resolved') {
      // ADR-038: which claim closed the failure, machine-readable in the document and named here, so a
      // reader can tell "the implementation was at fault" from "the check was at fault" after the fact.
      const kind = entry.resolvedKind === undefined ? '' : ` [${entry.resolvedKind}]`;
      lines.push(`Resolved by ${entry.resolvedBy ?? 'unknown'}${kind}${entry.resolvedNote === undefined ? '' : `: ${entry.resolvedNote}`}`);
    }
    if (cited.has(entry.id)) {
      lines.push(`Decision(s) proposed for this failure: ${(cited.get(entry.id) ?? []).join(', ')}`);
    }
    lines.push('');
    for (const failure of failures) {
      lines.push(`- **${failure.checkId || '(no id)'}** — ${failure.check}`);
      if (failure.kind === 'decision-not-honoured' && failure.decision !== undefined) {
        const current = failure.decision.chosen ?? failure.decision.default ?? '(undecided)';
        lines.push(`  - decision: ${failure.decision.id}${failure.decision.blocking ? ' (blocking)' : ''} — ${failure.decision.question}`);
        lines.push(`  - recorded answer: ${current}`);
        lines.push(`  - the implementation did not honour it. Either the implementation changes, or the answer does:`);
        for (const option of failure.alternatives) lines.push(`    - ${option}`);
        if (failure.alternatives.length === 0) lines.push('    - (this decision has no other option to answer)');
      } else {
        lines.push(`  - ${failure.reason ?? 'no decision is named for this check'}`);
      }
    }
    lines.push('');
  }
  lines.push('The intake, if it proposes a new decision, must: keep every existing requirement, decision and');
  lines.push('failure entry; give each new decision 2-4 bounded options and a default; and set');
  lines.push('`fromFeedback: FB-nnn` on it so the document says which failure it answers.');
  return `${lines.join('\n')}\n`;
}

/** The failures that no decision covers, in the order the document records them. */
export function failuresWithoutDecision(text: string): AnalysedFailure[] {
  return analyseFeedback(text)
    .filter((a) => a.entry.status === 'open')
    .flatMap((a) => a.failures)
    .filter((f) => f.kind !== 'decision-not-honoured');
}
