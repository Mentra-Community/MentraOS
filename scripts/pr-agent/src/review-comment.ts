import { parseVerdictFromText, stripVerdictJson } from './findings.js';
import { MARKER_BUGBOT_VERDICT, MARKER_REVIEW, type PrAgentState, type ReviewSlot } from './types.js';

const SLOT_LABEL: Record<ReviewSlot, string> = {
  standards: 'Claude — standards',
  depth: 'Claude — depth',
  codex: 'Codex — review',
  bugbot: 'Bugbot',
};

type ReviewTexts = {
  standards?: string;
  depth?: string;
  codex?: string;
  bugbot?: string;
};

function verdictBadge(text: string | undefined): string {
  const verdict = text ? parseVerdictFromText(text)?.verdict : undefined;
  if (verdict === 'changes_requested') return '⚠️ changes requested';
  if (verdict === 'approve') return '✅ approve';
  return '— no verdict';
}

function prose(slot: ReviewSlot, raw: string): string {
  const cleaned = slot === 'bugbot' ? raw.split(MARKER_BUGBOT_VERDICT).join('') : raw;
  const text = stripVerdictJson(cleaned);
  return text || '_(reviewer returned no written summary)_';
}

/**
 * Build the always-on, human-visible review comment. Posted/updated every review
 * cycle regardless of verdict so a reviewer summary is always visible on the PR,
 * even when the agents approve with no blocking findings.
 */
export function buildReviewComment(
  state: PrAgentState,
  reviews: ReviewTexts,
  activePair: ReviewSlot[],
): string {
  const blocking = state.openFindings.filter((f) => f.severity === 'blocking').length;
  const nits = state.nitFindings.length;

  const sections: string[] = [];
  for (const slot of activePair) {
    const raw = reviews[slot as keyof ReviewTexts];
    if (!raw) continue;
    sections.push(`### ${SLOT_LABEL[slot]} — ${verdictBadge(raw)}\n\n${prose(slot, raw)}`);
  }

  const overall = blocking > 0 ? '⚠️ Changes requested' : '✅ No blocking findings';
  const reviewerList = activePair.length ? activePair.join(', ') : 'none';

  // No ingested review text: showing the ledger's blocking/nit counts next to
  // "no reviews ran" reads as a contradiction. State plainly that this cycle
  // carried no review signal and that counters did not move.
  if (sections.length === 0) {
    return `${MARKER_REVIEW}
## 🤖 PR Agent Review — cycle ${state.cycle}

_No model reviews were ingested this cycle (scheduled: ${reviewerList}); ledger and budget counters unchanged._

<sub>Updated automatically by the PR Agent Orchestrator each review cycle. Nits do not block merge.</sub>`;
  }

  return `${MARKER_REVIEW}
## 🤖 PR Agent Review — cycle ${state.cycle}

**${overall}** · ${blocking} blocking · ${nits} nit${nits === 1 ? '' : 's'}
_Reviewers this cycle: ${reviewerList}_

${sections.join('\n\n---\n\n')}

<sub>Updated automatically by the PR Agent Orchestrator each review cycle. Nits do not block merge.</sub>`;
}
