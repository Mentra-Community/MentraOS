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
    return { state, shouldHandoff: false };
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
