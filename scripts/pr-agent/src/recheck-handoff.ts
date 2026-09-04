import { loadConfig } from './config.js';
import {
  fetchWorkflowStatuses,
  getChangedFiles,
  getPrHeadSha,
  isCiGreen,
  requiredWorkflowsForPaths,
} from './ci-gates.js';
import { openBlocking } from './findings.js';
import type { Octokit } from '@octokit/rest';
import type { PrAgentState } from './types.js';

export type RecheckHandoffResult = {
  state: PrAgentState;
  shouldHandoff: boolean;
  handoffReason?: 'human_handoff';
  /**
   * Reviews are clean and CI is green, but the PR has not banked enough
   * consecutive clean cycles to hand off — and with no CI gate matching the
   * diff, nothing external will start the next cycle. The workflow
   * self-dispatches instead of leaving the PR stranded in_progress (#3851).
   */
  needsContinuation?: boolean;
};

/** Re-evaluate clean handoff after CI settles (no new review ingest, no cycle bump). */
export async function recheckHandoff(
  repoRoot: string,
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  state: PrAgentState,
): Promise<RecheckHandoffResult> {
  const config = loadConfig(repoRoot);
  const ref = await getPrHeadSha(octokit, owner, repo, prNumber);
  const changedFiles = await getChangedFiles(octokit, owner, repo, prNumber);
  const required = requiredWorkflowsForPaths(changedFiles, repoRoot);
  const ciChecks = await fetchWorkflowStatuses(octokit, owner, repo, ref, required);
  const ciGreen = isCiGreen(ciChecks);
  const openCount = openBlocking(state.openFindings).length;

  const cleanHandoff =
    state.status === 'in_progress' &&
    ciGreen &&
    openCount === 0 &&
    state.consecutiveNoNewReviews >= config.limits.consecutiveNoNewReviewsForHandoff;

  if (!cleanHandoff) {
    // Short of the clean-cycle threshold with nothing red to fix and no CI
    // gate to report back: the loop needs a nudge or it dies here.
    const needsContinuation =
      state.status === 'in_progress' &&
      ciGreen &&
      openCount === 0 &&
      required.length === 0 &&
      state.consecutiveNoNewReviews < config.limits.consecutiveNoNewReviewsForHandoff;
    return { state, shouldHandoff: false, needsContinuation };
  }

  const nextState: PrAgentState = {
    ...state,
    status: 'human_handoff',
  };

  return {
    state: nextState,
    shouldHandoff: true,
    handoffReason: 'human_handoff',
  };
}
