import type { Octokit } from '@octokit/rest';

const BUGBOT_CHECK_NAME = 'Cursor Bugbot';

export async function triggerBugbot(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
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
