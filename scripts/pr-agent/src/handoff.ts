import { isCiFailed, type CiCheckStatus } from './ci-gates.js';
import { openBlocking } from './findings.js';
import type { Finding, PrAgentState } from './types.js';
import { MARKER_HANDOFF } from './types.js';

export function buildHandoffComment(
  reason: 'human_handoff' | 'budget_exhausted' | 'diverging',
  state: PrAgentState,
  ciChecks: CiCheckStatus[],
): string {
  const open = openBlocking(state.openFindings);
  const ciFailed = isCiFailed(ciChecks);

  let reasonText =
    reason === 'human_handoff'
      ? 'Clean handoff — CI green, no blocking findings, models have no further reviews.'
      : reason === 'budget_exhausted'
        ? 'Budget exhausted — fix or review cycle cap reached.'
        : 'Diverging — stagnation or review churn detected.';

  if (ciFailed) {
    reasonText =
      reason === 'human_handoff'
        ? 'Handoff with failing CI — path-scoped checks are red; do not merge until CI is green.'
        : `${reasonText} Path-scoped CI is failing — do not merge until CI is green.`;
  }

  const ciTable =
    ciChecks.length === 0
      ? '_No path-scoped CI workflows required for this PR._'
      : ciChecks
          .map(
            (c) =>
              `| ${c.name} | ${c.status} | ${c.conclusion ?? '—'} |`,
          )
          .join('\n');

  const blockingList =
    open.length === 0
      ? '_None_'
      : open
          .map((f: Finding) => `- **${f.id}** (\`${f.file}\`) [${f.source}]: ${f.message}`)
          .join('\n');

  const nits =
    state.nitFindings.length === 0
      ? '_None_'
      : state.nitFindings
          .slice(0, 20)
          .map((f) => `- (\`${f.file}\`) ${f.message}`)
          .join('\n');

  const footer = ciFailed
    ? '**CI is failing.** Do not merge until path-scoped checks are green. Label `agent-resume` after pushing fixes to re-run the loop.'
    : '**Humans merge when ready.** Agents do not auto-merge. Label `agent-resume` to re-run the loop after new commits.';

  return `${MARKER_HANDOFF}
## PR Agent Handoff

**Exit reason:** ${reasonText}

| Metric | Value |
|--------|-------|
| Fix rounds | ${state.fixRound} |
| Review cycles | ${state.cycle} |
| Consecutive no-new-review cycles | ${state.consecutiveNoNewReviews} |

### CI status

| Check | Status | Conclusion |
|-------|--------|------------|
${ciTable}

### Remaining blocking findings

${blockingList}

### Nits (informational)

${nits}

---

${footer}
`;
}
