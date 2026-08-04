import type { Octokit } from '@octokit/rest';
import { listAllIssueComments } from './state.js';

const BUGBOT_CHECK_NAME = 'Cursor Bugbot';

// Minimum gap before we post another "bugbot run" trigger. Prevents the
// workflow_run completion event from looping: Bugbot finishes → workflow_run
// triggers orchestrator → orchestrator re-triggers Bugbot → repeat.
const BUGBOT_RETRIGGER_COOLDOWN_MS = 5 * 60 * 1_000; // 5 minutes

export async function triggerBugbot(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  // Check if a "bugbot run" comment was posted recently to avoid re-triggering
  // Bugbot when the orchestrator is itself started by a Bugbot workflow_run event.
  const comments = await listAllIssueComments(octokit, owner, repo, issueNumber);
  const lastTrigger = [...comments]
    .reverse()
    .find((c) => c.body?.trim() === 'bugbot run');
  if (lastTrigger?.created_at) {
    const age = Date.now() - new Date(lastTrigger.created_at).getTime();
    if (age < BUGBOT_RETRIGGER_COOLDOWN_MS) {
      console.log(`Skipping Bugbot trigger — last trigger was ${Math.round(age / 1000)}s ago`);
      return;
    }
  }

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: 'bugbot run',
  });
}

export async function pollBugbotCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  maxWaitMin: number,
): Promise<{ completed: boolean; success: boolean }> {
  const deadline = Date.now() + maxWaitMin * 60_000;
  while (Date.now() < deadline) {
    const { data } = await octokit.checks.listForRef({ owner, repo, ref, per_page: 100 });
    const matching = data.check_runs.filter((r) => r.name === BUGBOT_CHECK_NAME);
    if (matching.length > 0) {
      const latest = [...matching].sort(
        (a, b) =>
          new Date(b.started_at ?? 0).getTime() - new Date(a.started_at ?? 0).getTime() || b.id - a.id,
      )[0]!;
      if (latest.status === 'completed') {
        return { completed: true, success: latest.conclusion === 'success' };
      }
    }
    await sleep(20_000);
  }
  return { completed: false, success: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
